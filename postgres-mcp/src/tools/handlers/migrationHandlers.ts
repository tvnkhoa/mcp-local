import { createHash, randomUUID } from "node:crypto";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { QueryConfig } from "pg";

import type { ConnectionManager } from "../../repositories/connectionManager.js";
import { PolicyViolationError } from "../../middleware/errors.js";
import { asText, type ResponseProfile } from "../../middleware/responseFormatter.js";
import { splitSqlStatements, topLevelWords, type SplitStatement } from "../../middleware/ddlGuardrails.js";
import { quoteIdent } from "../../middleware/ident.js";
import { issueApprovalToken, verifyApprovalToken } from "../../services/write/approval.js";
import { runExclusive } from "../../services/concurrency/envMutex.js";
import { recordAudit } from "../../services/write/auditLog.js";
import {
  assertMigrationEnabled,
  efDatabaseUpdate,
  efMigrationsAdd,
  efMigrationsListConnected,
  efMigrationsScript,
  efMigrationsScriptDelta,
  listMigrationFiles,
  type EfResult,
  type MigrationConfig
} from "../../services/migration/efRunner.js";
import { captureSchema, diffSnapshots } from "../../services/migration/schemaSnapshot.js";

interface MigrationPreviewRecord {
  previewId: string;
  environment: string;
  preSnapshotId: string;
  /** Pending migration ids at preview time — re-checked at apply so a migration added between
   *  preview and apply (schema unchanged, so the snapshot drift guard misses it) is caught. */
  pendingMigrations: string[];
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

/** What `planEfDryRun` decided for one statement it will not run. */
export interface SkippedStatement {
  index: number;
  reason: "TRANSACTION_CONTROL" | "NON_TRANSACTIONAL";
  /** The first 120 characters, enough to recognise it. */
  statement: string;
}

export interface EfDryRunPlan {
  run: SplitStatement[];
  skipped: SkippedStatement[];
}

const TRANSACTION_CONTROL = new Set(["start", "begin", "commit", "end", "rollback", "abort", "savepoint", "release"]);

/**
 * Decide, statement by statement, what a dry run of an EF script executes.
 *
 * The script is split by the DDL lane's tokenizer, not by lines. That is the fix for PG-MIG-007
 * and its whole family: the old line filter recognised `COMMIT;` only when it stood alone on a
 * line in exactly that spelling, so `commit ;` (or any COMMIT the filter did not recognise)
 * stayed in the script and committed the dry run for real. Here a transaction-control statement
 * is recognised by its first word wherever it appears, and a `BEGIN` inside EF's `DO $EF$ … $EF$`
 * blocks is never a statement of its own, because the dollar-quoted body is one token.
 *
 * Two kinds of statement are skipped, and every skip is reported:
 *  - Transaction control (`START TRANSACTION`, `COMMIT`, …). The dry run owns the transaction.
 *  - Statements Postgres refuses inside a transaction: the `CONCURRENTLY` index builds and drops,
 *    `DETACH PARTITION … CONCURRENTLY`, `VACUUM`, `CREATE DATABASE`. A dry run cannot run them.
 *    It says so rather than pretending they passed.
 */
export function planEfDryRun(script: string): { ok: true; plan: EfDryRunPlan } | { ok: false; error: { code: string; message: string } } {
  const split = splitSqlStatements(script);
  if (!split.ok) {
    return { ok: false, error: { code: "EF_SCRIPT_UNSPLITTABLE", message: `The migration script could not be split into statements: ${split.error.message}` } };
  }
  const run: SplitStatement[] = [];
  const skipped: SkippedStatement[] = [];
  for (const statement of split.statements) {
    const words = topLevelWords(statement.tokens).map((w) => w.word);
    const first = words[0] ?? "";
    const preview = statement.text.replace(/\s+/g, " ").slice(0, 120);
    if (TRANSACTION_CONTROL.has(first)) {
      skipped.push({ index: statement.index, reason: "TRANSACTION_CONTROL", statement: preview });
      continue;
    }
    const concurrently = words.includes("concurrently") && (first === "create" || first === "drop" || first === "alter" || first === "reindex");
    if (concurrently || first === "vacuum" || (first === "create" && words[1] === "database")) {
      skipped.push({ index: statement.index, reason: "NON_TRANSACTIONAL", statement: preview });
      continue;
    }
    run.push(statement);
  }
  return { ok: true, plan: { run, skipped } };
}

function efOk(result: EfResult, action: string): EfResult {
  if (result.exitCode !== 0) {
    throw new PolicyViolationError("EF_COMMAND_FAILED", `dotnet ef ${action} failed (exit ${result.exitCode}): ${result.stderr || result.stdout}`);
  }
  return result;
}

/**
 * Gate a large debug-only field (raw `dotnet ef` stdout, full scripts) to `profile:"verbose"`.
 * Returns `undefined` at every other profile, which `JSON.stringify` drops from the payload —
 * the same idiom used for `migration_preview`'s full `script`. Keeps the field for debugging the
 * parse without paying its bytes on every call (the parsed arrays already carry the data).
 */
function verboseOnly<T>(value: T, profile: ResponseProfile): T | undefined {
  return profile === "verbose" ? value : undefined;
}

// ── migration_status ──────────────────────────────────────────────────────────

interface EfMigrationListEntry {
  id: string;
  name: string;
  safeName: string;
  applied: boolean | null;
}

/**
 * Run `migrations list --json` and split ids into applied vs pending. Structured `applied`
 * (true/false/null) replaces scraping a "(Pending)" text marker — immune to CLI locale
 * translation and to any future reformatting of the human-readable output. Anything other than
 * `applied === true` (including an unexpected `null`) counts as pending: safer to flag a
 * migration for attention than to silently assume it's applied.
 */
async function listMigrations(
  config: MigrationConfig,
  connectionString: string
): Promise<{ raw: string; entries: EfMigrationListEntry[]; applied: string[]; pending: string[] }> {
  const result = efOk(await efMigrationsListConnected(config, connectionString), "migrations list");
  let entries: EfMigrationListEntry[];
  try {
    entries = JSON.parse(result.stdout);
  } catch (error) {
    throw new PolicyViolationError(
      "EF_OUTPUT_UNPARSEABLE",
      `Failed to parse 'dotnet ef migrations list --json' output as JSON: ${String(error)}`
    );
  }
  return {
    raw: result.stdout.trim(),
    entries, // EF returns migrations in apply order — callers rely on this to detect a contiguous pending suffix
    applied: entries.filter((m) => m.applied === true).map((m) => m.id),
    pending: entries.filter((m) => m.applied !== true).map((m) => m.id)
  };
}

export async function handleMigrationStatus(
  args: { environment?: string; profile?: ResponseProfile },
  connections: ConnectionManager,
  config: MigrationConfig
): Promise<CallToolResult> {
  assertMigrationEnabled(config);
  const env = connections.getEnvironment(args.environment);
  const { raw, applied, pending } = await listMigrations(config, env.connectionString);

  return asText(
    {
      environment: env.name,
      appliedCount: applied.length,
      pendingCount: pending.length,
      applied,
      pending,
      // Redundant with applied[]/pending[] (same ids + name/safeName/applied per entry); scales with
      // total migration files, so gate it to verbose (PG-STA-001).
      raw: verboseOnly(raw, args.profile ?? "compact")
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
      raw: verboseOnly(result.stdout.trim(), args.profile ?? "compact")
    },
    args.profile ?? "compact"
  );
}

// ── the pending script ──────────────────────────────────────────────────────────

/**
 * The SQL for the pending migrations: what `migration_preview` shows and `migration_dry_run`
 * executes. One builder for both (B-15.2). Before, the dry run always ran the full idempotent
 * script, so it was not testing the SQL the preview had shown (PG-MIG-008).
 *
 * Is the pending set a contiguous suffix (the normal linear case)? If so, script just the delta
 * from the migration right before the first pending one. If NOT — a pending migration has an id
 * ordered before an already-applied one (branch merges apply migrations out of id order) — no
 * `script <from>` range can represent a non-contiguous subset, so fall back to the idempotent full
 * script, which guards each migration individually and is correct at any migration point.
 */
async function buildPendingScript(
  config: MigrationConfig,
  connectionString: string,
  entries: EfMigrationListEntry[],
  withFullScript: boolean
): Promise<{ pendingScript: string; fullScript: string | undefined; contiguous: boolean }> {
  const firstPendingIdx = entries.findIndex((m) => m.applied !== true);
  const contiguous = entries.slice(firstPendingIdx + 1).every((m) => m.applied !== true);
  const fromId = firstPendingIdx > 0 ? entries[firstPendingIdx - 1].id : undefined;

  if (contiguous) {
    // Net pending SQL only — scripting from the last applied migration yields just the delta,
    // not the whole guarded baseline (the ~50 KB PG-PRV-001 problem). Delta and (verbose-only)
    // full idempotent script are independent dotnet invocations → run them together.
    const [delta, full] = await Promise.all([
      efMigrationsScriptDelta(config, connectionString, fromId),
      withFullScript ? efMigrationsScript(config, connectionString) : Promise.resolve(undefined)
    ]);
    return {
      pendingScript: efOk(delta, "migrations script").stdout.trim(),
      fullScript: full ? efOk(full, "migrations script").stdout : undefined,
      contiguous
    };
  }
  // Non-contiguous: the idempotent full script IS the correct pending representation, so it
  // doubles as both `pendingScript` and the verbose `script` (one invocation, no delta call).
  const full = efOk(await efMigrationsScript(config, connectionString), "migrations script").stdout;
  return { pendingScript: full.trim(), fullScript: withFullScript ? full : undefined, contiguous };
}

// ── migration_preview ──────────────────────────────────────────────────────────

export async function handleMigrationPreview(
  args: { environment?: string; profile?: ResponseProfile },
  connections: ConnectionManager,
  config: MigrationConfig
): Promise<CallToolResult> {
  assertMigrationEnabled(config);
  const profile = args.profile ?? "compact";
  const env = connections.getEnvironment(args.environment, true); // migrations are writes → require writable env
  const pool = connections.getPool(args.environment, true);

  // Sweep before anything else so expired records are evicted on every preview call — even the
  // `no_pending` path below returns early, so leaving the sweep after it would strand records
  // whenever the target env has nothing pending.
  sweepExpiredMigrationPreviews();

  // captureSchema (a DB round-trip) and listMigrations (a dotnet subprocess) are independent —
  // run them together. `entries` is in EF apply order; the connected list is what tells us which
  // migrations are actually pending on THIS DB (the idempotent script's IF NOT EXISTS guards
  // only decide that at runtime).
  const [preSnapshot, listing] = await Promise.all([
    captureSchema(pool),
    listMigrations(config, env.connectionString)
  ]);
  const { entries, pending } = listing;
  if (pending.length === 0) {
    return asText({ environment: env.name, status: "no_pending", note: "No pending migrations." }, profile);
  }

  const { pendingScript, fullScript } = await buildPendingScript(config, env.connectionString, entries, profile === "verbose");

  const previewId = randomUUID();
  const expiresAt = new Date(Date.now() + config.previewTtlMs).toISOString();
  // Digest binds the previewed SQL — the plan migration_apply will run. `apply` uses
  // `dotnet ef database update` (applies exactly the pending set) + the preSnapshotId drift guard
  // and the pending-set re-check, never a stored script, so binding to what we showed is stable.
  const digest = migrationDigest(env.name, preSnapshot.snapshotId, pendingScript);
  const approvalToken = issueApprovalToken(previewId, digest, expiresAt, config.approvalSecret);

  migrationPreviews.set(previewId, {
    previewId,
    environment: env.name,
    preSnapshotId: preSnapshot.snapshotId,
    pendingMigrations: pending,
    digest,
    expiresAt
  });

  return asText(
    {
      previewId,
      approvalToken,
      environment: env.name,
      preSnapshotId: preSnapshot.snapshotId,
      pendingCount: pending.length,
      pendingMigrations: pending,
      pendingScript,
      script: fullScript, // undefined unless verbose — JSON.stringify drops it
      expiresAt
    },
    profile
  );
}

// ── migration_apply ──────────────────────────────────────────────────────────────

export async function handleMigrationApply(
  args: { environment?: string; previewId: string; approvalToken: string; profile?: ResponseProfile },
  connections: ConnectionManager,
  config: MigrationConfig
): Promise<CallToolResult> {
  assertMigrationEnabled(config);

  // The same per-environment mutex as write_apply / write_rollback. Without it, two concurrent
  // applies of one preview both passed the drift guard (the first had not finished, so nothing
  // had drifted yet) and both ran `dotnet ef database update`; and a data write could land on a
  // table mid-migration. The environment is peeked only to key the lock — every check below
  // runs inside it, so the second of two callers sees PREVIEW_NOT_FOUND, not a stale preview.
  const previewEnv =
    migrationPreviews.get(args.previewId)?.environment ?? connections.resolveEnvName(args.environment);

  return runExclusive(previewEnv, async () => {
    const preview = migrationPreviews.get(args.previewId);
    if (!preview) {
      // Record is swept only after POSTGRES_MIGRATION_PREVIEW_TTL_MS (default 1h) or on server restart;
      // within that window a human-gated approval can pause freely — the token's own expiry no
      // longer blocks apply (PG-PRV-002), the drift guard below is the real staleness check.
      throw new PolicyViolationError("PREVIEW_NOT_FOUND", `Migration preview '${args.previewId}' not found or expired.`);
    }
    // ignoreExpiry: freshness for a schema migration is proven by the drift guard (below), not the
    // time-box — see verifyApprovalToken. The record-existence check above still bounds how stale a
    // preview can be, and the HMAC still proves this token was issued for this exact plan.
    verifyApprovalToken(args.approvalToken, preview.previewId, preview.digest, preview.expiresAt, config.approvalSecret, {
      ignoreExpiry: true
    });

    const env = connections.getEnvironment(preview.environment, true);
    const pool = connections.getPool(preview.environment, true);

    // Two independent freshness checks, run together (schema round-trip + dotnet subprocess):
    //  1. Schema drift — the live schema must still match what was previewed.
    //  2. Pending-set drift — the set of pending migrations must be unchanged. Adding a migration
    //     between preview and apply leaves the schema untouched, so the snapshot guard alone would
    //     miss it and `dotnet ef database update` would apply migrations that were never previewed.
    const [preSnapshot, current] = await Promise.all([
      captureSchema(pool),
      listMigrations(config, env.connectionString)
    ]);
    if (preSnapshot.snapshotId !== preview.preSnapshotId) {
      throw new PolicyViolationError(
        "MIGRATION_DRIFT",
        "Schema changed since migration_preview. Re-run migration_preview before applying."
      );
    }
    if (current.pending.join(",") !== preview.pendingMigrations.join(",")) {
      throw new PolicyViolationError(
        "MIGRATION_DRIFT",
        "Pending migration set changed since migration_preview. Re-run migration_preview before applying."
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
        raw: verboseOnly(updateResult.stdout.trim(), args.profile ?? "compact")
      },
      args.profile ?? "compact"
    );
  });
}

// ── migration_dry_run ──────────────────────────────────────────────────────────

export async function handleMigrationDryRun(
  args: { environment?: string; profile?: ResponseProfile },
  connections: ConnectionManager,
  config: MigrationConfig
): Promise<CallToolResult> {
  assertMigrationEnabled(config);
  const profile = args.profile ?? "compact";
  const env = connections.getEnvironment(args.environment, true);
  const pool = connections.getPool(args.environment, true);

  const { entries, pending } = await listMigrations(config, env.connectionString);
  if (pending.length === 0) {
    return asText({ environment: env.name, status: "no_pending", note: "No pending migrations." }, profile);
  }
  // The same SQL migration_preview shows: the delta, or the idempotent script when the pending set
  // is not contiguous.
  const { pendingScript, contiguous } = await buildPendingScript(config, env.connectionString, entries, false);
  const planned = planEfDryRun(pendingScript);
  if (!planned.ok) {
    throw new PolicyViolationError(planned.error.code, planned.error.message);
  }
  const { run, skipped } = planned.plan;
  const base = {
    environment: env.name,
    pendingMigrations: pending,
    script: contiguous ? "delta" : "idempotent",
    statements: run.length + skipped.length,
    skipped: skipped.filter((s) => s.reason === "NON_TRANSACTIONAL"),
    transactionControlRemoved: skipped.filter((s) => s.reason === "TRANSACTION_CONTROL").length
  };
  if (run.length === 0) {
    return asText(
      { ...base, status: "not_dry_runnable", note: "Every statement in the pending script must run outside a transaction, so a dry run cannot execute any of them." },
      profile
    );
  }

  // One statement at a time, over the extended protocol, inside a transaction that is always
  // rolled back. One at a time is what lets a failure name its statement. The extended protocol
  // refuses a statement that hides a second one, so nothing runs unexamined.
  const client = await pool.connect();
  let ran = 0;
  try {
    await client.query("begin");
    for (const statement of run) {
      try {
        await client.query({ text: statement.text, queryMode: "extended" } as QueryConfig);
        ran += 1;
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        const sqlState = typeof (error as { code?: unknown }).code === "string" ? (error as { code: string }).code : undefined;
        return asText(
          {
            ...base,
            status: "failed",
            statementsRun: ran,
            error: detail,
            failure: { statementIndex: statement.index, ...(sqlState === undefined ? {} : { sqlState }), statement: statement.text.replace(/\s+/g, " ").slice(0, 200) }
          },
          profile
        );
      }
    }
    return asText(
      {
        ...base,
        status: "ok",
        statementsRun: ran,
        note:
          skipped.some((x) => x.reason === "NON_TRANSACTIONAL")
            ? "Ran in a rolled-back transaction. Some statements cannot run inside a transaction and were skipped; they are not verified."
            : "Migration script executed cleanly in a rolled-back transaction (no changes persisted)."
      },
      profile
    );
  } finally {
    await client.query("rollback").catch(() => undefined);
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
