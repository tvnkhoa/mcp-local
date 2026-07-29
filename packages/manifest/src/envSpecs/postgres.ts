/**
 * `postgres-mcp`'s environment contract — 21 vars.
 *
 * The connection-source group is the important part: the server needs exactly one of three ways
 * to find a database, and `evaluateEnv` treats `PG_ENV_*` as a family so `PG_ENV_DEV` satisfies
 * it. See the package README for why the trailing underscore in that prefix is load-bearing.
 */

import type { EnvField } from "../types.js";

export const postgresEnv: readonly EnvField[] = [
  // --- Connection source: at least one of these three --------------------------
  {
    name: "CH_DB_CONNECTION",
    required: false,
    secret: true,
    group: "connection-source",
    section: "Connection source (need ONE of these three)",
    prompt: "Postgres connection string (Npgsql; blank to use PG_ENV_* or appsettings)",
    note: "Connection source. Need ONE of: CH_DB_CONNECTION | PG_ENV_* | CH_APPSETTINGS_ROOTS."
  },
  {
    name: "CH_APPSETTINGS_ROOTS",
    required: false,
    group: "connection-source",
    section: "Connection source (need ONE of these three)",
    prompt: "appsettings.json root(s) to discover connections (optional)",
    note: "Alternative connection source: discover connection strings from .NET appsettings*.json."
  },
  {
    name: "PG_ENV_*",
    prefix: "PG_ENV_",
    familyExamples: ["PG_ENV_DEV", "PG_ENV_STAGING", "PG_ENV_PROD"],
    required: false,
    secret: true,
    group: "connection-source",
    section: "Connection source (need ONE of these three)",
    note: "Per-env connection strings, declared directly instead of discovered from appsettings. Any one satisfies the connection source. `PG_ENV_*` is a family, not a literal var name — the trailing underscore is part of the prefix, so PG_ENVIRONMENT does not count."
  },
  { name: "CH_CONNECTION_NAME", required: false, default: "CommunicationHubDb", section: "Connection source (need ONE of these three)", note: "Which named connection to pick out of appsettings." },

  // --- Environment access ------------------------------------------------------
  { name: "PG_ALLOWED_ENVIRONMENTS", required: false, default: "dev", section: "Environment access" },
  {
    name: "PG_WRITABLE_ENVIRONMENTS",
    required: false,
    default: "",
    section: "Environment access",
    note: "prod is ALWAYS read-only regardless of this value."
  },
  { name: "PG_DEFAULT_ENVIRONMENT", required: false, default: "dev", section: "Environment access" },

  // --- Query bounds ------------------------------------------------------------
  { name: "MCP_DB_DEFAULT_LIMIT", required: false, default: "500", section: "Query bounds" },
  { name: "MCP_DB_MAX_LIMIT", required: false, default: "2000", section: "Query bounds" },
  { name: "MCP_DB_DEFAULT_TIMEOUT_MS", required: false, default: "30000", section: "Query bounds" },
  { name: "MCP_DB_MAX_TIMEOUT_MS", required: false, default: "60000", section: "Query bounds" },
  {
    name: "PG_EXPLAIN_COST_WARN",
    required: false,
    codeDefault: "1000000",
    section: "Query bounds",
    note: "EXPLAIN cost above which a read query is flagged as expensive."
  },

  // --- Data writes (gated) -----------------------------------------------------
  {
    name: "PG_WRITE_ENABLED",
    required: false,
    default: "false",
    section: "Data writes (OFF unless enabled)",
    note: "Data writes (preview→apply→rollback) OFF unless true."
  },
  {
    name: "PG_WRITE_APPROVAL_SECRET",
    required: false,
    secret: true,
    section: "Data writes (OFF unless enabled)",
    note: "Auto-generated per process if empty; set to keep tokens valid across restarts."
  },
  { name: "PG_WRITE_PREVIEW_TTL_MS", required: false, codeDefault: "900000", section: "Data writes (OFF unless enabled)", note: "Write-preview lifetime — 15 minutes." },
  { name: "PG_WRITE_SAMPLE_LIMIT", required: false, codeDefault: "20", section: "Data writes (OFF unless enabled)", note: "Rows sampled into a write preview." },

  // --- EF Core migrations (gated) ----------------------------------------------
  {
    name: "PG_MIGRATION_ENABLED",
    required: false,
    default: "false",
    section: "EF Core migrations (OFF unless enabled)",
    note: "EF Core migration tooling OFF unless true."
  },
  { name: "PG_MIGRATION_PREVIEW_TTL_MS", required: false, codeDefault: "3600000", section: "EF Core migrations (OFF unless enabled)", note: "Migration-preview lifetime — 1 hour." },
  { name: "CH_DOTNET_PROJECT", required: false, section: "EF Core migrations (OFF unless enabled)", note: "Path to the EF Core project (the one holding the DbContext)." },
  { name: "CH_DOTNET_STARTUP_PROJECT", required: false, section: "EF Core migrations (OFF unless enabled)", note: "Startup project passed to `dotnet ef --startup-project`." },
  { name: "PG_DOTNET_TIMEOUT_MS", required: false, codeDefault: "120000", section: "EF Core migrations (OFF unless enabled)", note: "Timeout for a `dotnet ef` invocation." }
];
