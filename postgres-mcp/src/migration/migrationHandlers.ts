import { createHash, randomUUID } from "node:crypto";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import type { ConnectionManager } from "../db/connectionManager.js";
import { PolicyViolationError } from "../errors.js";
import { asText, type ResponseProfile } from "../response/responseFormatter.js";
import { quoteIdent } from "../sql/ident.js";
import { issueApprovalToken, verifyApprovalToken } from "../write/approval.js";
import { recordAudit } from "../write/auditLog.js";
import {
  assertMigrationEnabled,
  efDatabaseUpdate,
  efMigrationsAdd,
  efMigrationsListConnected,
  efMigrationsScript,
  listMigrationFiles,
  type EfResult,
  type MigrationConfig
} from "./efRunner.js";
import { captureSchema, diffSnapshots } from "./schemaSnapshot.js";

interface MigrationPreviewRecord {
  previewId: string;
  environment: string;
  preSnapshotId: string;
  script: string;
  digest: string;
  expiresAt: string;
}

const migrationPreviews = new Map<string, MigrationPreviewRecord>();

/** Evict expired migration previews so unapplied previews don't accumulate forever. */
function sweepExpiredMigrationPreviews(): void {
  const now = Date.now();
  for (const [id, rec] of migrationPreviews) {
    if (Date.parse(rec.expiresAt) < now) {
      migrationPreviews.delete(id);
    }
  }
}

function migrationDigest(environment: string, preSnapshotId: string, script: string): string {
  return createHash("sha256").update(`${environment}::${preSnapshotId}::${script}`).digest("hex");
}

/**
 * Remove EF's own transaction-control statements (`START TRANSACTION;` / `COMMIT;`),
 * which it emits as standalone lines around each migration in the generated script.
 * Left in place, the script's COMMIT would close the dry-run's outer transaction and
 * persist the DDL — defeating the rolled-back-dry-run guarantee. We strip ONLY these
 * two exact statements; `BEGIN` is left untouched because it legitimately appears
 * inside EF's `DO $EF$ ... BEGIN ... END $EF$;` PL/pgSQL blocks.
 */
function stripTransactionControl(script: string): string {
  return script
    .split(/\r?\n/)
    .filter((line) => {
      const normalized = line.trim().replace(/;\s*$/, "").toUpperCase();
      return normalized !== "START TRANSACTION" && normalized !== "COMMIT";
    })
    .join("\n");
}

function efOk(result: EfResult, action: string): EfResult {
  if (result.exitCode !== 0) {
    throw new PolicyViolationError("EF_COMMAND_FAILED", `dotnet ef ${action} failed (exit ${result.exitCode}): ${result.stderr || result.stdout}`);
  }
  return result;
}

// ── migration_status ──────────────────────────────────────────────────────────

interface EfMigrationListEntry {
  id: string;
  name: string;
  safeName: string;
  applied: boolean | null;
}

export async function handleMigrationStatus(
  args: { environment?: string; profile?: ResponseProfile },
  connections: ConnectionManager,
  config: MigrationConfig
): Promise<CallToolResult> {
  assertMigrationEnabled(config);
  const env = connections.getEnvironment(args.environment);
  const result = efOk(await efMigrationsListConnected(config, env.connectionString), "migrations list");

  let entries: EfMigrationListEntry[];
  try {
    entries = JSON.parse(result.stdout);
  } catch (error) {
    throw new PolicyViolationError(
      "EF_OUTPUT_UNPARSEABLE",
      `Failed to parse 'dotnet ef migrations list --json' output as JSON: ${String(error)}`
    );
  }

  // Structured `applied` (true/false/null) replaces scraping a "(Pending)" text marker —
  // immune to CLI locale translation and to any future reformatting of the human-readable
  // output. Treat anything other than `applied === true` (including an unexpected `null`)
  // as pending: safer to flag a migration for attention than to silently assume it's applied.
  const applied = entries.filter((m) => m.applied === true).map((m) => m.id);
  const pending = entries.filter((m) => m.applied !== true).map((m) => m.id);

  return asText(
    {
      environment: env.name,
      appliedCount: applied.length,
      pendingCount: pending.length,
      applied,
      pending,
      raw: result.stdout.trim()
    },
    args.profile ?? "compact"
  );
}

// ── migration_add ──────────────────────────────────────────────────────────────

