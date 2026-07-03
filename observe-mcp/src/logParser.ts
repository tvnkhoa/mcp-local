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

/** OpenObserve `_timestamp` is microseconds since epoch. Render ISO if numeric. */
function toIso(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    // Heuristic: values > 1e15 are microseconds, > 1e12 are milliseconds.
    const ms = value > 1e15 ? value / 1000 : value > 1e12 ? value : value * 1000;
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
