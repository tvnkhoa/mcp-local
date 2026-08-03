/**
 * observe-mcp's tool table, declared as data (migration-plan step S-25).
 *
 * What used to be a `ListTools` array plus a hand-written `switch` in `index.ts`
 * is now eight `defineTool` declarations. The shared pipeline in `@mcp/sdk`
 * supplies resolve → profile → validate → guards → handle → serialize; what
 * stays local is this server's own contract — the exact descriptions and JSON
 * Schemas, the SQL guardrail, and the `{ code, message, detail? }` error
 * envelope injected through `formatError`.
 *
 * The JSON Schemas are written out rather than generated from the zod schemas:
 * `contracts/observe-mcp.json` is a committed contract, and a generator would be
 * free to drift it. `schema.*` only removes boilerplate.
 *
 * Seven of the eight handlers return a plain payload and let dispatch serialize
 * it. `run_observe_query` is the exception and is documented at its declaration.
 */

import { ok } from "@mcp/core";
import type { AnyToolDefinition, JsonSchemaNode, ToolCallResult } from "@mcp/sdk";
import { annotations, defineTool, schema } from "@mcp/sdk";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import type { ObserveConfig } from "../config/index.js";
import { isPlatformError } from "@mcp/core";
import { validateReadOnlySql } from "../middleware/sqlGuardrails.js";
import { mapError, type MappedError } from "../middleware/errors.js";
import { normalizeLog, normalizeSpan, capLog } from "../services/logParser.js";
import type { ObserveClient } from "../services/observeClient.js";
import {
  resolveWindow,
  clampSize,
  buildSearchLogsSql,
  buildTraceLogsSql,
  buildTraceSpansSql,
  buildLogStatsSql,
  buildSampleSql
} from "../services/queryBuilder.js";
import { asText as asTextProfiled, asError as asErrorProfiled, responseProfileSchema } from "../middleware/responseFormatter.js";

/**
 * `mapError`, plus the refusals dispatch itself raises. Re-declared here rather
 * than imported so `tools.ts` is the single place `index.ts` and the tests wire
 * their error contract from.
 */
export function toWireError(error: unknown): MappedError {
  if (isPlatformError(error)) {
    return { code: error.code, message: error.message };
  }
  return mapError(error);
}

/**
 * Bridge a handler's `CallToolResult` to the platform's `ToolCallResult`.
 * `CallToolResult.content` is a text|image|resource union; the platform type
 * narrows it to text. Variance, not a shape change.
 */
function raw(result: CallToolResult): ToolCallResult {
  return result as unknown as ToolCallResult;
}