export async function handleMigrationAdd(
  args: { name: string; environment?: string; profile?: ResponseProfile },
  connections: ConnectionManager,
  config: MigrationConfig
): Promise<CallToolResult> {
  assertMigrationEnabled(config);
  // `migrations add` does not touch the database; use the default env's connection only
  // to satisfy the design-time factory.
  const env = connections.getEnvironment(args.environment);
  const result = efOk(await efMigrationsAdd(config, args.name, env.connectionString), "migrations add");
  const files = listMigrationFiles(config, args.name);

  return asText(
    {
      name: args.name,
      generatedFiles: files,
      note: "Migration generated. You may edit the generated .cs file before previewing/applying.",
      raw: result.stdout.trim()
    },
    args.profile ?? "compact"
  );
}

// ── migration_preview ──────────────────────────────────────────────────────────

export async function handleMigrationPreview(
  args: { environment?: string; profile?: ResponseProfile },
  connections: ConnectionManager,
  config: MigrationConfig
): Promise<CallToolResult> {
  assertMigrationEnabled(config);
  const env = connections.getEnvironment(args.environment, true); // migrations are writes → require writable env
  const pool = connections.getPool(args.environment, true);

  const preSnapshot = await captureSchema(pool);
  const script = efOk(await efMigrationsScript(config, env.connectionString), "migrations script").stdout;

  sweepExpiredMigrationPreviews();
  const previewId = randomUUID();
  const expiresAt = new Date(Date.now() + config.previewTtlMs).toISOString();
  const digest = migrationDigest(env.name, preSnapshot.snapshotId, script);
  const approvalToken = issueApprovalToken(previewId, digest, expiresAt, config.approvalSecret);

  migrationPreviews.set(previewId, {
    previewId,
    environment: env.name,
    preSnapshotId: preSnapshot.snapshotId,
    script,
    digest,
    expiresAt
  });

  return asText(
    {
      previewId,
      approvalToken,
      environment: env.name,
      preSnapshotId: preSnapshot.snapshotId,
      script,
      expiresAt
    },
    args.profile ?? "standard"
  );
}

// ── migration_apply ──────────────────────────────────────────────────────────────

export async function handleMigrationApply(
  args: { environment?: string; previewId: string; approvalToken: string; profile?: ResponseProfile },
  connections: ConnectionManager,
  config: MigrationConfig
): Promise<CallToolResult> {
  assertMigrationEnabled(config);
  const preview = migrationPreviews.get(args.previewId);
  if (!preview) {
    throw new PolicyViolationError("PREVIEW_NOT_FOUND", `Migration preview '${args.previewId}' not found or expired.`);
  }
  if (Date.parse(preview.expiresAt) < Date.now()) {
    migrationPreviews.delete(args.previewId);
    throw new PolicyViolationError("PREVIEW_EXPIRED", "Migration preview expired. Create a fresh migration_preview.");
  }
  verifyApprovalToken(args.approvalToken, preview.previewId, preview.digest, preview.expiresAt, config.approvalSecret);

  const env = connections.getEnvironment(preview.environment, true);
  const pool = connections.getPool(preview.environment, true);

  // Drift guard: schema must still match what was previewed.
  const preSnapshot = await captureSchema(pool);
  if (preSnapshot.snapshotId !== preview.preSnapshotId) {
    throw new PolicyViolationError(
      "MIGRATION_DRIFT",
      "Schema changed since migration_preview. Re-run migration_preview before applying."
    );
  }

  let updateResult: EfResult;
  try {
    updateResult = efOk(await efDatabaseUpdate(config, env.connectionString), "database update");
  } catch (error) {
    await recordAudit(pool, env.name, {
      tool: "migration_apply",
      environment: env.name,
      statementType: "migration",
      targetTable: null,
      sqlHash: null,
      rowsAffected: null,
      status: "failed",
      rollbackId: null,
      detail: { error: String(error) }
    });
    throw error;
  }

  // Verify: capture post-snapshot and diff so the caller sees exactly what changed.
  const postSnapshot = await captureSchema(pool);
  const diff = diffSnapshots(preSnapshot, postSnapshot);
  migrationPreviews.delete(args.previewId);

  await recordAudit(pool, env.name, {
    tool: "migration_apply",
    environment: env.name,
    statementType: "migration",
    targetTable: null,
    sqlHash: null,
    rowsAffected: null,
    status: "applied",
    rollbackId: null,
    detail: { preSnapshotId: preSnapshot.snapshotId, postSnapshotId: postSnapshot.snapshotId }
  });

  return asText(
    {
      environment: env.name,
      status: "applied",
      preSnapshotId: preSnapshot.snapshotId,
      postSnapshotId: postSnapshot.snapshotId,
      // Derived from the snapshot IDs themselves (not `!diff.identical`) so this flag can
      // never disagree with the two IDs shown right next to it — snapshotId is name-sensitive
      // (it hashes the raw captured constraints) while `diff` is deliberately name-insensitive,
      // so a rename-only change (e.g. a constraint recreated under a different name) would
      // otherwise report schemaChanged:false alongside two different snapshot IDs.
      schemaChanged: preSnapshot.snapshotId !== postSnapshot.snapshotId,
      diff,
      raw: updateResult.stdout.trim()
    },
    args.profile ?? "compact"
  );
}

