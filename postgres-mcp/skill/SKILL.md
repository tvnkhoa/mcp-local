---
name: {{KEY}}
description: "PostgreSQL: read-only SQL, tables/columns/FKs, profile a table, schema/data diff between envs; when enabled, previewed writes with rollback, EF Core and raw-SQL DDL migrations. Use for: query the database or prod, what columns does X have, did the deploy land, add/apply/rollback a migration, create an index. Not for SQL Server / T-SQL (sqlserver-mcp) or logs (observe-mcp). Prod is read-only."
---

# {{DISPLAY_NAME}}

{{TAGLINE}} Tools are exposed as `{{TOOL_NAMESPACE}}`.

**Read-only is the default.** Use a write or migration tool only when the user asks for that change
and its flag is on. **`prod` is force read-only regardless of config** — say so instead of looking
for a way round.

## Step 0 — Orient

```
list_environments()                          // configured envs, which are writable
health_check(environment?)
list_tables(environment?, schema?)
describe_table(environment?, table, schema?) // columns, types, keys
```

Pass `environment` explicitly for anything that matters; never guess a name — list them.

## Read data

```
run_read_query(sql: "SELECT ... WHERE id = $1 LIMIT 100", params: [42], environment?, limit?)
run_read_query(sql, explain: true)           // plan + cost, does not execute
```

- One `SELECT` / `WITH … SELECT`, in a read-only transaction. Bind values with `params` (`$1`, …);
  never concatenate user input into `sql`. `limit` and `timeoutMs` are clamped.
- `compare_environments(source, target)` for schema drift; `data_diff(source, target, table)` for
  row-count + checksum equality.

## Writes — off unless `POSTGRES_WRITE_ENABLED=true`

```
write_preview(sql, params?, environment)     // dry run, rolled back: sample rows, previewId, approvalToken
// show the user the sample + row count; wait for an explicit yes
write_apply(previewId, approvalToken)        // returns rollbackId (or null)
write_rollback(rollbackId)
```

- `UPDATE`/`DELETE` need a `WHERE`; `allowFullTable: true` only on an explicit whole-table request.
- Tokens expire — re-preview, never reuse an expired or drifted token.
- **Read `rollbackSupported` / `rollbackNote` before applying.** No rollback for e.g. a table without
  a primary key, `RETURNING`, `ON CONFLICT DO UPDATE`, or more than 10,000 rows. If the user needs
  undo, rewrite the statement (split the upsert, batch the delete).
- A `partial`/`failed` rollback is retryable; a row changed since the apply is reported
  (`row_changed_since_apply`), not overwritten.

## EF Core migrations — off unless `POSTGRES_MIGRATION_ENABLED=true`

```
migration_status(environment)
migration_add(name)
migration_preview(environment)               // pending SQL + approvalToken
migration_apply(previewId, approvalToken, environment, acknowledgeRisks?)
```

Rollback: `migration_preview(environment, targetMigration: "<applied id>" | "0")`; apply then needs
`acknowledgeRisks` including `EF_REVERT`.

## Raw-SQL DDL migrations — off unless `POSTGRES_DDL_ENABLED=true`

```
ddl_status(environment)                      // read-only, works on prod
ddl_create(name, up, down?, noTransaction?)  // writes the files; touches no database
ddl_preview(environment, direction?, target?) // plan + approvalToken + requiredAcknowledgements
ddl_dry_run(previewId)                       // runs and rolls back — takes real locks
ddl_apply(previewId, approvalToken, acknowledgeRisks?)
```

- DDL only; data changes go through `write_preview` (add the column nullable, backfill, then
  `SET NOT NULL`). A `DO` body is not checked: read it to the user before they acknowledge `DO_BLOCK`.
- `CREATE INDEX CONCURRENTLY` → `noTransaction: true`, alone in its migration.
- Always write a `down`; roll back with `ddl_preview(direction: "down", target: "<version>" | "0")`.
- `DDL_DRIFT` → preview again, never retry the old token. `DDL_LOCKED` / `MIGRATION_LOCKED` → wait.
  `*_POOLED_CONNECTION` → needs a direct connection; tell the user, do not retry.
  `DDL_CHECKSUM_MISMATCH` → an applied file was edited: restore it, write a new migration.

## Guardrails

- **Never fill in `acknowledgeRisks` yourself** (EF or DDL). Show each risk — data loss
  (`DROP_TABLE`, `DROP_COLUMN`, `EF_REVERT`), rewrites and long locks, privilege changes, row changes
  (`DATA_CHANGE`), unchecked code (`DO_BLOCK`) — and wait for an explicit yes.
- Never echo connection strings or passwords; name env vars only.
- Smallest scope: explicit `environment`, explicit `LIMIT`, read-only unless asked.

Setup, connection sources, env vars and troubleshooting: see `postgres-mcp/README.md`.

## Tool reference

{{TOOL_LIST}}
