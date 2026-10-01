---
name: db-tool-review
description: "Review a data-reading tool in this workspace's SQL-emitting servers (postgres-mcp, sqlserver-mcp, observe-mcp, codebase-index-mcp's SQLite query_graph) on two axes. SQL construction and guardrails: bind parameters vs string interpolation, identifier quoting, literal escaping where the backend has no bind params, the per-dialect read-only guardrail and its forbidden-token list. Resource bounds: row limits, timeouts, time-window caps, multi-catalog fan-out and connection-pool caps, codebase-index result/depth caps. Use when a diff touches a sqlGuardrails/ddlGuardrails/writeGuardrails file, a query builder, a repository that composes SQL or a FORBIDDEN_TOKENS list; when it adds or changes a limit / maxRows / timeoutMs / size / time window / databases[] parameter or a *_LIMIT / *_TIMEOUT_MS / *_MAX_* env var; or when a tool could return an unbounded result. Not a whole-server pre-merge review: mcp-security-review is the umbrella and hands off here. Not for host config (mcp-host-integration-security)."
---

# DB Tool Review

Two narrow questions about a tool that reads data, each with its own checklist:

1. **SQL construction and guardrails** — can caller input change the shape of a SQL statement?
2. **Resource bounds** — can a caller make the tool return or wait for an unbounded amount?

Policy is already loaded from `.claude/rules/db-guardrails.md` and `typescript-mcp.md`; this is the
repo-specific checklist. Run the part the diff touches; a new tool needs both.

---

## Part 1 — SQL construction and guardrails

### Where SQL is built, per server

| Server | Validator (read lane) | How values reach SQL | Identifiers |
|---|---|---|---|
| `postgres-mcp` | `src/middleware/sqlGuardrails.ts` (+ `writeGuardrails.ts`; DDL lane `ddlGuardrails.ts` has **its own tokenizer, not `scanSql`** — ADR 0005) | `$1…$n` bind params (`args.params`) | `quoteIdent` in `src/middleware/ident.ts` — the only permitted quoting primitive |
| `sqlserver-mcp` | `src/middleware/sqlGuardrails.ts` — T-SQL scan switches, 4-part-name refusal, allowlist over 3-part names (ADR 0004) | `request.input("p1", …)` (`src/tools/queryTools.ts`, `execTools.ts`) | bracketed; `execute_routine` takes a routine name + typed params, never statement text |
| `observe-mcp` | `src/middleware/sqlGuardrails.ts` | **No bind params exist in the OpenObserve search API** — values go through `sqlString()` (quote doubling) in `src/services/queryBuilder.ts` | `sqlIdent()` / column validators reject anything outside `[A-Za-z0-9_.-]`; trace ids via `assertTraceId` (hex only) |
| `codebase-index-mcp` | `src/middleware/sqliteGuardrails.ts` (`query_graph`) | better-sqlite3 prepared statements | — |

All read-lane validators sit on `@mcp/shared/sql` (`scanSql` → `isSelectLike` →
`hasMultipleStatements` → `findForbiddenToken`), which ships the mechanism and **no token list**.

### Checklist

1. **No interpolation of caller values.** In the diff, every `${…}` inside a SQL string is either
   a bind placeholder, a `quoteIdent`/`sqlIdent`/`sqlString` call, or a server-computed value
   (clamped integer limit, constant). Flag anything else.
2. **Identifiers.** A dynamic schema/table/column name goes through the server's one quoting
   primitive — never a local re-implementation.
3. **observe-mcp specifically.** Every literal built from input passes `sqlString`; every
   identifier passes `sqlIdent` or a column validator. A new filter field needs both a validator
   and a negative test in `src/middleware/sqlGuardrails.test.ts` or `src/services/queryBuilder.test.ts`.
4. **Guardrail shape.** Single statement (trailing `;` only), must start `select`/`with`, then the
   token check. For postgres, the `with x as (delete … returning *) select …` regression in
   `src/tools/tools.test.ts` must still be refused. sqlserver-mcp's guard cases live in
   `src/tools/tools.test.ts` too (there is no `sqlGuardrails.test.ts` there).
5. **Token list changes** must satisfy ADR 0002's two-part rule — (1) the dialect executes it as a
   statement, (2) it is not a legal identifier/function in ordinary reads. Never union lists across
   dialects (e.g. SQLite omits `replace`; T-SQL omits `comment`). T-SQL scanner switches
   (`dollarQuotedStrings`, `escapeStrings`, `bracketQuotedIdentifiers`) are part of the guard — a
   wrong one **erases** statement text before the token check.
6. **Engine-level backstop.** postgres reads run inside `set local transaction read only` +
   `statement_timeout` (`src/tools/readTools.ts`). T-SQL has no equivalent: the control is a
   `db_datareader` login + `SQLSERVER_ALLOWED_DATABASES` — do not claim parity.
7. **Logs.** SQL is logged as `queryHash`, not raw text, and driver errors do not reach the caller
   verbatim (postgres-mcp's error fallback exists because driver messages can carry a connection
   string).
