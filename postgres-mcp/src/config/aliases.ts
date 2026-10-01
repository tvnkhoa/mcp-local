/**
 * Legacy environment variable names, still honoured.
 *
 * Two renames live here. S-43 converged three unrelated prefixes on `POSTGRES_*`: `CH_*` (named for
 * the CommunicationHub app this server was first written against), `PG_*` and `MCP_DB_*`. The
 * 2026-10-01 naming pass then renamed five `POSTGRES_*` names so a lane's variables carry the
 * lane (`POSTGRES_DOTNET_*` → `POSTGRES_MIGRATION_DOTNET_*`), the shared approval secret stops
 * claiming to be the write lane's, and the EXPLAIN threshold says what it is. A var renamed twice
 * lists both former names, newest first.
 *
 * The mechanism is `@mcp/core`'s `resolveEnvAliases`; its header has the rules. This table is
 * duplicated from `packages/manifest/src/envSpecs/postgres.ts` because a server must not import
 * the workspace tooling packages (dependency rule 5, enforced as `servers/tooling-import`).
 * `scripts/lib/envAliases.test.mjs` compares the two and fails on drift.
 */

import { resolveEnvAliases } from "@mcp/core";

/** canonical name → the former names it replaced. */
export const ENV_ALIASES: Readonly<Record<string, readonly string[]>> = {
  POSTGRES_CONNECTION: ["CH_DB_CONNECTION"],
  POSTGRES_APPSETTINGS_ROOTS: ["CH_APPSETTINGS_ROOTS"],
  POSTGRES_CONNECTION_NAME: ["CH_CONNECTION_NAME"],
  POSTGRES_ALLOWED_ENVIRONMENTS: ["PG_ALLOWED_ENVIRONMENTS"],
  POSTGRES_WRITABLE_ENVIRONMENTS: ["PG_WRITABLE_ENVIRONMENTS"],
  POSTGRES_DEFAULT_ENVIRONMENT: ["PG_DEFAULT_ENVIRONMENT"],
  POSTGRES_DEFAULT_LIMIT: ["MCP_DB_DEFAULT_LIMIT"],
  POSTGRES_MAX_LIMIT: ["MCP_DB_MAX_LIMIT"],
  POSTGRES_DEFAULT_TIMEOUT_MS: ["MCP_DB_DEFAULT_TIMEOUT_MS"],
  POSTGRES_MAX_TIMEOUT_MS: ["MCP_DB_MAX_TIMEOUT_MS"],
  POSTGRES_EXPLAIN_COST_WARN_THRESHOLD: ["POSTGRES_EXPLAIN_COST_WARN", "PG_EXPLAIN_COST_WARN"],
  POSTGRES_WRITE_ENABLED: ["PG_WRITE_ENABLED"],
  POSTGRES_APPROVAL_SECRET: ["POSTGRES_WRITE_APPROVAL_SECRET", "PG_WRITE_APPROVAL_SECRET"],
  POSTGRES_WRITE_PREVIEW_TTL_MS: ["PG_WRITE_PREVIEW_TTL_MS"],
  POSTGRES_WRITE_SAMPLE_LIMIT: ["PG_WRITE_SAMPLE_LIMIT"],
  POSTGRES_MIGRATION_ENABLED: ["PG_MIGRATION_ENABLED"],
  POSTGRES_MIGRATION_PREVIEW_TTL_MS: ["PG_MIGRATION_PREVIEW_TTL_MS"],
  POSTGRES_MIGRATION_DOTNET_PROJECT: ["POSTGRES_DOTNET_PROJECT", "CH_DOTNET_PROJECT"],
  POSTGRES_MIGRATION_DOTNET_STARTUP_PROJECT: ["POSTGRES_DOTNET_STARTUP_PROJECT", "CH_DOTNET_STARTUP_PROJECT"],
  POSTGRES_MIGRATION_DOTNET_TIMEOUT_MS: ["POSTGRES_DOTNET_TIMEOUT_MS", "PG_DOTNET_TIMEOUT_MS"]
};

/** canonical prefix → the former prefixes it replaced. */
export const ENV_PREFIX_ALIASES: Readonly<Record<string, readonly string[]>> = {
  POSTGRES_ENV_: ["PG_ENV_"]
};

/**
 * Copy any legacy value onto its canonical name, so the rest of the server only reads canonical
 * names. Idempotent; called before anything reads configuration.
 *
 * @returns the legacy names that were actually used, for the caller to report.
 */
export function resolveAliases(env: NodeJS.ProcessEnv = process.env): string[] {
  return resolveEnvAliases({ label: "postgres-mcp", names: ENV_ALIASES, prefixes: ENV_PREFIX_ALIASES }, env);
}
