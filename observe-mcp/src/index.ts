import process from "node:process";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ErrorCode,
  type CallToolResult
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { loadConfig, describeConfig, type ObserveConfig } from "./config/index.js";
import { mapError } from "./errors.js";
import { ObserveClient, type StreamType } from "./observeClient.js";
import { normalizeLog, normalizeSpan, capLog } from "./logParser.js";
import {
  asText as asTextProfiled,
  asError as asErrorProfiled,
  responseProfileSchema
} from "./response/responseFormatter.js";
import {
  resolveWindow,
  clampSize,
  buildSearchLogsSql,
  buildTraceLogsSql,
  buildTraceSpansSql,
  buildLogStatsSql,
  buildSampleSql
} from "./queryBuilder.js";
import { validateReadOnlySql } from "./guardrails/sqlGuardrails.js";

const config: ObserveConfig = loadConfig();
const client = new ObserveClient(config);

// --- shared zod fragments -------------------------------------------------
const profileArg = responseProfileSchema.optional();
const offsetArg = z.number().int().min(0).optional();
const timeArg = z.string().min(1).max(32).optional();
const instantArg = z.string().min(1).max(64).optional();
const traceIdArg = z.string().min(8).max(64);
const streamTypeArg = z.enum(["logs", "traces", "metrics"]);

// --- per-tool schemas -----------------------------------------------------
const listStreamsSchema = z.object({
  type: streamTypeArg.optional(),
  profile: profileArg
}).strict();

const searchLogsSchema = z.object({
  service: z.string().min(1).max(256).optional(),
  level: z.string().min(1).max(16).optional(),
  sourceContext: z.string().min(1).max(256).optional(),
  contains: z.string().min(1).max(512).optional(),
  time: timeArg,
  start: instantArg,
  end: instantArg,
  limit: z.number().int().positive().optional(),
  offset: offsetArg,
  stream: z.string().min(1).max(256).optional(),
  profile: profileArg
}).strict();

const traceLogsSchema = z.object({
  traceId: traceIdArg,
  time: timeArg,
  start: instantArg,
  end: instantArg,
  limit: z.number().int().positive().optional(),
  stream: z.string().min(1).max(256).optional(),
  profile: profileArg
}).strict();

const traceSpansSchema = z.object({
  traceId: traceIdArg,
  time: timeArg,
  start: instantArg,
  end: instantArg,
  limit: z.number().int().positive().optional(),
  stream: z.string().min(1).max(256).optional(),
  profile: profileArg
}).strict();

const tailLogsSchema = z.object({
  service: z.string().min(1).max(256).optional(),
  level: z.string().min(1).max(16).optional(),
  minutes: z.number().int().positive().max(1440).optional(),
  limit: z.number().int().positive().optional(),
  stream: z.string().min(1).max(256).optional(),
  profile: profileArg
}).strict();

const logStatsSchema = z.object({
  groupBy: z.enum(["level", "service", "sourceContext"]).optional(),
  time: timeArg,
  start: instantArg,
  end: instantArg,
  limit: z.number().int().positive().max(500).optional(),
  stream: z.string().min(1).max(256).optional(),
  profile: profileArg
}).strict();

const runQuerySchema = z.object({
  sql: z.string().min(1).max(8192),
  type: streamTypeArg.optional(),
  time: timeArg,
  start: instantArg,
  end: instantArg,
  size: z.number().int().positive().optional(),
  offset: offsetArg,
  profile: profileArg
}).strict();

const describeStreamSchema = z.object({
  stream: z.string().min(1).max(256).optional(),
  type: streamTypeArg.optional(),
  sample: z.number().int().positive().max(50).optional(),
  time: timeArg,
  start: instantArg,
  end: instantArg,
  profile: profileArg
}).strict();

