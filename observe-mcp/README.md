# observe-mcp

An MCP server for **checking and tracing logs** of the CommunicationHub CRM backend.
The backend ships logs and traces over OTLP to a self-hosted **OpenObserve** instance
(services do not write log files locally), so this server queries OpenObserve's HTTP
`_search` API rather than reading files.

- Pure TypeScript, ESM, no native dependencies (`@modelcontextprotocol/sdk` + `zod`).
- Read-only: all tools issue `SELECT` queries within a bounded time window.
- Credentials come from env only and are never logged (diagnostics go to stderr).

## Commands

```bash
npm install
npm run build       # tsc -> dist/
npm run typecheck   # type check only
npm run dev         # run with tsx (no build)
npm test            # unit tests (node:test via tsx; no credentials needed)

# End-to-end smoke test (build first; needs real credentials in env)
npm run build && node scripts/smoke-test.mjs
```

## Configuration (env)

<!-- BEGIN GENERATED: env-table -->

| Variable | Required | Default | Notes |
|---|---|---|---|
| `OBSERVE_BASE_URL` | **yes** | — | The OpenObserve UI/API host — NOT the OTLP ingest host. |
| `OBSERVE_ORG` | **yes** | — | From the OpenObserve URL: org_identifier=… |
| `OBSERVE_LOG_STREAM` | **yes** | — | — |
| `OBSERVE_TRACE_STREAM` | no | — | Optional. Unset reuses the logs stream NAME, which usually resolves correctly anyway because span queries pass the `traces` stream type and OpenObserve resolves a name within its type — both live environments run this way and return spans. get_trace_spans warns only if that fallback actually returns nothing. |
| `OBSERVE_AUTH_BASIC` | one of `observe-auth` | — | **secret** · Auth: provide this OR OBSERVE_USERNAME + OBSERVE_PASSWORD. Accepted with or without the "Basic " prefix. |
| `OBSERVE_USERNAME` | one of `observe-auth` | — | — |
| `OBSERVE_PASSWORD` | one of `observe-auth` | — | **secret** |
| `OBSERVE_ENV_*` | no | — | **secret** · A family, not a literal var name — the trailing underscore is part of the prefix, and the suffix becomes the environment name. Value is a `;`-separated spec: `baseUrl=…;org=…;logStream=…;traceStream=…`, optionally with `username=`/`password=`/`authBasic=` to override the shared credentials for that one environment. Each pair splits on its first `=` only, so a URL survives intact. An unknown key is rejected at startup rather than ignored. |
| `OBSERVE_PRIMARY_ENV_NAME` | no | `default` *(code)* | Names the environment built from the flat OBSERVE_BASE_URL/ORG/LOG_STREAM trio. Set it when that trio is a real named environment (e.g. `ssdev_au`) rather than an unnamed default. |
| `OBSERVE_DEFAULT_ENVIRONMENT` | no | — | Which environment answers when a tool call omits `environment`. Validated against the configured set — an unknown value falls back to dev, then default, then the first registered, rather than breaking every call. |
| `OBSERVE_ALLOWED_ENVIRONMENTS` | no | — | Comma-separated allowlist. Filters at registration, so a name outside it does not exist in the server at all. Unset = no filtering. |
| `OBSERVE_APP_NAMESPACE_PREFIXES` | no | `CRM.,SS.,SSNet.,WEC,WeCRM.,CommunicationHub.,OSB.,Bmw.,WecSocialAds.` *(code)* | Comma-separated namespace prefixes counted as first-party code when classifying a log row's sourceContext. This is what makes discover_services able to point at the owning project. |
| `OBSERVE_FRAMEWORK_NAMESPACE_PREFIXES` | no | `Microsoft.,System.,Npgsql,MassTransit,Quartz,Hangfire,Serilog,OpenTelemetry,Rebus,Ocelot,Elsa.,Grpc.,Amazon.,AWSSDK,Azure.,Polly,StackExchange.,MediatR,FluentValidation,Refit,IdentityServer,FFmpeg.` *(code)* | Comma-separated prefixes treated as framework/library noise. Necessary because by raw volume the top log scopes are all framework plumbing, which identifies nothing. A context matching neither list is reported as `unclassified`, never dropped. |
| `OBSERVE_DEFAULT_SIZE` | no | `100` | — |
| `OBSERVE_MAX_SIZE` | no | `1000` | — |
| `OBSERVE_DEFAULT_LOOKBACK_MS` | no | `3600000` | 1 hour. |
| `OBSERVE_MAX_LOOKBACK_MS` | no | `604800000` | 7 days. |
| `OBSERVE_TIMEOUT_MS` | no | `30000` | — |
| `OBSERVE_MAX_RETRIES` | no | `2` *(code)* | Retries for transient HTTP failures (network / 5xx / 429). 0 disables. |
| `OBSERVE_LOG_COLUMNS` | no | — | Comma-separated columns instead of SELECT * (smaller/faster). Unset = SELECT *, which is schema-safe. A query naming a column the stream lacks auto-falls back to SELECT *. |
| `OBSERVE_MSG_MAX_NANO` | no | `200` *(code)* | Caps the long `message` field per response profile. verbose keeps full text. |
| `OBSERVE_MSG_MAX_COMPACT` | no | `400` *(code)* | — |
| `OBSERVE_MSG_MAX_STANDARD` | no | `2000` *(code)* | — |
| `OBSERVE_MSG_MAX_VERBOSE` | no | `unlimited` *(code)* | — |
| `OBSERVE_EXC_MAX_NANO` | no | `0` *(code)* | Caps the `exception` field. 0 = drop the field entirely, which is what nano does. |
| `OBSERVE_EXC_MAX_COMPACT` | no | `800` *(code)* | — |
| `OBSERVE_EXC_MAX_STANDARD` | no | `6000` *(code)* | — |
| `OBSERVE_EXC_MAX_VERBOSE` | no | `unlimited` *(code)* | — |
| `NODE_TLS_REJECT_UNAUTHORIZED` | no | — | Set to 0 ONLY if the query host uses a self-signed/untrusted TLS certificate. This is a Node flag, not a server setting, and it disables certificate verification for the WHOLE process — every outbound TLS connection, not just OpenObserve. Prefer trusting the CA. |

