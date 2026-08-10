import type { ObserveLimits } from "../config/index.js";
import { PolicyViolationError } from "../middleware/errors.js";

export type TimeWindow = {
  startUs: number;
  endUs: number;
};

const RELATIVE_RE = /^(\d+)\s*(s|m|h|d)$/i;
const UNIT_MS: Record<string, number> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000
};

/**
 * Resolve a time window (microseconds) from optional relative/absolute inputs.
 *
 * - `time` (relative, e.g. "15m", "1h", "24h", "7d") sets a lookback ending now.
 * - `start` + `end` (ISO 8601 or epoch ms) set an explicit window.
 * - Nothing → default lookback ending now.
 *
 * `nowMs` is injected so callers control "now" (SDK scripts forbid Date.now(); the
 * server passes Date.now() at call time). The span is capped at maxLookbackMs.
 */
export function resolveWindow(
  opts: { time?: string; start?: string; end?: string },
  config: ObserveLimits,
  nowMs: number
): TimeWindow {
  let startMs: number;
  let endMs: number;

  if (opts.start !== undefined || opts.end !== undefined) {
    endMs = opts.end !== undefined ? parseInstantMs(opts.end, "end") : nowMs;
    startMs = opts.start !== undefined ? parseInstantMs(opts.start, "start") : endMs - config.defaultLookbackMs;
  } else if (opts.time !== undefined && opts.time.trim() !== "") {
    const lookbackMs = parseRelativeMs(opts.time);
    endMs = nowMs;
    startMs = nowMs - lookbackMs;
  } else {
    endMs = nowMs;
    startMs = nowMs - config.defaultLookbackMs;
  }

  if (endMs <= startMs) {
    throw new PolicyViolationError("validation_error", "Time window end must be after start.");
  }
  if (endMs - startMs > config.maxLookbackMs) {
    throw new PolicyViolationError(
      "validation_error",
      `Time window exceeds the maximum lookback of ${config.maxLookbackMs} ms. Narrow the range.`
    );
  }

  return { startUs: Math.floor(startMs * 1000), endUs: Math.floor(endMs * 1000) };
}

function parseRelativeMs(input: string): number {
  const match = RELATIVE_RE.exec(input.trim());
  if (!match) {
    throw new PolicyViolationError(
      "validation_error",
      `Invalid relative time "${input}". Use forms like "15m", "1h", "24h", "7d".`
    );
  }
  const value = Number(match[1]);
  const unit = match[2].toLowerCase();
  const ms = value * UNIT_MS[unit];
  if (ms <= 0) {
    throw new PolicyViolationError("validation_error", `Relative time must be positive: "${input}".`);
  }
  return ms;
}

function parseInstantMs(input: string, label: string): number {
  const trimmed = input.trim();
  if (/^\d+$/.test(trimmed)) {
    // Bare number = epoch milliseconds.
    return Number(trimmed);
  }
  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) {
    throw new PolicyViolationError(
      "validation_error",
      `Invalid ${label} time "${input}". Use ISO 8601 (e.g. 2026-07-03T10:00:00Z) or epoch milliseconds.`
    );
  }
  return parsed;
}

/** Clamp a requested size into [1, maxSize], falling back to the default. */
export function clampSize(requested: number | undefined, config: ObserveLimits): number {
  if (requested === undefined || !Number.isFinite(requested)) {
    return config.defaultSize;
  }
  return Math.min(Math.max(1, Math.floor(requested)), config.maxSize);
}

/** Escape a single-quoted SQL string literal (doubling embedded quotes). */
export function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** Quote a stream/identifier for the FROM clause; reject anything unsafe. */
export function sqlIdent(name: string): string {
  if (!/^[A-Za-z0-9_.-]+$/.test(name)) {
    throw new PolicyViolationError("validation_error", `Unsafe stream/identifier name: "${name}".`);
  }
  return `"${name}"`;
}

/**
 * A trace id is a hex string (OTel = 32 hex chars; tolerate 16-64). Reject
 * anything else so it can be embedded in SQL without injection risk.
 */
export function assertTraceId(traceId: string): string {
  const trimmed = traceId.trim();
  if (!/^[0-9a-fA-F]{8,64}$/.test(trimmed)) {
    throw new PolicyViolationError(
      "validation_error",
      "traceId must be a hex string (typically the 32-char OtelTraceId / X-Correlation-ID)."
    );
  }
  return trimmed;
}

// ---------------------------------------------------------------------------
// SQL builders
// ---------------------------------------------------------------------------

export type LogFilters = {
  service?: string;
  level?: string;
  sourceContext?: string;
  contains?: string;
};

