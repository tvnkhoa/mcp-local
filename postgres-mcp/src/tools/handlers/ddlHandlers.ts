/**
 * Handlers for the raw-SQL DDL lane.
 *
 * Phase 1.3 adds the two tools that touch no database state: `ddl_status`, which reads the
 * ledger, and `ddl_create`, which writes migration files. Preview, dry run and apply come in 1.4.
 *
 * Responses name files, never paths. The migrations directory is server configuration, and a
 * response that echoed it would publish the server's filesystem layout to every client.
 */

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import type { ConnectionManager } from "../../repositories/connectionManager.js";
import { validateDdlScript } from "../../middleware/ddlGuardrails.js";
import { lintDdl, type RiskFinding } from "../../middleware/ddlRiskLint.js";
import { PolicyViolationError } from "../../middleware/errors.js";
import { asText, type ResponseProfile } from "../../middleware/responseFormatter.js";
import { assertDdlEnabled, effectiveTimeouts, requireMigrationsDir, type DdlConfig } from "../../services/ddl/ddlConfig.js";
import { loadMigrations, nextVersion, writeMigrationFiles, type LoadedMigrations } from "../../services/ddl/ddlFiles.js";
import { deriveState, readHistory } from "../../services/ddl/ddlHistory.js";
import { computeStatus } from "../../services/ddl/ddlPlanner.js";

const EF_HISTORY_WARNING =
  "EF Core also manages this database (__EFMigrationsHistory exists). Changes made through ddl_* are invisible to the EF model snapshot; mirror them in the EF model, or prefer migration_*.";

// ── ddl_status ───────────────────────────────────────────────────────────────

export async function handleDdlStatus(
  args: { environment?: string; profile?: ResponseProfile },
  connections: ConnectionManager,
  config: DdlConfig
): Promise<CallToolResult> {
  assertDdlEnabled(config);
  const profile = args.profile ?? "compact";
  // Read-only, so no requireWrite: status is how you inspect prod.
  const env = connections.getEnvironment(args.environment);
  const pool = connections.getPool(args.environment);

  const loaded: LoadedMigrations =
    config.migrationsDir === "" ? { migrations: [], ignoredFiles: [], warnings: [] } : await loadMigrations(config.migrationsDir);
  const [rows, tables] = await Promise.all([
    readHistory(pool),
    pool.query<{ ledger: boolean; ef: boolean }>(
      `select to_regclass('mcp_ops.ddl_history') is not null as ledger,
              to_regclass('public."__EFMigrationsHistory"') is not null as ef`
    )
  ]);
  const state = deriveState(rows);
  const status = computeStatus(loaded.migrations, state);
  const efHistoryTablePresent = tables.rows[0]?.ef === true;

  const warnings = [...loaded.warnings];
  if (config.migrationsDir === "") {
    warnings.push("POSTGRES_DDL_MIGRATIONS_DIR is not set, so only the ledger is shown; no file is compared against it.");
  }
  if (efHistoryTablePresent) {
    warnings.push(EF_HISTORY_WARNING);
  }

  const summary = {
    applied: status.applied.length,
    pending: status.pending.length,
    checksumMismatch: status.checksumMismatch.length,
    missingFiles: status.missingFiles.length,
    outOfOrder: status.outOfOrder.length,
    inlineApplied: status.inlineApplied.length
  };

  if (profile === "nano") {
    return asText({ environment: env.name, summary, historyRows: rows.length }, profile);
  }
  return asText(
    {
      environment: env.name,
      migrationsDirConfigured: config.migrationsDir !== "",
      historyTablePresent: tables.rows[0]?.ledger === true,
      efHistoryTablePresent,
      summary,
      ...status,
      ignoredFiles: loaded.ignoredFiles,
      warnings
    },
    profile
  );
}

// ── ddl_create ───────────────────────────────────────────────────────────────

const NO_TRANSACTION_DIRECTIVE = "-- mcp:no-transaction";

