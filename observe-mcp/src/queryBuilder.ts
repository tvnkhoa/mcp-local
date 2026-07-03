import type { ObserveConfig } from "./config.js";
import { PolicyViolationError } from "./errors.js";

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
  config: ObserveConfig,
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
export function clampSize(requested: number | undefined, config: ObserveConfig): number {
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

export function buildSearchLogsSql(stream: string, filters: LogFilters, size: number): string {
  const where = buildLogWhere(filters);
  const whereClause = where ? ` WHERE ${where}` : "";
  return `SELECT * FROM ${sqlIdent(stream)}${whereClause} ORDER BY _timestamp DESC LIMIT ${size}`;
}

export function buildTraceLogsSql(stream: string, traceId: string, size: number): string {
  const id = assertTraceId(traceId);
  // Some rows populate `traceid` but leave `trace_id` empty (and vice versa) — match either.
  const match = `(trace_id = ${sqlString(id)} OR traceid = ${sqlString(id)})`;
  return `SELECT * FROM ${sqlIdent(stream)} WHERE ${match} ORDER BY _timestamp ASC LIMIT ${size}`;
}

export function buildTraceSpansSql(stream: string, traceId: string, size: number): string {
  const id = assertTraceId(traceId);
  const match = `(trace_id = ${sqlString(id)} OR traceid = ${sqlString(id)})`;
  return `SELECT * FROM ${sqlIdent(stream)} WHERE ${match} ORDER BY start_time ASC LIMIT ${size}`;
}

export type StatsColumn = "severity" | "service_name" | "instrumentation_library_name";

/** Aggregate log counts grouped by a dimension over the window. */
export function buildLogStatsSql(stream: string, groupBy: StatsColumn, size: number): string {
  return `SELECT ${groupBy}, COUNT(*) AS count FROM ${sqlIdent(stream)} GROUP BY ${groupBy} ORDER BY count DESC LIMIT ${size}`;
}