8. **Tests.** Each new rule has an accepted and a refused case.

### Verify

```bash
cd postgres-mcp && npm run test        # unit tests (src/**/*.test.ts); write/ddl lanes: test:write-flow, test:ddl-flow (need Docker + a build; skip without it)
cd sqlserver-mcp && npm run test
cd observe-mcp && npm run test
cd codebase-index-mcp && npm run test:sqlite-guardrails
```

---

## Part 2 — Resource bounds

The rule: every `limit`/`timeoutMs`-style input has a default and a hard maximum from config, is
**clamped**, and the schema, README and runtime agree.

### Where the bounds live

Declared once in `packages/manifest/src/envSpecs/<server>.ts`, read only by the server's
`src/config/`, rendered into `.env.example` and the README env table by `generate:all`.

| Server | Knobs (env) | How the bound is applied |
|---|---|---|
| `postgres-mcp` | `POSTGRES_DEFAULT_LIMIT` / `_MAX_LIMIT`, `POSTGRES_DEFAULT_TIMEOUT_MS` / `_MAX_TIMEOUT_MS`, `POSTGRES_EXPLAIN_COST_WARN_THRESHOLD`, `POSTGRES_WRITE_SAMPLE_LIMIT`; DDL lane `POSTGRES_DDL_*_TIMEOUT_MS`, EF lane `POSTGRES_MIGRATION_LOCK_TIMEOUT_MS` | `Math.min(requested ?? default, max)`, then the query is wrapped `select * from (…) limit N` inside `set local transaction read only` + `set local statement_timeout` (`src/tools/readTools.ts`) |
| `sqlserver-mcp` | `SQLSERVER_DEFAULT_LIMIT` / `_MAX_LIMIT`, `SQLSERVER_DEFAULT_TIMEOUT_MS` / `_MAX_TIMEOUT_MS`, `SQLSERVER_MAX_FANOUT_DATABASES`, `SQLSERVER_POOL_MAX_CONNECTIONS`, `SQLSERVER_MAX_POOLS`, `SQLSERVER_POOL_IDLE_TIMEOUT_MS`, `SQLSERVER_EXEC_TIMEOUT_MS` | `clamp()` in `src/tools/common.ts`. **T-SQL has no LIMIT** — rows are bounded by cancelling the stream (`src/repositories/queryRunner.ts`, `truncated`), the statement is never rewritten. Fan-out over `databases[]` is capped by `SQLSERVER_MAX_FANOUT_DATABASES` and runs at `MAX_FANOUT_CONCURRENCY` |
| `observe-mcp` | `OBSERVE_DEFAULT_LIMIT` / `OBSERVE_MAX_LIMIT`, `OBSERVE_DEFAULT_LOOKBACK_MS` / `OBSERVE_MAX_LOOKBACK_MS`, `OBSERVE_TIMEOUT_MS`, `OBSERVE_MAX_RETRIES`, `OBSERVE_MSG_MAX_*` / `OBSERVE_EXC_MAX_*` (per-profile truncation) | `clampSize` and the lookback cap in `src/services/queryBuilder.ts`; HTTP abort timer in `src/services/observeClient.ts` |
| `codebase-index-mcp` | `CODEBASE_INDEX_MAX_LIMIT`, `CODEBASE_INDEX_MAX_DEPTH`, parse/edge caps | zod schema maxima built from config (`src/types/schemas/`, wired in e.g. `src/tools/graphImpact.ts`) — over-max is **rejected** as `VALIDATION_ERROR`, not clamped |

`@mcp/core` exports `resolveLimit` / `resolveTimeoutMs` / `createLimitPolicy`, but **no server
uses them today** — each clamps locally as above. Use the helper for new code; do not claim existing
servers do.

### Checklist for a new or changed bounded parameter

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

### Verify

```bash
npm run generate:all && npm run generate:check     # env table / .env.example follow the manifest
cd <server> && npm run build && cd .. && npm run contracts:update -- --server <key>   # read git diff contracts/
cd <server> && npm run test
```

---

## Output

One block per part that was run:

- **SQL construction:** `pass` / `fail`, then each violation as
  `file:line — what reaches SQL unbound — exact fix`.
- **Resource bounds:** budget table (parameter → default → max → env var → enforcement
  `file:line`), then gaps and risks.

## Authoritative reference

SQL construction — token-list rule: `docs/decisions/0002-sql-guardrail-token-lists.md`. T-SQL
scanner, shape rule and allowlist: `docs/decisions/0004-tsql-guardrail-policy.md`. DDL lane
tokenizer: `docs/decisions/0005-ddl-migration-lane.md`. Mechanism: `@mcp/shared/sql`
(`packages/shared/README.md`).

Resource bounds — env contract and defaults: `packages/manifest/src/envSpecs/*.ts` (rendered into
each server's README — never hand-edit the generated table). Field semantics (`default` vs
`codeDefault`): `docs/servers/server-development.md` §2. Limit helpers: `@mcp/core` `limits`
(`packages/core/README.md`).
