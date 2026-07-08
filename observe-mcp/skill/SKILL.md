---
name: {{KEY}}
description: "Search logs and traces for the CommunicationHub backend via the {{DISPLAY_NAME}} (self-hosted OpenObserve). Triggers on: search logs, find errors/exceptions, trace a request, follow a trace id end-to-end, get spans, log volume/stats over a time window. Read-only."
---

# {{DISPLAY_NAME}}

{{TAGLINE}} Tools are exposed as `{{TOOL_NAMESPACE}}`.

Use this to search application logs, trace a single request end-to-end by trace id, inspect spans, and get log volume statistics. Everything is **read-only** — it queries the OpenObserve `_search` API.

## Step 0 — Orient

```
list_streams              // available log/trace streams
describe_stream(stream)   // columns/schema of a stream
```

## Search logs

```
search_logs(query?, service?, level?, startTime?, endTime?, size?, profile?)
tail_logs(...)            // most-recent-first
```
- Filter by `service` (see the CommunicationHub service catalog — 43 service_name values in stream `wecrm_dev`) and `level` (e.g. Error) to cut noise.
- Bound the window: `size` is capped by `OBSERVE_MAX_SIZE`; lookback by `OBSERVE_MAX_LOOKBACK_MS`. Prefer explicit `startTime`/`endTime`.

## Trace a request end-to-end

```
trace_logs(traceId)            // all log lines for one trace id, ordered
get_trace_spans(traceId)       // span tree (timing / parent-child)
```
Start from an error in `search_logs`, grab its `trace_id`, then `trace_logs` + `get_trace_spans` to follow the request across services.

## Stats

```
log_stats(groupBy?, startTime?, endTime?)   // volume by service/level/time bucket
run_observe_query(sql)                       // raw SQL against a stream when structured tools don't fit
```

## Guardrails

- Read-only. Never attempt writes/ingest through this server.
- Always constrain time window and `size` — unbounded queries are slow and get truncated by the caps.
- Use `profile: "compact"` (default) for triage; escalate to `standard`/`verbose` only when you need full message/exception text (per-profile char caps apply).
- Do not echo credentials.

## Configuration (env)

Server entry: `node {{ENTRY_PATH}}`

Auth: set **either** `OBSERVE_AUTH_BASIC` **or** `OBSERVE_USERNAME` + `OBSERVE_PASSWORD`.

{{ENV_TABLE}}

## Tool reference

{{TOOL_LIST}}
