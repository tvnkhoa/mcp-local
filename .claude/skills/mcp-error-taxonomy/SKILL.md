---
name: mcp-error-taxonomy
description: "Choose the error code, audience and message for a new failure path in one of this workspace's MCP servers, and wire it through that server's error envelope (createErrorMapper / toWireError, or codebase-index-mcp's own mapError). Use when adding a thrown error class, a guard refusal, an upstream/driver failure branch, or when a caller sees internal_error for what is really their mistake, or a message leaks a connection string or path. Not for log/telemetry design (mcp-observability-runbook) or for whether the tool list changed (mcp-contract-conformance)."
---

# MCP Error Taxonomy

## The vocabulary — `@mcp/core` `ERROR_CODES`

`validation_error` · `policy_violation` · `not_found` · `conflict` · `unauthorized` · `rate_limited`
· `upstream_error` · `timeout` · `config_error` · `unsupported` · `internal_error`

`PlatformError` derives `audience` (`user` for all but `upstream_error`, `timeout`,
`internal_error`) and `retryable` (`rate_limited`, `timeout`, `upstream_error`) from the code.
`toPayload()` never serializes `cause` or a stack; `toPlatformError(e)` puts a raw `Error` on
`cause` and returns a generic `internal_error`.

Servers also publish a few **server-specific** codes — `lock_timeout` (postgres-mcp),
`observe_http_error`, `bitbucket_http_error`, `mcp_error`. Reuse a platform code before inventing one;
a new code is a contract change clients may branch on.

## Two envelopes — know which server you are in

| Server(s) | Envelope | Built by |
|---|---|---|
| `postgres-mcp`, `sqlserver-mcp`, `observe-mcp`, `bitbucket-mcp` | `{ code, message, detail? }`, lower_snake codes | `createErrorMapper` from `@mcp/sdk` in `src/middleware/errors.ts`, fronted by a `PlatformError` unwrap (`toWireError` in postgres/sqlserver/observe; inline in `bitbucket-mcp/src/tools/index.ts`) |
| `codebase-index-mcp` | `{ code, message, requestId }`, UPPER_SNAKE codes (`VALIDATION_ERROR` for zod and `McpError(InvalidParams)`, `INTERNAL_ERROR` for `InternalError` and unknown throws, `MCP_ERROR` for any other JSON-RPC code; platform codes pass through lower_snake), message prefixed **once** with the tool name | its own `mapError(error, toolName)` in `src/middleware/errors.ts` — deliberately not on `createErrorMapper` |

`createErrorMapper` branch order is fixed: **validation → coded classes → protocol error → the
server's `rules` → fallback**. Error classes are **injected**, never imported by the SDK: each server
owns its own `zod`, so `instanceof` across the package boundary fails (ADR 0001).

## Procedure for a new failure path

1. **Classify.** Caller can fix it by changing input/config → a user-audience code. Defect or
   unexpected upstream state → `internal_error` / `upstream_error`.
2. **Raise it the platform way.** In an SDK handler return `err(notFound("…"))` — one factory per
   code in `@mcp/core` (`validationError`, `policyViolation`, `configError`, `upstreamError`, …) —
   or refuse from a guard; throwing becomes `internal_error` with detail logged, not returned.
   For a class carrying its own `code`, add it to the mapper's `coded` list.
3. **Message policy.** User audience: what was wrong + the next step (name the env flag, the allowed
   values, the workaround). Never echo a driver/HTTP message that can contain a connection string,
   token, or absolute path — postgres-mcp supplies its own `fallback` for exactly this reason; copy
   that if your upstream can leak.
4. **Detail.** Machine-useful, non-secret context goes in `detail` (sdk servers) — it reaches the
   caller, so it is not a place for `cause`.
5. **Test the envelope.** One test per new branch asserting `code` and that no secret appears
   (`@mcp/testing` `assertNoLeak`); for codebase-index, `npm run test:server-envelopes`.
6. **Stable codes.** Changing an existing code is breaking for callers — treat it like a schema change.

## Output

Error matrix: `case → code → audience/retryable → message (user-safe) → where raised (file:line)`.

## Authoritative reference

`docs/servers/tool-development.md` §5 (envelopes, branch order, `toWireError`). Codes and
`PlatformError`: `packages/core/src/errors.ts` / `packages/core/README.md`. Mapper:
`packages/sdk/src/errorMapper.ts`. Why classes are injected: `docs/decisions/0001-workspace-native-deps.md`.
