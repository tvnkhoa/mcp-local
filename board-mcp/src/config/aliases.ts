/**
 * Former environment variable names, still honoured — none yet.
 *
 * Every server keeps this table in the same place so `scripts/lib/envAliases.test.mjs` can compare
 * it with `packages/manifest/src/envSpecs/board-mcp.ts` (`deprecatedAliases`) and fail on drift. A
 * server must not import the workspace tooling packages (dependency rule 5), hence the copy. When a
 * BOARD_* variable is first renamed, add the row here and in the manifest together.
 */

import { resolveEnvAliases } from "@mcp/core";

/** canonical name → the former names it replaced. */
export const ENV_ALIASES: Readonly<Record<string, readonly string[]>> = {
};

/** Copy any former name's value onto its canonical name. Idempotent. Returns the former names used. */
export function resolveAliases(env: NodeJS.ProcessEnv = process.env): string[] {
  return resolveEnvAliases({ label: "board-mcp", names: ENV_ALIASES }, env);
}
