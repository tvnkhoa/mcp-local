---
name: {{KEY}}
description: "Query PostgreSQL safely via the {{DISPLAY_NAME}}: read-only SQL, table/schema inspection, multi-environment access, and gated writes/migrations. Triggers on: query the database, run SQL, inspect a table/schema, compare environments, diff data, EF Core migration. Read-only by default; prod is always read-only."
---

# {{DISPLAY_NAME}}

{{TAGLINE}} Tools are exposed as `{{TOOL_NAMESPACE}}`.

Use this to inspect schema, run read-only SQL, compare environments, and (when explicitly enabled) apply reviewed writes or EF Core migrations. **Read-only is the default** — reach for write/migration tools only when the user asks and the corresponding flag is on.

## Step 0 — Orient

```
list_environments        // which envs are configured + which are writable
list_tables(environment?) // discover tables
describe_table(table)     // columns, types, keys
get_table_relationships(table)
```

## Read queries (default path)

```
run_read_query(sql: "SELECT ... WHERE ... LIMIT 100", environment?, limit?, timeoutMs?, explain?)
```
- Only `SELECT` and `WITH ... SELECT` are allowed. Multi-statement and mutation tokens are blocked.
- Always bound results with a `LIMIT` (server also caps via `POSTGRES_DEFAULT_LIMIT`/`POSTGRES_MAX_LIMIT`).
- Use `explain:true` to see the plan; a warning fires when EXPLAIN cost exceeds `POSTGRES_EXPLAIN_COST_WARN`.
- `profile_table`, `compare_environments`, `data_diff` for profiling and cross-env comparison.

## Environment selection

Pass `environment` explicitly for anything sensitive. `POSTGRES_DEFAULT_ENVIRONMENT` is used when omitted. Only envs in `POSTGRES_ALLOWED_ENVIRONMENTS` are reachable; only those in `POSTGRES_WRITABLE_ENVIRONMENTS` accept writes. **`prod` is force read-only regardless of config.**

## Writes (OFF unless `POSTGRES_WRITE_ENABLED=true`) — preview → apply → rollback

```
write_preview(sql, environment)   // returns previewId, approvalToken, affected sample, mandatory-WHERE check
// review the sample + row estimate carefully
write_apply(previewId, approvalToken)
write_rollback(rollbackId)        // if needed
```
- A `WHERE` clause is **mandatory** for UPDATE/DELETE — unbounded mutations are rejected.
- Approval tokens are HMAC-signed and expire (`POSTGRES_WRITE_PREVIEW_TTL_MS`, default 15 min).

**Check `rollbackSupported` in the preview before you apply.** Rollback is offered only when the
server can capture the undo data itself. When it cannot, the preview says so in `rollbackNote`,
`write_apply` returns `rollbackId: null`, and the change is one-way. Refused for: a table with no
primary key · a statement with its own `RETURNING` · `INSERT ... ON CONFLICT DO UPDATE` (plain
`DO NOTHING` is fine) · an `UPDATE` that assigns a primary-key column, or whose SET list cannot be
read as plain `column = value` assignments · a parameterized, joined or whole-table `UPDATE` · more
than 10,000 affected rows. If you need rollback and hit one of these, rewrite the statement — e.g.
split an upsert into a preview-able `UPDATE`, or batch a large delete. `write_apply` can also
downgrade the preview's verdict: if fewer rows were captured than the change affected, it returns
`rollbackId: null` rather than offer an undo that would be incomplete.

Rollback restores each row independently, so one conflicting row does not cost the others. Read
`status` (this call), `pending` (rows still outstanding) and `unrestored[]` (why each row failed:
`row_changed_since_apply`, `row_missing`, `version_unavailable`, `no_restorable_columns`, or
`conflict` with the Postgres `sqlState`). A `partial` or `failed` rollback is **retryable** and
retries only what is left. A row somebody else changed after the apply is reported as
`row_changed_since_apply` rather than overwritten.

## Migrations (OFF unless `POSTGRES_MIGRATION_ENABLED=true`)

```
migration_status → migration_add / migration_preview → migration_dry_run → migration_apply
```
Preview and dry-run before applying. Requires the configured .NET project paths.

## Guardrails

- Never construct SQL by string-concatenating untrusted input — the server enforces parameterized/whitelisted execution, and you should respect that intent.
- Never echo secrets (connection strings, passwords) back to the user.
- Default to the smallest scope: explicit env, explicit `LIMIT`, read-only unless asked otherwise.

## Configuration (env)

Server entry: `node {{ENTRY_PATH}}`

A connection source is required — set **one** of `POSTGRES_CONNECTION`, `POSTGRES_ENV_*`, or `POSTGRES_APPSETTINGS_ROOTS`.
(The pre-S-43 names `CH_DB_CONNECTION`, `PG_ENV_*`, `CH_APPSETTINGS_ROOTS` are still accepted, with a
one-time deprecation warning. Use the canonical names above.)

{{ENV_TABLE}}

## Tool reference

{{TOOL_LIST}}
