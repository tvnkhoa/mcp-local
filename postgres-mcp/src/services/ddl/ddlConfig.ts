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
import { isInternalSchema } from "../../middleware/internalSchemas.js";

/** A `schema.name` pair, both already validated as plain lower-case identifiers. */
export interface QualifiedName {
  schema: string;
  name: string;
}

/** A custom setting (`prefix.name`) the server sets before each migration runs. */
export interface SessionSetting {
  name: string;
  value: string;
}

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
  /**
   * POSTGRES_DDL_EXTERNAL_LEDGER. When set, the repo's own ledger table (`filename`, `checksum`)
   * replaces `mcp_ops.ddl_history`, and the directory holds psql-style `NNNN-name.sql` files:
   * forward-only, checksummed over their raw bytes, as the repo's runner reads them.
   */
  externalLedger?: QualifiedName;
  /** POSTGRES_DDL_OWNER_ROLES. The only roles `ALTER … OWNER TO` may name. Empty refuses it. */
  ownerRoles?: readonly string[];
  /** POSTGRES_DDL_SESSION_SETTINGS. Set (transaction-local) before every migration runs. */
  sessionSettings?: readonly SessionSetting[];
  /**
   * POSTGRES_DDL_ADOPTION_SENTINEL. A relation whose presence means the schema already exists. A
   * file-mode up plan against an EMPTY ledger refuses while it exists, instead of applying every
   * file onto a populated database.
   */
  adoptionSentinel?: QualifiedName;
  /** Why one of the settings above could not be parsed. Every DDL tool refuses with it. */
  configError?: string;
}

export function assertDdlEnabled(config: DdlConfig): void {
  if (!config.enabled) {
    throw new PolicyViolationError(
      "DDL_DISABLED",
      "DDL migrations are disabled. Set POSTGRES_DDL_ENABLED=true (and POSTGRES_DDL_MIGRATIONS_DIR for file-based migrations) to enable."
    );
  }
  if (config.configError !== undefined) {
    throw new PolicyViolationError("DDL_CONFIG_INVALID", config.configError);
  }
}

// ── parsing the lane's settings ──────────────────────────────────────────────

const IDENTIFIER = /^[a-z_][a-z0-9_$]{0,62}$/;
/** A custom setting needs a dot, which is what keeps every core GUC (search_path, role…) out. */
const CUSTOM_SETTING = /^[a-z_][a-z0-9_]{0,62}\.[a-z_][a-z0-9_.]{0,62}$/;
const MAX_SESSION_SETTINGS = 16;
const MAX_SETTING_VALUE = 256;

export interface DdlLaneSettings {
  externalLedger: string;
  ownerRoles: string;
  sessionSettings: string;
  adoptionSentinel: string;
}

function parseQualified(raw: string, variable: string): QualifiedName | string {
  const parts = raw.split(".");
  const [schema, name] = parts.length === 1 ? ["public", parts[0] ?? ""] : parts;
  if (parts.length > 2 || schema === undefined || name === undefined || !IDENTIFIER.test(schema) || !IDENTIFIER.test(name)) {
    return `${variable} must be [schema.]name in lower-case identifiers, e.g. public.schema_migration.`;
  }
  return { schema, name };
}

/**
 * The lane's optional settings, from their raw env strings. Fails closed: a value that does not
 * parse is reported as `configError`, so the lane refuses rather than run with a setting quietly
 * dropped (an adoption guard that vanished on a typo is no guard).
 */
export function parseDdlLaneSettings(raw: DdlLaneSettings): Pick<DdlConfig, "externalLedger" | "ownerRoles" | "sessionSettings" | "adoptionSentinel" | "configError"> {
  const errors: string[] = [];
  const out: Pick<DdlConfig, "externalLedger" | "ownerRoles" | "sessionSettings" | "adoptionSentinel"> = {};

  if (raw.externalLedger !== "") {
    const ledger = parseQualified(raw.externalLedger, "POSTGRES_DDL_EXTERNAL_LEDGER");
    if (typeof ledger === "string") {
      errors.push(ledger);
    } else if (isInternalSchema(ledger.schema)) {
      errors.push(`POSTGRES_DDL_EXTERNAL_LEDGER may not be in ${ledger.schema}, which is this server's own schema.`);
    } else {
      out.externalLedger = ledger;
    }
  }

  if (raw.adoptionSentinel !== "") {
    const sentinel = parseQualified(raw.adoptionSentinel, "POSTGRES_DDL_ADOPTION_SENTINEL");
    if (typeof sentinel === "string") {
      errors.push(sentinel);
    } else {
      out.adoptionSentinel = sentinel;
    }
  }

  const roles = raw.ownerRoles.split(",").map((r) => r.trim()).filter((r) => r !== "");
  const badRole = roles.find((r) => !IDENTIFIER.test(r) || r.startsWith("pg_") || r === "public");
  if (badRole !== undefined) {
    errors.push(`POSTGRES_DDL_OWNER_ROLES: '${badRole}' is not a plain lower-case role name (pg_* and public are not roles a migration may hand objects to).`);
  } else {
    out.ownerRoles = roles;
  }

  const settings: SessionSetting[] = [];
  for (const entry of raw.sessionSettings.split(",").map((e) => e.trim()).filter((e) => e !== "")) {
    const at = entry.indexOf("=");
    const name = at < 0 ? entry : entry.slice(0, at).trim();
    const value = at < 0 ? "" : entry.slice(at + 1).trim();
    if (at < 0 || !CUSTOM_SETTING.test(name)) {
      errors.push(`POSTGRES_DDL_SESSION_SETTINGS: '${name}' must be prefix.name=value, a custom setting. Core settings (search_path, role, …) are not accepted.`);
    } else if (value.length > MAX_SETTING_VALUE) {
      errors.push(`POSTGRES_DDL_SESSION_SETTINGS: the value of ${name} is over ${String(MAX_SETTING_VALUE)} characters.`);
    } else if (settings.some((s) => s.name === name)) {
      errors.push(`POSTGRES_DDL_SESSION_SETTINGS: ${name} is set twice.`);
    } else {
      settings.push({ name, value });
    }
  }
  if (settings.length > MAX_SESSION_SETTINGS) {
    errors.push(`POSTGRES_DDL_SESSION_SETTINGS: at most ${String(MAX_SESSION_SETTINGS)} settings.`);
  }
  out.sessionSettings = settings;

  return errors.length === 0 ? out : { ...out, configError: errors.join(" ") };
}

/** `"schema"."name"`, for the two names above. Safe because both passed IDENTIFIER. */
export function quoteQualified(q: QualifiedName): string {
  return `"${q.schema}"."${q.name}"`;
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
