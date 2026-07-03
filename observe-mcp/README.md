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
| `OBSERVE_TIMEOUT_MS` | 30000 | HTTP request timeout |
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

### Time windows

All read tools accept either a relative `time` (`15m`, `1h`, `24h`, `7d`) ending now,
or an absolute `start`/`end` (ISO 8601 or epoch ms). The window is capped at
`OBSERVE_MAX_LOOKBACK_MS`.

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
