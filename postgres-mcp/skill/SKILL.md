---
name: {{KEY}}
description: "PostgreSQL via the {{DISPLAY_NAME}}: run read-only SQL, inspect tables/columns/foreign keys, profile a table, compare schema or data between environments (dev vs staging vs prod), and - only when enabled - previewed writes with rollback, EF Core migrations and raw-SQL DDL migrations. Use for: query the database, query prod, how many rows, check this table, what columns does X have, schema drift between envs, did the seed/deploy land, add a migration, apply/rollback a migration, create an index. Not for Microsoft SQL Server / T-SQL (use sqlserver-mcp) or OpenObserve logs (observe-mcp). Read-only by default; prod is always read-only."
---

# {{DISPLAY_NAME}}

{{TAGLINE}} Tools are exposed as `{{TOOL_NAMESPACE}}`.

**Read-only is the default.** Reach for a write or migration tool only when the user asks for that
change and its flag is on. **`prod` is force read-only regardless of config** — writes, migrations and
DDL previews are refused there; say so instead of looking for a way round.

## Step 0 — Orient

```
list_environments()                          // configured envs, which are writable
health_check(environment?)                   // connectivity for one env
list_tables(environment?, schema?)
describe_table(environment?, table, schema?) // columns, types, keys (schema defaults to public)
get_table_relationships(environment?, table?)
```

Pass `environment` explicitly for anything that matters; omitted, it is `POSTGRES_DEFAULT_ENVIRONMENT`.
Only `POSTGRES_ALLOWED_ENVIRONMENTS` are reachable. Never guess an environment name — list them.

## Read data

```
run_read_query(sql: "SELECT ... WHERE id = $1 LIMIT 100", params: [42], environment?, limit?, timeoutMs?)
run_read_query(sql, explain: true)           // plan + estimated cost, does not execute
```

- One `SELECT` or `WITH … SELECT`; anything else, or a second statement, is refused. It runs in a
  read-only transaction.
- Bind values with `params` (`$1`, `$2`, …). Never concatenate user input into `sql`.
- `limit` is clamped to `POSTGRES_MAX_LIMIT`, `timeoutMs` to `POSTGRES_MAX_TIMEOUT_MS`. EXPLAIN cost
  above `POSTGRES_EXPLAIN_COST_WARN` adds a warning.
- `profile_table(table)` for null ratios / distinct counts; `compare_environments(source, target)` for
  schema drift; `data_diff(source, target, table)` for row-count + checksum equality.

## Writes — OFF unless `POSTGRES_WRITE_ENABLED=true`, only in `POSTGRES_WRITABLE_ENVIRONMENTS`

```
write_preview(sql, params?, environment)     // dry run, rolled back: sample rows, previewId, approvalToken
// show the user the sample + row count; wait for an explicit yes
write_apply(previewId, approvalToken)        // returns rollbackId (or null)
write_rollback(rollbackId)
```

- `UPDATE`/`DELETE` need a `WHERE`. `allowFullTable: true` lifts that — only on an explicit request
  for a whole-table change.
- Tokens are HMAC-signed and expire (`POSTGRES_WRITE_PREVIEW_TTL_MS`, 15 min). Re-preview, never
  reuse an expired or drifted token.
- **Read `rollbackSupported` / `rollbackNote` before applying.** No rollback for: a table with no
  primary key, a statement with its own `RETURNING`, `ON CONFLICT DO UPDATE`, an `UPDATE` that sets a
  PK column or uses non-plain `SET`, a parameterized / joined / whole-table `UPDATE`, or more than
  10,000 rows. If the user needs undo, rewrite the statement (split the upsert, batch the delete).
- `write_rollback` restores rows one by one. `partial`/`failed` is retryable and retries only the
  rows in `unrestored[]`; a row someone changed since the apply is reported as
  `row_changed_since_apply`, not overwritten.
- `mcp_ops` is the server's own audit schema: writes to it fail with `WRITE_RESERVED_SCHEMA`.

## EF Core migrations — OFF unless `POSTGRES_MIGRATION_ENABLED=true`

```
migration_status(environment)
migration_add(name)                          // needs POSTGRES_DOTNET_PROJECT (+ _STARTUP_PROJECT)
migration_preview(environment)               // pending SQL delta + approvalToken
migration_dry_run(environment)
migration_apply(previewId, approvalToken, environment, acknowledgeRisks?)
```

Rollback: `migration_preview(environment, targetMigration: "<applied id>" | "0")` lists
`revertMigrations` newest first with their Down SQL; apply then needs `acknowledgeRisks` including
`EF_REVERT`.

## Raw-SQL DDL migrations — OFF unless `POSTGRES_DDL_ENABLED=true`

```
ddl_status(environment)                      // applied / pending / edited / missing — read-only, works on prod
ddl_create(name, up, down?, noTransaction?)  // writes V<ts>__<name>.up/.down.sql; touches no database
ddl_preview(environment, direction?, target?) // plan + approvalToken + requiredAcknowledgements; or pass `sql` for inline DDL
ddl_dry_run(previewId)                       // runs in a transaction and rolls back — takes real locks
ddl_apply(previewId, approvalToken, acknowledgeRisks?)
```

- `up` accepts CREATE/ALTER/DROP/COMMENT ON only. Data changes go through `write_preview`: add the
  column nullable, backfill with `write_preview`, then `SET NOT NULL`.
- `CREATE INDEX CONCURRENTLY` → `noTransaction: true`, alone in its migration; dry-run reports it
  `skipped`.
- Roll back with `ddl_preview(direction: "down", target: "<version>" | "0")`; each reverted migration
  needs its `.down.sql`. Always write a `down`.
- `write_preview` and `run_read_query` both refuse DDL.

| Apply refusal | Do |
|---|---|
| `DDL_DRIFT` | schema, ledger or files changed — `ddl_preview` again, never retry the old token |
| `DDL_LOCKED` / `MIGRATION_LOCKED` | another session is migrating this database — wait, then retry |
| `DDL_POOLED_CONNECTION` / `MIGRATION_POOLED_CONNECTION` | PgBouncer transaction pooling — needs a direct connection or session mode; tell the user, do not retry |
| `DDL_LOCK_TIMEOUT` | a table is busy — retry off-peak |
| `DDL_CHECKSUM_MISMATCH` | an applied file was edited — restore it, write a new migration |
| `DDL_APPLY_FAILED` | the SQL failed — read `error.detail` |

## Guardrails

- **Never fill in `acknowledgeRisks` yourself** (EF or DDL). Show each risk's message — data loss
  (`DROP_TABLE`, `DROP_COLUMN`, `EF_REVERT`), rewrites and long locks (`ALTER_COLUMN_TYPE`,
  `SET_NOT_NULL`, `ADD_COLUMN_VOLATILE_DEFAULT`), privilege changes (`SECURITY_DEFINER`) — and wait for
  an explicit yes.
- Never echo connection strings, passwords or `PGPASSWORD`; report env vars by name only.
- Smallest scope: explicit `environment`, explicit `LIMIT`, read-only unless asked.

## Configuration (env)

Server entry: `node {{ENTRY_PATH}}`

A connection source is required — **one** of `POSTGRES_CONNECTION`, `POSTGRES_ENV_*`, or
`POSTGRES_APPSETTINGS_ROOTS`. Pre-S-43 names (`CH_*`, `PG_*`, `MCP_DB_*`) still work with a one-time
deprecation warning; write the canonical names.

{{ENV_TABLE}}

## Tool reference

{{TOOL_LIST}}
