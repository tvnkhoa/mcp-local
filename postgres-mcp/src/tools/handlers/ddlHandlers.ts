/**
 * Handlers for the raw-SQL DDL lane.
 *
 * `ddl_status` reads the ledger and `ddl_create` writes files; neither changes a database.
 * `ddl_preview` plans and issues an approval token, `ddl_dry_run` runs the plan inside a transaction
 * it rolls back, and `ddl_apply` re-plans under the DDL advisory lock, proves the plan is the one that
 * was approved, and runs it.
 *
 * Responses name files, never paths. The migrations directory is server configuration, and a
 * response that echoed it would publish the server's filesystem layout to every client.
 */

import { randomUUID } from "node:crypto";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import type { ConnectionManager } from "../../repositories/connectionManager.js";
import { validateDdlScript } from "../../middleware/ddlGuardrails.js";
import { lintDdl, type RiskFinding } from "../../middleware/ddlRiskLint.js";
import { PolicyViolationError } from "../../middleware/errors.js";
import { asError, asText, type ResponseProfile } from "../../middleware/responseFormatter.js";
import { runExclusive } from "../../services/concurrency/envMutex.js";
import { applyPlan, dryRunPlan, planAgainst, replanForExecution, sessionTimeouts, withDdlSession } from "../../services/ddl/ddlExecutor.js";
import type { DdlPreviewStore } from "../../services/ddl/ddlPreviewStore.js";
import { captureSchema, diffSnapshots } from "../../services/migration/schemaSnapshot.js";
import { issueApprovalToken, verifyApprovalToken } from "../../services/write/approval.js";
import { recordAudit } from "../../services/write/auditLog.js";
import { assertDdlEnabled, effectiveTimeouts, requireMigrationsDir, type DdlConfig } from "../../services/ddl/ddlConfig.js";
import { loadMigrations, nextVersion, writeMigrationFiles, type LoadedMigrations } from "../../services/ddl/ddlFiles.js";
import { ledgerFor } from "../../services/ddl/ddlLedger.js";
import { computeStatus, planDigest, type DdlPlan, type PlanRequest } from "../../services/ddl/ddlPlanner.js";

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

  const ledger = ledgerFor(config);
  const loaded: LoadedMigrations =
    config.migrationsDir === "" ? { migrations: [], ignoredFiles: [], warnings: [] } : await loadMigrations(config.migrationsDir, ledger.format);
  const [read, tables] = await Promise.all([
    ledger.read(pool),
    pool.query<{ ef: boolean }>(`select to_regclass('public."__EFMigrationsHistory"') is not null as ef`)
  ]);
  const status = computeStatus(loaded.migrations, read.state);
  const efHistoryTablePresent = tables.rows[0]?.ef === true;

  const warnings = [...loaded.warnings];
  if (config.migrationsDir === "") {
    warnings.push("POSTGRES_DDL_MIGRATIONS_DIR is not set, so only the ledger is shown; no file is compared against it.");
  }
  if (efHistoryTablePresent) {
    warnings.push(EF_HISTORY_WARNING);
  }
  if (ledger.external && !read.present) {
    warnings.push(`The external ledger ${ledger.label} does not exist here yet. ddl_apply refuses until the repo's own runner creates it.`);
  }

  const summary = {
    applied: status.applied.length,
    pending: status.pending.length,
    checksumMismatch: status.checksumMismatch.length,
    renamed: status.renamed.length,
    missingFiles: status.missingFiles.length,
    outOfOrder: status.outOfOrder.length,
    inlineApplied: status.inlineApplied.length
  };

  if (profile === "nano") {
    return asText({ environment: env.name, ledger: ledger.label, summary, historyRows: read.rowCount }, profile);
  }
  return asText(
    {
      environment: env.name,
      ledger: ledger.label,
      migrationsDirConfigured: config.migrationsDir !== "",
      historyTablePresent: read.present,
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
  const validated = validateDdlScript(sql, { ownerRoles: config.ownerRoles ?? [] });
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
  if (config.externalLedger !== undefined) {
    throw new PolicyViolationError(
      "DDL_CREATE_UNSUPPORTED",
      "ddl_create writes V<timestamp>__<name>.up.sql files. With POSTGRES_DDL_EXTERNAL_LEDGER the directory is the repo's own, in its NNNN-<name>.sql layout: add the file there as the repo does, then ddl_preview it."
    );
  }
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

// ── ddl_preview ──────────────────────────────────────────────────────────────

export interface DdlPreviewArgs {
  environment?: string;
  direction?: "up" | "down";
  target?: string;
  allowOutOfOrder?: boolean;
  sql?: string;
  label?: string;
  noTransaction?: boolean;
  profile?: ResponseProfile;
}

/**
 * The request a preview's arguments describe. File mode and inline mode take disjoint arguments;
 * mixing them is refused here rather than resolved by a precedence rule nobody would guess.
 * A zod refinement would say the same thing, but it would also hide the object shape from the
 * schema-parity test, so the check lives in the handler.
 */
function toRequest(args: DdlPreviewArgs): PlanRequest {
  if (args.sql !== undefined) {
    const fileOnly = (["direction", "target", "allowOutOfOrder"] as const).filter((k) => args[k] !== undefined);
    if (fileOnly.length > 0) {
      throw new PolicyViolationError("DDL_INVALID_ARGS", `sql (inline mode) cannot be combined with ${fileOnly.join(", ")}, which are file-mode arguments.`);
    }
    return { mode: "inline", sql: args.sql, ...(args.label === undefined ? {} : { label: args.label }), noTransaction: args.noTransaction === true };
  }
  const inlineOnly = (["label", "noTransaction"] as const).filter((k) => args[k] !== undefined);
  if (inlineOnly.length > 0) {
    throw new PolicyViolationError("DDL_INVALID_ARGS", `${inlineOnly.join(", ")} only applies with sql (inline mode). A file's mode comes from its own directives.`);
  }
  const direction = args.direction ?? "up";
  if (direction === "down" && args.target === undefined) {
    throw new PolicyViolationError("DDL_INVALID_ARGS", 'direction "down" needs target: the version to revert back to, or "0" to revert everything.');
  }
  return {
    mode: "file",
    direction,
    ...(args.target === undefined ? {} : { target: args.target }),
    ...(args.allowOutOfOrder === undefined ? {} : { allowOutOfOrder: args.allowOutOfOrder })
  };
}

function stepSummary(plan: DdlPlan, profile: ResponseProfile) {
  return plan.steps.map((step) => ({
    version: step.version,
    name: step.name,
    action: step.action,
    file: step.file,
    mode: step.mode,
    statementCount: step.statements.length,
    lockTimeoutMs: step.timeouts.lockTimeoutMs,
    statementTimeoutMs: step.timeouts.statementTimeoutMs,
    risks: step.risks,
    ...(profile === "verbose" ? { sql: step.sql } : {})
  }));
}

export async function handleDdlPreview(
  args: DdlPreviewArgs,
  connections: ConnectionManager,
  config: DdlConfig,
  store: DdlPreviewStore
): Promise<CallToolResult> {
  assertDdlEnabled(config);
  const profile = args.profile ?? "compact";
  const request = toRequest(args);
  const env = connections.getEnvironment(args.environment, true); // ENVIRONMENT_READ_ONLY on prod
  if (request.mode === "inline") {
    if (config.externalLedger !== undefined) {
      throw new PolicyViolationError("DDL_INLINE_UNSUPPORTED", "Inline SQL is not accepted with an external ledger, which records files only. Add the file to the migrations directory.");
    }
    // Refuse a bad script before any database work, with the guardrail's own code.
    const validated = validateDdlScript(request.sql, { noTransaction: request.noTransaction, ownerRoles: config.ownerRoles ?? [] });
    if (!validated.ok) {
      throw new PolicyViolationError(validated.error.code, validated.error.message);
    }
  } else {
    requireMigrationsDir(config);
  }

  const pool = connections.getPool(args.environment, true);
  // One read-only transaction on one connection: a consistent view of the catalog, and a
  // lock_timeout so a table held under ACCESS EXCLUSIVE fails the preview fast instead of
  // holding it for the pool's whole statement_timeout.
  const client = await pool.connect();
  let live;
  try {
    await client.query("begin read only");
    await client.query("select set_config('lock_timeout', $1, true)", [String(config.lockTimeoutMs)]);
    live = await planAgainst(client, request, config);
  } finally {
    await client.query("rollback").catch(() => undefined);
    client.release();
  }
  const warnings = [...live.plan.warnings, ...(live.efHistoryTablePresent ? [EF_HISTORY_WARNING] : [])];

  if (live.plan.steps.length === 0) {
    return asText({ environment: env.name, status: "nothing_to_do", direction: live.plan.direction, warnings }, profile);
  }

  const previewId = randomUUID();
  const expiresAt = new Date(Date.now() + config.previewTtlMs).toISOString();
  const digest = planDigest({ environment: env.name, preSnapshotId: live.snapshot.snapshotId, historyStateId: live.state.stateId, plan: live.plan });
  store.save({
    previewId,
    environment: env.name,
    request,
    plan: live.plan,
    digest,
    preSnapshotId: live.snapshot.snapshotId,
    historyStateId: live.state.stateId,
    expiresAt
  });

  return asText(
    {
      previewId,
      approvalToken: issueApprovalToken(previewId, digest, expiresAt, config.approvalSecret),
      environment: env.name,
      direction: live.plan.direction,
      kind: live.plan.kind,
      expiresAt,
      preSnapshotId: live.snapshot.snapshotId,
      historyStateId: live.state.stateId,
      steps: stepSummary(live.plan, profile),
      requiredAcknowledgements: live.plan.requiredAcknowledgements,
      warnings,
      next:
        live.plan.requiredAcknowledgements.length > 0
          ? `Review the risks, then ddl_dry_run, then ddl_apply with acknowledgeRisks: ${JSON.stringify(live.plan.requiredAcknowledgements)} once a human has agreed to them.`
          : "ddl_dry_run, then ddl_apply with this previewId and approvalToken."
    },
    profile
  );
}

// ── ddl_dry_run ──────────────────────────────────────────────────────────────

function requirePreview(store: DdlPreviewStore, previewId: string) {
  const record = store.get(previewId);
  if (record === undefined) {
    throw new PolicyViolationError("PREVIEW_NOT_FOUND", `DDL preview '${previewId}' not found or expired. Run ddl_preview again.`);
  }
  return record;
}

export async function handleDdlDryRun(
  args: { previewId: string; profile?: ResponseProfile },
  connections: ConnectionManager,
  config: DdlConfig,
  store: DdlPreviewStore
): Promise<CallToolResult> {
  assertDdlEnabled(config);
  const profile = args.profile ?? "compact";
  const lockKey = store.get(args.previewId)?.environment ?? "";

  return runExclusive(lockKey, async () => {
    const record = requirePreview(store, args.previewId);
    const env = connections.getEnvironment(record.environment, true);
    const result = await withDdlSession(env.poolConfig, sessionTimeouts(config, record.plan), async (client, session) => {
      const fresh = await replanForExecution(client, record, config);
      return dryRunPlan(client, fresh.plan, session, config);
    });
    store.recordDryRun(record.previewId, result);
    const payload = {
      previewId: record.previewId,
      environment: env.name,
      ...result,
      note: "Everything ran inside one transaction that was rolled back. Locks were real while it ran, bounded by each migration's lock_timeout."
    };
    return result.error === undefined
      ? asText(payload, profile)
      : asError({ code: result.error.code, message: result.error.message, ...payload }, profile);
  });
}

// ── ddl_apply ────────────────────────────────────────────────────────────────

export async function handleDdlApply(
  args: { previewId: string; approvalToken: string; acknowledgeRisks?: string[]; profile?: ResponseProfile },
  connections: ConnectionManager,
  config: DdlConfig,
  store: DdlPreviewStore
): Promise<CallToolResult> {
  assertDdlEnabled(config);
  const profile = args.profile ?? "compact";
  const lockKey = store.get(args.previewId)?.environment ?? "";

  return runExclusive(lockKey, async () => {
    const record = requirePreview(store, args.previewId);
    // ignoreExpiry: freshness is proven by re-planning against the database below, not by the
    // token's time box (the same reasoning as migration_apply, PG-PRV-002).
    verifyApprovalToken(args.approvalToken, record.previewId, record.digest, record.expiresAt, config.approvalSecret, { ignoreExpiry: true });

    const given = new Set(args.acknowledgeRisks ?? []);
    const missing = record.plan.requiredAcknowledgements.filter((code) => !given.has(code));
    if (missing.length > 0) {
      throw new PolicyViolationError(
        "DDL_RISK_NOT_ACKNOWLEDGED",
        `This plan carries high risks that must be acknowledged: ${missing.join(", ")}. Confirm them with a human, then pass acknowledgeRisks.`
      );
    }

    const env = connections.getEnvironment(record.environment, true);
    const pool = connections.getPool(record.environment, true);
    let outcome;
    try {
      outcome = await withDdlSession(env.poolConfig, sessionTimeouts(config, record.plan), async (client, session) => {
        const ledger = ledgerFor(config);
        await ledger.prepare(client);
        const fresh = await replanForExecution(client, record, config);
        // From here on the ledger moves, so the preview can never be applied again, whatever happens.
        store.consume(record.previewId);
        const applied = await applyPlan(client, fresh.plan, {
          environment: env.name,
          previewId: record.previewId,
          session: sessionTimeouts(config, record.plan),
          pid: session.pid,
          ledger,
          config
        });
        return { result: applied, pre: fresh.snapshot, post: await captureSchema(client) };
      });
    } catch (error) {
      // A refusal before anything ran (drift, lock held) and a lost connection mid-apply are both
      // on record, the same as write_apply's failure path.
      await recordAudit(pool, env.name, {
        tool: "ddl_apply",
        environment: env.name,
        statementType: "ddl",
        targetTable: null,
        sqlHash: record.digest.slice(0, 16),
        rowsAffected: null,
        status: "failed",
        rollbackId: null,
        detail: { direction: record.plan.direction, error: error instanceof PolicyViolationError ? error.code : String(error) }
      });
      throw error;
    }
    const { result, pre, post } = outcome;

    await recordAudit(pool, env.name, {
      tool: "ddl_apply",
      environment: env.name,
      statementType: "ddl",
      targetTable: null,
      sqlHash: record.digest.slice(0, 16),
      rowsAffected: null,
      status: result.status,
      rollbackId: null,
      detail: {
        direction: record.plan.direction,
        versions: result.steps.map((s) => `${s.version ?? "inline"}:${s.status}`),
        preSnapshotId: pre.snapshotId,
        postSnapshotId: post.snapshotId,
        ...(result.error === undefined ? {} : { errorCode: result.error.code })
      }
    });

    const payload = {
      previewId: record.previewId,
      environment: env.name,
      status: result.status,
      direction: record.plan.direction,
      steps: result.steps,
      preSnapshotId: pre.snapshotId,
      postSnapshotId: post.snapshotId,
      schemaChanged: pre.snapshotId !== post.snapshotId,
      diff: diffSnapshots(pre, post),
      dryRun: record.dryRun === undefined ? "not_run" : record.dryRun.status,
      ...(result.error === undefined ? {} : { error: result.error })
    };
    return result.error === undefined
      ? asText(payload, profile)
      : asError({ code: result.error.code, message: result.error.message, ...payload }, profile);
  });
}
