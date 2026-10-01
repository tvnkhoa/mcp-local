---
name: {{KEY}}
description: "Logs and traces for the CommunicationHub / CRM .NET backend via the {{DISPLAY_NAME}} (self-hosted OpenObserve, several environments incl. prod). Use for: search logs, find errors/exceptions in service X, what failed in the last hour, check prod logs, tail recent logs, follow a trace id end-to-end, get spans/latency for a request, log volume or error counts by service, which services exist, map a log line (SourceContext) back to the code. Not for CI/build logs (bitbucket-mcp) or database rows (postgres-mcp / sqlserver-mcp). Read-only."
---

# {{DISPLAY_NAME}}

{{TAGLINE}} Tools are exposed as `{{TOOL_NAMESPACE}}`. Everything is read-only.

## Step 0 — environment, then services

```
list_environments()                              // names, org, streams, which is default
discover_services(environment?, time: "24h")     // per service: volume, errors, warns, identitySource
```

- Every tool but `list_environments` takes `environment`; **each response echoes the one that
  answered** — check it before trusting a result. Never assume `prod`/`dev` exist; use the listed names.
- There is no fixed service list — ask `discover_services` (default window `1h`). `include:
  ["codeLinks"]` adds the owning code namespaces, `include: ["streams"]` the datasets, `lane:
  "traces"` the traces side; `source: "catalog"` reads the dated capture in
  `observe-mcp/docs/service-catalog.json` with no network (orientation only — act on live data).
- `list_streams(type?)` / `describe_stream(stream)` for datasets and their fields.

## Find errors

```
search_logs(service: "CRM.Gateway", level: "Error", time: "1h", contains?, sourceContext?, limit?)
tail_logs(service?, level?, minutes: 15)          // newest rows, max 1440 minutes
log_stats(groupBy: "service", time: "24h")        // volume by level (default) | service | serviceRaw | sourceContext
```

- `level` is prefix-matched (`Error`, `ERROR`, `Warn` all work). `contains` = substring of the
  message; `sourceContext` = the emitting .NET class.
- Always bound the window: `time` (`15m`, `1h`, `24h`, `7d`) or `start`/`end`. Caps:
  `OBSERVE_MAX_LIMIT` rows, `OBSERVE_MAX_LOOKBACK_MS` (7 days). Page with `offset` / `nextOffset`.

## Follow one request

```
search_logs(...)                 // pick an error row, take its traceId
trace_logs(traceId, time?)       // every log line for that trace, ordered
get_trace_spans(traceId, time?)  // span tree: timing, parent/child, which service was slow
```

## Raw SQL (escape hatch)

```
run_observe_query(sql: "SELECT ... FROM \"<stream>\" WHERE ...", time: "1h", size?)
```
SELECT/WITH only, always within a time window. Use the structured tools when they fit — they apply
service-identity resolution; raw SQL does not.

## Three facts that otherwise cost an hour

1. **Service identity is resolved, not raw.** These apps log through the OTel SDK (`service_name`)
   and a Serilog OTLP sink (arrives as `unknown_service:dotnet`, real name in `applicationname`).
   `search_logs` / `tail_logs` / `log_stats` / `discover_services` match the **resolved** name, so
   query the app's real name. Responses carry an `identity` block; `identitySource: "mixed"` is
   normal. `log_stats(groupBy: "serviceRaw")` shows the unresolved view.
2. **Traces are never resolved** (that stream has no `applicationname`), and the traces lane has
   services the logs lane lacks. `search_logs` empty for a service = no log rows in that window —
   check `discover_services(lane: "traces")`.
3. **Some services log only framework contexts** (e.g. `CRM.Gateway`, an Ocelot gateway). A catalog
   entry with `identifiedBy: "framework"` has no first-party code to find.

## From a log line to the code

1. `sourceContext` is the fully-qualified .NET type that logged it.
2. The service's entry in `observe-mcp/docs/service-catalog.json` names the owning project
   (`code.repoId` + `code.project`); `code.match: "folder-only"` is ambiguous — let the
   `sourceContext` decide. Live, `discover_services(service, include: ["codeLinks"])` gives the
   first-party namespaces.
3. Resolve the type with the codebase-index MCP (`search_symbols` strategy `name`, then
   `get_symbol_source`). Namespaces and project names can differ (`Bmw.Teleservices.V3.*` lives in
   `Teleservice.*` projects).

## Guardrails

- Read-only; never attempt ingest or writes.
- Bound every query by time window and `limit`; unbounded ones are slow and get truncated.
- `compact` (default) for triage; `standard`/`verbose` only for full message/exception text
  (per-profile character caps apply).
- Never echo credentials. `list_environments` is credential-free by construction.
- Catalog fields (`logsUnder`, `lanes`, `note`) are dated observations — re-test with
  `npm run catalog:verify` before acting on them.

## Configuration (env)

Server entry: `node {{ENTRY_PATH}}`

Auth: **either** `OBSERVE_AUTH_BASIC` **or** `OBSERVE_USERNAME` + `OBSERVE_PASSWORD`, shared across
environments; an environment can override them inside its `OBSERVE_ENV_*` value. Environments come
from the flat `OBSERVE_BASE_URL` / `OBSERVE_ORG` / `OBSERVE_LOG_STREAM` trio (named by
`OBSERVE_PRIMARY_ENV_NAME`, default `default`) and/or `OBSERVE_ENV_<NAME>` =
`baseUrl=…;org=…;logStream=…;traceStream=…`.

{{ENV_TABLE}}

## Tool reference

{{TOOL_LIST}}
