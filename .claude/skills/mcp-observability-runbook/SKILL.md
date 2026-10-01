---
name: mcp-observability-runbook
description: "Make this workspace's own MCP servers diagnosable — stderr structured logging, requestId correlation, health_check payloads, codebase-index tool telemetry, mcp:doctor — and triage one that will not start, returns errors, or is slow. Use when adding log events or a health field to a server, adding a long-running or gated tool, or debugging a server failure (ERR_MODULE_NOT_FOUND, failed handshake, stale dist, stale index). NOT for searching CommunicationHub/CRM application logs or traces — that is the observe-mcp operational skill. Not for choosing error codes (mcp-error-taxonomy)."
---

# MCP Observability Runbook

These are local stdio processes with no metrics backend: the observable surface is **stderr logs,
each tool's response payload, `health_check`, and `mcp:doctor`**. Design for those, not for
dashboards that do not exist.

## Instrumentation rules

1. **stderr only.** stdout is the protocol channel. `console.log` fails `guard:convention`;
   `createMcpServer` also redirects `console.*` to stderr.
2. **Use the injected logger.** In an SDK handler `ctx.logger` is already scoped with `tool` and
   `requestId`; start-up/crash events use `createEventLogger()` in `src/index.ts`. Event names are
   `snake_case` verbs (`query_succeeded`, `tool_refused`, `server_ready`).
3. **Redaction is in the logger** (`@mcp/core` `createRedactor`), not at call sites — but never
   pass a raw secret, full connection string, or full SQL anyway. Log SQL as a hash (postgres-mcp
   logs `queryHash`), report a secret as *present*, never its value (also in `describeConfig`,
   which reaches both stderr and `health_check`).
4. **Correlate.** Return the `requestId` in the payload where the server already does
   (postgres-mcp reads, codebase-index errors) so a caller's report maps to a log line.
5. **Report cost in the payload.** `elapsedMs`, `rowCount`/`truncated`, `timedOut` — callers see
   these; logs are often not collected.
6. **health_check** (every server except observe-mcp, which has `list_environments` /
   `discover_services` instead) reports config shape, reachability and, for codebase-index, index
   freshness. Add a field when an operator would otherwise have to guess (cf. sqlserver-mcp's
   `linkedServerCount`, which caught a false ADR claim).

Events the SDK already emits — do not duplicate: `server_starting`, `server_ready`, `tool_refused`
(guard), `tool_error` (handler `err`), `tool_threw`, `dispatch_failed`, `config_invalid`,
`shutdown_started` / `shutdown_complete` / `shutdown_hook_failed`.

codebase-index extras: `CODEBASE_INDEX_TELEMETRY_ENABLED` (+ `_SAMPLE_RATE`) writes
`[tool-telemetry] {toolName, elapsedMs, responseBytes, resultCount, profile, isError, errorCode}`
lines to stderr; `CODEBASE_INDEX_INDEX_LOG` enables index-progress logging; `index_runs` records
per-run metadata (`health_check` surfaces the latest).

## Triage runbook

| Symptom | Do |
|---|---|
| Server will not start / tools missing in the host | `npm run mcp:doctor -- --server <key>` (build/config/env/skill/start) → `cd <server> && npm run smoke` → `npm run contracts:check`. If contracts boots it and the host does not, it is config, not code |
| `ERR_MODULE_NOT_FOUND` on `@mcp/*` | `npm run build:packages` |
| Builds, but old behaviour / script import fails | stale `dist/` — `tsc` does not prune; `rm -rf dist && npm run build` in that server |
| A response carries `internal_error` | find the matching stderr error line (event `tool_threw` or `dispatch_failed`) by its `requestId`; if the caller's input caused it, it should not be `internal_error` (see `mcp-error-taxonomy`) |
| Slow / timeouts | check the payload's `elapsedMs` and the server's `*_TIMEOUT_MS` bounds (`db-tool-review`, Part 2) |
| codebase-index answers look stale | `health_check(repoId)` → re-index flow in `.claude/rules/mcp-hard-mode.md` |
| Behaviour changed after a parser/indexer upgrade | the full re-index + slash-style check in `mcp-hard-mode.md` |

After a fix in a server: `npm run build` there, restart the MCP server in the host (`/mcp`), retest.

## Output

Events/fields added (name → level → fields → why), health fields added, and runbook rows changed.

## Authoritative reference

`docs/development/workflow.md` §8 (stdout rule, logger, "when a server will not start", common
failures). Logger and redaction: `@mcp/core` `logging` / `redaction` (`packages/core/README.md`).
Doctor checks: `docs/servers/server-development.md` §6.