// ── migration_dry_run ──────────────────────────────────────────────────────────

export async function handleMigrationDryRun(
  args: { environment?: string; profile?: ResponseProfile },
  connections: ConnectionManager,
  config: MigrationConfig
): Promise<CallToolResult> {
  assertMigrationEnabled(config);
  const env = connections.getEnvironment(args.environment, true);
  const pool = connections.getPool(args.environment, true);

  const script = efOk(await efMigrationsScript(config, env.connectionString), "migrations script").stdout;
  const trimmed = script.trim();
  if (!trimmed) {
    return asText({ environment: env.name, status: "no_pending", note: "No pending migrations." }, args.profile ?? "compact");
  }

  // Run the idempotent script inside a transaction we always roll back — catches SQL
  // errors without persisting anything. EF's own START TRANSACTION/COMMIT lines are
  // stripped first so the script can't commit out from under our rollback.
  const runnable = stripTransactionControl(trimmed);
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(runnable);
    await client.query("rollback");
    return asText(
      {
        environment: env.name,
        status: "ok",
        note: "Migration script executed cleanly in a rolled-back transaction (no changes persisted)."
      },
      args.profile ?? "compact"
    );
  } catch (error) {
    try {
      await client.query("rollback");
    } catch {
      // ignore
    }
    return asText(
      { environment: env.name, status: "failed", error: String(error) },
      args.profile ?? "compact"
    );
  } finally {
    client.release();
  }
}

// ── compare_environments ────────────────────────────────────────────────────────

export async function handleCompareEnvironments(
  args: { source: string; target: string; includeRowCounts?: boolean; profile?: ResponseProfile },
  connections: ConnectionManager
): Promise<CallToolResult> {
  const sourceEnv = connections.getEnvironment(args.source);
  const targetEnv = connections.getEnvironment(args.target);
  const sourcePool = connections.getPool(args.source);
  const targetPool = connections.getPool(args.target);

  const [sourceSnap, targetSnap] = await Promise.all([captureSchema(sourcePool), captureSchema(targetPool)]);
  const diff = diffSnapshots(sourceSnap, targetSnap);

  let rowCounts: Array<{ table: string; source: number | null; target: number | null }> | undefined;
  if (args.includeRowCounts) {
    const shared = sourceSnap.tables
      .map((t) => `${t.schema}.${t.table}`)
      .filter((k) => targetSnap.tables.some((tt) => `${tt.schema}.${tt.table}` === k));
    rowCounts = [];
    for (const key of shared) {
      const [schema, table] = key.split(".");
      const q = `select count(*)::bigint as c from ${quoteIdent(schema)}.${quoteIdent(table)}`;
      const [s, t] = await Promise.all([
        sourcePool.query<{ c: string }>(q).then((r) => Number(r.rows[0]?.c ?? 0)).catch(() => null),
        targetPool.query<{ c: string }>(q).then((r) => Number(r.rows[0]?.c ?? 0)).catch(() => null)
      ]);
      rowCounts.push({ table: key, source: s, target: t });
    }
  }

  return asText(
    {
      source: sourceEnv.name,
      target: targetEnv.name,
      schemaIdentical: diff.identical,
      diff,
      rowCounts
    },
    args.profile ?? "compact"
  );
}
