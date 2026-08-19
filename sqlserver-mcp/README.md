# sqlserver-mcp

Read-only access to a Microsoft SQL Server instance — across every catalog on it — plus a gated lane
for executing stored procedures.

## What makes this different from `postgres-mcp`

Three things, and they are why this is a separate server rather than a driver swap.

**The unit of work is a catalog, not the server.** A SQL Server login is scoped to the instance, so
one connection string reaches every database on it. Every data tool therefore takes an optional
`database`, and connection pools are keyed `(environment, catalog)` with an LRU cap
(`SQLSERVER_MAX_POOLS`) — a pool map that grows with the number of catalogs touched is a connection
leak. `run_read_query` also takes `databases: string[]` to run one statement across several catalogs
and label the results.

**Cross-catalog reads are ordinary.** Three-part names (`OtherDb.dbo.Thing`) are how SQL Server
joins databases, and the guardrail is built to permit them. Four-part names, which reach a linked
server, are refused. See [ADR 0004](../docs/decisions/0004-tsql-guardrail-policy.md).

**T-SQL has no `LIMIT` and no read-only transaction.** Rows are bounded by cancelling the result
stream at `maxRows` — the caller's statement is never rewritten, because wrapping it in
`SELECT TOP (n) * FROM (…)` breaks CTEs and top-level `ORDER BY`. And there is no engine-level
read-only mode to fall back on, so the syntactic guardrail is the first line of defence rather than
the second.

> **Deployment recommendation: give this server a SQL login holding only `db_datareader`.** That is
> the control that survives a bug in the guardrail. Set `SQLSERVER_ALLOWED_DATABASES` to bound which
> catalogs it can reach at all.

## Commands

```bash
npm run build          # tsc -> dist/
npm run typecheck
npm run test           # node:test over src/**/*.test.ts — no database needed
npm run smoke          # end-to-end over a real stdio handshake (needs a build AND a real server)
npm run dev            # tsx, no build
```

`npm run test` covers the guardrail, the gates, target resolution and the error envelope — every
decision made *before* a connection is opened. `npm run smoke` is the only part that needs a
database, and it is read-only: it never calls `execute_routine`.

## Stored procedures

`execute_routine` is **off** unless `SQLSERVER_EXEC_ENABLED=true`, and it is annotated destructive
for every routine. That is not caution for its own sake: SQL Server's catalog records nothing about
whether a procedure writes, so a `Get…` procedure and an `Update…` procedure are indistinguishable
to anything but a human reading the body. Use `get_routine_definition` first.

