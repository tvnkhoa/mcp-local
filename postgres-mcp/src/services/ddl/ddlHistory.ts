/**
 * The DDL ledger: `mcp_ops.ddl_history`, and the state derived from it.
 *
 * Append-only. Nothing in the server updates or deletes a row. A migration's state is
 * whatever its latest `applied` row says: `up` means applied, `down` means reverted. Failed rows
 * are kept, so an operator can see what was tried, but they never change state.
 *
 * Only `ddl_apply` and `ddl_dry_run` create the table. `ddl_status` and `ddl_preview` must stay
 * read-only, so they treat a missing table as an empty history.
 *
 * The write lane cannot touch this table (PG-SEC-002), the DDL guardrail refuses any script that
 * names `mcp_ops`, and `captureSchema` leaves the schema out. Because it is out of the snapshot, a
 * preview binds `historyStateId` separately, or a concurrent apply could slip between preview and
 * apply unnoticed.
 */

import { createHash } from "node:crypto";

import type { Pool, PoolClient } from "pg";

export type Queryable = Pick<Pool | PoolClient, "query">;

/**
 * Key for `pg_try_advisory_lock(int, int)`. Shared by every server process that can apply DDL to
 * a database, and by the EF lane in phase 2.5. It is an arbitrary constant; the first half spells
 * "MCPD" in ASCII.
 */
export const DDL_LOCK_KEY: readonly [number, number] = [0x4d435044, 1];

export const HISTORY_DDL = `
create schema if not exists mcp_ops;
create table if not exists mcp_ops.ddl_history (
  id               bigint generated always as identity primary key,
  version          text,
  name             text not null,
  kind             text not null check (kind in ('file', 'inline', 'adopted')),
  direction        text not null check (direction in ('up', 'down')),
  checksum         text not null,
  up_checksum      text,
  execution_mode   text not null check (execution_mode in ('transactional', 'non_transactional')),
  status           text not null check (status in ('applied', 'failed')),
  statement_count  integer not null,
  failed_statement integer,
  error_sqlstate   text,
  environment      text not null,
  applied_by       text not null,
  preview_id       text not null,
  duration_ms      integer not null,
  applied_at       timestamptz not null default now()
);
create index if not exists ddl_history_version_idx on mcp_ops.ddl_history (version, id desc);
`;

export interface HistoryRow {
  id: number;
  version: string | null;
  name: string;
  kind: "file" | "inline" | "adopted";
  direction: "up" | "down";
  checksum: string;
  upChecksum: string | null;
  status: "applied" | "failed";
  appliedAt: string;
}

export interface AppliedVersion {
  version: string;
  name: string;
  /** The up script's checksum as applied (for an adoption, the inline script's). */
  checksum: string;
  kind: "file" | "adopted";
  historyId: number;
}

export interface HistoryState {
  /** Versions whose latest applied row is `up`, ascending. */
  applied: AppliedVersion[];
  /** Inline applies no file has adopted yet, oldest first. Each can be adopted once. */
  unadoptedInline: Array<{ historyId: number; name: string; checksum: string }>;
  /** The highest row id, or 0 for no rows. */
  maxId: number;
  /** A digest of the derived state. A preview binds it, so any apply in between invalidates it. */
  stateId: string;
}

/** Rows ascending by id, or `[]` when the table does not exist yet. Never creates it. */
export async function readHistory(db: Queryable): Promise<HistoryRow[]> {
  const exists = await db.query<{ present: boolean }>(`select to_regclass('mcp_ops.ddl_history') is not null as present`);
  if (exists.rows[0]?.present !== true) {
    return [];
  }
  const result = await db.query<{
    id: string;
    version: string | null;
    name: string;
    kind: HistoryRow["kind"];
    direction: HistoryRow["direction"];
    checksum: string;
    up_checksum: string | null;
    status: HistoryRow["status"];
    applied_at: Date;
  }>(
    `select id, version, name, kind, direction, checksum, up_checksum, status, applied_at
     from mcp_ops.ddl_history order by id`
  );
  return result.rows.map((r) => ({
    id: Number(r.id),
    version: r.version,
    name: r.name,
    kind: r.kind,
    direction: r.direction,
    checksum: r.checksum,
    upChecksum: r.up_checksum,
    status: r.status,
    appliedAt: new Date(r.applied_at).toISOString()
  }));
}

/** Pure: the ledger's current state. `rows` must be ascending by id. */
export function deriveState(rows: readonly HistoryRow[]): HistoryState {
  const latest = new Map<string, HistoryRow>();
  const inline: HistoryState["unadoptedInline"] = [];
  const adoptedChecksums: string[] = [];

  for (const row of rows) {
    if (row.status !== "applied") {
      continue;
    }
    if (row.kind === "inline") {
      inline.push({ historyId: row.id, name: row.name, checksum: row.checksum });
      continue;
    }
    if (row.version !== null) {
      latest.set(row.version, row);
      if (row.kind === "adopted" && row.direction === "up") {
        adoptedChecksums.push(row.checksum);
      }
    }
  }

  // Each adoption consumes one inline row with the same checksum, oldest first.
  for (const checksum of adoptedChecksums) {
    const at = inline.findIndex((i) => i.checksum === checksum);
    if (at >= 0) {
      inline.splice(at, 1);
    }
  }

  const applied: AppliedVersion[] = [...latest.values()]
    .filter((row) => row.direction === "up")
    .map((row) => ({
      version: row.version as string,
      name: row.name,
      checksum: row.checksum,
      kind: row.kind === "adopted" ? ("adopted" as const) : ("file" as const),
      historyId: row.id
    }))
    .sort((a, b) => a.version.localeCompare(b.version));

  const maxId = rows.reduce((max, row) => Math.max(max, row.id), 0);
  const stateId = createHash("sha256")
    .update(JSON.stringify({ maxId, applied: applied.map((a) => [a.version, a.checksum]), inline: inline.map((i) => i.checksum) }))
    .digest("hex")
    .slice(0, 24);

  return { applied, unadoptedInline: inline, maxId, stateId };
}

/** Create the ledger if it is missing. Callers hold the DDL advisory lock. */
export async function ensureHistory(db: Queryable): Promise<void> {
  await db.query(HISTORY_DDL);
}

export interface NewHistoryRow {
  version: string | null;
  name: string;
  kind: HistoryRow["kind"];
  direction: HistoryRow["direction"];
  checksum: string;
  upChecksum: string | null;
  executionMode: "transactional" | "non_transactional";
  status: HistoryRow["status"];
  statementCount: number;
  failedStatement: number | null;
  errorSqlstate: string | null;
  environment: string;
  previewId: string;
  durationMs: number;
}

/** Append one row. `applied_by` is the database role plus this host, recorded server-side. */
export async function insertHistory(db: Queryable, row: NewHistoryRow, host: string): Promise<number> {
  const result = await db.query<{ id: string }>(
    `insert into mcp_ops.ddl_history
       (version, name, kind, direction, checksum, up_checksum, execution_mode, status,
        statement_count, failed_statement, error_sqlstate, environment, applied_by, preview_id, duration_ms)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, current_user || '@' || $13, $14, $15)
     returning id`,
    [
      row.version,
      row.name,
      row.kind,
      row.direction,
      row.checksum,
      row.upChecksum,
      row.executionMode,
      row.status,
      row.statementCount,
      row.failedStatement,
      row.errorSqlstate,
      row.environment,
      host,
      row.previewId,
      row.durationMs
    ]
  );
  return Number(result.rows[0]?.id);
}