/** Build the WHERE fragment (without the "WHERE" keyword) from log filters. */
function buildLogWhere(filters: LogFilters): string {
  const clauses: string[] = [];
  if (filters.service) {
    clauses.push(`service_name = ${sqlString(filters.service)}`);
  }
  if (filters.level) {
    // Serilog levels land in `severity` as full words (Information/Warning/Error/Fatal).
    // Prefix-match (case-insensitive) so callers can pass either the abbreviation
    // ("WARN"/"INFO") or the full word ("Warning") — exact equality would silently
    // match nothing for the abbreviations. Strip LIKE wildcards from user input first.
    const lvl = filters.level.trim().toUpperCase().replace(/[%_]/g, "");
    clauses.push(`UPPER(severity) LIKE ${sqlString(`${lvl}%`)}`);
  }
  if (filters.sourceContext) {
    // Serilog SourceContext is exported as the OTLP instrumentation scope name.
    clauses.push(`instrumentation_library_name = ${sqlString(filters.sourceContext)}`);
  }
  if (filters.contains) {
    // str_match is OpenObserve's substring matcher over the message body.
    clauses.push(`str_match(body, ${sqlString(filters.contains)})`);
  }
  return clauses.join(" AND ");
}

/** Validate a bare column identifier for a projection list (reject anything unsafe). */
function sqlColumn(name: string): string {
  if (!/^[A-Za-z0-9_.]+$/.test(name)) {
    throw new PolicyViolationError("validation_error", `Unsafe column name: "${name}".`);
  }
  return name;
}

/** Build the SELECT projection: an explicit column list when configured, else "*". */
function selectList(columns?: string[]): string {
  return columns && columns.length > 0 ? columns.map(sqlColumn).join(", ") : "*";
}

export function buildSearchLogsSql(stream: string, filters: LogFilters, size: number, columns?: string[]): string {
  const where = buildLogWhere(filters);
  const whereClause = where ? ` WHERE ${where}` : "";
  return `SELECT ${selectList(columns)} FROM ${sqlIdent(stream)}${whereClause} ORDER BY _timestamp DESC LIMIT ${size}`;
}

export function buildTraceLogsSql(stream: string, traceId: string, size: number, columns?: string[]): string {
  const id = assertTraceId(traceId);
  // Some rows populate `traceid` but leave `trace_id` empty (and vice versa) — match either.
  const match = `(trace_id = ${sqlString(id)} OR traceid = ${sqlString(id)})`;
  return `SELECT ${selectList(columns)} FROM ${sqlIdent(stream)} WHERE ${match} ORDER BY _timestamp ASC LIMIT ${size}`;
}

/**
 * Plain recent-rows sample used for field/schema discovery (describe_stream, and
 * `discover_services` with `include:"fields"`). An optional `service` narrows the
 * sample, so field discovery for one service is not diluted by every other one.
 */
export function buildSampleSql(stream: string, size: number, service?: string): string {
  const where = service ? ` WHERE service_name = ${sqlString(service)}` : "";
  return `SELECT * FROM ${sqlIdent(stream)}${where} ORDER BY _timestamp DESC LIMIT ${size}`;
}

/** The column a stream stores its trace id in. Spans use one or the other, never both. */
export type TraceIdColumn = "trace_id" | "traceid";

/**
 * Spans for one trace, ordered along the timeline.
 *
 * Matches a SINGLE column, unlike `buildTraceLogsSql` which ORs `trace_id` and
 * `traceid`. That difference is load-bearing: a logs stream is a flattened
 * free-for-all where both spellings can appear across rows, but a traces stream
 * follows the OTel schema and has exactly one of them. Naming the absent one is not
 * harmless — DataFusion rejects an unknown column while PLANNING the query, so the
 * OR form failed the whole request with "Schema error: No field named traceid" and
 * `get_trace_spans` returned nothing at all on a standard traces stream.
 *
 * The caller picks the column and retries with the other on a missing-column error.
 */
export function buildTraceSpansSql(
  stream: string,
  traceId: string,
  size: number,
  traceIdColumn: TraceIdColumn = "trace_id"
): string {
  const id = assertTraceId(traceId);
  return `SELECT * FROM ${sqlIdent(stream)} WHERE ${traceIdColumn} = ${sqlString(id)} ORDER BY start_time ASC LIMIT ${size}`;
}

export type StatsColumn = "severity" | "service_name" | "instrumentation_library_name";

