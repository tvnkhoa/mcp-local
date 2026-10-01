/**
 * Former environment variable names, still honoured.
 *
 * The 2026-10-01 naming pass renamed these so every server follows one convention
 * (`docs/reference/conventions.md`, env-var naming): row bounds are `_DEFAULT_LIMIT` / `_MAX_LIMIT`,
 * booleans end `_ENABLED`, units are spelled out, and nothing is abbreviated. An install that still
 * sets an old name keeps working, with a one-time deprecation warning on stderr.
 *
 * The mechanism is `@mcp/core`'s `resolveEnvAliases`; its header has the rules. This table is
 * duplicated from `packages/manifest/src/envSpecs/sqlserver.ts` because a server must not import the workspace tooling packages
 * (dependency rule 5). `scripts/lib/envAliases.test.mjs` compares the two and fails on drift.
 */

import { resolveEnvAliases } from "@mcp/core";

/** canonical name → the former names it replaced. */
export const ENV_ALIASES: Readonly<Record<string, readonly string[]>> = {
  SQLSERVER_POOL_MAX_CONNECTIONS: ["SQLSERVER_POOL_MAX"],
  SQLSERVER_EXEC_ALLOWED_ROUTINES: ["SQLSERVER_EXEC_ALLOWLIST"],
  SQLSERVER_MAX_FANOUT_DATABASES: ["SQLSERVER_MAX_FANOUT"]
};

/** Copy any former name's value onto its canonical name. Idempotent. Returns the former names used. */
export function resolveAliases(env: NodeJS.ProcessEnv = process.env): string[] {
  return resolveEnvAliases({ label: "sqlserver-mcp", names: ENV_ALIASES }, env);
}
