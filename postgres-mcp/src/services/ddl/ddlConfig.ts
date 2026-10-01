/**
 * The DDL lane's configuration, its gate, and the timeout policy.
 *
 * Composed in `index.ts` from `config/index.ts` accessors, like `WriteConfig` and
 * `MigrationConfig`. Environment scope is not configured here: the lane writes to the same
 * environments as the write lane (`POSTGRES_WRITABLE_ENVIRONMENTS`), and `prod` is never one of
 * them.
 */

import { PolicyViolationError } from "../../middleware/errors.js";
import type { DdlDirectives } from "../../middleware/ddlGuardrails.js";

export interface DdlConfig {
  enabled: boolean;
  /** Absolute path, or "" when unset. Only file-mode plans and `ddl_create` need it. */
  migrationsDir: string;
  /** Per-migration `lock_timeout`. A directive may lower it, never raise it. */
  lockTimeoutMs: number;
  /** Default per-statement `statement_timeout`. */
  statementTimeoutMs: number;
  /** Ceiling for the `-- mcp:statement-timeout-ms` directive, e.g. a long CONCURRENTLY build. */
  maxStatementTimeoutMs: number;
  previewTtlMs: number;
  approvalSecret: string;
}

export function assertDdlEnabled(config: DdlConfig): void {
  if (!config.enabled) {
    throw new PolicyViolationError(
      "DDL_DISABLED",
      "DDL migrations are disabled. Set POSTGRES_DDL_ENABLED=true (and POSTGRES_DDL_MIGRATIONS_DIR for file-based migrations) to enable."
    );
  }
}

/** The migrations directory, or a refusal naming the variable that would set it. */
export function requireMigrationsDir(config: DdlConfig): string {
  if (config.migrationsDir === "") {
    throw new PolicyViolationError(
      "DDL_MIGRATIONS_DIR_UNCONFIGURED",
      "POSTGRES_DDL_MIGRATIONS_DIR is not set. File-based migrations need it; inline ddl_preview { sql } does not."
    );
  }
  return config.migrationsDir;
}

export interface EffectiveTimeouts {
  lockTimeoutMs: number;
  statementTimeoutMs: number;
}

/**
 * The timeouts one migration runs with: its directives, bounded by the operator's config.
 *
 * Out-of-bounds values are refused, not clamped. A migration that asked for a 10-minute lock wait
 * and silently got 5 seconds would fail in a way that reads like contention, not like config.
 */
export function effectiveTimeouts(
  config: DdlConfig,
  directives: DdlDirectives
): { ok: true; timeouts: EffectiveTimeouts } | { ok: false; error: { code: string; message: string } } {
  const lock = directives.lockTimeoutMs ?? config.lockTimeoutMs;
  if (lock > config.lockTimeoutMs) {
    return {
      ok: false,
      error: {
        code: "DDL_DIRECTIVE_EXCEEDS_LIMIT",
        message: `-- mcp:lock-timeout-ms=${String(lock)} is above POSTGRES_DDL_LOCK_TIMEOUT_MS (${String(config.lockTimeoutMs)}). A migration may only lower the lock wait.`
      }
    };
  }
  const statement = directives.statementTimeoutMs ?? config.statementTimeoutMs;
  if (statement > config.maxStatementTimeoutMs) {
    return {
      ok: false,
      error: {
        code: "DDL_DIRECTIVE_EXCEEDS_LIMIT",
        message: `-- mcp:statement-timeout-ms=${String(statement)} is above POSTGRES_DDL_MAX_STATEMENT_TIMEOUT_MS (${String(config.maxStatementTimeoutMs)}).`
      }
    };
  }
  return { ok: true, timeouts: { lockTimeoutMs: lock, statementTimeoutMs: statement } };
}
