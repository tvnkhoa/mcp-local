import { randomUUID, createHash } from "node:crypto";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Pool, PoolClient } from "pg";

import type { ConnectionManager } from "../../repositories/connectionManager.js";
import { PolicyViolationError } from "../../middleware/errors.js";
import { asText, type ResponseProfile } from "../../middleware/responseFormatter.js";
import { quoteIdent } from "../../middleware/ident.js";
import { validateWriteSql, type WriteStatementType, type WriteTarget } from "../../middleware/writeGuardrails.js";
import { recordAudit } from "../../services/write/auditLog.js";
import {
  createWriteDigest,
  issueApprovalToken,
  verifyApprovalToken
} from "../../services/write/approval.js";
import {
  MAX_ROLLBACK_ROWS,
  WritePreviewStore,
  type CapturedRow,
  type WriteApplyRecord
} from "../../services/write/previewStore.js";

export interface WriteConfig {
  enabled: boolean;
  approvalSecret: string;
  previewTtlMs: number;
  sampleLimit: number;
}

// ── helpers ──────────────────────────────────────────────────────────────────

function qualified(target: WriteTarget): string {
  return `${quoteIdent(target.schema)}.${quoteIdent(target.table)}`;
}

function sqlHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function hasReturning(sql: string): boolean {
  return /\breturning\b/i.test(sql);
}

/**
 * Replace the contents of string literals and comments with spaces while preserving
 * length, so keyword positions found here map 1:1 back onto the original SQL. This
 * prevents the words where/from/set *inside a string value* from being mistaken for
 * SQL clauses (e.g. `SET note = 'see report from sales where ready'`).
 */
function maskSqlLiterals(sql: string): string {
  const out = sql.split("");
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    const next = sql[i + 1];
    if (c === "'" || c === '"') {
      const quote = c;
      out[i] = " ";
      i++;
      while (i < sql.length) {
        if (sql[i] === quote) {
          if (sql[i + 1] === quote) {
            out[i] = " ";
            out[i + 1] = " ";
            i += 2;
            continue;
          }
          out[i] = " ";
          i++;
          break;
        }
        out[i] = " ";
        i++;
      }
      continue;
    }
    if (c === "-" && next === "-") {
      while (i < sql.length && sql[i] !== "\n") {
        out[i] = " ";
        i++;
      }
      continue;
    }
    if (c === "/" && next === "*") {
      while (i < sql.length) {
        if (sql[i] === "*" && sql[i + 1] === "/") {
          out[i] = " ";
          out[i + 1] = " ";
          i += 2;
          break;
        }
        out[i] = " ";
        i++;
      }
      continue;
    }
    i++;
  }
  return out.join("");
}

/** Top-level WHERE extraction (used only for param-less single-table UPDATE rollback). */
function extractWhereClause(sql: string): string | null {
  const masked = maskSqlLiterals(sql);
  const whereMatch = /\bwhere\b/i.exec(masked);
  if (!whereMatch) {
    return null;
  }
  const after = whereMatch.index + whereMatch[0].length;
  let endIdx = sql.length;
  const returningMatch = /\breturning\b/i.exec(masked.slice(after));
  if (returningMatch) {
    endIdx = after + returningMatch.index;
  }
  const tail = sql.slice(after, endIdx);
  return tail.trim() || null;
}

/** UPDATE with a FROM/join clause cannot be reliably snapshotted for rollback. */
function updateHasJoin(sql: string): boolean {
  const masked = maskSqlLiterals(sql);
  const setIdx = /\bset\b/i.exec(masked)?.index ?? 0;
  return /\bfrom\b/i.test(masked.slice(setIdx));
}

