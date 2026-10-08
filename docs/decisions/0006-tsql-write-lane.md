# ADR 0006 — `sqlserver-mcp` gets a previewed write lane for T-SQL batches

**Status** — Accepted
**Date** — 2026-10-08

## Context

[ADR 0004](./0004-tsql-guardrail-policy.md) made `sqlserver-mcp` read-only plus one gated exec lane.
`execute_routine` runs only stored procedures, and it binds parameters rather than accepting
statement text. That left no way to run a small, idempotent seed on a development catalog. The case
that prompted this ADR is a ~60-line `CRM_Identity` batch: `DECLARE`, a table variable,
`INSERT … WHERE NOT EXISTS` into two tables, all inside `BEGIN TRY / BEGIN TRAN … COMMIT` with
`ROLLBACK; THROW` in the `CATCH`. Running it meant opening SSMS. `postgres-mcp` already has
`write_preview` → `write_apply` → `write_rollback`.

That lane cannot be copied across. It accepts **one** `INSERT`/`UPDATE`/`DELETE` and captures
before-images so it can roll back. A seed is a batch with control flow. And T-SQL transactions do
not nest the way the batch's author might assume.

## Decision

Two tools, `write_preview` and `write_apply`, behind their own gates. They are separate from the
exec lane because they are a different capability with a different risk.

### Gates (each refusal names its gate in the error code)

| Gate | Code | Note |
|---|---|---|
| `SQLSERVER_WRITE_ENABLED` (strict flag) | `policy_violation` | Off by default. Both tools carry the guard. |
| Environment is `prod` or `uat` (after `canonicalEnvName`, so `production`/`test`/`testing` too) | `environment_never_writable` | Unconditional. The list below cannot override it. |
| Environment not in `SQLSERVER_WRITABLE_ENVIRONMENTS` | `environment_not_writable` | Empty means **none**, not all. The name follows `POSTGRES_WRITABLE_ENVIRONMENTS`. |
| `SQLSERVER_ALLOWED_DATABASES` | `database_not_allowed` | Through `ConnectionManager.resolve`, as everywhere else in the server. |
| `SQLSERVER_READONLY_DATABASES` | `database_readonly` | The never-execute list now also means never-write. |
| A three-part name naming any *other* real catalog | `write_cross_catalog` | A write batch addresses one catalog. Reads from other catalogs are refused too: no text check can reliably tell an `INSERT … SELECT`'s target from its source. |

`write_apply` trusts only configuration and its stored preview, never the caller's arguments. It
re-resolves the stored target, re-runs every gate and re-validates the stored text.

### What the guardrail accepts

The guardrail accepts a batch that starts with `BEGIN`/`DECLARE`/`SET`/`INSERT`/`UPDATE`/`DELETE`/
`MERGE`/`WITH`/`SELECT`/`IF` and contains at least one write verb. The leading-keyword rule is not
cosmetic. T-SQL executes a bare procedure name on a batch's first line without `EXEC`, and no token
check sees that.

It refuses ADR 0004's list minus the four data verbs, plus `use`, `trigger`, `setuser`, `writetext`,
`updatetext`, any `xp_*`, `save`, `distributed` and `goto`. It also refuses `GO`, which is a
client-side separator, and four-part names. `INTO` is allowed after `INSERT`/`MERGE` or before a
`@table`/`#temp`. Any other `INTO` is `SELECT … INTO`, which creates a permanent table. `USE`/`GO`
are refused, not tolerated, because the `database` argument names the catalog and one batch keeps
the verify `SELECT` inside the same transaction.

### How a preview persists nothing

This is the part that is easy to get wrong. The runner pins one connection with `mssql.Transaction`
and runs:

```
BEGIN TRAN (driver)                          @@TRANCOUNT = 1
SET XACT_ABORT ON; BEGIN TRAN × N            N = COMMIT tokens in the batch → 1 + N
<the batch, byte-for-byte>
SELECT @@TRANCOUNT                           must equal 1 + N, else roll back and refuse
preview: ROLLBACK        apply: compare rowsAffected, then COMMIT × N, COMMIT
```

