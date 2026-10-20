/**
 * The one place board-mcp reads configuration.
 *
 * Dependency rule 10: `process.env` is touched here and nowhere else in this server, via
 * `@mcp/core`'s reader. Pass the loaded config down rather than reaching for the environment again.
 */

import path from "node:path";

import { createEnvReader, defaultEnvSource, type EnvReader, type EnvSource } from "@mcp/core";

let reader: EnvReader | undefined;

/** The environment snapshot, taken on first read rather than at import (see PG-ENV-002). */
function env(): EnvReader {
  return (reader ??= createEnvReader(defaultEnvSource()));
}

/** Where board.mjs lives, relative to the repo root. */
export const BOARD_CLI_RELATIVE = "checks/board/board.mjs";

export const DEFAULT_CALL_TIMEOUT_MS = 30_000;
/** A call longer than this is refused at load: the board's own mutex breaks a stale lock at 30 s. */
export const MAX_CALL_TIMEOUT_MS = 600_000;

export interface BoardConfig {
  /** `BOARD_REPO_ROOT` exactly as configured. Checked for absoluteness per call (`rootProblem`). */
  readonly repoRoot: string;
  /** `BOARD_WRITE_ENABLED` — exact "true" or "1"; anything else is off. */
  readonly writeEnabled: boolean;
  /** `BOARD_CALL_TIMEOUT_MS` — one board.mjs run is killed past it. */
  readonly callTimeoutMs: number;
}

/**
 * Fail fast on a missing root. Absoluteness is NOT checked here: the contract snapshot boots the
 * server with a placeholder that is not a path, and the tools refuse a non-absolute root anyway.
 */
export function loadConfig(source?: EnvSource): BoardConfig {
  const reader = source === undefined ? env() : createEnvReader(source);
  const repoRoot = reader.string("BOARD_REPO_ROOT", "");
  if (repoRoot === "") {
    throw new Error("BOARD_REPO_ROOT is required (absolute path of the repo holding checks/board/board.mjs) — see .env.example");
  }
  return {
    repoRoot,
    writeEnabled: reader.strictFlag("BOARD_WRITE_ENABLED"),
    callTimeoutMs: Math.min(reader.positiveNumber("BOARD_CALL_TIMEOUT_MS", DEFAULT_CALL_TIMEOUT_MS), MAX_CALL_TIMEOUT_MS)
  };
}

/** Why the configured root cannot be used, or null when it can. */
export function rootProblem(config: BoardConfig): string | null {
  if (!path.isAbsolute(config.repoRoot)) {
    return `BOARD_REPO_ROOT must be an absolute path; it is ${JSON.stringify(config.repoRoot)}.`;
  }
  return null;
}

/** Absolute path of the wrapped CLI. */
export function boardCliPath(config: BoardConfig): string {
  return path.join(config.repoRoot, BOARD_CLI_RELATIVE);
}

/**
 * The repo root a test may run the real CLI against: `BOARD_REPO_ROOT` when set, or null. Tests
 * call this rather than reading the environment themselves (dependency rule 10).
 */
export function boardRepoRootFromEnv(): string | null {
  return env().optionalString("BOARD_REPO_ROOT") ?? null;
}

/** Non-secret echo for `health_check` and the start-up log. Nothing here is a credential. */
export function describeConfig(config: BoardConfig): Record<string, unknown> {
  return {
    repoRoot: config.repoRoot.replace(/\\/g, "/"),
    writeEnabled: config.writeEnabled,
    callTimeoutMs: config.callTimeoutMs
  };
}
