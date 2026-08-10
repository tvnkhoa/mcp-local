/**
 * The env-reading surface for postgres-mcp.
 *
 * Dependency rule 10 allows exactly two readers of `process.env` per server: `@mcp/core`'s reader
 * and the server's own config module. This server had `config/environments.ts` — which resolves the
 * multi-environment connection registry — but the remaining reads sat in `index.ts` next to the
 * config objects they built. S-41 moved them here.
 *
 * What did NOT move is the *composition*: `index.ts` still assembles `writeConfig` and
 * `migrationConfig` from these accessors, because that is where the gates and stores they belong to
 * are wired. Only the environment access relocated.
 *
 * Note `efRunner.ts` still spreads `process.env` into its `dotnet ef` child. That is inheritance,
 * not configuration — a child needs PATH and DOTNET_ROOT — and `guard:deps` was narrowed in S-41 to
 * stop reporting it.
 */

import { createEnvReader, defaultEnvSource, type EnvReader } from "@mcp/core";

import { resolveAliases } from "./aliases.js";

let reader: EnvReader | undefined;

/**
 * The environment snapshot, taken on first read rather than at import (PG-ENV-002).
 *
 * `index.ts` calls `resolveAliases()` as its first statement with an effect, but a module's imports
 * are fully evaluated before the importer's body runs — so a module-scope
 * `createEnvReader(defaultEnvSource())` here snapshotted `process.env` *before* the alias pass had
 * copied any legacy name onto its canonical one. Everything read through this reader then fell
 * through to its default: the write and migration gates read `false` where the operator had set
 * `true`, silently, while the deprecation warning on stderr asserted the fallback had worked.
 *
 * Two things fix it, and both are here on purpose. Lazily creating the reader means the snapshot
 * cannot precede an alias pass no matter who imports this module first; calling `resolveAliases()`
 * ourselves means a caller that never went through the entry point — a test, or a future second
 * entry point — gets the same alias handling a real boot does. That is the existing precedent from
 * `resolveEnvironments()`, and `resolveAliases` is idempotent, so the entry point's own call still
 * reports the deprecations exactly once.
 */
function env(): EnvReader {
  if (reader === undefined) {
    resolveAliases();
    reader = createEnvReader(defaultEnvSource());
  }
  return reader;
}

/**
 * A positive number, or the fallback when unset, unparseable, or ≤ 0.
 *
 * Body copied verbatim from `index.ts`, deliberately NOT replaced with
 * `envReader.positiveNumber`: that helper floors its result, and these values include
 * `POSTGRES_EXPLAIN_COST_WARN` and TTLs where a silent change of parsing is a change of behaviour. The
 * point of S-41 is to move the read, not to re-decide what it means.
 *
 * The read goes through `env().raw` rather than `process.env` directly so that a caller which never
 * reached the entry point still gets the alias pass (PG-ENV-002). `raw` trims and reports a
 * whitespace-only value as unset, which is the same outcome the old `!raw` / `Number("  ") <= 0`
 * path produced for every input — the parse below is unchanged.
 */
export function numberFromEnv(key: string, fallbackValue: number): number {
  const raw = env().raw(key);
  if (raw === undefined) {
    return fallbackValue;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallbackValue;
  }
  return parsed;
}

/**
 * A write gate.
 *
 * `strictFlag`, not `boolean`: `POSTGRES_WRITE_ENABLED` and `POSTGRES_MIGRATION_ENABLED` accept only an exact
 * `"true"` or `"1"` — no casing, no trimming. Loosening that would let `"TRUE "` or `"yes"` open a
 * write path, which is the one place in this server where a permissive parse is a security bug.
 */
export function parseBoolEnv(key: string): boolean {
  return env().strictFlag(key);
}

/** A trimmed string, empty when unset. */
function stringFromEnv(key: string): string {
  return env().string(key, "").trim();
}

/**
 * The raw `POSTGRES_WRITE_APPROVAL_SECRET`, before `resolveApprovalSecret` decides whether to generate
 * one. Empty string when unset, which is what triggers per-process generation.
 */
export function approvalSecretFromEnv(): string {
  return env().string("POSTGRES_WRITE_APPROVAL_SECRET", "");
}

/** `dotnet ef` project paths. Empty when unset; the migration gate reports that as unconfigured. */
export function dotnetProjectsFromEnv(): { project: string; startupProject: string } {
  return {
    project: stringFromEnv("POSTGRES_DOTNET_PROJECT"),
    startupProject: stringFromEnv("POSTGRES_DOTNET_STARTUP_PROJECT")
  };
}
