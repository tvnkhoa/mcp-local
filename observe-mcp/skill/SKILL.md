---
name: {{KEY}}
description: "Search logs and traces for the CommunicationHub / CRM backend via the {{DISPLAY_NAME}} (self-hosted OpenObserve). Triggers on: search logs, find errors/exceptions, trace a request, follow a trace id end-to-end, get spans, log volume/stats over a time window, which services exist, map a log line back to code. Read-only."
---

# {{DISPLAY_NAME}}

{{TAGLINE}} Tools are exposed as `{{TOOL_NAMESPACE}}`.

Use this to search application logs, trace a single request end-to-end by trace id, inspect spans, discover which services are emitting, and map a log line back to the code that wrote it. Everything is **read-only** — it queries the OpenObserve `_search` API.

## Step 0 — Pick an environment

One server serves several OpenObserve orgs. Every tool except `list_environments` takes an optional `environment`; omitting it uses the server default, and **every response echoes the environment that answered**, so check that field before trusting a result.

```
list_environments()                     // names, org, streams, which is default
```

Never assume an environment name. `prod` and `dev` may not exist — the names are whatever the install configured.

## Step 1 — Discover what is actually there

```
discover_services(time: "7d")                                   // per service: volume, errors, warns, first/last seen
discover_services(include: ["codeLinks"])                       // + the namespaces that identify the owning code
discover_services(include: ["streams"])                         // log/trace datasets, metrics noise omitted
discover_services(source: "catalog")                            // the committed 7-day capture, no network
describe_stream(stream)                                         // field/schema of one stream
```

There is **no fixed service list** — ask. A dated capture lives in `observe-mcp/docs/service-catalog.json`, refreshed by `npm run catalog:refresh`; responses report its age and warn when it is stale. Age is the weaker signal: its `logsUnder` / `lanes` / `note` fields are point-in-time observations that one deploy on the emitting service can invalidate at any age, so re-test them with `npm run catalog:verify` before acting on them.

Three facts about this data that will otherwise cost you an hour:

1. **A service is named down two different paths, and the server reconciles them for you.** These .NET apps emit logs both through the OTel SDK (which carries `service_name`) and through a Serilog OTLP sink (which, unless the app sets `service.name`, reports the spec default `unknown_service:dotnet` and puts the real name in `applicationname`). `search_logs(service:)`, `tail_logs(service:)`, `log_stats(groupBy:"service")` and `discover_services` all match the **resolved** name, so query the app's real name and you get all of its rows regardless of path. Each response carries an `identity` block saying whether resolution was applied, and `discover_services` reports an `identitySource` per service: `resource` (the OTLP resource named every row), `enricher` (every row recovered from `applicationname`), `mixed` (both paths at once). **`mixed` is the ordinary state, not an anomaly** — one app runs both paths, e.g. `CRM.Gateway` emitted 15,528 rows through the SDK provider and 3,836 through the Serilog sink in the same hour — and it marks the services that lose rows to any query using `service_name` alone. Use `log_stats(groupBy:"serviceRaw")` to see the unresolved view, which is how you measure how much of the index still lands in the sentinel bucket.
2. **The traces lane has services the logs lane does not, and it is never resolved.** A traces stream has no `applicationname` column at all, so spans are always attributed by `service_name`. If `search_logs` for a service returns nothing, it genuinely has no log rows in that window — check `discover_services(lane:"traces")`. A catalog entry may also carry `logsUnder`, but treat it as a dated observation and re-test it (`npm run catalog:verify`) rather than trusting it.
3. **A service can legitimately have no first-party log contexts.** `CRM.Gateway` is an Ocelot gateway: every context it logs is framework. The catalog says so directly — `identifiedBy: "framework"` means the entry is grounded only in the libraries the app uses, versus `"namespace"`, which points at first-party code. Do not go hunting for code that was never logged.

## Search logs

```
search_logs(service?, level?, sourceContext?, contains?, time?, start?, end?, limit?, offset?, stream?, environment?, profile?)
tail_logs(service?, level?, minutes?, limit?)      // last N minutes, default 15
```
- Filter by `service` (get real values from `discover_services`) and `level` (e.g. `Error`) to cut noise. `level` is prefix-matched on `severity`, so `ERROR` and `Error` both work.
- `contains` is a substring match on the message body; `sourceContext` is the emitting class.
- Bound the window: `time` takes `15m` / `1h` / `24h` / `7d`, or pass absolute `start` / `end`. `limit` is capped by `OBSERVE_MAX_SIZE`, lookback by `OBSERVE_MAX_LOOKBACK_MS`.

## Trace a request end-to-end

```
trace_logs(traceId)            // all log lines for one trace id, ordered
get_trace_spans(traceId)       // span tree (timing / parent-child)
```
Start from an error in `search_logs`, grab its `traceId`, then `trace_logs` + `get_trace_spans` to follow the request across services.

## Stats and escape hatch

```
log_stats(groupBy?, time?, start?, end?)     // volume by level (default), service, or sourceContext
run_observe_query(sql, time?, size?)         // raw read-only SQL when the structured tools don't fit
```

## From a log line to the code

1. Take `sourceContext` from the row — for .NET it is the fully-qualified type that logged it.
2. Look the service up in `docs/service-catalog.json`; `code.repoId` + `code.project` name the owning project. Watch for `code.match: "folder-only"`, which means the mapping is ambiguous and the `sourceContext` is what disambiguates it.
3. Resolve the type with the codebase-index MCP (`search_symbols` / `get_symbol_source`) in that repo.

Note that a namespace and its project name can disagree — the teleservices apps use namespace `Bmw.Teleservices.V3.*` in projects named `Teleservice.*`, so searching the repo for the namespace finds no project file.

## Guardrails

- Read-only. Never attempt writes/ingest through this server.
- Always constrain the time window and `limit` — unbounded queries are slow and get truncated by the caps.
- Use `profile: "compact"` (default) for triage; escalate to `standard`/`verbose` only when you need full message/exception text (per-profile char caps apply).
- Do not echo credentials. `list_environments` is credential-free by construction; keep it that way.
- Prefer `source: "catalog"` for orientation and live queries for anything you will act on. The catalog is dated; the index is not.

## Configuration (env)

Server entry: `node {{ENTRY_PATH}}`

Auth: set **either** `OBSERVE_AUTH_BASIC` **or** `OBSERVE_USERNAME` + `OBSERVE_PASSWORD`. These are shared across environments; an individual environment can override them inside its `OBSERVE_ENV_*` value.

Environments come from either the flat `OBSERVE_BASE_URL` / `OBSERVE_ORG` / `OBSERVE_LOG_STREAM` trio (named by `OBSERVE_PRIMARY_ENV_NAME`, default `default`) or the `OBSERVE_ENV_<NAME>` family, whose value is `baseUrl=…;org=…;logStream=…;traceStream=…`.

{{ENV_TABLE}}

## Tool reference

{{TOOL_LIST}}