- **A `COMMIT`** in the batch only decrements `@@TRANCOUNT`. It commits for real only when the count
  reaches zero, and the N extra levels make that unreachable as long as each `COMMIT` runs at most
  once. Without a backward jump T-SQL runs each statement once or not at all, so `WHILE` and `GOTO`
  are refused in a batch that commits. A loop without `COMMIT` is allowed.
- **A `ROLLBACK`** goes straight to zero at any level, and every statement after it autocommits.
  The only harmless position is `ROLLBACK [TRAN]; THROW …;` immediately closing a top-level `CATCH`.
  That `THROW` ends the batch. Inside a nested `TRY` it would not end the batch: it would jump to the
  outer `CATCH` and keep running. Every other `ROLLBACK` is refused, along with `SAVE TRAN` and
  rollback to a savepoint. The batch's own error path therefore still works, and preview reports its
  error.
- **`XACT_ABORT ON`** turns a run-time error into a whole-transaction rollback rather than a
  half-applied batch that carries on.
- **The `@@TRANCOUNT` check** is the run-time backstop for whatever the text check missed, such as a
  `BEGIN TRAN` with no `COMMIT`. It applies in apply as well as in preview.

### Approval and apply

`write_preview` returns `previewId` and `approvalToken`, using the shared `@mcp/shared` preview-token
format. The token is bound to a digest of environment, catalog, exact SQL and the preview's
`rowsAffected`. Previews live in memory, are single-use, and expire after
`SQLSERVER_WRITE_PREVIEW_TTL_MS` (15 min). `SQLSERVER_APPROVAL_SECRET` is generated per process
when unset. `write_apply` re-runs the exact batch, and if `rowsAffected` differs from the preview it
**rolls back** with `write_drift` rather than commit something nobody reviewed.

### Audit

Every apply attempt, committed or not, is logged to stderr as `write_audit`. When
`SQLSERVER_WRITE_AUDIT_FILE` is set, it is also appended there as one JSON line: environment,
catalog, preview id, SQL hash, `rowsAffected`, status and time. Nothing is written to the target
database. `postgres-mcp` keeps `mcp_ops.audit_log`, but here an audit table would need exactly the
DDL this lane refuses, on a catalog the server does not own.

## Rejected

| Alternative | Why not |
|---|---|
| Route ad-hoc SQL through `execute_routine` → `sys.sp_executesql` | Erases the line ADR 0004 drew: the exec lane takes a name and bound parameters, never text. |
| Copy `postgres-mcp`'s single-statement lane | Cannot express the seed. `TRY/CATCH` and `DECLARE` are the point. |
| Refuse any batch with its own transaction control | Safe, but makes callers rewrite every script written for SSMS. The extra-levels construction keeps `COMMIT` harmless for the same safety. |
| Split on `GO` and run several batches in one transaction | More surface: a `USE` between batches, and per-batch variable scope. The `database` argument already does `USE`'s job. |
| `write_rollback` / generated inverse statements | A batch reaches any number of tables through control flow, so there is no general before-image. The preview plus the `rowsAffected` drift check is the safety mechanism. |
| Audit table in the target catalog | Needs DDL on a database the server does not own. |

## Consequences

- The deployment control is still the login. A `db_datareader` login stays read-only whatever the
  flags say, and SQL Server refuses the write. Enabling the lane needs a login with write permission
  on the dev catalog *and* the two settings.
- A preview takes real locks and fires triggers on the tables it touches for the length of the
  batch. That is why `write_preview` is not annotated `readOnly`.
- A trigger that itself commits or rolls back could get past the transaction-count reasoning. The
  `@@TRANCOUNT` check catches a trigger's unbalanced count, but not a trigger that commits the
  caller's transaction outright. That is accepted for a dev-only lane. Triggers that commit are
  already an error in SQL Server (3609).