29 variables. Defaults marked *(code)* are the server's own fallback and are **not** written into your agent config — set them only to override.

<!-- END GENERATED: env-table -->

Provide exactly one of `OBSERVE_AUTH_BASIC` **or** `OBSERVE_USERNAME`+`OBSERVE_PASSWORD`.

## Tools

<!-- BEGIN GENERATED: tool-list -->

10 tools, namespaced `mcp__observe-mcp__<tool>`:

- `describe_stream`
- `discover_services`
- `get_trace_spans`
- `list_environments`
- `list_streams`
- `log_stats`
- `run_observe_query`
- `search_logs`
- `tail_logs`
- `trace_logs`

<!-- END GENERATED: tool-list -->

| Tool | Purpose |
| --- | --- |
| `list_streams` | List streams (logs/traces/metrics); connectivity + auth check |
| `search_logs` | Search logs by `service`/`level`/`sourceContext`/`contains` over a window (newest first) |
| `trace_logs` | **Trace a request** — all log records for a `traceId`, chronological |
| `get_trace_spans` | Distributed-trace spans for a `traceId` (operation, service, duration, status) |
| `tail_logs` | Most recent logs over the last N minutes |
| `log_stats` | Count logs grouped by level / service / sourceContext (error summary) |
| `run_observe_query` | Raw read-only OpenObserve SQL against a stream + mandatory time window |
| `describe_stream` | Discover a stream's fields by sampling recent rows (observed JSON types + non-null counts) |

### Time windows

All read tools accept either a relative `time` (`15m`, `1h`, `24h`, `7d`) ending now,
or an absolute `start`/`end` (ISO 8601 or epoch ms). The window is capped at
`OBSERVE_MAX_LOOKBACK_MS`.

### Response profiles & field caps

Every tool accepts `profile` (`nano` | `compact` | `standard` | `verbose`, default
`compact`). Beyond dropping `null` fields, profiles cap the long `message`/`exception`
fields so a page of error logs (stack traces) stays token-efficient — truncated text
is marked `…[+N chars]`. Defaults (chars):

| profile | message | exception |
| --- | --- | --- |
| nano | 200 | dropped |
| compact | 400 | 800 |
| standard | 2000 | 6000 |
| verbose | full | full |

When `message` is fully contained in `exception` (common with Serilog) the redundant
`message` is dropped. Use `verbose` (or raise `OBSERVE_*_MAX_*`) to see full text.

### Pagination

`search_logs` and `run_observe_query` accept `offset` (default 0) and return
`nextOffset` (non-null when the page filled `limit`/`size`) so you can page through
large result sets.

### Tracing a request

The correlation key is the 32-hex OpenTelemetry trace id, which the backend also
returns to clients in the `X-Correlation-ID` response header and stamps into every
log line as `TraceId`/`OtelTraceId`. Feed that id to `trace_logs` (log timeline) and
`get_trace_spans` (span tree).

## Registration

Add to the project's `mcpServers` in `~/.claude.json` (see the workspace `CLAUDE.md`):

```jsonc
"observe-mcp": {
  "type": "stdio",
  "command": "node",
  "args": ["D:/1.SourceCode/mcp-local/observe-mcp/dist/index.js"],
  "env": { "OBSERVE_USERNAME": "...", "OBSERVE_PASSWORD": "..." }
}
```