/** Summarize the fields present across sampled rows: observed JSON types + non-null count. */
function describeFields(
  hits: Array<Record<string, unknown>>
): Array<{ name: string; types: string[]; nonNull: number }> {
  const acc = new Map<string, { types: Set<string>; nonNull: number }>();
  for (const hit of hits) {
    for (const [key, value] of Object.entries(hit)) {
      let entry = acc.get(key);
      if (!entry) {
        entry = { types: new Set<string>(), nonNull: 0 };
        acc.set(key, entry);
      }
      if (value === null || value === undefined) {
        entry.types.add("null");
      } else {
        entry.nonNull += 1;
        entry.types.add(Array.isArray(value) ? "array" : typeof value);
      }
    }
  }
  return [...acc.entries()]
    .map(([name, e]) => ({ name, types: [...e.types].sort(), nonNull: e.nonNull }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function buildTools(config: ObserveConfig, client: ObserveClient): AnyToolDefinition[] {
  // --- shared zod fragments --------------------------------------------------
  const profileArg = responseProfileSchema.optional();
  const offsetArg = z.number().int().min(0).optional();
  const timeArg = z.string().min(1).max(32).optional();
  const instantArg = z.string().min(1).max(64).optional();
  const traceIdArg = z.string().min(8).max(64);
  const streamTypeArg = z.enum(["logs", "traces", "metrics"]);
  const limitArg = z.number().int().positive().optional();
  const streamArg = z.string().min(1).max(256).optional();

  // --- shared JSON Schema fragments -----------------------------------------
  // Deliberately NOT `schema.profile()`: that helper adds a description this
  // server has never advertised, and `tools/list` is a committed contract.
  const profileProp: JsonSchemaNode = schema.enumOf(["nano", "compact", "standard", "verbose"]);
  const typeProp: JsonSchemaNode = schema.enumOf(["logs", "traces", "metrics"]);
  const limitProp: JsonSchemaNode = schema.number();
  const offsetProp: JsonSchemaNode = schema.number(
    "Row offset for pagination (default 0); use the returned nextOffset to page"
  );

  /** Every tool here reads a remote observability backend and changes nothing. */
  const reads = annotations.readRemote();

  // --- list_streams ----------------------------------------------------------
  const listStreams = defineTool({
    name: "list_streams",
    description:
      "List OpenObserve streams (log/trace/metric datasets) for the configured org. Doubles as a connectivity + auth check.",
    input: z.object({ type: streamTypeArg.optional(), profile: profileArg }).strict(),
    inputSchema: schema.object({ type: typeProp, profile: profileProp }),
    annotations: reads,
    handler: async (input) => {
      const streams = await client.listStreams(input.type);
      return ok({
        org: config.org,
        baseUrl: config.baseUrl,
        count: streams.length,
        streams: streams.map((s) => ({ name: s.name, type: s.stream_type ?? null }))
      });
    }
  });

  // --- search_logs -----------------------------------------------------------
  const searchLogs = defineTool({
    name: "search_logs",
    description:
      "Search recent logs with optional filters (service, level, sourceContext, free-text contains) over a time window. Returns newest-first.",
    input: z
      .object({
        service: z.string().min(1).max(256).optional(),
        level: z.string().min(1).max(16).optional(),
        sourceContext: z.string().min(1).max(256).optional(),
        contains: z.string().min(1).max(512).optional(),
        time: timeArg,
        start: instantArg,
        end: instantArg,
        limit: limitArg,
        offset: offsetArg,
        stream: streamArg,
        profile: profileArg
      })
      .strict(),
    inputSchema: schema.object({
      service: schema.string("service_name, e.g. CommunicationHub.Web"),
      level: schema.string(
        "Log level; prefix-matched on `severity`, so INFO/WARN/ERROR/FATAL all work (Information/Warning/...)"
      ),
      sourceContext: schema.string("Serilog SourceContext (emitting class)"),
      contains: schema.string("Substring to match in the message body"),
      time: schema.string("Relative window ending now, e.g. 15m, 1h, 24h, 7d (default 1h)"),
      start: schema.string("Absolute start (ISO 8601 or epoch ms)"),
      end: schema.string("Absolute end (ISO 8601 or epoch ms)"),
      limit: limitProp,
      offset: offsetProp,
      stream: schema.string("Override the configured logs stream"),
      profile: profileProp
    }),
    annotations: reads,
    handler: async (input) => {
      const stream = input.stream ?? config.logStream;
      const window = resolveWindow(input, config, Date.now());
      const size = clampSize(input.limit, config);
      const offset = input.offset ?? 0;
      const sql = buildSearchLogsSql(stream, input, size, config.logColumns);
      const res = await client.search({
        sql,
        startUs: window.startUs,
        endUs: window.endUs,
        from: offset,
        size,
        type: "logs",
        fallbackSelectAll: config.logColumns.length > 0
      });
      const caps = config.fieldCaps[input.profile ?? "compact"];
      return ok({
        stream,
        total: res.total ?? res.hits.length,
        count: res.hits.length,
        offset,
        nextOffset: res.hits.length === size ? offset + size : null,
        tookMs: res.took ?? null,
        logs: res.hits.map((h) => capLog(normalizeLog(h), caps))
      });
    }
  });

  // --- trace_logs ------------------------------------------------------------
  const traceLogs = defineTool({
    name: "trace_logs",
    description:
      "Trace a single request: return ALL log records for a trace id (the X-Correlation-ID / OtelTraceId), ordered chronologically.",
    input: z
      .object({
        traceId: traceIdArg,
        time: timeArg,
        start: instantArg,
        end: instantArg,
        limit: limitArg,
        stream: streamArg,
        profile: profileArg
      })
      .strict(),
    inputSchema: schema.object(
      {
        traceId: schema.string("32-hex OtelTraceId / X-Correlation-ID"),
        time: schema.string("Relative window to search (default 1h)"),
        start: schema.string(),
        end: schema.string(),
        limit: limitProp,
        stream: schema.string(),
        profile: profileProp
      },
      { required: ["traceId"] }
    ),
    annotations: reads,
    handler: async (input) => {
      const stream = input.stream ?? config.logStream;
      const window = resolveWindow(input, config, Date.now());
      const size = clampSize(input.limit, config);
      const sql = buildTraceLogsSql(stream, input.traceId, size, config.logColumns);
      const res = await client.search({
        sql,
        startUs: window.startUs,
        endUs: window.endUs,
        size,
        type: "logs",
        fallbackSelectAll: config.logColumns.length > 0
      });
      const caps = config.fieldCaps[input.profile ?? "compact"];
      return ok({
        stream,
        traceId: input.traceId,
        count: res.hits.length,
        tookMs: res.took ?? null,
        timeline: res.hits.map((h) => capLog(normalizeLog(h), caps))
      });
    }
  });

  // --- get_trace_spans -------------------------------------------------------
  const getTraceSpans = defineTool({
    name: "get_trace_spans",
    description:
      "Return the distributed-trace spans for a trace id from the traces stream (operation, service, duration, status), ordered by start time.",
    input: z
      .object({
        traceId: traceIdArg,
        time: timeArg,
        start: instantArg,
        end: instantArg,
        limit: limitArg,
        stream: streamArg,
        profile: profileArg
      })
      .strict(),
    inputSchema: schema.object(
      {
        traceId: schema.string(),
        time: schema.string("Relative window to search (default 1h)"),
        start: schema.string(),
        end: schema.string(),
        limit: limitProp,
        stream: schema.string("Override the configured traces stream"),
        profile: profileProp
      },
      { required: ["traceId"] }
    ),
    annotations: reads,
    handler: async (input) => {
      const stream = input.stream ?? config.traceStream;
      const window = resolveWindow(input, config, Date.now());
      const size = clampSize(input.limit, config);
      const sql = buildTraceSpansSql(stream, input.traceId, size);
      // Spans live in a traces stream ordered by `start_time`. If no dedicated
      // traces stream is configured, this falls back to the logs stream — which
      // has no `start_time` column, so the query errors / returns nothing. Warn.
      const warning =
        !input.stream && !config.traceStreamConfigured
          ? "No traces stream configured (OBSERVE_TRACE_STREAM is unset), so spans are being queried against the logs stream — this may error or return nothing. Set OBSERVE_TRACE_STREAM to your traces stream, or pass `stream` explicitly."
          : null;
      const res = await client.search({
        sql,
        startUs: window.startUs,
        endUs: window.endUs,
        size,
        type: "traces"
      });
      return ok({
        stream,
        traceId: input.traceId,
        warning,
        count: res.hits.length,
        tookMs: res.took ?? null,
        spans: res.hits.map(normalizeSpan)
      });
    }
  });

  // --- tail_logs -------------------------------------------------------------
  const tailLogs = defineTool({
    name: "tail_logs",
    description:
      "Convenience: the most recent logs over the last N minutes (default 15), optionally filtered by level/service.",
    input: z
      .object({
        service: z.string().min(1).max(256).optional(),
        level: z.string().min(1).max(16).optional(),
        minutes: z.number().int().positive().max(1440).optional(),
        limit: limitArg,
        stream: streamArg,
        profile: profileArg
      })
      .strict(),
    inputSchema: schema.object({
      service: schema.string(),
      level: schema.string(),
      minutes: schema.number("Lookback minutes (default 15, max 1440)"),
      limit: limitProp,
      stream: schema.string(),
      profile: profileProp
    }),
    annotations: reads,
    handler: async (input) => {
      const stream = input.stream ?? config.logStream;
      const minutes = input.minutes ?? 15;
      const window = resolveWindow({ time: `${minutes}m` }, config, Date.now());
      const size = clampSize(input.limit, config);
      const sql = buildSearchLogsSql(
        stream,
        { service: input.service, level: input.level },
        size,
        config.logColumns
      );
      const res = await client.search({
        sql,
        startUs: window.startUs,
        endUs: window.endUs,
        size,
        type: "logs",
        fallbackSelectAll: config.logColumns.length > 0
      });
      const caps = config.fieldCaps[input.profile ?? "compact"];
      return ok({
        stream,
        minutes,
        count: res.hits.length,
        logs: res.hits.map((h) => capLog(normalizeLog(h), caps))
      });
    }
  });

  // --- log_stats -------------------------------------------------------------
  const logStats = defineTool({
    name: "log_stats",
    description:
      "Aggregate log counts grouped by level (default), service, or sourceContext over a time window — an error/warning summary.",
    input: z
      .object({
        groupBy: z.enum(["level", "service", "sourceContext"]).optional(),
        time: timeArg,
        start: instantArg,
        end: instantArg,
        limit: z.number().int().positive().max(500).optional(),
        stream: streamArg,
        profile: profileArg
      })
      .strict(),
    inputSchema: schema.object({
      groupBy: schema.enumOf(["level", "service", "sourceContext"]),
      time: schema.string("Relative window (default 1h)"),
      start: schema.string(),
      end: schema.string(),
      limit: limitProp,
      stream: schema.string(),
      profile: profileProp
    }),
    annotations: reads,
    handler: async (input) => {
      const stream = input.stream ?? config.logStream;
      const window = resolveWindow(input, config, Date.now());
      const size = clampSize(input.limit ?? 100, config);
      const column =
        input.groupBy === "service"
          ? "service_name"
          : input.groupBy === "sourceContext"
            ? "instrumentation_library_name"
            : "severity";
      const sql = buildLogStatsSql(stream, column, size);
      const res = await client.search({
        sql,
        startUs: window.startUs,
        endUs: window.endUs,
        size,
        type: "logs"
      });
      return ok({ stream, groupBy: column, tookMs: res.took ?? null, buckets: res.hits });
    }
  });

  // --- run_observe_query -----------------------------------------------------
  const runQuerySchema = z
    .object({
      sql: z.string().min(1).max(8192),
      type: streamTypeArg.optional(),
      time: timeArg,
      start: instantArg,
      end: instantArg,
      size: z.number().int().positive().optional(),
      offset: offsetArg,
      profile: profileArg
    })
    .strict();

  const runObserveQuery = defineTool({
    name: "run_observe_query",
    description:
      "Escape hatch: run a raw read-only OpenObserve SQL query (SELECT/WITH only) against a stream within a mandatory time window.",
    input: runQuerySchema,
    inputSchema: schema.object(
      {
        sql: schema.string('e.g. SELECT * FROM "wecrm_dev" WHERE severity_text = \'ERROR\''),
        type: typeProp,
        time: schema.string("Relative window (default 1h)"),
        start: schema.string(),
        end: schema.string(),
        size: limitProp,
        offset: offsetProp,
        profile: profileProp
      },
      { required: ["sql"] }
    ),
    annotations: reads,
    /**
     * The only rawResult tool in this server, for one specific reason: its SQL
     * guardrail rejection renders at the CALLER's profile (defaulting to
     * verbose), while every other failure here is always verbose. Routing it
     * through `formatError` would flatten that distinction and silently
     * pretty-print rejections that are currently minified at nano/compact/
     * standard — a byte-level contract change no schema can reveal. Verified
     * against the pre-migration server at all four profiles.
     */
    rawResult: true,
    handler: async (input) => ok(raw(await runObserveQueryImpl(input)))
  });

  async function runObserveQueryImpl(args: z.infer<typeof runQuerySchema>): Promise<CallToolResult> {
    const guard = validateReadOnlySql(args.sql);
    if (!guard.ok) {
      return asErrorProfiled(guard.error, args.profile ?? "verbose");
    }
    const window = resolveWindow(args, config, Date.now());
    const size = clampSize(args.size, config);
    const offset = args.offset ?? 0;
    const res = await client.search({
      sql: guard.sanitizedSql,
      startUs: window.startUs,
      endUs: window.endUs,
      from: offset,
      size,
      type: args.type
    });
    return asTextProfiled(
      {
        total: res.total ?? res.hits.length,
        count: res.hits.length,
        offset,
        nextOffset: res.hits.length === size ? offset + size : null,
        tookMs: res.took ?? null,
        scanSize: res.scan_size ?? null,
        hits: res.hits
      },
      args.profile
    );
  }

  // --- describe_stream -------------------------------------------------------
  const describeStream = defineTool({
    name: "describe_stream",
    description:
      "Discover the fields of a stream by sampling recent rows (no fixed schema assumptions). Returns each field with its observed JSON types and how many sampled rows had a non-null value.",
    input: z
      .object({
        stream: streamArg,
        type: streamTypeArg.optional(),
        sample: z.number().int().positive().max(50).optional(),
        time: timeArg,
        start: instantArg,
        end: instantArg,
        profile: profileArg
      })
      .strict(),
    inputSchema: schema.object({
      stream: schema.string("Stream to inspect (default: the configured logs stream)"),
      type: typeProp,
      sample: schema.number("Rows to sample for field discovery (default 5, max 50)"),
      time: schema.string("Relative window to sample from (default 1h)"),
      start: schema.string(),
      end: schema.string(),
      profile: profileProp
    }),
    annotations: reads,
    handler: async (input) => {
      const stream = input.stream ?? config.logStream;
      const window = resolveWindow(input, config, Date.now());
      const sample = input.sample ?? 5;
      const sql = buildSampleSql(stream, sample);
      const res = await client.search({
        sql,
        startUs: window.startUs,
        endUs: window.endUs,
        size: sample,
        type: input.type
      });
      const fields = describeFields(res.hits);
      return ok({
        stream,
        type: input.type ?? null,
        sampled: res.hits.length,
        fieldCount: fields.length,
        fields
      });
    }
  });

  // Registration order is the order `tools/list` advertises, unchanged from the
  // hand-written array it replaced.
  return [
    listStreams,
    searchLogs,
    traceLogs,
    getTraceSpans,
    tailLogs,
    logStats,
    runObserveQuery,
    describeStream
  ];
}
