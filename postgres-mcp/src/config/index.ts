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

import { createEnvReader, defaultEnvSource } from "@mcp/core";

const envReader = createEnvReader(defaultEnvSource());

/**
 * A positive number, or the fallback when unset, unparseable, or ≤ 0.
 *
 * Body copied verbatim from `index.ts`, deliberately NOT replaced with
 * `envReader.positiveNumber`: that helper floors its result, and these values include
 * `POSTGRES_EXPLAIN_COST_WARN` and TTLs where a silent change of parsing is a change of behaviour. The
 * point of S-41 is to move the read, not to re-decide what it means.
 */
export function numberFromEnv(key: string, fallbackValue: number): number {
  const raw = process.env[key];
  if (!raw) {
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
  return envReader.strictFlag(key);
}

/** A trimmed string, empty when unset. */
function stringFromEnv(key: string): string {
  return envReader.string(key, "").trim();
}

/**
 * The raw `POSTGRES_WRITE_APPROVAL_SECRET`, before `resolveApprovalSecret` decides whether to generate
 * one. Empty string when unset, which is what triggers per-process generation.
 */
export function approvalSecretFromEnv(): string {
  return envReader.string("POSTGRES_WRITE_APPROVAL_SECRET", "");
}

/** `dotnet ef` project paths. Empty when unset; the migration gate reports that as unconfigured. */
export function dotnetProjectsFromEnv(): { project: string; startupProject: string } {
  return {
    project: stringFromEnv("POSTGRES_DOTNET_PROJECT"),
    startupProject: stringFromEnv("POSTGRES_DOTNET_STARTUP_PROJECT")
  };
}