/**
 * Whether this statement's undo data can be captured, and if not, why.
 *
 * One principle decides every branch: **rollback is offered only when this server owns
 * the undo data.** Each `reason` below is a case where it does not.
 *
 *  - No primary key — nothing to address a row by.
 *  - The caller's own RETURNING — capture appends `returning *, xmin`, which it cannot
 *    do to a statement that already returns something.
 *  - `ON CONFLICT … DO UPDATE` — RETURNING hands back a row that may have existed
 *    before, indistinguishable from a fresh insert, and its prior values were never
 *    captured. Deleting it on rollback destroyed data (PG-WRT-002). `DO NOTHING` is
 *    fine: it returns only rows that were really inserted.
 *  - An UPDATE that assigns a PK column — restore addresses rows by the PK it captured,
 *    which after the change matches nothing (PG-WRT-003).
 *  - Parameterized / joined / whole-table UPDATE — the before-snapshot re-runs the
 *    statement's WHERE, so it needs a self-contained single-table WHERE.
 *  - More rows than MAX_ROLLBACK_ROWS — the snapshot is held in memory.
 */
function assessRollback(
  validated: Extract<ReturnType<typeof validateWriteSql>, { ok: true }>,
  pkColumns: string[],
  params: unknown[],
  rowsAffected: number
): { reason?: string } {
  if (pkColumns.length === 0) {
    return { reason: "Rollback is not available: the table has no primary key, so a row cannot be addressed." };
  }
  if (validated.hasReturning) {
    return {
      reason:
        "Rollback is not available: the statement has its own RETURNING clause, which rollback needs in order to capture undo data. Remove it — write_preview already reports the affected rows."
    };
  }
  if (validated.hasOnConflictUpdate) {
    return {
      reason:
        "Rollback is not available: INSERT ... ON CONFLICT DO UPDATE can modify a row that already existed, and its prior values are not captured. ON CONFLICT DO NOTHING is supported."
    };
  }
  if (validated.statementType === "update") {
    const pkSet = new Set(pkColumns);
    const assignedPk = validated.setColumns.filter((column) => pkSet.has(column));
    if (assignedPk.length > 0) {
      return {
        reason: `Rollback is not available: this UPDATE assigns the primary key column(s) ${assignedPk.join(", ")}, so the captured rows could no longer be located.`
      };
    }
    if (params.length > 0) {
      return {
        reason:
          "Rollback is not available for a parameterized UPDATE: the before-snapshot re-runs the WHERE clause, which needs to be self-contained."
      };
    }
    if (updateHasJoin(validated.sanitizedSql)) {
      return { reason: "Rollback is not available for an UPDATE with a FROM/join clause." };
    }
    if (!validated.hasWhere) {
      return { reason: "Rollback is not available for a whole-table UPDATE." };
    }
  }
  if (rowsAffected > MAX_ROLLBACK_ROWS) {
    return {
      reason: `Rollback is not available: this statement affects ${String(rowsAffected)} rows, over the ${String(MAX_ROLLBACK_ROWS)}-row capture limit. Narrow the WHERE clause and apply it in batches.`
    };
  }
  return {};
}

interface ColumnMeta {
  /** pg_attribute.attidentity: '' none, 'a' GENERATED ALWAYS AS IDENTITY, 'd' BY DEFAULT. */
  identity: string;
  /** pg_attribute.attgenerated: '' none, 's' GENERATED ALWAYS AS (...) STORED. */
  generated: string;
}

/** Per-column identity/generated flags — needed so rollback doesn't try to write read-only columns. */
async function getColumnMeta(pool: Pool, target: WriteTarget): Promise<Map<string, ColumnMeta>> {
  const result = await pool.query<{ attname: string; attidentity: string; attgenerated: string }>(
    `
    select a.attname, a.attidentity, a.attgenerated
    from pg_attribute a
    where a.attrelid = to_regclass($1)
      and a.attnum > 0
      and not a.attisdropped
    `,
    [`${target.schema}.${target.table}`]
  );
  const map = new Map<string, ColumnMeta>();
  for (const r of result.rows) {
    map.set(r.attname, { identity: r.attidentity, generated: r.attgenerated });
  }
  return map;
}

async function getPrimaryKeyColumns(pool: Pool, target: WriteTarget): Promise<string[]> {
  const result = await pool.query<{ attname: string }>(
    `
    select a.attname
    from pg_index i
    join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey)
    where i.indrelid = to_regclass($1)
      and i.indisprimary
    order by array_position(i.indkey, a.attnum)
    `,
    [`${target.schema}.${target.table}`]
  );
  return result.rows.map((r) => r.attname);
}

