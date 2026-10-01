/**
 * Where the DDL lane reads and records which migrations have run: one ledger per configuration,
 * never two.
 *
 *  - `mcp_ops.ddl_history` (the default): the server's own append-only ledger, `ddlHistory.ts`.
 *  - An EXTERNAL ledger (POSTGRES_DDL_EXTERNAL_LEDGER): a repo's own `(filename, checksum)` table,
 *    written until now by that repo's runner (wec.aria's `db/migrate.sh`). The lane reads it and
 *    inserts into it exactly as that runner does, so either one can apply the next file and the
 *    other sees it as applied. `mcp_ops.ddl_history` is then not used at all: a second ledger that
 *    disagreed with the first is the problem this mode exists to avoid.
 *
 * The external table is the repo's, so the lane never creates or alters it. It must exist with a
 * `filename` and a `checksum` column; the runner that owns it creates it.
 */

import { createHash } from "node:crypto";

import { PolicyViolationError } from "../../middleware/errors.js";
import { quoteQualified, type DdlConfig, type QualifiedName } from "./ddlConfig.js";
import { PSQL_MIGRATION_FILE, type MigrationFileFormat } from "./ddlFiles.js";
import { deriveState, ensureHistory, insertHistory, readHistory, type HistoryState, type NewHistoryRow, type Queryable } from "./ddlHistory.js";

export interface LedgerRead {
  state: HistoryState;
  /** Rows in the ledger, failed ones included. 0 when the table does not exist. */
  rowCount: number;
  present: boolean;
}

export interface DdlLedger {
  /** `schema.table`, for responses. */
  readonly label: string;
  readonly external: boolean;
  /** The file layout this ledger's directory uses. */
  readonly format: MigrationFileFormat;
  /** Read-only: a missing table reads as an empty ledger. */
  read(db: Queryable): Promise<LedgerRead>;
  /** Before an apply, under the DDL lock: create `mcp_ops.ddl_history`, or prove the external table is usable. */
  prepare(db: Queryable): Promise<void>;
  /** Record a step that ran, in the step's own transaction. Returns the row id where there is one. */
  recordApplied(db: Queryable, row: NewHistoryRow, file: string | null, host: string): Promise<number | undefined>;
  /** Record a failed attempt, outside the rolled-back transaction. Best effort. */
  recordFailure(db: Queryable, row: NewHistoryRow, host: string): Promise<void>;
}

const MCP_LEDGER: DdlLedger = {
  label: "mcp_ops.ddl_history",
  external: false,
  format: "mcp",
  async read(db) {
    const rows = await readHistory(db);
    const present = rows.length > 0 || (await db.query<{ p: boolean }>(`select to_regclass('mcp_ops.ddl_history') is not null as p`)).rows[0]?.p === true;
    return { state: deriveState(rows), rowCount: rows.length, present };
  },
  prepare: ensureHistory,
  recordApplied: (db, row, _file, host) => insertHistory(db, row, host),
  async recordFailure(db, row, host) {
    await insertHistory(db, row, host).catch(() => undefined);
  }
};

/** The state an external ledger's rows describe. Pure, so it is tested without a database. */
export function deriveExternalState(rows: ReadonlyArray<{ filename: string; checksum: string }>, label: string): HistoryState {
  const sorted = [...rows].sort((a, b) => (a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : 0));
  const applied = sorted.map((row, at) => {
    const match = PSQL_MIGRATION_FILE.exec(row.filename);
    return {
      // A row whose name is not in the psql format still counts as applied; it shows up as a file
      // that is no longer on disk rather than disappearing from the report.
      version: match?.[1] ?? row.filename,
      name: match?.[2] ?? row.filename,
      checksum: row.checksum,
      kind: "file" as const,
      historyId: at + 1,
      file: row.filename
    };
  });
  const stateId = createHash("sha256")
    .update(JSON.stringify({ ledger: label, rows: sorted.map((r) => [r.filename, r.checksum]) }))
    .digest("hex")
    .slice(0, 24);
  return { applied, unadoptedInline: [], maxId: rows.length, stateId };
}

function externalLedger(table: QualifiedName): DdlLedger {
  const label = `${table.schema}.${table.name}`;
  const quoted = quoteQualified(table);

  const columns = async (db: Queryable): Promise<string[] | undefined> => {
    const result = await db.query<{ present: boolean; columns: string[] | null }>(
      `select to_regclass($1) is not null as present,
              (select array_agg(attname::text) from pg_attribute
                where attrelid = to_regclass($1) and attnum > 0 and not attisdropped) as columns`,
      [quoted]
    );
    const row = result.rows[0];
    return row?.present === true ? (row.columns ?? []) : undefined;
  };

  const assertShape = (found: string[]): void => {
    const missing = ["filename", "checksum"].filter((c) => !found.includes(c));
    if (missing.length > 0) {
      throw new PolicyViolationError(
        "DDL_LEDGER_SHAPE",
        `POSTGRES_DDL_EXTERNAL_LEDGER ${label} has no ${missing.join(" or ")} column. The lane reads and writes (filename, checksum).`
      );
    }
  };

  return {
    label,
    external: true,
    format: "psql",
    async read(db) {
      const found = await columns(db);
      if (found === undefined) {
        return { state: deriveExternalState([], label), rowCount: 0, present: false };
      }
      assertShape(found);
      const rows = await db.query<{ filename: string; checksum: string }>(`select filename::text as filename, checksum::text as checksum from ${quoted}`);
      return { state: deriveExternalState(rows.rows, label), rowCount: rows.rows.length, present: true };
    },
    async prepare(db) {
      const found = await columns(db);
      if (found === undefined) {
        throw new PolicyViolationError(
          "DDL_LEDGER_MISSING",
          `The external ledger ${label} does not exist in this database. It belongs to the repo: create it with the repo's own runner (which also applies its adoption guard), then retry.`
        );
      }
      assertShape(found);
    },
    async recordApplied(db, row, file) {
      if (file === null) {
        // Unreachable: the planner refuses inline mode with an external ledger.
        throw new PolicyViolationError("DDL_INLINE_UNSUPPORTED", "An external ledger records files only.");
      }
      await db.query(`insert into ${quoted} (filename, checksum) values ($1, $2)`, [file, row.checksum]);
      return undefined;
    },
    // The repo's ledger has no notion of a failed attempt, and a row in it means "applied". The
    // failure is still on record in the server's audit log.
    async recordFailure() {
      return undefined;
    }
  };
}

export function ledgerFor(config: DdlConfig): DdlLedger {
  return config.externalLedger === undefined ? MCP_LEDGER : externalLedger(config.externalLedger);
}
