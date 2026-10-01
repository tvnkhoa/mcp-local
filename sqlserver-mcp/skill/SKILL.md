---
name: {{KEY}}
description: "Microsoft SQL Server via the {{DISPLAY_NAME}}: read-only T-SQL, list the databases (catalogs) on an instance, inspect tables/views/indexes/foreign keys, read a stored procedure/function/view definition, map which databases reference each other, profile a table, run one query across many tenant catalogs, and - only when enabled - execute a stored procedure. Use for: query SQL Server / MSSQL / RDS SQL Server, run T-SQL, what does this stored procedure do, which procs changed recently, list databases, find cross-database dependencies, same query across all tenant DBs. Not for PostgreSQL (use postgres-mcp) or logs (observe-mcp). Read-only by default."
---

# {{DISPLAY_NAME}}

{{TAGLINE}} Tools are exposed as `{{TOOL_NAMESPACE}}`.

**The unit of work is a *catalog*, not the server.** One login reaches every database on the
instance, so almost every tool takes an optional `database` (omitted = the catalog the connection
string names). Catalog names are deployment-specific — never guess one; `list_databases` first.

## Step 0 — Orient

```
list_environments()                       // configured environments
health_check()                            // connectivity, version, linkedServerCount
list_databases(environment?)              // WHICH CATALOGS EXIST — always start here
list_tables(database, namePattern?)       // tables + views, approximate row counts
describe_table(database, table, schema?)  // columns, defaults, indexes, FKs both directions
```

## Read data

```
run_read_query(sql: "select ... where Id = @p1", parameters: [42], database?, maxRows?, timeoutMs?)
```

- One `SELECT` / `WITH … SELECT`. Bind values with `parameters` (positional → `@p1`, `@p2`, …);
  never concatenate a value into `sql`.
- **Three-part names are allowed and are how you join catalogs**: `OtherDb.dbo.Thing`. Four-part
  names (linked servers) are refused.
- No `LIMIT` in T-SQL, and do **not** add `TOP` for a bound: the server cancels the stream at
  `maxRows` (clamped to `SQLSERVER_MAX_LIMIT`) and reports `truncated: true`. Rows come back as
  positional arrays in `recordsets[].rows` with `columns[]`, so duplicate column names survive.
- `profile_table(database, table)` — null ratio + distinct count per column, exact row count.

### One statement across many catalogs

```
run_read_query(sql, databases: ["TenantA", "TenantB"])
list_tables(databases: [...])  ·  list_routines(databases: [...], namePattern: "Report[_]%")
```

One labelled slot per catalog, in order. A failing catalog gets `error` + `errorCode` in its own slot
— check `failureCount`. `database` and `databases` are mutually exclusive; width is capped by
`SQLSERVER_MAX_FANOUT`. **You supply the list** — the server does not know which catalogs are
tenants; if a table holds it, read that first. Prefer `databases` over hand-written `sys.tables`
queries: you keep per-catalog labels and partial-failure handling.

## Understand an unfamiliar schema

Most logic on a mature instance lives in procedures and views.

```
list_routines(database, type: "procedure", namePattern: "Report[_]%")
list_routines(database, modifiedAfter: "2026-08-19")   // what changed — start an incident here
get_routine_definition(database, routine, schema?)     // body + parameter contract
find_cross_database_references(database)               // which OTHER catalogs it reaches into
```

`find_cross_database_references` returns the dependency graph between catalogs grouped by target;
per-reference rows need `includeReferences: true` (or `profile: "standard"`). Read its `coverage`:
references built in dynamic SQL (`sp_executesql`, `EXEC(@sql)`) are invisible to the catalog.

## Execute a stored procedure — OFF unless `SQLSERVER_EXEC_ENABLED=true`

```
get_routine_definition(database, routine)              // ALWAYS read it first, tell the user what it does
execute_routine(routine, database?, schema?, parameters?)  // parameters: { Name: value } — no @ prefix
```

**Treat every routine as a write.** The catalog records nothing about whether a procedure modifies
data, so the tool is annotated destructive for all of them; a `Get…` name is not evidence. Get an
explicit yes before calling it. Gates, in order: the flag, `SQLSERVER_READONLY_DATABASES` (refuses
unconditionally), `SQLSERVER_EXEC_ALLOWLIST` if set. A refusal names its gate — report it, do not retry.

## Guardrails

- Refused in `run_read_query`: non-`SELECT`, a second statement, `EXEC`, `SELECT … INTO`,
  `OPENQUERY`/`OPENROWSET`/`OPENDATASOURCE`, `DBCC`, `BACKUP`, `WAITFOR`, `xp_cmdshell`, four-part
  names. Bracketed reserved words as columns (`[Update]`) are fine.
- `SQLSERVER_ALLOWED_DATABASES`, when set, bounds every catalog a call names **and** every catalog a
  three-part name reaches.
- T-SQL has no read-only transaction: the guard is syntactic. The real control is a login with only
  `db_datareader` — recommend that when the user is configuring this.
- Never echo a connection string or password. Never fix TLS errors by disabling verification —
  RDS needs its CA bundle via `NODE_EXTRA_CA_CERTS`.
- Profiles: `compact` default; `nano` for inventories on a big catalog; `standard` for dropped fields.

## Configuration (env)

Server entry: `node {{ENTRY_PATH}}`

A connection source is required — **one** of `SQLSERVER_CONNECTION` or `SQLSERVER_ENV_*`. Integrated
Security is not supported; supply a SQL login.

{{ENV_TABLE}}

## Tool reference

{{TOOL_LIST}}