/**
 * The text that goes into the file. `noTransaction: true` is written INTO the file as the
 * directive, because a file-mode plan reads its mode from the file and nothing else. A flag
 * that lived only in the create call would be lost by the time the file is applied.
 */
function withDirective(sql: string, noTransaction: boolean): string {
  if (!noTransaction || /^\s*--\s*mcp:no-transaction\s*$/m.test(sql.split(/\r?\n/).slice(0, 20).join("\n"))) {
    return sql;
  }
  return `${NO_TRANSACTION_DIRECTIVE}\n${sql}`;
}

/** Validate one script for `ddl_create`, failing with the script's role in the message. */
function checkScript(role: "up" | "down", sql: string, config: DdlConfig): { risks: RiskFinding[]; mode: string; statementCount: number; warnings: string[] } {
  const validated = validateDdlScript(sql);
  if (!validated.ok) {
    throw new PolicyViolationError(validated.error.code, `${role}: ${validated.error.message}`);
  }
  const timed = effectiveTimeouts(config, validated.directives);
  if (!timed.ok) {
    throw new PolicyViolationError(timed.error.code, `${role}: ${timed.error.message}`);
  }
  // No environment is involved in writing a file, so there is no snapshot to say which tables
  // exist: every table counts as existing. ddl_preview re-lints against the real database.
  const lint = lintDdl(validated.statements);
  if (lint.blocked.length > 0) {
    const first = lint.blocked[0] as RiskFinding;
    throw new PolicyViolationError("DDL_RISK_BLOCKED", `${role}, statement ${String(first.statementIndex + 1)}: ${first.message}`);
  }
  return {
    risks: lint.findings,
    mode: validated.mode,
    statementCount: validated.statements.length,
    warnings: validated.warnings.map((w) => `${role}: ${w}`)
  };
}

export async function handleDdlCreate(
  args: { name: string; up: string; down?: string; noTransaction?: boolean; version?: string; profile?: ResponseProfile },
  config: DdlConfig
): Promise<CallToolResult> {
  assertDdlEnabled(config);
  const dir = requireMigrationsDir(config);
  const profile = args.profile ?? "compact";
  const noTransaction = args.noTransaction === true;

  // Everything is checked before anything is written: a refused migration leaves no file.
  const upText = withDirective(args.up, noTransaction);
  const downText = args.down === undefined ? undefined : withDirective(args.down, noTransaction);
  const up = checkScript("up", upText, config);
  const down = downText === undefined ? undefined : checkScript("down", downText, config);

  const loaded = await loadMigrations(dir);
  const existing = loaded.migrations.map((m) => m.version);
  const newest = [...existing].sort().at(-1);
  if (args.version !== undefined && newest !== undefined && args.version < newest && !existing.includes(args.version)) {
    throw new PolicyViolationError(
      "DDL_OUT_OF_ORDER",
      `Version ${args.version} would sort before the newest existing migration (${newest}). Omit version to get the next one.`
    );
  }
  const version = args.version ?? nextVersion(new Date(), existing);

  const written = await writeMigrationFiles(dir, { version, name: args.name, up: upText, ...(downText === undefined ? {} : { down: downText }) }, existing);

  const risks = [...up.risks.map((r) => ({ ...r, script: "up" })), ...(down?.risks ?? []).map((r) => ({ ...r, script: "down" }))];
  return asText(
    {
      version,
      name: args.name,
      files: [written.up.file, ...(written.down === undefined ? [] : [written.down.file])],
      checksum: written.up.checksum,
      mode: up.mode,
      statementCount: up.statementCount,
      hasDown: written.down !== undefined,
      // Advisory here: these were linted with no database, so every table counted as existing.
      // ddl_preview re-lints against the target environment and decides what apply must acknowledge.
      risks,
      warnings: [
        ...up.warnings,
        ...(down?.warnings ?? []),
        ...(written.down === undefined ? ["No down script: this migration cannot be reverted with ddl_preview { direction: \"down\" }."] : [])
      ]
    },
    profile
  );
}