// Single-writer mutex PER ENVIRONMENT: serialize apply/rollback on the same database
// so two writes never interleave, while letting independent environments proceed in
// parallel (a long apply on staging must not block an unrelated write on dev).
const writeMutexes = new Map<string, Promise<unknown>>();
function runExclusive<T>(envKey: string, fn: () => Promise<T>): Promise<T> {
  const prev = writeMutexes.get(envKey) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  writeMutexes.set(envKey, run.then(() => undefined, () => undefined));
  return run;
}

function assertEnabled(config: WriteConfig): void {
  if (!config.enabled) {
    throw new PolicyViolationError(
      "WRITE_DISABLED",
      "Data modification is disabled. Set POSTGRES_WRITE_ENABLED=true and POSTGRES_WRITE_APPROVAL_SECRET to enable."
    );
  }
}

// ── write_preview ──────────────────────────────────────────────────────────────

export async function handleWritePreview(
  args: { environment?: string; sql: string; params?: unknown[]; allowFullTable?: boolean; profile?: ResponseProfile },
  connections: ConnectionManager,
  store: WritePreviewStore,
  config: WriteConfig
): Promise<CallToolResult> {
  assertEnabled(config);
  const env = connections.getEnvironment(args.environment, true); // requireWrite → ENVIRONMENT_READ_ONLY otherwise
  const profile = args.profile ?? "compact";
  const params = args.params ?? [];

  const validated = validateWriteSql(args.sql, args.allowFullTable === true);
  if (!validated.ok) {
    throw new PolicyViolationError(validated.error.code, validated.error.message);
  }

  const pool = connections.getPool(args.environment, true);
  const pkColumns = await getPrimaryKeyColumns(pool, validated.target);

  // Dry-run: execute inside a transaction we always roll back, to get the real
  // affected-row count and a sample of affected rows. Nothing is persisted.
  const dryRunSql = hasReturning(validated.sanitizedSql)
    ? validated.sanitizedSql
    : `${validated.sanitizedSql} returning *`;

  const client = await pool.connect();
  let rowsAffected = 0;
  let affectedSample: unknown[] = [];
  try {
    await client.query("begin");
    const result = await client.query(dryRunSql, params);
    rowsAffected = result.rowCount ?? 0;
    affectedSample = result.rows.slice(0, config.sampleLimit);
    await client.query("rollback");
  } catch (error) {
    await safeRollback(client);
    throw error;
  } finally {
    client.release();
  }

  const rollback = assessRollback(validated, pkColumns, params, rowsAffected);
  const rollbackSupported = rollback.reason === undefined;

  const previewId = randomUUID();
  const expiresAt = new Date(Date.now() + config.previewTtlMs).toISOString();
  const digest = createWriteDigest({
    environment: env.name,
    sql: validated.sanitizedSql,
    params,
    statementType: validated.statementType,
    rowsAffected
  });
  const approvalToken = issueApprovalToken(previewId, digest, expiresAt, config.approvalSecret);

  store.savePreview({
    previewId,
    environment: env.name,
    sql: validated.sanitizedSql,
    params,
    statementType: validated.statementType,
    target: validated.target,
    digest,
    rowsAffected,
    sampleBefore: affectedSample,
    pkColumns,
    rollbackSupported,
    createdAt: Date.now(),
    expiresAt,
    status: "ready"
  });

  return asText(
    {
      previewId,
      approvalToken,
      environment: env.name,
      statementType: validated.statementType,
      targetTable: `${validated.target.schema}.${validated.target.table}`,
      rowsAffected,
      affectedSample,
      rollbackSupported,
      rollbackNote: rollback.reason,
      expiresAt
    },
    profile
  );
}

// ── write_apply ──────────────────────────────────────────────────────────────

