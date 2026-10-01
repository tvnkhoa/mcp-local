/**
 * Former environment variable names, still honoured.
 *
 * The 2026-10-01 naming pass renamed these so every server follows one convention
 * (`docs/reference/conventions.md`, env-var naming): row bounds are `_DEFAULT_LIMIT` / `_MAX_LIMIT`,
 * booleans end `_ENABLED`, units are spelled out, and nothing is abbreviated. An install that still
 * sets an old name keeps working, with a one-time deprecation warning on stderr.
 *
 * The mechanism is `@mcp/core`'s `resolveEnvAliases`; its header has the rules. This table is
 * duplicated from `packages/manifest/src/envSpecs/codebaseIndex.ts` because a server must not import the workspace tooling packages
 * (dependency rule 5). `scripts/lib/envAliases.test.mjs` compares the two and fails on drift.
 */

import { resolveEnvAliases } from "@mcp/core";

/** canonical name → the former names it replaced. */
export const ENV_ALIASES: Readonly<Record<string, readonly string[]>> = {
  CODEBASE_INDEX_NUGET_NAMESPACE_MAP: ["NUGET_NAMESPACE_MAP"],
  CODEBASE_INDEX_MAX_LIMIT: ["CODEBASE_INDEX_MAX_RESULT_LIMIT"],
  CODEBASE_INDEX_LOG_MODE: ["CODEBASE_INDEX_INDEX_LOG"],
  CODEBASE_INDEX_SUBTRANSACTION_FILES: ["CODEBASE_INDEX_SUBTX_SIZE"],
  CODEBASE_INDEX_WATCH_AUTO_REPOS: ["CODEBASE_INDEX_AUTO_WATCH_REPOS"],
  CODEBASE_INDEX_WATCH_AUTO_START_ENABLED: ["CODEBASE_INDEX_WATCH_AUTO_START"],
  CODEBASE_INDEX_POST_RESOLVE_TYPE_REFS_ENABLED: ["CODEBASE_INDEX_POST_RESOLVE_TYPE_REFS"],
  CODEBASE_INDEX_POST_RESOLVE_PROPERTY_REFS_ENABLED: ["CODEBASE_INDEX_POST_RESOLVE_PROPERTY_REFS"],
  CODEBASE_INDEX_REFACTOR_STRICT_APPROVAL_ENABLED: ["CODEBASE_INDEX_REFACTOR_STRICT_APPROVAL"]
};

/** Copy any former name's value onto its canonical name. Idempotent. Returns the former names used. */
export function resolveAliases(env: NodeJS.ProcessEnv = process.env): string[] {
  return resolveEnvAliases({ label: "codebase-index", names: ENV_ALIASES }, env);
}
