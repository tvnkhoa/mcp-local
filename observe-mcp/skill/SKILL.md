---
name: {{KEY}}
description: "OpenObserve logs and traces for the CommunicationHub / CRM .NET services, incl. prod. Use for: search logs, errors/exceptions in service X, what failed in the last hour, tail logs, follow a trace id, spans/latency, error counts by service, which services exist, log line (SourceContext) to code. Not for CI/build logs (bitbucket-mcp) or database rows (postgres-mcp/sqlserver-mcp). Read-only."
---

# {{DISPLAY_NAME}}

{{TAGLINE}} Tools are exposed as `{{TOOL_NAMESPACE}}`. Everything is read-only.

## Step 0 — environment, then services

```
list_environments()                              // names, streams, which is default
discover_services(environment?, time: "24h")     // per service: volume, errors, identitySource
```

- Every tool but `list_environments` takes `environment`, and **each response echoes the one that
  answered** — check it. Never assume `prod`/`dev` exist; use the listed names.
- There is no fixed service list — ask `discover_services`. `include: ["codeLinks"]` adds the owning
  code namespaces, `lane: "traces"` the traces side, `source: "catalog"` the dated offline capture
  (orientation only — act on live data).

## Find errors

```
search_logs(service: "<service>", level: "Error", time: "1h", contains?, sourceContext?, limit?)
tail_logs(service?, level?, minutes: 15)
log_stats(groupBy: "service", time: "24h")        // level (default) | service | serviceRaw | sourceContext
```

- `level` is prefix-matched. `contains` = message substring; `sourceContext` = the emitting .NET class.
- Always bound the window: `time` (`15m`, `1h`, `24h`, `7d`) or `start`/`end`. Page with `offset` /
  `nextOffset`.

## Follow one request

```
search_logs(...)                 // pick an error row, take its traceId
trace_logs(traceId, time?)       // every log line for that trace, ordered
get_trace_spans(traceId, time?)  // span tree: timing, which service was slow
```

`run_observe_query(sql, time)` is the raw-SQL escape hatch (SELECT/WITH, time-bounded); it does not
apply the service-identity resolution below — prefer the structured tools.

## Three facts that otherwise cost an hour

1. **Service identity is resolved, not raw.** Rows from the Serilog OTLP sink arrive as
   `unknown_service:dotnet` with the real name in `applicationname`; the logs tools match the
   **resolved** name, so query the app's real name. `identitySource: "mixed"` is normal;
   `log_stats(groupBy: "serviceRaw")` shows the unresolved view.
2. **Traces are never resolved**, and the traces lane has services the logs lane lacks. Empty
   `search_logs` for a service = no log rows in that window — check `discover_services(lane: "traces")`.
3. **Some services log only framework contexts** (e.g. an API gateway). A catalog entry with
   `identifiedBy: "framework"` has no first-party code to find.

## From a log line to the code

`sourceContext` is the fully-qualified .NET type that logged it.
`discover_services(service, include: ["codeLinks"])` gives the owning first-party namespaces; then
resolve the type with the codebase-index MCP (`search_symbols` strategy `name`, then
`get_symbol_source`). Namespaces and project names can differ — let the `sourceContext` decide.

## Guardrails

- Read-only; never attempt ingest or writes.
- Bound every query by time window and `limit`.
- `compact` (default) for triage; `standard`/`verbose` only for full message/exception text.
- Never echo credentials.

Setup, auth, environments, the service catalog and troubleshooting: see `observe-mcp/README.md`.

## Tool reference

{{TOOL_LIST}}