export async function handleWriteApply(
  args: { environment?: string; previewId: string; approvalToken: string; profile?: ResponseProfile },
  connections: ConnectionManager,
  store: WritePreviewStore,
  config: WriteConfig
): Promise<CallToolResult> {
  assertEnabled(config);
  const profile = args.profile ?? "compact";

  // Peek the authoritative environment so the mutex is keyed to the right database;
  // all real validation still happens inside the critical section below.
  const previewEnv = store.getPreview(args.previewId)?.environment ?? connections.resolveEnvName(args.environment);

  return runExclusive(previewEnv, async () => {
    const preview = store.getPreview(args.previewId);
    if (!preview) {
      throw new PolicyViolationError("PREVIEW_NOT_FOUND", `Preview '${args.previewId}' not found or expired.`);
    }
    if (preview.status === "applied") {
      throw new PolicyViolationError("PREVIEW_ALREADY_APPLIED", "This preview has already been applied.");
    }
    if (preview.status === "expired" || Date.parse(preview.expiresAt) < Date.now()) {
      throw new PolicyViolationError("PREVIEW_EXPIRED", "Preview expired. Create a fresh write_preview.");
    }
    // Verifies signature + that token was issued for exactly this plan + not expired.
    verifyApprovalToken(args.approvalToken, preview.previewId, preview.digest, preview.expiresAt, config.approvalSecret);

    const env = connections.getEnvironment(preview.environment, true);
    const pool = connections.getPool(preview.environment, true);
    const client = await pool.connect();
    const rollbackId = randomUUID();
    const applyId = randomUUID();
    let rowsAffected = 0;
    let capturedRows: CapturedRow[] = [];

    try {
      await client.query("begin");

      // Capture rollback data inside the same committed transaction.
      //
      // UPDATE's before-values come from re-running the statement's own WHERE, which is
      // sound only because rollbackSupported already required a self-contained,
      // single-table, param-less WHERE.
      let beforeRows: Array<Record<string, unknown>> = [];
      if (preview.rollbackSupported && preview.statementType === "update") {
        const where = extractWhereClause(preview.sql);
        if (where) {
          const snap = await client.query<Record<string, unknown>>(
            `select * from ${qualified(preview.target)} where ${where}`
          );
          beforeRows = snap.rows;
        }
      }

      // `xmin` is the row's MVCC version, captured here as of *after* the change. It is
      // what lets rollback tell "still as I left it" from "somebody else changed it",
      // without comparing column values in JS.
      const execSql = preview.rollbackSupported ? `${preview.sql} returning *, xmin` : preview.sql;
      const result = await client.query<Record<string, unknown>>(execSql, preview.params);
      rowsAffected = result.rowCount ?? 0;

      if (preview.rollbackSupported) {
        capturedRows =
          preview.statementType === "update"
            ? pairSnapshotWithVersions(beforeRows, result.rows, preview.pkColumns)
            : result.rows.map((row) => toCapturedRow(row, preview.statementType));
      }

      await client.query("commit");
    } catch (error) {
      await safeRollback(client);
      client.release();
      await recordAudit(pool, env.name, {
        tool: "write_apply",
        environment: env.name,
        statementType: preview.statementType,
        targetTable: `${preview.target.schema}.${preview.target.table}`,
        sqlHash: sqlHash(preview.sql),
        rowsAffected: null,
        status: "failed",
        rollbackId: null,
        detail: { error: String(error) }
      });
      throw error;
    }
    client.release();

    store.markApplied(preview.previewId);
    const applyRecord: WriteApplyRecord = {
      rollbackId,
      applyId,
      previewId: preview.previewId,
      environment: env.name,
      statementType: preview.statementType,
      target: preview.target,
      pkColumns: preview.pkColumns,
      capturedRows,
      rowsAffected,
      appliedAt: Date.now(),
      rolledBack: false
    };
    store.saveApply(applyRecord);

    await recordAudit(pool, env.name, {
      tool: "write_apply",
      environment: env.name,
      statementType: preview.statementType,
      targetTable: `${preview.target.schema}.${preview.target.table}`,
      sqlHash: sqlHash(preview.sql),
      rowsAffected,
      status: "applied",
      rollbackId: preview.rollbackSupported ? rollbackId : null
    });

    return asText(
      {
        applyId,
        rollbackId: preview.rollbackSupported ? rollbackId : null,
        environment: env.name,
        statementType: preview.statementType,
        rowsAffected,
        rollbackSupported: preview.rollbackSupported,
        status: "applied"
      },
      profile
    );
  });
}

