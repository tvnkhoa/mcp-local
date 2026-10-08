/**
 * Previews awaiting apply, and the audit record of every apply. ADR 0006.
 *
 * Previews are held in memory only. A preview is a few kilobytes of SQL and a short TTL, and losing
 * them on restart is the safe failure: the caller re-runs the preview, which re-checks everything.
 * Together with the per-process approval secret (when none is configured) it means no token
 * outlives the process that issued it.
 */

import { appendFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";

import type { EventLogger } from "@mcp/core";

export interface WritePreview {
  readonly previewId: string;
  readonly environment: string;
  readonly database: string;
  readonly sql: string;
  readonly commitCount: number;
  readonly rowsAffected: readonly number[];
  readonly digest: string;
  readonly sqlHash: string;
  readonly expiresAt: string;
}

export function sqlHash(sql: string): string {
  return createHash("sha256").update(sql).digest("hex").slice(0, 16);
}

/**
 * What the approval token is bound to. Changing any of these — the text, the target, or what the
 * preview showed it would do — makes the token fail as `mismatch`.
 */
export function writeDigest(input: {
  environment: string;
  database: string;
  sql: string;
  rowsAffected: readonly number[];
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        environment: input.environment,
        database: input.database.toLowerCase(),
        sql: input.sql,
        rowsAffected: input.rowsAffected
      })
    )
    .digest("hex");
}

/** Bound on live previews, so a client looping on write_preview cannot grow the map without limit. */
const MAX_PREVIEWS = 200;

export class WritePreviewStore {
  private readonly previews = new Map<string, WritePreview>();

  constructor(private readonly clock: () => number = () => Date.now()) {}

  save(preview: Omit<WritePreview, "previewId">): WritePreview {
    this.sweep();
    while (this.previews.size >= MAX_PREVIEWS) {
      const oldest = this.previews.keys().next().value as string;
      this.previews.delete(oldest);
    }
    const saved = { ...preview, previewId: randomUUID() };
    this.previews.set(saved.previewId, saved);
    return saved;
  }

  get(previewId: string): WritePreview | undefined {
    return this.previews.get(previewId);
  }

  /** Previews are single-use: removed as soon as an apply starts executing. */
  take(previewId: string): void {
    this.previews.delete(previewId);
  }

  private sweep(): void {
    const now = this.clock();
    for (const [id, preview] of this.previews) {
      if (Date.parse(preview.expiresAt) < now) {
        this.previews.delete(id);
      }
    }
  }
}

export interface WriteAuditEntry {
  readonly environment: string;
  readonly database: string;
  readonly previewId: string;
  readonly sqlHash: string;
  readonly status: string;
  readonly rowsAffected: readonly number[] | null;
  readonly elapsedMs: number | null;
  readonly detail?: string;
}

/**
 * Record an apply attempt — committed or not.
 *
 * Always to the event log (stderr). Also to `SQLSERVER_WRITE_AUDIT_FILE` when set, as one JSON
 * line per apply. Never to the target database: the lane writes data, not schema, and an audit
 * table would need exactly the DDL it refuses. A failure to append to the file is logged and does
 * not undo an apply that has already committed.
 */
export async function recordWriteAudit(
  logger: EventLogger,
  auditFile: string | undefined,
  entry: WriteAuditEntry
): Promise<void> {
  const line = { ts: new Date().toISOString(), tool: "write_apply", ...entry };
  logger.info("write_audit", line);
  if (auditFile === undefined) {
    return;
  }
  try {
    await appendFile(auditFile, `${JSON.stringify(line)}\n`, "utf8");
  } catch (cause) {
    logger.error("write_audit_file_failed", {
      reason: cause instanceof Error ? cause.message : String(cause)
    });
  }
}
