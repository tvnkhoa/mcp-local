import type { Pool } from "pg";

export interface AuditEntry {
  tool: string;
  environment: string;
  statementType: string | null;
  targetTable: string | null;
  sqlHash: string | null;
  rowsAffected: number | null;
  status: string;
  rollbackId: string | null;
  detail?: Record<string, unknown>;
}

const ENSURE_SCHEMA_SQL = `
create schema if not exists mcp_ops;
create table if not exists mcp_ops.audit_log (
  id            bigint generated always as identity primary key,
  ts            timestamptz not null default now(),
  tool          text not null,
  environment   text not null,
  statement_type text,
  target_table  text,
  sql_hash      text,
  rows_affected integer,
  status        text not null,
  rollback_id   text,
  detail        jsonb
);
`;

const ensured = new Set<string>();

/**
 * Append a durable audit row to mcp_ops.audit_log on the target database and mirror
 * it to stderr. The schema/table is created on first use per pool. Audit failures
 * never block the operation — they degrade to a stderr-only record.
 */
export async function recordAudit(pool: Pool, poolKey: string, entry: AuditEntry): Promise<void> {
  process.stderr.write(JSON.stringify({ level: "audit", ...entry, ts: new Date().toISOString() }) + "\n");

  try {
    if (!ensured.has(poolKey)) {
      await pool.query(ENSURE_SCHEMA_SQL);
      ensured.add(poolKey);
    }
    await pool.query(
      `insert into mcp_ops.audit_log
        (tool, environment, statement_type, target_table, sql_hash, rows_affected, status, rollback_id, detail)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        entry.tool,
        entry.environment,
        entry.statementType,
        entry.targetTable,
        entry.sqlHash,
        entry.rowsAffected,
        entry.status,
        entry.rollbackId,
        entry.detail ? JSON.stringify(entry.detail) : null
      ]
    );
  } catch (error) {
    process.stderr.write(
      JSON.stringify({ level: "error", event: "audit_write_failed", error: String(error) }) + "\n"
    );
  }
}
