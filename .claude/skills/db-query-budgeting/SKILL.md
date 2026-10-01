---
name: db-query-budgeting
description: "Set and enforce resource bounds on data-reading tools in this workspace — row limits, timeouts, time-window caps, multi-catalog fan-out and connection-pool caps — for postgres-mcp, sqlserver-mcp and observe-mcp (and codebase-index-mcp's result/depth caps). Use when adding or changing a tool parameter like limit / maxRows / timeoutMs / size / time window / databases[], adding a *_LIMIT / *_TIMEOUT_MS / *_MAX_* env var, or reviewing a tool that could return an unbounded result. Not for SQL injection/guardrail review (db-parameterization-audit)."
---

# DB Query Budgeting

The rule (already loaded from `.claude/rules/db-guardrails.md` and `typescript-mcp.md`): every
`limit`/`timeoutMs`-style input has a default and a hard maximum from config, is **clamped**, and the
schema, README and runtime agree. This skill is how that is done here.

## Where the bounds live

Declared once in `packages/manifest/src/envSpecs/<server>.ts`, read only by the server's
`src/config/`, rendered into `.env.example` and the README env table by `generate:all`.

| Server | Knobs (env) | How the bound is applied |
|---|---|---|
| `postgres-mcp` | `POSTGRES_DEFAULT_LIMIT` / `_MAX_LIMIT`, `POSTGRES_DEFAULT_TIMEOUT_MS` / `_MAX_TIMEOUT_MS`, `POSTGRES_EXPLAIN_COST_WARN`, `POSTGRES_WRITE_SAMPLE_LIMIT`; DDL lane `POSTGRES_DDL_*_TIMEOUT_MS`, EF lane `POSTGRES_MIGRATION_LOCK_TIMEOUT_MS` | `Math.min(requested ?? default, max)`, then the query is wrapped `select * from (…) limit N` inside `set local transaction read only` + `set local statement_timeout` (`src/tools/readTools.ts`) |
| `sqlserver-mcp` | `SQLSERVER_DEFAULT_LIMIT` / `_MAX_LIMIT`, `SQLSERVER_DEFAULT_TIMEOUT_MS` / `_MAX_TIMEOUT_MS`, `SQLSERVER_MAX_FANOUT`, `SQLSERVER_POOL_MAX`, `SQLSERVER_MAX_POOLS`, `SQLSERVER_POOL_IDLE_TIMEOUT_MS`, `SQLSERVER_EXEC_TIMEOUT_MS` | `clamp()` in `src/tools/common.ts`. **T-SQL has no LIMIT** — rows are bounded by cancelling the stream (`src/repositories/queryRunner.ts`, `truncated`), the statement is never rewritten. Fan-out over `databases[]` is capped by `SQLSERVER_MAX_FANOUT` and runs at `MAX_FANOUT_CONCURRENCY` |
| `observe-mcp` | `OBSERVE_DEFAULT_SIZE` / `OBSERVE_MAX_SIZE`, `OBSERVE_DEFAULT_LOOKBACK_MS` / `OBSERVE_MAX_LOOKBACK_MS`, `OBSERVE_TIMEOUT_MS`, `OBSERVE_MAX_RETRIES`, `OBSERVE_MSG_MAX_*` / `OBSERVE_EXC_MAX_*` (per-profile truncation) | `clampSize` and the lookback cap in `src/services/queryBuilder.ts`; HTTP abort timer in `src/services/observeClient.ts` |
| `codebase-index-mcp` | `CODEBASE_INDEX_MAX_RESULT_LIMIT`, `CODEBASE_INDEX_MAX_DEPTH`, parse/edge caps | zod schema maxima built from config (`src/types/schemas/`, wired in e.g. `src/tools/graphImpact.ts`) — over-max is **rejected** as `VALIDATION_ERROR`, not clamped |

`@mcp/core` exports `resolveLimit` / `resolveTimeoutMs` / `createLimitPolicy`, but **no server
uses them today** — each clamps locally as above. Use the helper for new code; do not claim existing
servers do.

## Checklist for a new or changed bounded parameter

1. **Env contract.** Default + max declared in `envSpecs/<server>.ts`. Tuning knobs take
   `codeDefault` (documents, never pins); `default` is written into `~/.claude.json` and pins the
   value. Never both.
2. **Pick the server's existing over-max behaviour and say it.** The DB servers clamp (and report
   `truncated`); codebase-index rejects. Either way a non-number is a validation error, never a
   silent coercion.
3. **Advertised schema = runtime.** `inputSchema` states the maximum the handler enforces
   (`schema.integer("…", { maximum })`); the contract snapshot will show the change.
4. **Engine-side backstop** where the engine has one (postgres `statement_timeout`; driver
   `requestTimeout` for sqlserver; `AbortController` for HTTP). A timeout surfaces as `timeout`, a
   lock wait as `lock_timeout` (postgres).
5. **Response honesty.** Payload reports `truncated` / `rowCount` / `elapsedMs` so a caller can tell
   a capped result from a complete one.
6. **Multi-target tools** (`databases[]`, multi-environment): cap the fan-out count and the
   concurrency separately, and keep per-target failures in the result rather than failing the call.

## Verify

```bash
npm run generate:all && npm run generate:check     # env table / .env.example follow the manifest
cd <server> && npm run build && cd .. && npm run contracts:update -- --server <key>   # read git diff contracts/
cd <server> && npm run test
```

## Output

Budget table (parameter → default → max → env var → enforcement `file:line`), then gaps and risks.

## Authoritative reference

Env contract and defaults: `packages/manifest/src/envSpecs/*.ts` (rendered into each server's
README — never hand-edit the generated table). Field semantics (`default` vs `codeDefault`):
`docs/servers/server-development.md` §2. Limit helpers: `@mcp/core` `limits` (`packages/core/README.md`).