/** Aggregate log counts grouped by a dimension over the window. */
export function buildLogStatsSql(stream: string, groupBy: StatsColumn, size: number): string {
  return `SELECT ${groupBy}, COUNT(*) AS count FROM ${sqlIdent(stream)} GROUP BY ${groupBy} ORDER BY count DESC LIMIT ${size}`;
}

// ---------------------------------------------------------------------------
// Discovery builders (discover_services)
// ---------------------------------------------------------------------------

/**
 * Severity is matched case-insensitively and against both vocabularies on purpose.
 * These orgs export Serilog levels as title-case words (`Information` / `Warning` /
 * `Error`), but an OTel-native exporter writes `ERROR` / `FATAL`, and a stream
 * could hold either. Comparing `UPPER(severity)` to both spellings means the
 * counts stay correct without the caller having to know which producer wrote the row.
 */
const ERROR_LEVELS = "('ERROR', 'FATAL', 'CRITICAL')";
const WARN_LEVELS = "('WARNING', 'WARN')";

/**
 * The whole per-service inventory in one round trip: volume, error/warn split,
 * first/last seen, and how many distinct source contexts the service emitted.
 *
 * Verified against a live stream: ~410 ms over 6h and ~1.2 s over 7d, so the 7-day
 * capture the service catalog takes is a single query per environment rather than
 * one query per service.
 *
 * `MIN`/`MAX(_timestamp)` come back as epoch microseconds — callers must render
 * them through the same conversion `logParser` applies to row timestamps.
 */
export function buildServiceInventorySql(stream: string, size: number): string {
  return (
    `SELECT service_name, COUNT(*) AS log_count, ` +
    `MIN(_timestamp) AS first_seen, MAX(_timestamp) AS last_seen, ` +
    `SUM(CASE WHEN UPPER(severity) IN ${ERROR_LEVELS} THEN 1 ELSE 0 END) AS error_count, ` +
    `SUM(CASE WHEN UPPER(severity) IN ${WARN_LEVELS} THEN 1 ELSE 0 END) AS warn_count, ` +
    `COUNT(DISTINCT instrumentation_library_name) AS context_count ` +
    `FROM ${sqlIdent(stream)} GROUP BY service_name ORDER BY log_count DESC LIMIT ${size}`
  );
}

/**
 * The traces-lane inventory. Deliberately a separate, simpler query: a traces
 * stream has no `severity` column, so reusing the logs builder above would fail.
 *
 * This lane is not redundant — a live check found `CommunicationHub.Web` (the
 * largest span producer by an order of magnitude), `CRM.EasyServ.DataSync` and
 * `whatsapp-api` present in traces but absent from the logs inventory. Answering
 * "which services exist" from logs alone silently omits them.
 */
export function buildTraceServiceInventorySql(stream: string, size: number): string {
  return (
    `SELECT service_name, COUNT(*) AS span_count, ` +
    `MIN(start_time) AS first_seen, MAX(start_time) AS last_seen ` +
    `FROM ${sqlIdent(stream)} GROUP BY service_name ORDER BY span_count DESC LIMIT ${size}`
  );
}

/**
 * Distinct source contexts (Serilog `SourceContext`, exported as the OTLP
 * instrumentation scope name), optionally for one service.
 *
 * Classification into app / framework / unclassified happens in TypeScript, not
 * here: the prefix lists are configurable, and building a `NOT LIKE` chain out of
 * environment-supplied strings would put configuration into a SQL statement.
 */
export function buildContextInventorySql(stream: string, size: number, service?: string): string {
  const clauses = ["instrumentation_library_name IS NOT NULL"];
  if (service) {
    clauses.push(`service_name = ${sqlString(service)}`);
  }
  return (
    `SELECT instrumentation_library_name, COUNT(*) AS count ` +
    `FROM ${sqlIdent(stream)} WHERE ${clauses.join(" AND ")} ` +
    `GROUP BY instrumentation_library_name ORDER BY count DESC LIMIT ${size}`
  );
}

/**
 * The service × context matrix, used by the service catalog to attribute code to a
 * service name.
 *
 * This is what makes `unknown_service:dotnet` readable. It is the largest bucket in
 * both live environments, and it is not one service — it is every app that never
 * set OTel `service.name`. The only way to tell them apart is the namespace of the
 * context that emitted each row, which is exactly what this pairing recovers.
 */
export function buildServiceContextMatrixSql(stream: string, size: number): string {
  return (
    `SELECT service_name, instrumentation_library_name, COUNT(*) AS count ` +
    `FROM ${sqlIdent(stream)} WHERE instrumentation_library_name IS NOT NULL ` +
    `GROUP BY service_name, instrumentation_library_name ORDER BY count DESC LIMIT ${size}`
  );
}
