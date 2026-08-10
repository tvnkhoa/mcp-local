/**
 * observe-mcp's tool table, declared as data (migration-plan step S-25).
 *
 * What used to be a `ListTools` array plus a hand-written `switch` in `index.ts`
 * is now a set of `defineTool` declarations. The shared pipeline in `@mcp/sdk`
 * supplies resolve → profile → validate → guards → handle → serialize; what
 * stays local is this server's own contract — the exact descriptions and JSON
 * Schemas, the SQL guardrail, and the `{ code, message, detail? }` error
 * envelope injected through `formatError`.
 *
 * The JSON Schemas are written out rather than generated from the zod schemas:
 * `contracts/observe-mcp.json` is a committed contract, and a generator would be
 * free to drift it. `schema.*` only removes boilerplate.
 *
 * Every tool except `list_environments` takes an optional `environment` and
 * resolves its client through `ClientManager`, and every response echoes the
 * environment that answered — including when the argument was omitted. Without
 * that echo a caller cannot tell dev from prod in a payload.
 *
 * All handlers return a plain payload and let dispatch serialize it, except
 * `run_observe_query`, which is documented at its declaration.
 */

import { ok } from "@mcp/core";
import type { AnyToolDefinition, ToolCallResult } from "@mcp/sdk";
import { annotations, defineTool, registerTool, schema } from "@mcp/sdk";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import type { ObserveLimits } from "../config/index.js";
import { isPlatformError } from "@mcp/core";
import { validateReadOnlySql } from "../middleware/sqlGuardrails.js";
import { mapError, type MappedError } from "../middleware/errors.js";
import { normalizeLog, normalizeSpan, capLog, describeFields } from "../services/logParser.js";
import type { ClientManager } from "../services/clientManager.js";
import { isMissingColumnError } from "../services/observeClient.js";
import {
  resolveWindow,
  clampSize,
  buildSearchLogsSql,
  buildTraceLogsSql,
  buildTraceSpansSql,
  buildLogStatsSql,
  buildSampleSql,
  type TraceIdColumn
} from "../services/queryBuilder.js";
import { asText as asTextProfiled, asError as asErrorProfiled } from "../middleware/responseFormatter.js";

import { buildDiscoveryTools } from "./discovery.js";
import {
  envProp,
  environmentArg,
  instantArg,
  limitArg,
  limitProp,
  offsetArg,
  offsetProp,
  profileArg,
  profileProp,
  streamArg,
  streamTypeArg,
  timeArg,
  traceIdArg,
  typeProp
} from "./common.js";

