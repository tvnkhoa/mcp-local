/**
 * `sqlserver-mcp`'s environment contract.
 *
 * Two things shape this list, and both come from the audit the server was designed against.
 *
 * **One connection reaches every catalog on the instance.** A SQL Server login is scoped to the
 * server, not to a database, so a single connection string is authority over ~20 catalogs in the
 * target deployment. `SQLSERVER_ALLOWED_DATABASES` is therefore not a convenience filter — it is
 * the only way to narrow what this server can address, and the reason it exists at all.
 *
 * **Stored procedures cannot be classified as read-only.** Nothing in the SQL Server catalog
 * records whether a procedure writes, and the schema audited has `Get…` and `Update…` procedures
 * sitting side by side. So execution gets its own flag, its own allowlist and its own never-execute
 * list, rather than riding on the read path.
 *
 * Names deliberately avoided: `MSSQL_*`. Those belong to the official `mcr.microsoft.com/mssql/server`
 * image (`MSSQL_SA_PASSWORD`, `MSSQL_PID`), and colliding with them in a shared shell would let one
 * tool's configuration silently reconfigure the other — the same reasoning that keeps
 * `postgres-mcp` off `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB`.
 */

import type { EnvField } from "../types.js";

export const sqlserverEnv: readonly EnvField[] = [
  // --- Connection source: at least one of these two ----------------------------
  // Order matters beyond documentation: `contract-snapshot.mjs` fills the FIRST member of a group
  // and unsets the rest, so the flat variable is what the credential-free boot check uses.
  {
    name: "SQLSERVER_CONNECTION",
    required: false,
    secret: true,
    group: "connection-source",
    section: "Connection source (need ONE of these two)",
    prompt: "SQL Server connection string (ADO.NET; blank to use SQLSERVER_ENV_*)",
    note: "Connection source. Need ONE of: SQLSERVER_CONNECTION | SQLSERVER_ENV_*. Integrated Security is not supported — supply a SQL login."
  },
  {
    name: "SQLSERVER_ENV_*",
    prefix: "SQLSERVER_ENV_",
    familyExamples: ["SQLSERVER_ENV_DEV", "SQLSERVER_ENV_UAT", "SQLSERVER_ENV_PROD"],
    required: false,
    secret: true,
    group: "connection-source",
    section: "Connection source (need ONE of these two)",
    note: "Per-environment connection strings. Any one satisfies the connection source. `SQLSERVER_ENV_*` is a family, not a literal var name — the trailing underscore is part of the prefix."
  },

  // --- Access control ----------------------------------------------------------
  {
    name: "SQLSERVER_DEFAULT_ENVIRONMENT",
    required: false,
    codeDefault: "the sole configured environment",
    section: "Access control",
    note: "Which environment a call means when it omits `environment`."
  },
  {
    name: "SQLSERVER_ALLOWED_ENVIRONMENTS",
    required: false,
    codeDefault: "(empty = every configured environment)",
    section: "Access control",
    note: "Comma-separated. Empty means no restriction, not 'none allowed'."
  },
  {
    name: "SQLSERVER_ALLOWED_DATABASES",
    required: false,
    codeDefault: "(empty = every catalog the login can see)",
    section: "Access control",
    note: "Comma-separated catalog allowlist. THE control that matters: one SQL Server login reaches every database on the instance, so without this the server's reach is the login's reach. Enforced in two places — the catalog a connection opens against, AND the first segment of any three-part name in a query, checked against the instance's real catalog list."
  },
  {
    name: "SQLSERVER_READONLY_DATABASES",
    required: false,
    codeDefault: "(empty)",
    section: "Access control",
    note: "Catalogs where execute_routine is refused unconditionally, whatever SQLSERVER_EXEC_ENABLED says. The analogue of postgres-mcp's 'prod is always read-only'."
  },

  // --- Query bounds ------------------------------------------------------------
  { name: "SQLSERVER_DEFAULT_LIMIT", required: false, codeDefault: "500", section: "Query bounds", note: "Rows returned per recordset when a call does not say." },
  { name: "SQLSERVER_MAX_LIMIT", required: false, codeDefault: "2000", section: "Query bounds", note: "Ceiling a call's maxRows is clamped to. T-SQL has no LIMIT, so the bound is applied by cancelling the row stream, never by rewriting the statement." },
  { name: "SQLSERVER_DEFAULT_TIMEOUT_MS", required: false, codeDefault: "30000", section: "Query bounds" },
  { name: "SQLSERVER_MAX_TIMEOUT_MS", required: false, codeDefault: "60000", section: "Query bounds" },
  {
    name: "SQLSERVER_MAX_FANOUT",
    required: false,
    codeDefault: "25",
    section: "Query bounds",
    note: "Most catalogs one run_read_query call may address via `databases`."
  },

  // --- Connection pools --------------------------------------------------------
  { name: "SQLSERVER_POOL_MAX", required: false, codeDefault: "5", section: "Connection pools", note: "Connections per (environment, catalog) pool." },
  {
    name: "SQLSERVER_MAX_POOLS",
    required: false,
    codeDefault: "12",
    section: "Connection pools",
    note: "Total pools held open, across every environment and catalog; least-recently-used are closed past this. One pool per catalog means an unbounded map is a connection leak."
  },
  { name: "SQLSERVER_POOL_IDLE_TIMEOUT_MS", required: false, codeDefault: "30000", section: "Connection pools" },

  // --- Stored-procedure execution (gated) --------------------------------------
  {
    name: "SQLSERVER_EXEC_ENABLED",
    required: false,
    default: "false",
    section: "Stored-procedure execution (OFF unless enabled)",
    note: "execute_routine is OFF unless true. Parsed strictly: exact \"true\" or \"1\". SQL Server records nothing about whether a procedure writes, so enabling this grants write capability regardless of which routines you intend to call."
  },
  {
    name: "SQLSERVER_EXEC_ALLOWLIST",
    required: false,
    codeDefault: "(empty = no narrowing)",
    section: "Stored-procedure execution (OFF unless enabled)",
    note: "Comma-separated glob patterns over `schema.routine`, e.g. `dbo.Report_*,dbo.Get*`. `*` is the whole grammar. Empty does NOT deny — the flag above is the gate."
  },
  { name: "SQLSERVER_EXEC_TIMEOUT_MS", required: false, codeDefault: "120000", section: "Stored-procedure execution (OFF unless enabled)" },

  // --- Node runtime -------------------------------------------------------------
  // Not a sqlserver-mcp variable and not read by this server's code, but declared for the same
  // reason `postgres-mcp` and `observe-mcp` declare it: a generated `.env.example` that omits what
  // a real deployment needs is not a complete picture. No `default` — writing one would pin an
  // external convention into every user's agent config.
  {
    name: "NODE_EXTRA_CA_CERTS",
    required: false,
    section: "Node runtime",
    note: "Absolute path to a PEM bundle added to Node's trust store. This is the fix for `TLS certificate verification failed` and the only one of the three that keeps the certificate verified. AWS RDS chains to an Amazon RDS CA that Node does not ship: download the bundle for your region from https://truststore.pki.rds.amazonaws.com/<region>/<region>-bundle.pem and point this at it."
  },
  {
    name: "NODE_TLS_REJECT_UNAUTHORIZED",
    required: false,
    section: "Node runtime",
    note: "Node-level TLS switch. A blunt last resort: it disables verification for every TLS connection the process makes. Prefer NODE_EXTRA_CA_CERTS, which fixes the cause; failing that TrustServerCertificate=true, which at least scopes the damage to this connection. Both of those leave the traffic encrypted but unauthenticated — reachable by anyone who can get in the path."
  }
];
