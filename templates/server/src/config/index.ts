/**
 * The one place __DIR__ reads configuration.
 *
 * Dependency rule 10: `process.env` is touched here and nowhere else in this server, via
 * `@mcp/core`'s reader. `guard:deps` reports a violation anywhere else, so pass the loaded config
 * down rather than reaching for the environment again.
 */

import { createEnvReader, defaultEnvSource, type EnvReader } from "@mcp/core";

let reader: EnvReader | undefined;

/**
 * The environment snapshot, taken on first read rather than at import.
 *
 * `defaultEnvSource()` copies `process.env` — so *when* it is called decides what the server sees.
 * At module scope it runs during the entry point's import phase, before a single statement of
 * `index.ts` has executed, which means anything the entry point does to the environment first is
 * invisible to every read below. `postgres-mcp` shipped that bug (PG-ENV-002): its legacy-variable
 * alias pass ran as the first statement of `index.ts` and still lost to this snapshot, silently
 * turning off its write and migration gates.
 *
 * Reading lazily costs nothing and removes the ordering question entirely. Keep it lazy.
 */
function env(): EnvReader {
  return (reader ??= createEnvReader(defaultEnvSource()));
}

export interface __PASCAL__Config {
  /** Example required setting. Replace with this server's own. */
  readonly baseUrl: string;
  readonly timeoutMs: number;
}

/**
 * Fail fast on missing configuration.
 *
 * A server that starts with half a config and fails on the first call is harder to diagnose than
 * one that refuses to start, so validation belongs here rather than in a handler.
 */
export function loadConfig(): __PASCAL__Config {
  const baseUrl = env().string("__ENV_PREFIX___BASE_URL", "");
  if (baseUrl === "") {
    throw new Error("__ENV_PREFIX___BASE_URL is required — see .env.example");
  }
  return {
    baseUrl,
    timeoutMs: env().positiveNumber("__ENV_PREFIX___TIMEOUT_MS", 30_000)
  };
}

/**
 * Non-secret echo for `health_check` and the start-up log.
 *
 * Never return a credential from here: the value reaches stderr and the health payload. Report
 * whether a secret is *present*, not what it is.
 */
export function describeConfig(config: __PASCAL__Config): Record<string, unknown> {
  return {
    baseUrl: config.baseUrl,
    timeoutMs: config.timeoutMs
  };
}
