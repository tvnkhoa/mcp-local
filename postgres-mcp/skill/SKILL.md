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
- Always bound results with a `LIMIT` (server also caps via `MCP_DB_DEFAULT_LIMIT`/`MCP_DB_MAX_LIMIT`).
- Use `explain:true` to see the plan; a warning fires when EXPLAIN cost exceeds `PG_EXPLAIN_COST_WARN`.
- `profile_table`, `compare_environments`, `data_diff` for profiling and cross-env comparison.

## Environment selection

Pass `environment` explicitly for anything sensitive. `PG_DEFAULT_ENVIRONMENT` is used when omitted. Only envs in `PG_ALLOWED_ENVIRONMENTS` are reachable; only those in `PG_WRITABLE_ENVIRONMENTS` accept writes. **`prod` is force read-only regardless of config.**

## Writes (OFF unless `PG_WRITE_ENABLED=true`) — preview → apply → rollback

```
write_preview(sql, environment)   // returns previewId, approvalToken, affected sample, mandatory-WHERE check
// review the sample + row estimate carefully
write_apply(previewId, approvalToken)
write_rollback(applyId)           // if needed
```
- A `WHERE` clause is **mandatory** for UPDATE/DELETE — unbounded mutations are rejected.
- Approval tokens are HMAC-signed and expire (`PG_WRITE_PREVIEW_TTL_MS`, default 15 min).

## Migrations (OFF unless `PG_MIGRATION_ENABLED=true`)

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

A connection source is required — set **one** of `CH_DB_CONNECTION`, `PG_ENV_*`, or `CH_APPSETTINGS_ROOTS`.

{{ENV_TABLE}}

## Tool reference

{{TOOL_LIST}}
