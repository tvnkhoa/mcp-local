---
name: db-parameterization-audit
description: "Audit how SQL text is BUILT and VALIDATED in this workspace's four SQL-emitting servers (postgres-mcp, sqlserver-mcp, observe-mcp, codebase-index-mcp's SQLite query tool): bind parameters vs string interpolation, identifier quoting, literal escaping where the backend has no bind params, and the per-dialect read-only guardrail and its forbidden-token list. Use when a diff touches a sqlGuardrails/ddlGuardrails/writeGuardrails file, a query builder, a repository that composes SQL, or a FORBIDDEN_TOKENS list. Not for limits/timeouts (db-query-budgeting) or a whole-server pre-merge review (mcp-security-review)."
---

# DB Parameterization Audit

Narrow audit of one question: **can caller input change the shape of a SQL statement?** Policy is
already loaded from `.claude/rules/db-guardrails.md`; this is the repo-specific checklist.

## Where SQL is built, per server

| Server | Validator (read lane) | How values reach SQL | Identifiers |
|---|---|---|---|
| `postgres-mcp` | `src/middleware/sqlGuardrails.ts` (+ `writeGuardrails.ts`; DDL lane `ddlGuardrails.ts` has **its own tokenizer, not `scanSql`** — ADR 0005) | `$1…$n` bind params (`args.params`) | `quoteIdent` in `src/middleware/ident.ts` — the only permitted quoting primitive |
| `sqlserver-mcp` | `src/middleware/sqlGuardrails.ts` — T-SQL scan switches, 4-part-name refusal, allowlist over 3-part names (ADR 0004) | `request.input("p1", …)` (`src/tools/queryTools.ts`, `execTools.ts`) | bracketed; `execute_routine` takes a routine name + typed params, never statement text |
| `observe-mcp` | `src/middleware/sqlGuardrails.ts` | **No bind params exist in the OpenObserve search API** — values go through `sqlString()` (quote doubling) in `src/services/queryBuilder.ts` | `sqlIdent()` / column validators reject anything outside `[A-Za-z0-9_.-]`; trace ids via `assertTraceId` (hex only) |
| `codebase-index-mcp` | `src/middleware/sqliteGuardrails.ts` (`query_graph`) | better-sqlite3 prepared statements | — |

All read-lane validators sit on `@mcp/shared/sql` (`scanSql` → `isSelectLike` →
`hasMultipleStatements` → `findForbiddenToken`), which ships the mechanism and **no token list**.

## Checklist

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

## Verify

```bash
cd postgres-mcp && npm run test        # unit tests (src/**/*.test.ts); write/ddl lanes: test:write-flow, test:ddl-flow (need Docker + a build; skip without it)
cd sqlserver-mcp && npm run test
cd observe-mcp && npm run test
cd codebase-index-mcp && npm run test:sqlite-guardrails
```

## Output

`pass` / `fail`, then each violation as `file:line — what reaches SQL unbound — exact fix`.

## Authoritative reference

Token-list rule: `docs/decisions/0002-sql-guardrail-token-lists.md`. T-SQL scanner, shape rule and
allowlist: `docs/decisions/0004-tsql-guardrail-policy.md`. DDL lane tokenizer:
`docs/decisions/0005-ddl-migration-lane.md`. Mechanism: `@mcp/shared/sql` (`packages/shared/README.md`).
