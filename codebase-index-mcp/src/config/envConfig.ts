/**
 * The only module in this server permitted to read `process.env` (dependency rule 10, enforced by
 * `guard:deps` as `env/direct-access`).
 *
 * S-41 moved seven reads here from five other modules. They were not doing anything wrong
 * individually — each was a small `process.env.X ?? default` next to the code that used it — but
 * spread across the tree there was no single place to answer "what does this server read?", which
 * is exactly the question S-35 had to answer by proxying a live boot because no file could.
 */

import {
  parseAllowedRoots,
  parseAutoWatchRepos,
  parseBooleanEnv,
  parseWatchConfigFromEnv
} from "../middleware/indexGuardrails.js";
import { parsePerformanceProfileEnv } from "./performanceConfig.js";
import type { PerformanceProfile } from "../services/indexing/indexPipeline.js";

export function numberFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }

  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    return fallback;
  }

  return Math.floor(value);
}

export function ratioFromEnv(raw: string | undefined, fallback: number): number {
  if (!raw) {
    return fallback;
  }

  const value = Number(raw);
  if (!Number.isFinite(value)) {
    return fallback;
  }

  return Math.max(0, Math.min(1, value));
}

export function nonNegativeNumberFromEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) {
    return undefined;
  }

  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    return undefined;
  }

  return Math.floor(value);
}

export function parseOptionalBooleanEnv(raw: string | undefined): boolean | undefined {
  if (raw === undefined) {
    return undefined;
  }
  return parseBooleanEnv(raw, false);
}

/**
 * Like {@link nonNegativeNumberFromEnv} but returns `undefined` for a missing or invalid value
 * rather than a fallback, so a caller can distinguish "not configured" from "configured to zero".
 *
 * Moved here from `treeSitterExtractor.ts` in S-41.
 */
export function optionalNumberFromEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) {
    return undefined;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return undefined;
  }
  return Math.floor(parsed);
}

/** A 0–1 ratio, clamped. `undefined` when unset. Moved here from `treeSitterExtractor.ts` (S-41). */
export function optionalRatioFromEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) {
    return undefined;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    return undefined;
  }
  return Math.min(1, Math.max(0, parsed));
}

/** A raw string, trimmed, or `undefined` when unset or blank. */
export function optionalStringFromEnv(name: string): string | undefined {
  const raw = process.env[name];
  if (raw === undefined) {
    return undefined;
  }
  const trimmed = raw.trim();
  return trimmed === "" ? undefined : trimmed;
}

/**
 * `CODEBASE_INDEX_INDEX_LOG`, lowercased. Read once at module load, as it was when
 * `indexProgress.ts` owned it.
 */
export const INDEX_LOG_MODE = (process.env.CODEBASE_INDEX_INDEX_LOG ?? "").toLowerCase();

/**
 * npm's own `npm_package_version`, set only when the process was started through an npm script.
 *
 * Not this server's configuration, which is why it looked out of place in the old `serverUtils.ts` — but it
 * is still an environment read, and rule 10 does not carve out exceptions for whose variable it is.
 */
export const NPM_PACKAGE_VERSION = (process.env.npm_package_version ?? "").trim();

// ── Named accessors, so `index.ts` never touches process.env ─────────────────
// Each one pairs a variable name with the parser that already owned its meaning. The parsers are
// unchanged and still live in `middleware/indexGuardrails.ts`; only the environment access moved
// here (S-41). Read at call time, exactly as before.

/** A boolean flag with an explicit default — note not every default is `false`. */
export function booleanFromEnv(name: string, fallback: boolean): boolean {
  return parseBooleanEnv(process.env[name], fallback);
}

/** A 0–1 ratio with a default. Wraps {@link ratioFromEnv}, which takes the raw value. */
export function ratioFromEnvName(name: string, fallback: number): number {
  return ratioFromEnv(process.env[name], fallback);
}

/** A plain string with a default. Used for the refactor HMAC secret, which may legitimately be "". */
export function stringFromEnv(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

/** `CODEBASE_INDEX_ALLOWED_ROOTS` — the one required variable. */
export function allowedRootsFromEnv(): string[] {
  return parseAllowedRoots(process.env.CODEBASE_INDEX_ALLOWED_ROOTS);
}

/** `CODEBASE_INDEX_AUTO_WATCH_REPOS`. */
export function autoWatchReposFromEnv(): ReturnType<typeof parseAutoWatchRepos> {
  return parseAutoWatchRepos(process.env.CODEBASE_INDEX_AUTO_WATCH_REPOS);
}

/** The whole watch config, which reads several `CODEBASE_INDEX_WATCH_*` variables. */
export function watchConfigFromEnv(): ReturnType<typeof parseWatchConfigFromEnv> {
  return parseWatchConfigFromEnv(process.env);
}

/**
 * `CODEBASE_INDEX_LARGE_REPO_PROFILE`, resolved per run.
 *
 * Deliberately a function, not a const: the runner calls it on every index run so the override can
 * be changed without restarting the server. That was true before this moved, and is preserved.
 */
export function performanceProfileOverrideFromEnv(): PerformanceProfile | "auto" {
  return parsePerformanceProfileEnv(process.env.CODEBASE_INDEX_LARGE_REPO_PROFILE);
}
