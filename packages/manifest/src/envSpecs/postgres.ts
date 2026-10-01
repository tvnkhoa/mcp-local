/**
 * `postgres-mcp`'s environment contract — 30 vars: 28 under one `POSTGRES_*` prefix, plus the two
 * Node / libpq runtime vars declared at the bottom (which this server's code does not read).
 *
 * S-43 converged three prefixes into one. Before it, this server read `CH_*` (5 vars, named for the
 * CommunicationHub app it was first written against), `PG_*` (12) and `MCP_DB_*` (4) — so an
 * operator had to know which of three unrelated namespaces a given setting lived in.
 *
 * **Every old name still works.** Each field carries `deprecatedAliases`, and the server falls back
 * to the alias with a one-time warning. The canonical name wins when both are set. Nothing here is
 * a breaking change for an existing `~/.claude.json`.
 *
 * Two things deliberately did NOT move:
 *
 *  - `CH_DB_CONNECTION` as written by `migration/efRunner.ts` into the `dotnet ef` child process.
 *    That is an *outbound* contract — the name the .NET project's `IDesignTimeDbContextFactory`
 *    reads — not this server's own configuration. Renaming it would break migrations against a
 *    codebase this workspace does not own.
 *  - `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` are avoided as names. They are the
 *    official postgres Docker image's variables, and colliding with them in a shared shell would
 *    make one tool's configuration silently reconfigure the other.
 *
 * The connection-source group is the important part: the server needs exactly one of three ways to
 * find a database, and `evaluateEnv` treats `POSTGRES_ENV_*` as a family so `POSTGRES_ENV_DEV`
 * satisfies it. The trailing underscore in that prefix is load-bearing — see the package README.
 */

import type { EnvField } from "../types.js";

