import type { WriteStatementType, WriteTarget } from "../../middleware/writeGuardrails.js";

export interface WritePreviewRecord {
  previewId: string;
  environment: string;
  sql: string;
  params: unknown[];
  statementType: WriteStatementType;
  target: WriteTarget;
  digest: string;
  rowsAffected: number;
  sampleBefore: unknown[];
  pkColumns: string[];
  rollbackSupported: boolean;
  createdAt: number;
  expiresAt: string;
  status: "ready" | "applied" | "expired";
}

/** One row of undo data, plus what rollback needs to apply it exactly once. */
export interface CapturedRow {
  /** UPDATE/DELETE: the column values before the change. INSERT: the row as inserted. */
  values: Record<string, unknown>;
  /**
   * The row's MVCC version (`xmin`) as it stood *after* the apply committed, or null
   * when there is no row left to version (DELETE). Restore matches on it, so a row
   * somebody else changed in between is reported instead of silently clobbered.
   */
  xmin: string | null;
  /**
   * Set once this row has been restored. A partially-successful rollback stays
   * retryable, and the retry attempts only the rows still outstanding.
   */
  restored: boolean;
}

export interface WriteApplyRecord {
  rollbackId: string;
  applyId: string;
  previewId: string;
  environment: string;
  statementType: WriteStatementType;
  target: WriteTarget;
  pkColumns: string[];
  capturedRows: CapturedRow[];
  rowsAffected: number;
  appliedAt: number;
  rolledBack: boolean;
}

/**
 * Ephemeral in-memory store for the write review flow. Previews live only for their
 * short TTL (default 15 min) so a process restart simply invalidates pending plans —
 * deliberately avoids a native SQLite dependency. The durable audit trail lives in
 * the target Postgres (see auditLog.ts).
 */
/**
 * Backstop cap on retained rollback records so a long-lived process doing many writes
 * cannot grow the apply history (which holds full captured-row snapshots) without
 * bound. Oldest records are evicted first; rollback of an evicted apply reports
 * ROLLBACK_NOT_FOUND, same as after a restart.
 */
const MAX_APPLIES = 1000;

/**
 * Cap on the rows one apply may capture. `MAX_APPLIES` bounds how many rollback
 * records are retained; this bounds how large a single one can get, which is the other
 * half of the same problem — one DELETE across a large table would otherwise pull the
 * whole thing into memory. `write_preview` knows the exact row count from its dry run,
 * so a statement over the cap is refused rollback up front rather than discovered here.
 */
export const MAX_ROLLBACK_ROWS = 10_000;

export class WritePreviewStore {
  private readonly previews = new Map<string, WritePreviewRecord>();
  private readonly applies = new Map<string, WriteApplyRecord>();

  savePreview(record: WritePreviewRecord): void {
    this.cleanup();
    this.previews.set(record.previewId, record);
  }

  getPreview(previewId: string): WritePreviewRecord | undefined {
    const rec = this.previews.get(previewId);
    if (!rec) {
      return undefined;
    }
    if (Date.parse(rec.expiresAt) < Date.now()) {
      rec.status = "expired";
    }
    return rec;
  }

  markApplied(previewId: string): void {
    const rec = this.previews.get(previewId);
    if (rec) {
      rec.status = "applied";
    }
  }

  saveApply(record: WriteApplyRecord): void {
    this.applies.set(record.rollbackId, record);
    // FIFO eviction: Map preserves insertion order, so the first key is the oldest.
    while (this.applies.size > MAX_APPLIES) {
      const oldest = this.applies.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.applies.delete(oldest);
    }
  }

  getApply(rollbackId: string): WriteApplyRecord | undefined {
    return this.applies.get(rollbackId);
  }

  private cleanup(): void {
    const now = Date.now();
    // Drop any expired preview — including ones already applied. Once past its TTL the
    // "already applied" distinction is moot, so keeping it only leaks memory.
    for (const [id, rec] of this.previews) {
      if (Date.parse(rec.expiresAt) < now) {
        this.previews.delete(id);
      }
    }
  }
}