/**
 * `mapError`, plus the refusals dispatch itself raises. Re-declared here rather
 * than imported so `tools/index.ts` is the single place `index.ts` and the tests
 * wire their error contract from.
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

export function buildTools(limits: ObserveLimits, clients: ClientManager): readonly AnyToolDefinition[] {
  /** Every tool that reaches OpenObserve reads a remote backend and changes nothing. */
  const reads = annotations.readRemote();

  // --- list_environments -----------------------------------------------------
  const listEnvironments = defineTool({
    name: "list_environments",
    description:
      "List the configured OpenObserve environments (org, log/trace stream, and which one answers by default). Call this first when you do not know which environment names exist.",
    input: z.object({ profile: profileArg }).strict(),
    inputSchema: schema.object({ profile: profileProp }),
    // The only tool here that touches no network — it reports resolved config, so
    // openWorld is false. Everything else is `readRemote`.
    annotations: annotations.read(),
    handler: () =>
      ok({
        defaultEnvironment: clients.defaultEnvironment,
        count: clients.list().length,
        environments: clients.list()
      })
  });

  // --- list_streams ----------------------------------------------------------
  const listStreams = defineTool({
    name: "list_streams",
    description:
      "List OpenObserve streams (log/trace/metric datasets) for the configured org. Doubles as a connectivity + auth check.",
    input: z.object({ type: streamTypeArg.optional(), environment: environmentArg, profile: profileArg }).strict(),
    inputSchema: schema.object({ type: typeProp, environment: envProp, profile: profileProp }),
    annotations: reads,
    handler: async (input) => {
      const env = clients.getEnvironment(input.environment);
      const streams = await clients.getClient(input.environment).listStreams(input.type);
      return ok({
        environment: env.name,
        org: env.org,
        baseUrl: env.baseUrl,
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
        environment: environmentArg,
        profile: profileArg
      })
      .strict(),
    inputSchema: schema.object({
      service: schema.string("service_name, e.g. CRM.Gateway — use discover_services to list them"),
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
      environment: envProp,
      profile: profileProp
    }),
    annotations: reads,
    handler: async (input) => {
      const env = clients.getEnvironment(input.environment);
      const stream = input.stream ?? env.logStream;
      const window = resolveWindow(input, limits, Date.now());
      const size = clampSize(input.limit, limits);
      const offset = input.offset ?? 0;
      const sql = buildSearchLogsSql(stream, input, size, limits.logColumns);
      const res = await clients.getClient(input.environment).search({
        sql,
        startUs: window.startUs,
        endUs: window.endUs,
        from: offset,
        size,
        type: "logs",
        fallbackSelectAll: limits.logColumns.length > 0
      });
      const caps = limits.fieldCaps[input.profile ?? "compact"];
      return ok({
        environment: env.name,
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
        environment: environmentArg,
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
        environment: envProp,
        profile: profileProp
      },
      { required: ["traceId"] }
    ),
    annotations: reads,
    handler: async (input) => {
      const env = clients.getEnvironment(input.environment);
      const stream = input.stream ?? env.logStream;
      const window = resolveWindow(input, limits, Date.now());
      const size = clampSize(input.limit, limits);
      const sql = buildTraceLogsSql(stream, input.traceId, size, limits.logColumns);
      const res = await clients.getClient(input.environment).search({
        sql,
        startUs: window.startUs,
        endUs: window.endUs,
        size,
        type: "logs",
        fallbackSelectAll: limits.logColumns.length > 0
      });
      const caps = limits.fieldCaps[input.profile ?? "compact"];
      return ok({
        environment: env.name,
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
        environment: environmentArg,
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
        environment: envProp,
        profile: profileProp
      },
      { required: ["traceId"] }
    ),
    annotations: reads,
    handler: async (input) => {
      const env = clients.getEnvironment(input.environment);
      const stream = input.stream ?? env.traceStream;
      const window = resolveWindow(input, limits, Date.now());
      const size = clampSize(input.limit, limits);
      // Spans live in a traces stream ordered by `start_time`. With no dedicated
      // traces stream configured this reuses the logs stream NAME — which usually
      // works, because the search call passes `type: "traces"` and OpenObserve
      // resolves a stream name within its type: both shipped environments have
      // traceStream === logStream and return tens of millions of spans. So the
      // warning is decided AFTER the query, from an empty result, rather than
      // asserted up front from config — the old unconditional version fired on
      // every call in exactly the deployments this server targets.
      const usingLogsStreamName = !input.stream && !env.traceStreamConfigured;

      const client = clients.getClient(input.environment);
      const runSpans = (traceIdColumn: TraceIdColumn) =>
        client.search({
          sql: buildTraceSpansSql(stream, input.traceId, size, traceIdColumn),
          startUs: window.startUs,
          endUs: window.endUs,
          size,
          type: "traces"
        });

      // A traces stream names its trace id `trace_id` (OTel) or `traceid`, never
      // both, and referencing the absent one fails the query at plan time rather
      // than simply matching nothing. So try the standard column and fall back
      // once, instead of ORing them and breaking on every stream that has only one.
      //
      // The FIRST error is what gets reported if the retry also fails. The
      // missing-column test is deliberately broad (any 400 naming a column, field
      // or schema), so it also catches "No field named start_time" — the real
      // failure when this ran against a stream that holds no spans. Surfacing the
      // retry's "No field named traceid" instead would point at the wrong column.
      let res;
      try {
        res = await runSpans("trace_id");
      } catch (error) {
        if (!isMissingColumnError(error)) {
          throw error;
        }
        try {
          res = await runSpans("traceid");
        } catch {
          throw error;
        }
      }

      const warning =
        usingLogsStreamName && res.hits.length === 0
          ? `No traces stream is configured for environment '${env.name}', so spans were queried against "${stream}" — the logs stream name — and nothing matched. That name usually also resolves as a traces stream; when it does not, set a traceStream for the environment or pass \`stream\` explicitly.`
          : null;

      return ok({
        environment: env.name,
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
        environment: environmentArg,
        profile: profileArg
      })
      .strict(),
    inputSchema: schema.object({
      service: schema.string(),
      level: schema.string(),
      minutes: schema.number("Lookback minutes (default 15, max 1440)"),
      limit: limitProp,
      stream: schema.string(),
      environment: envProp,
      profile: profileProp
    }),
    annotations: reads,
    handler: async (input) => {
      const env = clients.getEnvironment(input.environment);
      const stream = input.stream ?? env.logStream;
      const minutes = input.minutes ?? 15;
      const window = resolveWindow({ time: `${minutes}m` }, limits, Date.now());
      const size = clampSize(input.limit, limits);
      const sql = buildSearchLogsSql(
        stream,
        { service: input.service, level: input.level },
        size,
        limits.logColumns
      );
      const res = await clients.getClient(input.environment).search({
        sql,
        startUs: window.startUs,
        endUs: window.endUs,
        size,
        type: "logs",
        fallbackSelectAll: limits.logColumns.length > 0
      });
      const caps = limits.fieldCaps[input.profile ?? "compact"];
      return ok({
        environment: env.name,
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
        environment: environmentArg,
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
      environment: envProp,
      profile: profileProp
    }),
    annotations: reads,
    handler: async (input) => {
      const env = clients.getEnvironment(input.environment);
      const stream = input.stream ?? env.logStream;
      const window = resolveWindow(input, limits, Date.now());
      const size = clampSize(input.limit ?? 100, limits);
      const column =
        input.groupBy === "service"
          ? "service_name"
          : input.groupBy === "sourceContext"
            ? "instrumentation_library_name"
            : "severity";
      const sql = buildLogStatsSql(stream, column, size);
      const res = await clients.getClient(input.environment).search({
        sql,
        startUs: window.startUs,
        endUs: window.endUs,
        size,
        type: "logs"
      });
      return ok({ environment: env.name, stream, groupBy: column, tookMs: res.took ?? null, buckets: res.hits });
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
      environment: environmentArg,
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
        sql: schema.string('e.g. SELECT * FROM "my_stream" WHERE severity_text = \'ERROR\''),
        type: typeProp,
        time: schema.string("Relative window (default 1h)"),
        start: schema.string(),
        end: schema.string(),
        size: limitProp,
        offset: offsetProp,
        environment: envProp,
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
    const env = clients.getEnvironment(args.environment);
    const window = resolveWindow(args, limits, Date.now());
    const size = clampSize(args.size, limits);
    const offset = args.offset ?? 0;
    const res = await clients.getClient(args.environment).search({
      sql: guard.sanitizedSql,
      startUs: window.startUs,
      endUs: window.endUs,
      from: offset,
      size,
      type: args.type
    });
    return asTextProfiled(
      {
        environment: env.name,
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
        environment: environmentArg,
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
      environment: envProp,
      profile: profileProp
    }),
    annotations: reads,
    handler: async (input) => {
      const env = clients.getEnvironment(input.environment);
      const stream = input.stream ?? env.logStream;
      const window = resolveWindow(input, limits, Date.now());
      const sample = input.sample ?? 5;
      const sql = buildSampleSql(stream, sample);
      const res = await clients.getClient(input.environment).search({
        sql,
        startUs: window.startUs,
        endUs: window.endUs,
        size: sample,
        type: input.type
      });
      const fields = describeFields(res.hits);
      return ok({
        environment: env.name,
        stream,
        type: input.type ?? null,
        sampled: res.hits.length,
        fieldCount: fields.length,
        fields
      });
    }
  });

  // Order is the order `tools/list` advertises. `registerTool` only flattens and
  // rejects a duplicate name; it does not reorder. New tools are appended so the
  // eight original positions are unchanged.
  return registerTool([
    listStreams,
    searchLogs,
    traceLogs,
    getTraceSpans,
    tailLogs,
    logStats,
    runObserveQuery,
    describeStream,
    listEnvironments,
    ...buildDiscoveryTools(limits, clients)
  ]);
}