export const postgresEnv: readonly EnvField[] = [
  // --- Connection source: at least one of these three --------------------------
  {
    name: "POSTGRES_CONNECTION",
    deprecatedAliases: ["CH_DB_CONNECTION"],
    required: false,
    secret: true,
    group: "connection-source",
    section: "Connection source (need ONE of these three)",
    prompt: "Postgres connection string (Npgsql; blank to use POSTGRES_ENV_* or appsettings)",
    note: "Connection source. Need ONE of: POSTGRES_CONNECTION | POSTGRES_ENV_* | POSTGRES_APPSETTINGS_ROOTS."
  },
  {
    name: "POSTGRES_APPSETTINGS_ROOTS",
    deprecatedAliases: ["CH_APPSETTINGS_ROOTS"],
    required: false,
    kind: "path-list",
    group: "connection-source",
    section: "Connection source (need ONE of these three)",
    prompt: "appsettings.json root(s) to discover connections (optional)",
    note: "Alternative connection source: discover connection strings from .NET appsettings*.json."
  },
  {
    name: "POSTGRES_ENV_*",
    prefix: "POSTGRES_ENV_",
    deprecatedAliases: ["PG_ENV_"],
    familyExamples: ["POSTGRES_ENV_DEV", "POSTGRES_ENV_STAGING", "POSTGRES_ENV_PROD"],
    required: false,
    secret: true,
    group: "connection-source",
    section: "Connection source (need ONE of these three)",
    note: "Per-env connection strings, declared directly instead of discovered from appsettings. Any one satisfies the connection source. `POSTGRES_ENV_*` is a family, not a literal var name — the trailing underscore is part of the prefix, so POSTGRES_ENVIRONMENT would not count (and no such var exists). The legacy `PG_ENV_` prefix is still accepted."
  },
  {
    name: "POSTGRES_CONNECTION_NAME",
    deprecatedAliases: ["CH_CONNECTION_NAME"],
    required: false,
    default: "CommunicationHubDb",
    section: "Connection source (need ONE of these three)",
    note: "Which named connection to pick out of appsettings."
  },

  // --- Environment access ------------------------------------------------------
  { name: "POSTGRES_ALLOWED_ENVIRONMENTS", deprecatedAliases: ["PG_ALLOWED_ENVIRONMENTS"], required: false, default: "dev", section: "Environment access" },
  {
    name: "POSTGRES_WRITABLE_ENVIRONMENTS",
    deprecatedAliases: ["PG_WRITABLE_ENVIRONMENTS"],
    required: false,
    default: "",
    section: "Environment access",
    note: "prod is ALWAYS read-only regardless of this value."
  },
  { name: "POSTGRES_DEFAULT_ENVIRONMENT", deprecatedAliases: ["PG_DEFAULT_ENVIRONMENT"], required: false, default: "dev", section: "Environment access" },

  // --- Query bounds ------------------------------------------------------------
  { name: "POSTGRES_DEFAULT_LIMIT", deprecatedAliases: ["MCP_DB_DEFAULT_LIMIT"], required: false, default: "500", section: "Query bounds" },
  { name: "POSTGRES_MAX_LIMIT", deprecatedAliases: ["MCP_DB_MAX_LIMIT"], required: false, default: "2000", section: "Query bounds" },
  { name: "POSTGRES_DEFAULT_TIMEOUT_MS", deprecatedAliases: ["MCP_DB_DEFAULT_TIMEOUT_MS"], required: false, default: "30000", section: "Query bounds" },
  { name: "POSTGRES_MAX_TIMEOUT_MS", deprecatedAliases: ["MCP_DB_MAX_TIMEOUT_MS"], required: false, default: "60000", section: "Query bounds" },
  {
    name: "POSTGRES_EXPLAIN_COST_WARN",
    deprecatedAliases: ["PG_EXPLAIN_COST_WARN"],
    required: false,
    codeDefault: "1000000",
    section: "Query bounds",
    note: "EXPLAIN cost above which a read query is flagged as expensive."
  },

  // --- Data writes (gated) -----------------------------------------------------
  {
    name: "POSTGRES_WRITE_ENABLED",
    deprecatedAliases: ["PG_WRITE_ENABLED"],
    required: false,
    default: "false",
    section: "Data writes (OFF unless enabled)",
    note: "Data writes (preview→apply→rollback) OFF unless true. Parsed strictly: exact \"true\" or \"1\"."
  },
  {
    name: "POSTGRES_WRITE_APPROVAL_SECRET",
    deprecatedAliases: ["PG_WRITE_APPROVAL_SECRET"],
    required: false,
    secret: true,
    section: "Data writes (OFF unless enabled)",
    note: "Auto-generated per process if empty; set to keep tokens valid across restarts."
  },
  { name: "POSTGRES_WRITE_PREVIEW_TTL_MS", deprecatedAliases: ["PG_WRITE_PREVIEW_TTL_MS"], required: false, codeDefault: "900000", section: "Data writes (OFF unless enabled)", note: "Write-preview lifetime — 15 minutes." },
  { name: "POSTGRES_WRITE_SAMPLE_LIMIT", deprecatedAliases: ["PG_WRITE_SAMPLE_LIMIT"], required: false, codeDefault: "20", section: "Data writes (OFF unless enabled)", note: "Rows sampled into a write preview." },

  // --- EF Core migrations (gated) ----------------------------------------------
  {
    name: "POSTGRES_MIGRATION_ENABLED",
    deprecatedAliases: ["PG_MIGRATION_ENABLED"],
    required: false,
    default: "false",
    section: "EF Core migrations (OFF unless enabled)",
    note: "EF Core migration tooling OFF unless true. Parsed strictly: exact \"true\" or \"1\"."
  },
  { name: "POSTGRES_MIGRATION_PREVIEW_TTL_MS", deprecatedAliases: ["PG_MIGRATION_PREVIEW_TTL_MS"], required: false, codeDefault: "3600000", section: "EF Core migrations (OFF unless enabled)", note: "Migration-preview lifetime — 1 hour." },
  { name: "POSTGRES_DOTNET_PROJECT", deprecatedAliases: ["CH_DOTNET_PROJECT"], required: false, section: "EF Core migrations (OFF unless enabled)", note: "Path to the EF Core project (the one holding the DbContext)." },
  { name: "POSTGRES_DOTNET_STARTUP_PROJECT", deprecatedAliases: ["CH_DOTNET_STARTUP_PROJECT"], required: false, section: "EF Core migrations (OFF unless enabled)", note: "Startup project passed to `dotnet ef --startup-project`." },
  { name: "POSTGRES_DOTNET_TIMEOUT_MS", deprecatedAliases: ["PG_DOTNET_TIMEOUT_MS"], required: false, codeDefault: "120000", section: "EF Core migrations (OFF unless enabled)", note: "Timeout for a `dotnet ef` invocation." },
  { name: "POSTGRES_MIGRATION_LOCK_TIMEOUT_MS", required: false, codeDefault: "5000", section: "EF Core migrations (OFF unless enabled)", note: "lock_timeout for every `dotnet ef` session, via Npgsql `Options` (Npgsql 5+); also used by migration_dry_run. 0 = off (server default)." },

  // --- Raw-SQL DDL migrations (gated) ------------------------------------------
  // No aliases: these names are new, so there is no legacy spelling to keep working. Environment
  // scope is deliberately NOT configurable here — the lane writes where the write lane writes
  // (POSTGRES_WRITABLE_ENVIRONMENTS), and prod never.
  {
    name: "POSTGRES_DDL_ENABLED",
    required: false,
    default: "false",
    section: "Raw-SQL DDL migrations (OFF unless enabled)",
    note: "Raw-SQL DDL migrations (ddl_*) OFF unless true. Parsed strictly: exact \"true\" or \"1\"."
  },
  {
    name: "POSTGRES_DDL_MIGRATIONS_DIR",
    required: false,
    kind: "path",
    section: "Raw-SQL DDL migrations (OFF unless enabled)",
    note: "Directory of V<yyyymmddhhmmss>__<name>.up.sql / .down.sql files. Needed by file-based plans and ddl_create; inline SQL works without it."
  },
  { name: "POSTGRES_DDL_LOCK_TIMEOUT_MS", required: false, codeDefault: "5000", section: "Raw-SQL DDL migrations (OFF unless enabled)", note: "lock_timeout per migration. A file's -- mcp:lock-timeout-ms may lower it, never raise it." },
  { name: "POSTGRES_DDL_STATEMENT_TIMEOUT_MS", required: false, codeDefault: "300000", section: "Raw-SQL DDL migrations (OFF unless enabled)", note: "Default statement_timeout per DDL statement — 5 minutes." },
  { name: "POSTGRES_DDL_MAX_STATEMENT_TIMEOUT_MS", required: false, codeDefault: "3600000", section: "Raw-SQL DDL migrations (OFF unless enabled)", note: "Ceiling for -- mcp:statement-timeout-ms (e.g. a long CREATE INDEX CONCURRENTLY) — 1 hour." },
  { name: "POSTGRES_DDL_PREVIEW_TTL_MS", required: false, codeDefault: "3600000", section: "Raw-SQL DDL migrations (OFF unless enabled)", note: "DDL-preview lifetime — 1 hour. Freshness at apply is checked by the drift guard, not this." },
  {
    name: "POSTGRES_DDL_EXTERNAL_LEDGER",
    required: false,
    kind: "string",
    section: "Raw-SQL DDL migrations (OFF unless enabled)",
    note: "[schema.]table of a repo's own (filename, checksum) ledger, e.g. public.schema_migration. Replaces mcp_ops.ddl_history; the directory then holds psql-style NNNN-name.sql files, forward-only, sha256 over raw bytes. ADR 0005 Decision 7."
  },
  {
    name: "POSTGRES_DDL_OWNER_ROLES",
    required: false,
    kind: "string",
    section: "Raw-SQL DDL migrations (OFF unless enabled)",
    note: "Comma-separated roles ALTER … OWNER TO may name. Empty refuses every OWNER TO; a SUPERUSER/CREATEROLE/BYPASSRLS/REPLICATION role is refused even when listed."
  },
  {
    name: "POSTGRES_DDL_SESSION_SETTINGS",
    required: false,
    kind: "string",
    section: "Raw-SQL DDL migrations (OFF unless enabled)",
    note: "Comma-separated prefix.name=value custom settings, set transaction-locally before every migration (e.g. aria.expected_market=AU). Core settings are refused."
  },
  {
    name: "POSTGRES_DDL_ADOPTION_SENTINEL",
    required: false,
    kind: "string",
    section: "Raw-SQL DDL migrations (OFF unless enabled)",
    note: "[schema.]relation whose presence means the schema already exists. An up plan against an EMPTY ledger is refused while it exists (DDL_ADOPTION_REQUIRED)."
  },

  // --- Node / libpq runtime -----------------------------------------------------
  // Neither is a postgres-mcp variable, and neither is read by this server's code. Both are set by
  // the live install on this workspace, so leaving them undeclared meant the generated
  // `.env.example` was not a complete picture of what a real deployment needs — the gap S-35 exists
  // to close (backlog B-07). `observe-mcp` already declares NODE_TLS_REJECT_UNAUTHORIZED, so
  // omitting it here also made two servers disagree about the same variable.
  //
  // Declared WITHOUT `default`: `install-mcp` writes any field carrying one into `~/.claude.json`,
  // which would pin an external convention into every user's agent config (the S-35 finding).
  {
    name: "PGSSLMODE",
    required: false,
    section: "Node / libpq runtime (external conventions)",
    note: "libpq's own TLS mode (`disable` | `require` | `verify-ca` | `verify-full`), read by the driver, not by this server. Set it when the target requires TLS but the connection string does not say so."
  },
  {
    name: "NODE_TLS_REJECT_UNAUTHORIZED",
    required: false,
    section: "Node / libpq runtime (external conventions)",
    note: "Set to 0 ONLY if the database host presents a self-signed/untrusted TLS certificate. This is a Node flag, not a server setting, and it disables certificate verification for the WHOLE process — every outbound TLS connection, not just Postgres. Prefer `PGSSLMODE=verify-full` with a trusted CA."
  }
];
