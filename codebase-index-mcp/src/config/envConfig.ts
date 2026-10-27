/**
 * The only module in this server permitted to read `process.env` (dependency rule 10, enforced by
 * `guard:deps` as `env/direct-access`).
 *
 * S-41 moved seven reads here from five other modules. They were not doing anything wrong
 * individually — each was a small `process.env.X ?? default` next to the code that used it — but
 * spread across the tree there was no single place to answer "what does this server read?", which
 * is exactly the question S-35 had to answer by proxying a live boot because no file could.
 */

import { randomBytes } from "node:crypto";
import path from "node:path";
import {
  parseAllowedRoots,
  parseAutoWatchRepos,
  parseBooleanEnv,
  parseWatchConfigFromEnv
} from "../middleware/indexGuardrails.js";
import type { PerformanceProfile } from "../services/indexing/indexPipeline.js";
import { resolveAliases } from "./aliases.js";

// Former names first: INDEX_LOG_MODE below is read at module load.
resolveAliases();

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

function ratioFromEnv(raw: string | undefined, fallback: number): number {
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
 * `CODEBASE_INDEX_LOG_MODE`, lowercased. Read once at module load, as it was when
 * `indexProgress.ts` owned it.
 */
export const INDEX_LOG_MODE = (process.env.CODEBASE_INDEX_LOG_MODE ?? "").toLowerCase();

/**
 * npm's own `npm_package_version`, set only when the process was started through an npm script.
 *
 * Not this server's configuration, which is why it looked out of place in the old `serverUtils.ts` — but it
 * is still an environment read, and rule 10 does not carve out exceptions for whose variable it is.
 */
export const NPM_PACKAGE_VERSION = (process.env.npm_package_version ?? "").trim();

/**
 * MCP-ISSUE-106: git's default `core.excludesFile` when the user set none — `$XDG_CONFIG_HOME/git/ignore`, else
 * `~/.config/git/ignore` (HOME, then USERPROFILE) — or null without either. Git's variables, not this server's,
 * read here for the same reason as `npm_package_version`. Read at call time.
 */
export function defaultGitExcludesFile(): string | null {
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg) return path.join(xdg, "git", "ignore");
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  return home ? path.join(home, ".config", "git", "ignore") : null;
}

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

/** `CODEBASE_INDEX_WATCH_AUTO_REPOS`. */
export function autoWatchReposFromEnv(): ReturnType<typeof parseAutoWatchRepos> {
  return parseAutoWatchRepos(process.env.CODEBASE_INDEX_WATCH_AUTO_REPOS);
}

/** The whole watch config, which reads several `CODEBASE_INDEX_WATCH_*` variables. */
export function watchConfigFromEnv(): ReturnType<typeof parseWatchConfigFromEnv> {
  return parseWatchConfigFromEnv(process.env);
}

/**
 * Map the raw `CODEBASE_INDEX_LARGE_REPO_PROFILE` value onto a profile.
 *
 * Pure — value in, profile out, no `process.env` — and it lives here rather than in
 * `performanceConfig.ts` to keep `config/` acyclic. `performanceConfig` needs this module's env
 * primitives (`nonNegativeNumberFromEnv`, `parseOptionalBooleanEnv`), so the dependency has to run
 * in that direction only; with this function on the other side the two imported each other, which
 * was the 2-cycle at the root of six of the eight cycles a full scan reported in this server.
 */
function parsePerformanceProfileEnv(raw: string | undefined): PerformanceProfile | "auto" {
  const value = (raw ?? "auto").trim().toLowerCase();
  if (value === "standard" || value === "off") {
    return "standard";
  }
  if (value === "large" || value === "balanced") {
    return "large";
  }
  if (value === "very-large" || value === "aggressive") {
    return "very-large";
  }
  return "auto";
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

/**
 * R3 exact: the TypeScript LanguageService lane of `find_field_accesses`.
 *
 * `CODEBASE_INDEX_TS_LS_ENABLED` defaults to true: the lane only ever runs for a TS/JS field, is
 * lazy (no program is built until such a query arrives) and replaces an answer the graph can only
 * give as a lower bound. `_COLD_START_MS` is the budget for one answer (cold or warm) and
 * `_MAX_RSS_MB` the process RSS ceiling; a breach is a coverage gap, never a partial list.
 */
/**
 * R4: how this process is reached. stdio unless started with `--transport http` (what
 * `scripts/serve-http.mjs` passes), so an HTTP port left in a stdio registration's env never turns
 * a per-session server into a listener. http needs both `CODEBASE_INDEX_HTTP_PORT` and
 * `CODEBASE_INDEX_HTTP_TOKEN`; a missing one is a start-up failure, not a silent stdio fallback.
 */
export function transportFromEnv(
  argv: readonly string[] = process.argv.slice(2)
): { kind: "stdio" } | { kind: "http"; port: number; token: string } {
  const flag = argv.findIndex((a) => a === "--transport" || a.startsWith("--transport="));
  const value = flag < 0 ? "stdio" : argv[flag]!.includes("=") ? argv[flag]!.split("=")[1] : argv[flag + 1];
  if (value === "stdio") return { kind: "stdio" };
  if (value !== "http") throw new Error(`--transport must be stdio or http, got ${String(value)}`);
  const port = Number(process.env.CODEBASE_INDEX_HTTP_PORT ?? "");
  const token = process.env.CODEBASE_INDEX_HTTP_TOKEN ?? "";
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("--transport http needs CODEBASE_INDEX_HTTP_PORT (1-65535)");
  }
  if (token === "") throw new Error("--transport http needs CODEBASE_INDEX_HTTP_TOKEN");
  return { kind: "http", port, token };
}

export function tsLanguageServiceConfigFromEnv(): { enabled: boolean; budgetMs: number; maxRssMb: number } {
  return {
    enabled: booleanFromEnv("CODEBASE_INDEX_TS_LS_ENABLED", true),
    budgetMs: numberFromEnv("CODEBASE_INDEX_TS_LS_COLD_START_MS", 60_000),
    maxRssMb: numberFromEnv("CODEBASE_INDEX_TS_LS_MAX_RSS_MB", 2_500)
  };
}

/**
 * MCP-ISSUE-104: the HMAC secret for refactor approval tokens. Unset, it used to fall back to a constant in
 * the source, so anyone could mint an apply token. Now: set, it is used; unset over HTTP (one process shared by
 * every session, restarted by the supervisor), startup refuses — `scripts/serve-http.mjs` supplies a persisted
 * one; unset over stdio, a random secret for this process (its previews die with it anyway).
 */
export function refactorApprovalSecret(
  envValue: string,
  transport: "stdio" | "http"
): { secret: string; source: "env" | "per-process" } {
  if (envValue.trim().length > 0) return { secret: envValue, source: "env" };
  if (transport === "http") {
    throw new Error(
      "--transport http needs CODEBASE_INDEX_REFACTOR_APPROVAL_SECRET (a refactor approval token must outlive a restart and must not be guessable). scripts/serve-http.mjs creates and passes one; set it yourself when serving another way."
    );
  }
  return { secret: randomBytes(32).toString("hex"), source: "per-process" };
}
