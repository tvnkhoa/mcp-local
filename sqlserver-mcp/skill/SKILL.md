---
name: {{KEY}}
description: "Query Microsoft SQL Server via the {{DISPLAY_NAME}}: read-only T-SQL, catalog/table/stored-procedure inspection, cross-database dependency mapping, and gated stored-procedure execution. Triggers on: query SQL Server, run T-SQL, inspect a table or stored procedure, list databases on the instance, find what a procedure does, which databases reference each other, run the same query across several catalogs. Read-only by default."
---

# {{DISPLAY_NAME}}

{{TAGLINE}} Tools are exposed as `{{TOOL_NAMESPACE}}`.

## The one thing to internalise

**On SQL Server the unit of work is a *catalog*, not the server.** One connection reaches every
database on the instance, so almost every tool takes an optional `database`. Omit it and you get the
catalog the connection string names; pass it to work anywhere else.

Catalog names are deployment-specific and often generated — never guess one. `list_databases` first.

## Step 0 — Orient

```
health_check                       // connectivity, server version, linkedServerCount
list_databases                     // WHICH CATALOGS EXIST. Always start here.
list_tables(database)              // tables + views, approximate row counts
                                   // takes `databases: [...]` to sweep several catalogs at once
describe_table(database, table)    // columns, defaults, indexes, FKs both directions
```

## Reading data

```
run_read_query(sql, database?, parameters?, maxRows?, timeoutMs?)
```

- Only `SELECT` and `WITH … SELECT`. One statement.
- **Three-part names are allowed and are the point**: `select * from OtherDb.dbo.Thing` is how
  SQL Server joins across catalogs, and it works from any connection on the instance.
- Four-part names (`server.db.dbo.obj`) are refused — they reach a linked server.
- Bind values with `parameters` (`@p1`, `@p2`, …). Never concatenate a value into `sql`.
- There is no `LIMIT` in T-SQL. Do **not** add `TOP` to get a bound — the server caps rows by
  cancelling the stream at `maxRows` and reports `truncated: true`. Rows come back as
  `recordsets[].rows` (positional arrays) with a matching `columns[]`, so duplicate column names in
  a wide join are never silently dropped.

### Running one thing across many catalogs

```
run_read_query(sql, databases: ["TenantA", "TenantB", …])
list_tables(databases: ["TenantA", "TenantB", …])
list_routines(databases: [...], namePattern: "Report[_]%")
```

One result slot per catalog, labelled, in the order you asked. A catalog that fails lands as
`error` + `errorCode` in its own slot and does not discard the others — check `failureCount` rather
than assuming every slot succeeded.

**Reach for `databases` on the metadata tools before hand-writing `sys.tables` / `sys.partitions`
through `run_read_query`.** That is the workaround it exists to remove, and it loses the per-catalog
labelling and the partial-failure handling you would then have to rebuild.

**You supply the list** — this server has no idea which catalogs are tenants or how to find them.
If the list lives in a table, read it first with an ordinary `run_read_query`, then pass the names
in. `database` and `databases` are mutually exclusive, and the width is capped by
`SQLSERVER_MAX_FANOUT`.

## Understanding a schema you have not seen

Most read logic on a mature SQL Server instance lives in procedures and views, not in tables.

```
list_routines(database, type: "procedure", namePattern: "Report[_]%")
get_routine_definition(database, routine)     // full body + parameter contract
find_cross_database_references(database)      // which OTHER catalogs this one reaches into
```

`find_cross_database_references` is the fastest way to understand how an instance is wired: it
returns the dependency graph *between* databases, grouped by target. Read its `coverage` field —
references built inside dynamic SQL (`sp_executesql`, `EXEC(@sql)`) are invisible to the catalog and
it says so rather than implying completeness.

## Executing stored procedures — OFF unless `SQLSERVER_EXEC_ENABLED=true`

```
get_routine_definition(database, routine)     // ALWAYS read this first
execute_routine(routine, database?, schema?, parameters?)   // parameters is an object keyed by parameter name, no @ prefix
```

**Treat every routine as a write.** SQL Server records nothing about whether a procedure modifies
data — `GetCustomerOverview` and `Customer_UpdateLastActivity` are the same kind of object in the
same schema. The tool is annotated `destructive` for all of them because the name is not evidence.
Read the body before calling it, and tell the user what it does.

Three gates, in order: the feature flag, then `SQLSERVER_READONLY_DATABASES` (which refuses
unconditionally), then `SQLSERVER_EXEC_ALLOWLIST` if set. A refusal names which gate stopped it —
do not retry, report it.

## Guardrails

- **Refused in `run_read_query`:** anything that is not a single `SELECT`/`WITH … SELECT`; a second
  statement; `EXEC`; `SELECT … INTO`; `OPENQUERY`/`OPENROWSET`/`OPENDATASOURCE`; `DBCC`, `BACKUP`,
  `WAITFOR`, `xp_cmdshell`; four-part names.
- **Reserved words as column names are fine** if bracketed: `select [Update] from t` works.
- `SQLSERVER_ALLOWED_DATABASES`, when set, is the boundary of what this server can reach at all —
  both the catalog a call names and any catalog reached by three-part name inside the SQL.
- **T-SQL has no read-only transaction.** Unlike the Postgres server, there is no engine-level
  enforcement behind the syntactic guard — the real control is the login's permissions. If the user
  is configuring this, recommend a SQL login with only `db_datareader`.
- Never echo a connection string or password back to the user.

## Response profiles

`nano | compact | standard | verbose` — `compact` is the default. Only `verbose` is pretty-printed.
Use `nano` for inventory calls on a large catalog; raise to `standard` only when you need a field
`compact` dropped.

<!-- The installer fills these two from the manifest. Leave them alone. -->

## Environment

Server entry: `node {{ENTRY_PATH}}`

A connection source is required — set **one** of `SQLSERVER_CONNECTION` or `SQLSERVER_ENV_*`.
Integrated Security is not supported; supply a SQL login.

{{ENV_TABLE}}

## Tools

{{TOOL_LIST}}
