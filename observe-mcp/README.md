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

| Var | Default | Notes |
| --- | --- | --- |
| `OBSERVE_BASE_URL` | `https://observe.easyserv.au:10443` | Query API/UI host (not the OTLP ingest host) |
| `OBSERVE_ORG` | `36619ZLzJ9IjUYKMqTT3MJC5A7Z` | `org_identifier` from the OpenObserve URL |
| `OBSERVE_LOG_STREAM` | `wecrm_dev` | Logs stream |
| `OBSERVE_TRACE_STREAM` | = log stream | Traces stream (override if different) |
| `OBSERVE_AUTH_BASIC` | — | Pre-encoded Basic token (alternative to user/pass) |
| `OBSERVE_USERNAME` / `OBSERVE_PASSWORD` | — | Basic-auth credentials, encoded at startup |
| `OBSERVE_DEFAULT_SIZE` / `OBSERVE_MAX_SIZE` | 100 / 1000 | Result caps |
| `OBSERVE_DEFAULT_LOOKBACK_MS` / `OBSERVE_MAX_LOOKBACK_MS` | 1h / 7d | Time-window caps |
| `OBSERVE_TIMEOUT_MS` | 30000 | HTTP request timeout (per attempt) |
| `OBSERVE_MAX_RETRIES` | 2 | Retry transient failures (network / 5xx / 429) with backoff; 0 disables |
| `OBSERVE_LOG_COLUMNS` | — | Optional CSV column projection for log/trace queries (else `SELECT *`); auto-falls back to `SELECT *` on a missing-column error |
| `OBSERVE_MSG_MAX_*` / `OBSERVE_EXC_MAX_*` | see below | Per-profile char caps for `message`/`exception` |
| `NODE_TLS_REJECT_UNAUTHORIZED` | — | Set `0` only for self-signed TLS (last resort) |

Provide exactly one of `OBSERVE_AUTH_BASIC` **or** `OBSERVE_USERNAME`+`OBSERVE_PASSWORD`.

## Tools

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