// ── capture helpers ──────────────────────────────────────────────────────────

/** Stable key for a row's primary-key tuple. */
function pkKey(row: Record<string, unknown>, pkColumns: string[]): string {
  return pkColumns.map((column) => String(row[column])).join(" ");
}

/** Split the `xmin` column back off a `returning *, xmin` row. */
function toCapturedRow(row: Record<string, unknown>, statementType: WriteStatementType): CapturedRow {
  const { xmin, ...values } = row;
  return {
    values,
    // A deleted row has no surviving version to match on. Its reinsert is guarded by
    // the primary-key constraint instead, which is what catches a re-created row.
    xmin: statementType === "delete" || xmin === null || xmin === undefined ? null : String(xmin),
    restored: false
  };
}

/**
 * Join the before-snapshot (which carries the values to restore) with the UPDATE's own
 * RETURNING (which carries the post-apply `xmin`) on the primary key.
 *
 * Sound because an UPDATE that assigns a PK column is refused rollback at preview time,
 * so the key is stable across the statement.
 */
function pairSnapshotWithVersions(
  beforeRows: Array<Record<string, unknown>>,
  returnedRows: Array<Record<string, unknown>>,
  pkColumns: string[]
): CapturedRow[] {
  const versions = new Map<string, string | null>();
  for (const row of returnedRows) {
    const xmin = row.xmin;
    versions.set(pkKey(row, pkColumns), xmin === null || xmin === undefined ? null : String(xmin));
  }
  return beforeRows.map((row) => ({
    values: row,
    xmin: versions.get(pkKey(row, pkColumns)) ?? null,
    restored: false
  }));
}

// ── write_rollback ──────────────────────────────────────────────────────────────

