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
Decision 2 was amended and Decision 7 added on 2026-10-01, with four more env vars, when the lane
was pointed at a repo with its own runner.

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

**Amended 2026-10-01: privileges on named objects, and ownership to an allowlisted role.** The first
real repo brought to the lane (wec.aria, whose 0017 replaces a SELECT grant with one SECURITY DEFINER
function) showed that refusing every privilege statement does not keep a migration safe. It leaves
the migration half-applied. Without `REVOKE … FROM PUBLIC` and `GRANT EXECUTE … TO aria_review` the
intended role cannot call the function. Without `ALTER FUNCTION … OWNER TO aria` it is worse: a
SECURITY DEFINER function runs as its owner, and the owner would be whoever connected, typically a
personal admin login. So the refusal itself caused the privilege escalation it was meant to prevent.

The allowlist therefore gains three shapes, each behind a new `PRIVILEGE_CHANGE` acknowledgement:

- `GRANT` / `REVOKE` **on a named object** (table, sequence, function, procedure, routine, schema),
  to or from named roles or `PUBLIC`.
- `CREATE` / `ALTER` / `DROP POLICY`, and turning row-level security off.
- `ALTER … OWNER TO <role>`, as the statement's only action, **only to a role in
  `POSTGRES_DDL_OWNER_ROLES`** (empty by default, which refuses it). At preview the role is read
  from `pg_roles`, and a role with `SUPERUSER`, `CREATEROLE`, `BYPASSRLS` or `REPLICATION` is
  blocked even when listed, because an object it owns runs past ordinary grants.

What stays refused is what reaches beyond objects the migration names: role membership
(`GRANT role TO role`), `WITH GRANT OPTION`, `GRANTED BY`, `ON ALL … IN SCHEMA`, database-,
parameter-, language- and foreign-level privileges, `ALTER DEFAULT PRIVILEGES` (it governs objects
created later, by anyone), `REASSIGN OWNED`, and the session-role words, which make the grantee
or owner whoever runs the migration. The operator chose this scope on 2026-10-01 over "GRANT /
REVOKE only", which would have refused 0017 itself (it hands its function to `aria`) and the next
aria file that uses a policy.

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

## Decision 7 — a repo's own ledger, read and written as its runner does (added 2026-10-01)

The lane's ledger is `mcp_ops.ddl_history`. A repo that already has migrations and a runner has a
ledger too, and two ledgers that disagree are the problem the "Adopt an existing tool" rejection
below names. So `POSTGRES_DDL_EXTERNAL_LEDGER=<schema.table>` makes the repo's
`(filename, checksum)` table the only ledger, and `mcp_ops.ddl_history` is not used at all.
Either the repo's runner or `ddl_apply` can then apply the next file, and the other sees it as
applied.

Matching the runner is the whole contract, so each rule below is that runner's rule:

- **Files** are psql-style `NNNN-name.sql`, ordered by file name, forward-only.
- **The checksum** is sha256 of the file's **raw bytes**, as `sha256sum` computes it, not the
  normalized text this lane hashes in its own format. A recorded checksum that differs stops every
  plan (`DDL_CHECKSUM_MISMATCH`). The ledger is keyed by file name, so a file renamed after it
  ran also stops every plan (`DDL_LEDGER_FILENAME_MISMATCH`), because the runner would run it again.
- **psql compatibility.** `\set ON_ERROR_STOP` is dropped, because the lane already stops at the
  first error. Every other meta-command is refused, not skipped, since `\i` or `\gexec` changes what
  runs. A `BEGIN;` … `COMMIT;` that wraps the whole file is dropped, because the lane opens that
  transaction itself. Anywhere else, transaction control is refused as before.
- **The adoption guard** (`POSTGRES_DDL_ADOPTION_SENTINEL`) refuses an up plan when the schema
  exists but the ledger is empty, as the runner does: such a database was built some other way.
- **Custom settings** the runner provides (`POSTGRES_DDL_SESSION_SETTINGS`, `prefix.name=value`
  only) are set transaction-locally with bound values before each migration's statements.

Two things are **stricter** than the runner. The file and its ledger row commit in one transaction,
where the runner inserts the row in a second psql call. And the lane never creates the table: it
belongs to the repo, whose runner creates it after its own adoption guard (`DDL_LEDGER_MISSING`).
One thing is **weaker**: a failed attempt leaves no row, because that ledger has no notion of
failure. It is still in `mcp_ops.audit_log`.

**Cost, accepted:** inline SQL, `ddl_create` and down migrations are unavailable in this mode, since
the repo's ledger records files and its files have no down scripts. Anything the runner does beyond
these rules, such as wec.aria's "skip 0028/0029 until pg-boss has booted", is not reproduced, and a
file that relies on it is refused or fails visibly.

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