// --- server ---------------------------------------------------------------
const server = new Server(
  { name: "communicationhub-observe-mcp", version: "0.1.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "list_streams",
      description:
        "List OpenObserve streams (log/trace/metric datasets) for the configured org. Doubles as a connectivity + auth check.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          type: { type: "string", enum: ["logs", "traces", "metrics"] },
          profile: { type: "string", enum: ["nano", "compact", "standard", "verbose"] }
        }
      }
    },
    {
      name: "search_logs",
      description:
        "Search recent logs with optional filters (service, level, sourceContext, free-text contains) over a time window. Returns newest-first.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          service: { type: "string", description: "service_name, e.g. CommunicationHub.Web" },
          level: { type: "string", description: "Log level; prefix-matched on `severity`, so INFO/WARN/ERROR/FATAL all work (Information/Warning/...)" },
          sourceContext: { type: "string", description: "Serilog SourceContext (emitting class)" },
          contains: { type: "string", description: "Substring to match in the message body" },
          time: { type: "string", description: "Relative window ending now, e.g. 15m, 1h, 24h, 7d (default 1h)" },
          start: { type: "string", description: "Absolute start (ISO 8601 or epoch ms)" },
          end: { type: "string", description: "Absolute end (ISO 8601 or epoch ms)" },
          limit: { type: "number" },
          offset: { type: "number", description: "Row offset for pagination (default 0); use the returned nextOffset to page" },
          stream: { type: "string", description: "Override the configured logs stream" },
          profile: { type: "string", enum: ["nano", "compact", "standard", "verbose"] }
        }
      }
    },
    {
      name: "trace_logs",
      description:
        "Trace a single request: return ALL log records for a trace id (the X-Correlation-ID / OtelTraceId), ordered chronologically.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["traceId"],
        properties: {
          traceId: { type: "string", description: "32-hex OtelTraceId / X-Correlation-ID" },
          time: { type: "string", description: "Relative window to search (default 1h)" },
          start: { type: "string" },
          end: { type: "string" },
          limit: { type: "number" },
          stream: { type: "string" },
          profile: { type: "string", enum: ["nano", "compact", "standard", "verbose"] }
        }
      }
    },
    {
      name: "get_trace_spans",
      description:
        "Return the distributed-trace spans for a trace id from the traces stream (operation, service, duration, status), ordered by start time.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["traceId"],
        properties: {
          traceId: { type: "string" },
          time: { type: "string", description: "Relative window to search (default 1h)" },
          start: { type: "string" },
          end: { type: "string" },
          limit: { type: "number" },
          stream: { type: "string", description: "Override the configured traces stream" },
          profile: { type: "string", enum: ["nano", "compact", "standard", "verbose"] }
        }
      }
    },
    {
      name: "tail_logs",
      description: "Convenience: the most recent logs over the last N minutes (default 15), optionally filtered by level/service.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          service: { type: "string" },
          level: { type: "string" },
          minutes: { type: "number", description: "Lookback minutes (default 15, max 1440)" },
          limit: { type: "number" },
          stream: { type: "string" },
          profile: { type: "string", enum: ["nano", "compact", "standard", "verbose"] }
        }
      }
    },
    {
      name: "log_stats",
      description: "Aggregate log counts grouped by level (default), service, or sourceContext over a time window — an error/warning summary.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          groupBy: { type: "string", enum: ["level", "service", "sourceContext"] },
          time: { type: "string", description: "Relative window (default 1h)" },
          start: { type: "string" },
          end: { type: "string" },
          limit: { type: "number" },
          stream: { type: "string" },
          profile: { type: "string", enum: ["nano", "compact", "standard", "verbose"] }
        }
      }
    },
    {
      name: "run_observe_query",
      description:
        "Escape hatch: run a raw read-only OpenObserve SQL query (SELECT/WITH only) against a stream within a mandatory time window.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["sql"],
        properties: {
          sql: { type: "string", description: 'e.g. SELECT * FROM "wecrm_dev" WHERE severity_text = \'ERROR\'' },
          type: { type: "string", enum: ["logs", "traces", "metrics"] },
          time: { type: "string", description: "Relative window (default 1h)" },
          start: { type: "string" },
          end: { type: "string" },
          size: { type: "number" },
          offset: { type: "number", description: "Row offset for pagination (default 0); use the returned nextOffset to page" },
          profile: { type: "string", enum: ["nano", "compact", "standard", "verbose"] }
        }
      }
    },
    {
      name: "describe_stream",
      description:
        "Discover the fields of a stream by sampling recent rows (no fixed schema assumptions). Returns each field with its observed JSON types and how many sampled rows had a non-null value.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          stream: { type: "string", description: "Stream to inspect (default: the configured logs stream)" },
          type: { type: "string", enum: ["logs", "traces", "metrics"] },
          sample: { type: "number", description: "Rows to sample for field discovery (default 5, max 50)" },
          time: { type: "string", description: "Relative window to sample from (default 1h)" },
          start: { type: "string" },
          end: { type: "string" },
          profile: { type: "string", enum: ["nano", "compact", "standard", "verbose"] }
        }
      }
    }
  ]
}));