export async function handleWriteRollback(
  args: { rollbackId: string; profile?: ResponseProfile },
  connections: ConnectionManager,
  store: WritePreviewStore,
  config: WriteConfig
): Promise<CallToolResult> {
  assertEnabled(config);
  const profile = args.profile ?? "compact";

  // Peek the authoritative environment to key the mutex; full checks run inside.
  const applyEnv = store.getApply(args.rollbackId)?.environment ?? "";

  return runExclusive(applyEnv, async () => {
    const apply = store.getApply(args.rollbackId);
    if (!apply) {
      throw new PolicyViolationError("ROLLBACK_NOT_FOUND", `Rollback '${args.rollbackId}' not found (process restart clears history).`);
    }
    if (apply.rolledBack) {
      throw new PolicyViolationError("ALREADY_ROLLED_BACK", "This change has already been rolled back.");
    }
    if (apply.pkColumns.length === 0) {
      throw new PolicyViolationError("ROLLBACK_UNSUPPORTED_NO_PK", "Cannot roll back a table without a primary key.");
    }

    const env = connections.getEnvironment(apply.environment, true);
    const pool = connections.getPool(apply.environment, true);
    const colMeta = await getColumnMeta(pool, apply.target);
    const client = await pool.connect();

    const outstanding = apply.capturedRows.filter((row) => !row.restored);
    const restoredNow: CapturedRow[] = [];
    const unrestored: Array<{ pk: Record<string, unknown>; reason: RestoreFailure }> = [];

    try {
      await client.query("begin");
      for (const [index, row] of outstanding.entries()) {
        // A SAVEPOINT per row is what makes the per-row error handling real. Without
        // one, the first failing statement aborts the whole transaction: every later
        // row fails too, COMMIT silently degrades to ROLLBACK, and the tool reported
        // rows as restored that were never written (PG-WRT-001). The name is built from
        // a loop index, so it cannot carry anything but digits.
        const savepoint = `mcp_rollback_${String(index)}`;
        await client.query(`savepoint ${savepoint}`);
        try {
          const affected = await restoreRow(client, apply, row, colMeta);
          if (affected > 0) {
            await client.query(`release savepoint ${savepoint}`);
            restoredNow.push(row);
            continue;
          }
          // Matched nothing. Previously this counted as success and reported a no-op
          // rollback as "restored" (PG-WRT-003).
          await client.query(`rollback to savepoint ${savepoint}`);
          unrestored.push({
            pk: pkOf(row, apply.pkColumns),
            reason: await diagnoseMiss(client, apply, row)
          });
        } catch {
          await client.query(`rollback to savepoint ${savepoint}`);
          unrestored.push({ pk: pkOf(row, apply.pkColumns), reason: "conflict" });
        }
      }
      await client.query("commit");
    } catch (error) {
      await safeRollback(client);
      client.release();
      // Audit the failure too. Only the success path used to be recorded, so a rollback
      // that threw left no trace in mcp_ops.audit_log.
      await recordAudit(pool, env.name, {
        tool: "write_rollback",
        environment: env.name,
        statementType: apply.statementType,
        targetTable: `${apply.target.schema}.${apply.target.table}`,
        sqlHash: null,
        rowsAffected: null,
        status: "failed",
        rollbackId: apply.rollbackId,
        detail: { error: String(error) }
      });
      throw error;
    }
    client.release();

    // Only now that COMMIT succeeded is a row really restored.
    for (const row of restoredNow) {
      row.restored = true;
    }
    const pending = apply.capturedRows.filter((row) => !row.restored).length;
    // `status` describes THIS call; `pending` describes what is left overall. A rollback
    // that restored nothing stays retryable — the row it conflicted on may be freed
    // later — and the retry attempts only the outstanding rows.
    const status =
      unrestored.length === 0 ? "restored" : restoredNow.length > 0 ? "partial" : "failed";
    apply.rolledBack = pending === 0;

    await recordAudit(pool, env.name, {
      tool: "write_rollback",
      environment: env.name,
      statementType: apply.statementType,
      targetTable: `${apply.target.schema}.${apply.target.table}`,
      sqlHash: null,
      rowsAffected: restoredNow.length,
      status,
      rollbackId: apply.rollbackId,
      detail: { conflicts: unrestored.length, pending }
    });

    return asText(
      {
        rollbackId: apply.rollbackId,
        environment: env.name,
        status,
        restored: restoredNow.length,
        conflicts: unrestored.length,
        pending,
        unrestored: unrestored.length > 0 ? unrestored : undefined,
        note:
          apply.capturedRows.length === 0
            ? "Nothing was captured for this apply, so there was nothing to restore."
            : undefined
      },
      profile
    );
  });
}

/** Why one row could not be put back. */
type RestoreFailure = "row_missing" | "row_changed_since_apply" | "no_restorable_columns" | "conflict";

function pkOf(row: CapturedRow, pkColumns: string[]): Record<string, unknown> {
  const pk: Record<string, unknown> = {};
  for (const column of pkColumns) {
    pk[column] = row.values[column];
  }
  return pk;
}

async function restoreRow(
  client: PoolClient,
  apply: WriteApplyRecord,
  row: CapturedRow,
  colMeta: Map<string, ColumnMeta>
): Promise<number> {
  if (apply.statementType === "delete") {
    return reinsertRow(client, apply.target, row, colMeta);
  }
  if (apply.statementType === "insert") {
    return deleteByPk(client, apply.target, apply.pkColumns, row);
  }
  return restoreUpdatedRow(client, apply.target, apply.pkColumns, row, colMeta);
}

/**
 * Distinguish "the row is gone" from "somebody changed it since the apply". Runs only
 * on the failure path, after the savepoint rollback made the transaction usable again,
 * so the happy path costs nothing.
 */
