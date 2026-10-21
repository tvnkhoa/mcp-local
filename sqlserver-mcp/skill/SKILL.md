---
name: {{KEY}}
description: "SQL Server / MSSQL / RDS: read-only T-SQL, list catalogs, tables/indexes/FKs, read a stored procedure or view, cross-database dependencies, one query across many tenant DBs; when enabled, run a proc or preview/apply a T-SQL write batch. Use for: run T-SQL, what does this proc do, which procs changed, list databases. Not for PostgreSQL (postgres-mcp) or logs (observe-mcp). Read-only by default."
---

# {{DISPLAY_NAME}}

{{TAGLINE}} Tools are exposed as `{{TOOL_NAMESPACE}}`.

**The unit of work is a *catalog*, not the server.** One login reaches every database on the
instance, so almost every tool takes an optional `database` (omitted = the connection's catalog).
Catalog names are deployment-specific — never guess one; `list_databases` first.

## Step 0 — Orient

```
list_environments()
health_check()
list_databases(environment?)              // WHICH CATALOGS EXIST — always start here
list_tables(database, namePattern?)
describe_table(database, table, schema?)  // columns, indexes, FKs both directions
```

## Read data

```
run_read_query(sql: "select ... where Id = @p1", parameters: [42], database?, maxRows?)
```

- One `SELECT` / `WITH … SELECT`. Bind values with `parameters` (→ `@p1`, `@p2`, …); never
  concatenate a value into `sql`.
- **Three-part names join catalogs**: `OtherDb.dbo.Thing`. Four-part names (linked servers) are refused.
- Do **not** add `TOP` for a bound: the server cancels the stream at `maxRows` and reports
  `truncated: true`. Rows are positional arrays in `recordsets[].rows` with `columns[]`.

### One statement across many catalogs

```
run_read_query(sql, databases: ["TenantA", "TenantB"])
list_routines(databases: [...], namePattern: "Report[_]%")
```

One labelled slot per catalog; a failing catalog gets `error` + `errorCode` in its own slot — check
`failureCount`. `database` and `databases` are mutually exclusive. **You supply the list** — the
server does not know which catalogs are tenants.

## Understand an unfamiliar schema

```
list_routines(database, modifiedAfter: "<date>")       // what changed — start an incident here
get_routine_definition(database, routine, schema?)     // body + parameter contract
find_cross_database_references(database)               // which OTHER catalogs it reaches into
```

References built in dynamic SQL (`sp_executesql`, `EXEC(@sql)`) are invisible to the catalog — read
the `coverage` field.

## Execute a stored procedure — off unless `SQLSERVER_EXEC_ENABLED=true`

```
get_routine_definition(database, routine)              // ALWAYS read it first, tell the user what it does
execute_routine(routine, database?, schema?, parameters?)  // parameters: { Name: value } — no @ prefix
```

**Treat every routine as a write** — the catalog does not record whether a procedure modifies data;
a `Get…` name is not evidence. Get an explicit yes first. A refusal names its gate — report it, do
not retry.

## Write batch — off unless `SQLSERVER_WRITE_ENABLED=true`, dev-type environments only

```
write_preview(sql, database?, environment?)   // runs the batch, ALWAYS rolls back; previewId + approvalToken
write_apply(previewId, approvalToken)         // re-runs that exact batch and commits
```

One batch, no `GO`, no `USE`. End it with a verify `SELECT`. Its own `BEGIN TRAN … COMMIT` and
`BEGIN CATCH … ROLLBACK; THROW; END CATCH` are fine; any other `ROLLBACK`, DDL, `EXEC` and names in
other catalogs are refused. **Show the preview and get an explicit yes before `write_apply`** — it
commits, and there is no rollback tool.
`write_apply` refuses with `write_drift` if `rowsAffected` changed since the preview: re-preview. A refusal names its gate in
`code` — report it, do not retry.

## Guardrails

- `run_read_query` refuses non-`SELECT`, a second statement, `EXEC`, `SELECT … INTO`,
  `OPENQUERY`/`OPENROWSET`, `DBCC`, `WAITFOR`, four-part names. `[Update]` as a column is fine.
- T-SQL has no read-only transaction: the guard is syntactic. The real control is a
  `db_datareader` login — recommend it when the user is configuring this.
- Never echo a connection string or password. Never fix a TLS error by disabling verification.
- Profiles: `compact` default; `nano` for inventories on a big catalog.

Setup, connection sources, env vars and troubleshooting (TLS / CA bundle): see `sqlserver-mcp/README.md`.

## Tool reference

{{TOOL_LIST}}
