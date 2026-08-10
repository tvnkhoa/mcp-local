// Normalize raw OpenObserve hits into stable, low-token shapes. OpenObserve flattens
// OTel/Serilog attributes and may lowercase or underscore keys, so every accessor
// tolerates a list of candidate field names. The exact keys were confirmed against a
// live sample during verification; new variants can be added to the candidate lists.

export type NormalizedLog = {
  ts: string | null;
  level: string | null;
  message: string | null;
  traceId: string | null;
  spanId: string | null;
  sourceContext: string | null;
  service: string | null;
  exception: string | null;
};

export type NormalizedSpan = {
  ts: string | null;
  traceId: string | null;
  spanId: string | null;
  parentSpanId: string | null;
  operation: string | null;
  service: string | null;
  durationMs: number | null;
  status: string | null;
};

type Hit = Record<string, unknown>;

function pick(hit: Hit, keys: string[]): unknown {
  for (const key of keys) {
    const v = hit[key];
    if (v !== undefined && v !== null && v !== "") {
      return v;
    }
  }
  return null;
}

function asStr(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "string") {
    return value;
  }
  return String(value);
}

/**
 * Render an epoch timestamp as ISO, inferring the unit from magnitude.
 *
 * The units genuinely differ by field: log `_timestamp` is MICROseconds, while a
 * span's `start_time` is NANOseconds. Without the nanosecond branch a span read as
 * microseconds is off by 1000x and renders as the year 58576 — which is what
 * `get_trace_spans` and the traces-lane service inventory were both reporting.
 *
 * The thresholds are far apart, so this is not a close call: a 2026 date is ~1.8e18
 * in ns, ~1.8e15 in µs, ~1.8e12 in ms and ~1.8e9 in s. Each cut sits an order of
 * magnitude clear of both neighbours.
 */
function toIso(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    const ms =
      value > 1e17
        ? value / 1e6 // nanoseconds (span start_time / end_time)
        : value > 1e14
          ? value / 1e3 // microseconds (log _timestamp)
          : value > 1e11
            ? value // milliseconds
            : value * 1e3; // seconds
    return new Date(ms).toISOString();
  }
  return asStr(value);
}

const TS_KEYS = ["_timestamp", "timestamp", "Timestamp"];
const LEVEL_KEYS = ["severity", "severity_text", "level", "Level", "severitytext"];
const MSG_KEYS = ["body", "message", "Message", "log", "msg"];
const TRACE_KEYS = ["trace_id", "traceid", "TraceId", "otel_trace_id", "OtelTraceId", "flow_trace_id", "FlowTraceId"];
const SPAN_KEYS = ["span_id", "spanid", "SpanId", "otel_span_id", "OtelSpanId"];
const PARENT_SPAN_KEYS = ["reference_parent_span_id", "parent_span_id", "OtelParentSpanId", "otel_parent_span_id"];
const SOURCE_KEYS = ["instrumentation_library_name", "source_context", "sourcecontext", "SourceContext"];
const SERVICE_KEYS = ["service_name", "servicename", "ServiceName", "service"];
const EXCEPTION_KEYS = ["exception", "Exception", "exceptions_message", "error"];
const OP_KEYS = ["operation_name", "operationname", "name", "span_name"];
const DURATION_KEYS = ["duration", "duration_ms", "durationms"];
const STATUS_KEYS = ["span_status", "status", "status_code"];

export function normalizeLog(hit: Hit): NormalizedLog {
  return {
    ts: toIso(pick(hit, TS_KEYS)),
    level: asStr(pick(hit, LEVEL_KEYS)),
    message: asStr(pick(hit, MSG_KEYS)),
    traceId: asStr(pick(hit, TRACE_KEYS)),
    spanId: asStr(pick(hit, SPAN_KEYS)),
    sourceContext: asStr(pick(hit, SOURCE_KEYS)),
    service: asStr(pick(hit, SERVICE_KEYS)),
    exception: asStr(pick(hit, EXCEPTION_KEYS))
  };
}

/** Truncate a field to `max` chars, appending a marker so a reader knows it was cut. */
function truncateField(value: string | null, max: number): string | null {
  if (value === null || !Number.isFinite(max) || value.length <= max) {
    return value;
  }
  const cut = Math.max(0, max);
  return `${value.slice(0, cut)}…[+${value.length - cut} chars]`;
}

/**
 * Apply per-profile caps to a normalized log's long fields. Two steps:
 *  1. Dedup — Serilog often emits the same rendered text in both `message` and the
 *     head of `exception`; when `exception` fully contains `message`, drop the
 *     redundant `message` (exception is the superset).
 *  2. Truncate — cap `message`/`exception` to the profile's character budget
 *     (Infinity = keep full, as verbose does). An exception cap of 0 drops it.
 * Callers select caps via `config.fieldCaps[profile]`; keeping this pure makes it testable.
 */
export function capLog(log: NormalizedLog, caps: { message: number; exception: number }): NormalizedLog {
  let message = log.message;

  // Resolve the exception first (0 = drop). Dedup against the FULL exception below.
  const redundantMessage =
    message !== null &&
    log.exception !== null &&
    message.trim().length > 0 &&
    log.exception.includes(message.trim());
  const exception = caps.exception <= 0 ? null : truncateField(log.exception, caps.exception);

  // Drop the message only when it duplicates a RETAINED exception — otherwise (e.g.
  // nano drops the exception) the message is the only remaining error text, so keep it.
  if (redundantMessage && exception !== null) {
    message = null;
  }
  message = truncateField(message, caps.message);

  return { ...log, message, exception };
}

/**
 * Summarize the fields present across sampled rows: observed JSON types + non-null
 * count. Shared by `describe_stream` and `discover_services`, which is why it lives
 * here rather than staying private to the tool table — two samplers inferring a
 * schema two different ways would report two different shapes for one stream.
 */
export function describeFields(hits: Hit[]): Array<{ name: string; types: string[]; nonNull: number }> {
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

/** Epoch microseconds (as OpenObserve aggregates return them) → ISO string. */
export function microsToIso(value: unknown): string | null {
  return toIso(value);
}

export function normalizeSpan(hit: Hit): NormalizedSpan {
  const rawDuration = pick(hit, DURATION_KEYS);
  let durationMs: number | null = null;
  if (typeof rawDuration === "number" && Number.isFinite(rawDuration)) {
    // OpenObserve span `duration` is microseconds.
    durationMs = rawDuration / 1000;
  }
  return {
    ts: toIso(pick(hit, ["start_time", ...TS_KEYS])),
    traceId: asStr(pick(hit, TRACE_KEYS)),
    spanId: asStr(pick(hit, SPAN_KEYS)),
    parentSpanId: asStr(pick(hit, PARENT_SPAN_KEYS)),
    operation: asStr(pick(hit, OP_KEYS)),
    service: asStr(pick(hit, SERVICE_KEYS)),
    durationMs,
    status: asStr(pick(hit, STATUS_KEYS))
  };
}