async function diagnoseMiss(
  client: PoolClient,
  apply: WriteApplyRecord,
  row: CapturedRow
): Promise<RestoreFailure> {
  if (apply.statementType === "delete") {
    // A reinsert matches nothing only when there was no writable column to insert.
    return "no_restorable_columns";
  }
  const conds = apply.pkColumns.map((column, i) => `${quoteIdent(column)} = $${String(i + 1)}`);
  const probe = await client.query(
    `select 1 from ${qualified(apply.target)} where ${conds.join(" and ")}`,
    apply.pkColumns.map((column) => row.values[column])
  );
  return (probe.rowCount ?? 0) > 0 ? "row_changed_since_apply" : "row_missing";
}

// ── row-level restore primitives ─────────────────────────────────────────────

async function reinsertRow(
  client: PoolClient,
  target: WriteTarget,
  row: CapturedRow,
  colMeta: Map<string, ColumnMeta>
): Promise<number> {
  // STORED generated columns are computed by the DB and cannot be written.
  const cols = Object.keys(row.values).filter((c) => colMeta.get(c)?.generated !== "s");
  if (cols.length === 0) {
    return 0;
  }
  // GENERATED ALWAYS AS IDENTITY columns require OVERRIDING SYSTEM VALUE to restore
  // the original key value (so existing foreign keys still resolve).
  const needsOverride = cols.some((c) => {
    const identity = colMeta.get(c)?.identity;
    return identity === "a" || identity === "d";
  });
  const overriding = needsOverride ? " overriding system value" : "";
  const placeholders = cols.map((_, i) => `$${i + 1}`);
  const sql = `insert into ${qualified(target)} (${cols.map(quoteIdent).join(", ")})${overriding} values (${placeholders.join(", ")})`;
  const res = await client.query(sql, cols.map((c) => row.values[c]));
  return res.rowCount ?? 0;
}

/**
 * The row's captured version as a WHERE condition, so a row somebody else touched
 * after the apply matches nothing and gets reported rather than overwritten.
 *
 * `xmin::text` rather than `xmin`: the captured version travels as a string, and
 * Postgres will not infer a text-to-xid cast for a bind parameter.
 */
function versionGuard(row: CapturedRow, values: unknown[]): string[] {
  if (row.xmin === null) {
    return [];
  }
  values.push(row.xmin);
  return [`xmin::text = $${String(values.length)}`];
}

async function deleteByPk(
  client: PoolClient,
  target: WriteTarget,
  pkColumns: string[],
  row: CapturedRow
): Promise<number> {
  const values = pkColumns.map((c) => row.values[c]);
  const conds = pkColumns.map((c, i) => `${quoteIdent(c)} = $${String(i + 1)}`);
  const sql = `delete from ${qualified(target)} where ${[...conds, ...versionGuard(row, values)].join(" and ")}`;
  const res = await client.query(sql, values);
  return res.rowCount ?? 0;
}

async function restoreUpdatedRow(
  client: PoolClient,
  target: WriteTarget,
  pkColumns: string[],
  row: CapturedRow,
  colMeta: Map<string, ColumnMeta>
): Promise<number> {
  const pkSet = new Set(pkColumns);
  // Skip PK columns (used in WHERE) and STORED generated columns (cannot be written).
  const setCols = Object.keys(row.values).filter((c) => !pkSet.has(c) && colMeta.get(c)?.generated !== "s");
  if (setCols.length === 0) {
    return 0;
  }
  const setClause = setCols.map((c, i) => `${quoteIdent(c)} = $${String(i + 1)}`);
  const whereClause = pkColumns.map((c, i) => `${quoteIdent(c)} = $${String(setCols.length + i + 1)}`);
  const values = [...setCols.map((c) => row.values[c]), ...pkColumns.map((c) => row.values[c])];
  const sql = `update ${qualified(target)} set ${setClause.join(", ")} where ${[...whereClause, ...versionGuard(row, values)].join(" and ")}`;
  const res = await client.query(sql, values);
  return res.rowCount ?? 0;
}

export async function safeRollback(client: PoolClient): Promise<void> {
  try {
    await client.query("rollback");
  } catch {
    // swallow
  }
}