server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
  const nowMs = Date.now();
  try {
    switch (request.params.name) {
      case "list_streams": {
        const args = listStreamsSchema.parse(request.params.arguments ?? {});
        const streams = await client.listStreams(args.type);
        return asTextProfiled(
          {
            org: config.org,
            baseUrl: config.baseUrl,
            count: streams.length,
            streams: streams.map((s) => ({ name: s.name, type: s.stream_type ?? null }))
          },
          args.profile
        );
      }

      case "search_logs": {
        const args = searchLogsSchema.parse(request.params.arguments ?? {});
        const stream = args.stream ?? config.logStream;
        const window = resolveWindow(args, config, nowMs);
        const size = clampSize(args.limit, config);
        const offset = args.offset ?? 0;
        const sql = buildSearchLogsSql(stream, args, size, config.logColumns);
        const res = await client.search({ sql, startUs: window.startUs, endUs: window.endUs, from: offset, size, type: "logs", fallbackSelectAll: config.logColumns.length > 0 });
        const caps = config.fieldCaps[args.profile ?? "compact"];
        return asTextProfiled(
          {
            stream,
            total: res.total ?? res.hits.length,
            count: res.hits.length,
            offset,
            nextOffset: res.hits.length === size ? offset + size : null,
            tookMs: res.took ?? null,
            logs: res.hits.map((h) => capLog(normalizeLog(h), caps))
          },
          args.profile
        );
      }

      case "trace_logs": {
        const args = traceLogsSchema.parse(request.params.arguments ?? {});
        const stream = args.stream ?? config.logStream;
        const window = resolveWindow(args, config, nowMs);
        const size = clampSize(args.limit, config);
        const sql = buildTraceLogsSql(stream, args.traceId, size, config.logColumns);
        const res = await client.search({ sql, startUs: window.startUs, endUs: window.endUs, size, type: "logs", fallbackSelectAll: config.logColumns.length > 0 });
        const caps = config.fieldCaps[args.profile ?? "compact"];
        return asTextProfiled(
          {
            stream,
            traceId: args.traceId,
            count: res.hits.length,
            tookMs: res.took ?? null,
            timeline: res.hits.map((h) => capLog(normalizeLog(h), caps))
          },
          args.profile
        );
      }

      case "get_trace_spans": {
        const args = traceSpansSchema.parse(request.params.arguments ?? {});
        const stream = args.stream ?? config.traceStream;
        const window = resolveWindow(args, config, nowMs);
        const size = clampSize(args.limit, config);
        const sql = buildTraceSpansSql(stream, args.traceId, size);
        // Spans live in a traces stream ordered by `start_time`. If no dedicated
        // traces stream is configured, this falls back to the logs stream — which
        // has no `start_time` column, so the query errors / returns nothing. Warn.
        const warning = !args.stream && !config.traceStreamConfigured
          ? "No traces stream configured (OBSERVE_TRACE_STREAM is unset), so spans are being queried against the logs stream — this may error or return nothing. Set OBSERVE_TRACE_STREAM to your traces stream, or pass `stream` explicitly."
          : null;
        const res = await client.search({ sql, startUs: window.startUs, endUs: window.endUs, size, type: "traces" });
        return asTextProfiled(
          {
            stream,
            traceId: args.traceId,
            warning,
            count: res.hits.length,
            tookMs: res.took ?? null,
            spans: res.hits.map(normalizeSpan)
          },
          args.profile
        );
      }

      case "tail_logs": {
        const args = tailLogsSchema.parse(request.params.arguments ?? {});
        const stream = args.stream ?? config.logStream;
        const minutes = args.minutes ?? 15;
        const window = resolveWindow({ time: `${minutes}m` }, config, nowMs);
        const size = clampSize(args.limit, config);
        const sql = buildSearchLogsSql(stream, { service: args.service, level: args.level }, size, config.logColumns);
        const res = await client.search({ sql, startUs: window.startUs, endUs: window.endUs, size, type: "logs", fallbackSelectAll: config.logColumns.length > 0 });
        const caps = config.fieldCaps[args.profile ?? "compact"];
        return asTextProfiled(
          {
            stream,
            minutes,
            count: res.hits.length,
            logs: res.hits.map((h) => capLog(normalizeLog(h), caps))
          },
          args.profile
        );
      }

      case "log_stats": {
        const args = logStatsSchema.parse(request.params.arguments ?? {});
        const stream = args.stream ?? config.logStream;
        const window = resolveWindow(args, config, nowMs);
        const size = clampSize(args.limit ?? 100, config);
        const column = args.groupBy === "service"
          ? "service_name"
          : args.groupBy === "sourceContext"
            ? "instrumentation_library_name"
            : "severity";
        const sql = buildLogStatsSql(stream, column, size);
        const res = await client.search({ sql, startUs: window.startUs, endUs: window.endUs, size, type: "logs" });
        return asTextProfiled(
          {
            stream,
            groupBy: column,
            tookMs: res.took ?? null,
            buckets: res.hits
          },
          args.profile
        );
      }

      case "run_observe_query": {
        const args = runQuerySchema.parse(request.params.arguments ?? {});
        const guard = validateReadOnlySql(args.sql);
        if (!guard.ok) {
          return asErrorProfiled(guard.error, args.profile ?? "verbose");
        }
        const window = resolveWindow(args, config, nowMs);
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

      case "describe_stream": {
        const args = describeStreamSchema.parse(request.params.arguments ?? {});
        const stream = args.stream ?? config.logStream;
        const window = resolveWindow(args, config, nowMs);
        const sample = args.sample ?? 5;
        const sql = buildSampleSql(stream, sample);
        const res = await client.search({ sql, startUs: window.startUs, endUs: window.endUs, size: sample, type: args.type });
        const fields = describeFields(res.hits);
        return asTextProfiled(
          {
            stream,
            type: args.type ?? null,
            sampled: res.hits.length,
            fieldCount: fields.length,
            fields
          },
          args.profile
        );
      }

      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${request.params.name}`);
    }
  } catch (error) {
    return asErrorProfiled(mapError(error), "verbose");
  }
});

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

function logInfo(event: string, detail: Record<string, unknown>): void {
  console.error(JSON.stringify({ level: "info", event, ...detail }));
}
function logError(event: string, detail: Record<string, unknown>): void {
  console.error(JSON.stringify({ level: "error", event, ...detail }));
}

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logInfo("server_started", { config: describeConfig(config) });
}

main().catch((error) => {
  logError("server_crashed", { error: mapError(error) });
  process.exit(1);
});
