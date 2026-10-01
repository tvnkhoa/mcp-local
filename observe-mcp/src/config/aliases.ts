/**
 * Former environment variable names, still honoured.
 *
 * The 2026-10-01 naming pass renamed these so every server follows one convention
 * (`docs/reference/conventions.md`, env-var naming): row bounds are `_DEFAULT_LIMIT` / `_MAX_LIMIT`,
 * booleans end `_ENABLED`, units are spelled out, and nothing is abbreviated. An install that still
 * sets an old name keeps working, with a one-time deprecation warning on stderr.
 *
 * The mechanism is `@mcp/core`'s `resolveEnvAliases`; its header has the rules. This table is
 * duplicated from `packages/manifest/src/envSpecs/observe.ts` because a server must not import the workspace tooling packages
 * (dependency rule 5). `scripts/lib/envAliases.test.mjs` compares the two and fails on drift.
 */

import { resolveEnvAliases } from "@mcp/core";

/** canonical name → the former names it replaced. */
export const ENV_ALIASES: Readonly<Record<string, readonly string[]>> = {
  OBSERVE_DEFAULT_LIMIT: ["OBSERVE_DEFAULT_SIZE"],
  OBSERVE_MAX_LIMIT: ["OBSERVE_MAX_SIZE"],
  OBSERVE_MESSAGE_MAX_CHARS_NANO: ["OBSERVE_MSG_MAX_NANO"],
  OBSERVE_EXCEPTION_MAX_CHARS_NANO: ["OBSERVE_EXC_MAX_NANO"],
  OBSERVE_MESSAGE_MAX_CHARS_COMPACT: ["OBSERVE_MSG_MAX_COMPACT"],
  OBSERVE_EXCEPTION_MAX_CHARS_COMPACT: ["OBSERVE_EXC_MAX_COMPACT"],
  OBSERVE_MESSAGE_MAX_CHARS_STANDARD: ["OBSERVE_MSG_MAX_STANDARD"],
  OBSERVE_EXCEPTION_MAX_CHARS_STANDARD: ["OBSERVE_EXC_MAX_STANDARD"],
  OBSERVE_MESSAGE_MAX_CHARS_VERBOSE: ["OBSERVE_MSG_MAX_VERBOSE"],
  OBSERVE_EXCEPTION_MAX_CHARS_VERBOSE: ["OBSERVE_EXC_MAX_VERBOSE"]
};

/** Copy any former name's value onto its canonical name. Idempotent. Returns the former names used. */
export function resolveAliases(env: NodeJS.ProcessEnv = process.env): string[] {
  return resolveEnvAliases({ label: "observe-mcp", names: ENV_ALIASES }, env);
}
