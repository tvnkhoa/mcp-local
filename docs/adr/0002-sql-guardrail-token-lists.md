# ADR 0002 — SQL guardrail forbidden-token lists stay per-dialect

**Status** — Accepted
**Step** — S-18 (Phase E)
**Date** — 2026-07-28

## Context

Three servers run a read-only SQL guard, all built on the same mechanism in
`@mcp/shared` (`stripStringsAndComments` → `isSelectLike` → `hasMultipleStatements` →
`findForbiddenToken`). `packages/shared/src/sql/index.ts` states the split in its header:

> MECHANISM ONLY. This module never ships a forbidden-token list — the caller [supplies it].

Each server therefore owns its own list, and the three had drifted:

| Server | Dialect | Tokens |
|---|---|---:|
| `postgres-mcp` | PostgreSQL | 18 |
| `codebase-index-mcp` | SQLite | 16 |
| `observe-mcp` | DataFusion (OpenObserve) | 13 |

S-18 asked one question: are `observe-mcp`'s five omissions — `comment`, `do`,
`analyze`, `reindex`, `refresh` — correct for OpenObserve, or simply stale?

## The rule this ADR establishes

A token belongs on a dialect's list only if **both** hold:

1. **The dialect can execute it as a statement.** A token the engine cannot parse guards
   nothing.
2. **It is not a valid identifier or function name in that dialect's ordinary read
   queries.** `findForbiddenToken` matches on word boundaries anywhere in the cleaned
   statement. Strings and comments are stripped first; **identifiers are not**. So every
   token added also rejects any column, alias, or function with that name.

Point 2 is the part that is easy to miss, and it is why "union all three lists" is wrong.

## Decision

**All five omissions are correct. `observe-mcp`'s list is unchanged.**

| Token | Does DataFusion execute it? | Verdict |
|---|---|---|
| `comment` | No — `COMMENT ON` is a PostgreSQL DDL statement | Stay out |
| `do` | No — `DO` is a PL/pgSQL anonymous block | Stay out |
| `analyze` | Only as `EXPLAIN ANALYZE`, which is read-only and cannot begin a statement that passes `isSelectLike` | Stay out |
| `reindex` | No | Stay out |
| `refresh` | No — DataFusion has no materialized views | Stay out |

This reverses the plan's provisional guess that `do` and `comment` "likely go in".

### Why the token list carries little weight in `observe-mcp` specifically

Two checks already run before it: the statement must start with `select`/`with`, and it
must be a single statement. The only way a forbidden statement survives both is nested
inside a SELECT/WITH — the PostgreSQL `WITH x AS (DELETE … RETURNING *) SELECT * FROM x`
attack, which `postgres-mcp` has a regression test for. **DataFusion does not support DML
inside CTEs**, so for OpenObserve the token list is a tripwire against a future engine
change, not a live control.

Against that near-zero benefit, each added token carries a real cost: OpenObserve streams
are **schemaless** — `describe_stream` discovers fields by sampling, so new fields appear
whenever an application logs a new property. A future field named `comment` would make
plain `SELECT comment FROM …` fail with `Forbidden SQL token detected: comment`, which
reads as a bug, not a policy.

### The same rule explains an apparent gap in the SQLite list

`codebase-index-mcp` omits `replace`, even though SQLite's `REPLACE INTO` is a genuine
write statement. That passes rule 1 but **fails rule 2**: `replace(x, y, z)` is a SQLite
scalar function, and `SELECT replace(name,'a','b') FROM symbols` is an ordinary query.
Adding `replace` would break legitimate reads while blocking nothing that `isSelectLike`
does not already reject.

Recorded here because it looks like an oversight on inspection and is not one.

### Where each list keeps a dialect-specific token

- `postgres-mcp` only: `copy`, `call`, `do`, `refresh`, `merge`
- `codebase-index-mcp` only: `attach`, `detach`, `pragma` — all real SQLite statements
- shared by all three: `insert`, `update`, `delete`, `truncate`, `alter`, `drop`,
  `create`, `grant`, `revoke`, `vacuum`

## Evidence gathered

- `describe_stream` over the live `wecrm_easyserv_dev` stream: **46 fields, none** named
  `comment`, `do`, `analyze`, `reindex`, or `refresh`. No collision exists today — the
  false-positive risk is latent, not current.
- `information_schema.columns` over the dev PostgreSQL database, filtered to all thirteen
  candidate names: **0 rows**. `postgres-mcp`'s inclusion of `comment` and `analyze` is
  likewise not causing a live false positive.

Both are negative results and are recorded as such: the decision rests on dialect
capability, not on an observed failure.

## Consequences

- No code change. `observe-mcp/src/guardrails/sqlGuardrails.ts` keeps 13 tokens.
- The rule above is pinned by a regression test in
  `observe-mcp/src/guardrails/sqlGuardrails.test.ts`, so a future "let's just union the
  lists" change fails with a pointer back to this ADR.
- Adding a token to any list is now a decision with two stated criteria rather than a
  judgement call.

## Revisit if

- OpenObserve/DataFusion gains DML-in-CTE support, or any of the five statements.
- A stream or table acquires a column named after a token already on its server's list —
  in which case the trade-off in rule 2 has flipped and that token needs re-examining.