Three gates run in order — the feature flag, then `SQLSERVER_READONLY_DATABASES` (which refuses
unconditionally, the analogue of `postgres-mcp`'s force-read-only `prod`), then
`SQLSERVER_EXEC_ALLOWLIST` if one is set. The tool never accepts statement text; it takes a routine
name and typed parameters, which the driver binds.

## Configuration (env)

<!-- BEGIN GENERATED: env-table -->

| Variable | Required | Default | Notes |
|---|---|---|---|
| `SQLSERVER_CONNECTION` | one of `connection-source` | — | **secret** · Connection source. Need ONE of: SQLSERVER_CONNECTION \| SQLSERVER_ENV_*. Integrated Security is not supported — supply a SQL login. |
| `SQLSERVER_ENV_*` | one of `connection-source` | — | **secret** · Per-environment connection strings. Any one satisfies the connection source. `SQLSERVER_ENV_*` is a family, not a literal var name — the trailing underscore is part of the prefix. |
| `SQLSERVER_DEFAULT_ENVIRONMENT` | no | `the sole configured environment` *(code)* | Which environment a call means when it omits `environment`. |
| `SQLSERVER_ALLOWED_ENVIRONMENTS` | no | `(empty = every configured environment)` *(code)* | Comma-separated. Empty means no restriction, not 'none allowed'. |
| `SQLSERVER_ALLOWED_DATABASES` | no | `(empty = every catalog the login can see)` *(code)* | Comma-separated catalog allowlist. THE control that matters: one SQL Server login reaches every database on the instance, so without this the server's reach is the login's reach. Enforced in two places — the catalog a connection opens against, AND the first segment of any three-part name in a query, checked against the instance's real catalog list. |
| `SQLSERVER_READONLY_DATABASES` | no | `(empty)` *(code)* | Catalogs where execute_routine is refused unconditionally, whatever SQLSERVER_EXEC_ENABLED says. The analogue of postgres-mcp's 'prod is always read-only'. |
| `SQLSERVER_DEFAULT_LIMIT` | no | `500` *(code)* | Rows returned per recordset when a call does not say. |
| `SQLSERVER_MAX_LIMIT` | no | `2000` *(code)* | Ceiling a call's maxRows is clamped to. T-SQL has no LIMIT, so the bound is applied by cancelling the row stream, never by rewriting the statement. |
| `SQLSERVER_DEFAULT_TIMEOUT_MS` | no | `30000` *(code)* | — |
| `SQLSERVER_MAX_TIMEOUT_MS` | no | `60000` *(code)* | — |
| `SQLSERVER_MAX_FANOUT` | no | `25` *(code)* | Most catalogs one run_read_query call may address via `databases`. |
| `SQLSERVER_POOL_MAX` | no | `5` *(code)* | Connections per (environment, catalog) pool. |
| `SQLSERVER_MAX_POOLS` | no | `12` *(code)* | Total pools held open, across every environment and catalog; least-recently-used are closed past this. One pool per catalog means an unbounded map is a connection leak. |
| `SQLSERVER_POOL_IDLE_TIMEOUT_MS` | no | `30000` *(code)* | — |
| `SQLSERVER_EXEC_ENABLED` | no | `false` | execute_routine is OFF unless true. Parsed strictly: exact "true" or "1". SQL Server records nothing about whether a procedure writes, so enabling this grants write capability regardless of which routines you intend to call. |
| `SQLSERVER_EXEC_ALLOWLIST` | no | `(empty = no narrowing)` *(code)* | Comma-separated glob patterns over `schema.routine`, e.g. `dbo.Report_*,dbo.Get*`. `*` is the whole grammar. Empty does NOT deny — the flag above is the gate. |
| `SQLSERVER_EXEC_TIMEOUT_MS` | no | `120000` *(code)* | — |
| `NODE_TLS_REJECT_UNAUTHORIZED` | no | — | Node-level TLS switch. Prefer TrustServerCertificate=true in the connection string, which is scoped to this connection instead of the whole process. |

18 variables. Defaults marked *(code)* are the server's own fallback and are **not** written into your agent config — set them only to override.

<!-- END GENERATED: env-table -->

Generated from `@mcp/manifest` — edit `packages/manifest/src/envSpecs/sqlserver.ts`, then run
`npm run generate:all`.

## Tools

<!-- BEGIN GENERATED: tool-list -->

12 tools, namespaced `mcp__sqlserver-mcp__<tool>`:

- `describe_table`
- `execute_routine`
- `find_cross_database_references`
- `get_routine_definition`
- `get_table_relationships`
- `health_check`
- `list_databases`
- `list_environments`
- `list_routines`
- `list_tables`
- `profile_table`
- `run_read_query`

<!-- END GENERATED: tool-list -->

Generated from `contracts/sqlserver-mcp.json`.

| Tool | Use it for |
|---|---|
| `health_check` | connectivity, server version, and `linkedServerCount` — the premise behind the four-part-name refusal |
| `list_environments` | configured environments, masked connections, open pool counts |
| `list_databases` | **start here.** Catalog names are deployment-specific and often generated; never guess one |
| `list_tables` · `describe_table` · `get_table_relationships` | schema, with FKs in both directions |
| `list_routines` · `get_routine_definition` | the procedures and views where most read logic actually lives |
| `find_cross_database_references` | the dependency graph *between* catalogs, from `sys.sql_expression_dependencies` |
| `run_read_query` | guarded `SELECT`, optionally fanned out across catalogs |
| `profile_table` | row count, null ratio and distinct count per column |
| `execute_routine` | gated stored-procedure execution |

`find_cross_database_references` reports a `coverage` field. References built inside dynamic SQL
(`sp_executesql`, `EXEC(@sql)`) never existed at compile time and so leave no row in the catalog —
the tool says how many such modules it found rather than implying the graph is complete.

## Layout

Standard nine-slot structure. Worth knowing where the load-bearing parts are:

| Path | What lives there |
|---|---|
| `src/config/environments.ts` | connection strings parsed into parts. Catalog switching is a field assignment, never a string replacement — see the module docblock for the bug that motivates it |
| `src/repositories/connectionManager.ts` | pool per `(environment, catalog)`, LRU-bounded; both allowlists |
| `src/middleware/sqlGuardrails.ts` | the T-SQL dialect policy over `@mcp/shared/sql` |
| `src/repositories/queryRunner.ts` | streaming row cap; the statement is never rewritten |
| `src/tools/readTools.ts` · `queryTools.ts` · `execTools.ts` | inventory/introspection · guarded SQL · the gated lane |

`src/config/` is the only place `process.env` is read (`guard:deps` enforces it). stdout is the MCP
transport — log to stderr only.
