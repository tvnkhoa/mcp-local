# ADR 0005 — `postgres-mcp` applies raw-SQL DDL through its own lane, with its own tokenizer

**Status** — Accepted
**Step** — the DDL migration lane, phases 0.1–1.4 (backlog B-16)
**Date** — 2026-10-01

## Context

Before this lane, `postgres-mcp`'s only path to a schema change was the EF Core wrapper.
`migration_*` shells out to `dotnet ef --no-build`, so it needs a built .NET project and an
`IDesignTimeDbContextFactory`, and it records state only in EF's own `__EFMigrationsHistory`. No
tool accepted DDL. `write_preview` refuses it outright (`DDL_NOT_ALLOWED`), and `run_read_query`'s
token list forbids `create`, `alter` and `drop`.

The lane added five tools (`ddl_status`, `ddl_create`, `ddl_preview`, `ddl_dry_run`,
`ddl_apply`), a ledger (`mcp_ops.ddl_history`), and six env vars. Six decisions below would look
wrong to a reviewer who did not see what forced them. Each one rejects the conventional choice.

## Decision 1 — a tokenizer of its own, not `@mcp/shared`'s `scanSql`

[ADR 0002](./0002-sql-guardrail-token-lists.md) puts the scanning mechanism in `@mcp/shared` and the
policy in each server. This lane breaks that split on purpose, because `scanSql` gives the wrong
answer for one of the three jobs it would have here:

| Job | Needed for | `scanSql` |
|---|---|---|
| Is there more than one statement? | Read and write lanes | Correct |
| Where does each statement end? | Splitting a migration | **Wrong in one case, unsafely** |
| Which identifiers does it name? | Refusing `mcp_ops` | **Cannot**: it blanks quoted identifiers |

The unsafe case was checked against a live PG 17. Postgres reads `foo$x$` as one identifier,
because identifiers may contain `$`. `scanSql` opens a dollar quote there instead. In
`create table foo$x$ (a int); drop table y; -- $x$` it therefore sees one statement, while Postgres
runs both and drops `y`. Splitting on `scanSql` would have sent that `drop` to the server without
the allowlist ever classifying it. `scanSql` also ends a block comment at the first `*/`, and
Postgres nests block comments.

`postgres-mcp/src/middleware/ddlGuardrails.ts` therefore has a tokenizer that follows Postgres's
lexer in each of these places. Where it cannot follow the server, it refuses rather than guesses:
`U&'…'` and `U&"…"` carry their own escapes, and `BEGIN ATOMIC` bodies contain `;`. **It is the
second line of defence, not the only one.** Every statement then runs over the extended protocol,
and Postgres itself refuses two commands in one Parse (`42601`, also checked live).

**Cost, accepted:** a second lexer in the workspace, which can drift from the shared one. It
stays local until a second consumer needs statement splitting. When one does, it moves to
`@mcp/shared` whole; it is not merged into `scanSql`, whose three current callers depend on its
present behaviour.

## Decision 2 — an allowlist, not a forbidden-token list

The read lane forbids 18 tokens. A migration is made of `create`, `alter` and `drop`, so the
token approach can only invert, and an inverted token list cannot see shape. `create role`,
`create table … as select` (it writes data) and `create schema s … grant …` (a schema element can
carry a GRANT) all begin with an allowed verb.

So the lane classifies each statement by verb and object kind against an explicit table: eleven
object kinds, plus `COMMENT ON` and `CREATE EXTENSION`. A few shape checks sit on top: no `OWNER TO`,
no `CREATE TABLE AS`, only the bare `CREATE SCHEMA name`, and function bodies in `sql` or `plpgsql`
only. Everything else is refused with a reason that points to the right lane. DML goes to
`write_preview`, whose row-count preview and rollback a migration lane would only duplicate.

