import { randomUUID, createHash } from "node:crypto";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Pool, PoolClient } from "pg";

import type { ConnectionManager } from "../db/connectionManager.js";
import { PolicyViolationError } from "../errors.js";
import { asText, type ResponseProfile } from "../response/responseFormatter.js";
import { quoteIdent } from "../sql/ident.js";
import { validateWriteSql, type WriteTarget } from "../sql/writeGuardrails.js";
import { recordAudit } from "./auditLog.js";
import {
  createWriteDigest,
  issueApprovalToken,
  verifyApprovalToken
} from "./approval.js";
import { WritePreviewStore, type WriteApplyRecord } from "./previewStore.js";

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
      "Data modification is disabled. Set PG_WRITE_ENABLED=true and PG_WRITE_APPROVAL_SECRET to enable."
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

  // Rollback support depends on having a PK and (for UPDATE) being a simple single-table form.
  let rollbackSupported = pkColumns.length > 0;
  if (validated.statementType === "update") {
    if (params.length > 0 || updateHasJoin(validated.sanitizedSql) || !validated.hasWhere) {
      rollbackSupported = false;
    }
  }

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
      rollbackNote: rollbackSupported
        ? undefined
        : "Rollback is not available for this statement (no primary key, parameterized UPDATE, joined UPDATE, or whole-table UPDATE).",
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
    let capturedRows: Array<Record<string, unknown>> = [];

    try {
      await client.query("begin");

      // Capture rollback data inside the same committed transaction.
      if (preview.rollbackSupported && preview.statementType === "update") {
        const where = extractWhereClause(preview.sql);
        if (where) {
          const snap = await client.query<Record<string, unknown>>(
            `select * from ${qualified(preview.target)} where ${where}`
          );
          capturedRows = snap.rows;
        }
      }

      const execSql = (preview.statementType === "delete" || preview.statementType === "insert") && !hasReturning(preview.sql)
        ? `${preview.sql} returning *`
        : preview.sql;
      const result = await client.query<Record<string, unknown>>(execSql, preview.params);
      rowsAffected = result.rowCount ?? 0;

      if (preview.rollbackSupported && (preview.statementType === "delete" || preview.statementType === "insert")) {
        capturedRows = result.rows;
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
      capturedRows: preview.rollbackSupported ? capturedRows : [],
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
    let restored = 0;
    let conflicts = 0;

    try {
      await client.query("begin");
      for (const row of apply.capturedRows) {
        try {
          if (apply.statementType === "delete") {
            restored += await reinsertRow(client, apply.target, row, colMeta);
          } else if (apply.statementType === "insert") {
            restored += await deleteByPk(client, apply.target, apply.pkColumns, row);
          } else {
            restored += await restoreUpdatedRow(client, apply.target, apply.pkColumns, row, colMeta);
          }
        } catch {
          conflicts += 1;
        }
      }
      await client.query("commit");
    } catch (error) {
      await safeRollback(client);
      client.release();
      throw error;
    }
    client.release();

    const status = conflicts === 0 ? "restored" : restored > 0 ? "partial" : "failed";
    // Only mark as rolled back if at least one row was restored. A fully-failed
    // rollback (every row conflicted, nothing restored) stays retryable instead of
    // being permanently locked out with ALREADY_ROLLED_BACK.
    apply.rolledBack = status !== "failed";

    await recordAudit(pool, env.name, {
      tool: "write_rollback",
      environment: env.name,
      statementType: apply.statementType,
      targetTable: `${apply.target.schema}.${apply.target.table}`,
      sqlHash: null,
      rowsAffected: restored,
      status,
      rollbackId: apply.rollbackId,
      detail: { conflicts }
    });

    return asText({ rollbackId: apply.rollbackId, environment: env.name, status, restored, conflicts }, profile);
  });
}

// ── row-level restore primitives ─────────────────────────────────────────────

async function reinsertRow(
  client: PoolClient,
  target: WriteTarget,
  row: Record<string, unknown>,
  colMeta: Map<string, ColumnMeta>
): Promise<number> {
  // STORED generated columns are computed by the DB and cannot be written.
  const cols = Object.keys(row).filter((c) => colMeta.get(c)?.generated !== "s");
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
  const res = await client.query(sql, cols.map((c) => row[c]));
  return res.rowCount ?? 0;
}

async function deleteByPk(
  client: PoolClient,
  target: WriteTarget,
  pkColumns: string[],
  row: Record<string, unknown>
): Promise<number> {
  const conds = pkColumns.map((c, i) => `${quoteIdent(c)} = $${i + 1}`);
  const sql = `delete from ${qualified(target)} where ${conds.join(" and ")}`;
  const res = await client.query(sql, pkColumns.map((c) => row[c]));
  return res.rowCount ?? 0;
}

async function restoreUpdatedRow(
  client: PoolClient,
  target: WriteTarget,
  pkColumns: string[],
  row: Record<string, unknown>,
  colMeta: Map<string, ColumnMeta>
): Promise<number> {
  const pkSet = new Set(pkColumns);
  // Skip PK columns (used in WHERE) and STORED generated columns (cannot be written).
  const setCols = Object.keys(row).filter((c) => !pkSet.has(c) && colMeta.get(c)?.generated !== "s");
  if (setCols.length === 0) {
    return 0;
  }
  const setClause = setCols.map((c, i) => `${quoteIdent(c)} = $${i + 1}`);
  const whereClause = pkColumns.map((c, i) => `${quoteIdent(c)} = $${setCols.length + i + 1}`);
  const sql = `update ${qualified(target)} set ${setClause.join(", ")} where ${whereClause.join(" and ")}`;
  const values = [...setCols.map((c) => row[c]), ...pkColumns.map((c) => row[c])];
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