`mcp_ops` is refused wherever a script names it, quoted or not, and not only in the target position.
No migration needs to name it. Run-time writes there (a volatile default, a trigger, a function the
migration calls) are caught separately. The check reads the `pg_stat_xact_user_tables` counters
before and after the migration, in the same transaction; `services/internalWriteGuard.ts` explains
why only that difference is trusted.

## Decision 3 — a non-transactional migration is exactly one statement

`CREATE INDEX CONCURRENTLY`, `DROP INDEX CONCURRENTLY` and `DETACH PARTITION … CONCURRENTLY` cannot
run inside a transaction. Flyway and similar tools let a migration opt out of its transaction and
then hold any number of statements. A failure part-way leaves the migration half-applied, and those
tools need a "dirty" state and a repair command to recover from it.

Here such a migration must be a single statement (`DDL_NO_TRANSACTION_MULTI_STATEMENT`). A failure
then leaves nothing half-done, with one exception the lane reports instead of hiding: a failed
`CONCURRENTLY` build can leave an INVALID index, which apply names in `invalidIndexesLeft`. No dirty
state exists, so no repair tool is needed.

**Cost, accepted:** two concurrent index builds are two migrations.

## Decision 4 — rollback is a direction of `ddl_preview`, not a separate rollback tool

Reverting a migration runs DDL. A separate tool would need its own preview, token, drift guard and
risk gate, so it would either duplicate them or skip them. `ddl_preview { direction: "down",
target }` goes through all of them unchanged. Its down scripts are linted like any other script, so
a down that drops a column needs `DROP_COLUMN` acknowledged.

## Decision 5 — no environment list of its own

The lane writes wherever the write lane writes (`POSTGRES_WRITABLE_ENVIRONMENTS`), and `prod` is
never writable. A `POSTGRES_DDL_ENVIRONMENTS` was proposed and declined by the operator on
2026-09-30, to keep one answer to "where can this server change things".

**Cost, accepted:** the default writable set includes the legacy `default` environment.
[PG-SEC-001](../../postgres-mcp/docs/mcp-postgres-issue-registry.md) shows that list has been
misconfigured before, and DDL is more dangerous than DML.

## Decision 6 — freshness is a re-plan, not a token TTL

`ddl_apply` verifies its token with `ignoreExpiry`, as `migration_apply` does after PG-PRV-002. It
then plans the same request again inside the locked session and requires the same digest. The digest
binds the environment, the schema snapshot, the ledger state and every step's checksum, action,
mode and timeouts. Equal digests mean the plan is unchanged, whatever the clock says. Unequal ones
refuse with `DDL_DRIFT`, naming which of the ledger, the schema or the files moved.

## Alternatives rejected

- **Adopt an existing tool (Flyway, sqitch, node-pg-migrate).** Each brings its own CLI or runtime,
  its own ledger and its own idea of a non-transactional migration (Decision 3), and none of them
  knows about `mcp_ops`, the approval token or the risk gate. Wrapping one would leave two ledgers
  to reconcile. The EF lane already shows the cost of a wrapped tool: it is the half of this server
  that CI cannot test.
- **Extend `write_preview` to accept DDL.** Its contract is one statement with a row count and a
  rollback. DDL has neither a row count nor a row-level undo.
- **Make the EF lane the only migration path.** It cannot run DDL that is not in a C# migration, and
  it needs a .NET build on the machine running the server.

## Consequences

- **Benefit:** schema changes no longer require a .NET project. Every change is previewed,
  risk-gated, ledgered and audited, and is reversible where a down script exists.
- **Cost:** two migration lanes can change one database. EF's model snapshot does not see DDL-lane
  changes, and the next `migration_add` may try to undo them. The lane warns when
  `__EFMigrationsHistory` exists. It does not prevent the conflict.
- **Cost:** session advisory locks and session-level timeouts do not survive PgBouncer in
  transaction-pooling mode, and the lane needs a direct connection. Since B-16.1 (PG-DDL-002), a
  session that moves backend is refused (`*_POOLED_CONNECTION`). A pooler that never moves it is
  still undetectable.
