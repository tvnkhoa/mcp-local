/**
 * In-memory DDL previews, keyed by previewId.
 *
 * A record outlives its approval token's TTL. `ddl_apply` verifies the token with
 * `ignoreExpiry`, because for a schema change the real staleness check is re-planning against the
 * live database at apply time. The record's own lifetime (`POSTGRES_DDL_PREVIEW_TTL_MS`) bounds how
 * long a preview can wait for a human. A restart clears every record, by design: a preview is a
 * claim about the database at one moment, and it is not worth persisting.
 */

import type { DdlPlan, PlanRequest } from "./ddlPlanner.js";

export interface DryRunStepResult {
  version: string | null;
  name: string;
  action: "apply" | "adopt" | "revert";
  status: "ok" | "failed" | "skipped" | "not_run";
  durationMs?: number;
  reason?: string;
}

export interface StepError {
  code: string;
  message: string;
  version: string | null;
  name: string;
  /** 0-based within the step's script; null when the step failed outside a statement. */
  statementIndex: number | null;
  sqlState?: string;
  /** The driver's message. Kept out of `message`, where it does not belong in this server's contract. */
  detail?: string;
}

export interface DryRunResult {
  status: "ok" | "failed";
  ranAt: string;
  steps: DryRunStepResult[];
  error?: StepError;
}

export interface DdlPreviewRecord {
  previewId: string;
  environment: string;
  /** What was asked for, kept so apply can re-plan exactly the same request. */
  request: PlanRequest;
  plan: DdlPlan;
  digest: string;
  preSnapshotId: string;
  historyStateId: string;
  expiresAt: string;
  dryRun?: DryRunResult;
}

export class DdlPreviewStore {
  private readonly records = new Map<string, DdlPreviewRecord>();

  save(record: DdlPreviewRecord): void {
    const now = Date.now();
    for (const [id, existing] of this.records) {
      if (Date.parse(existing.expiresAt) < now) {
        this.records.delete(id);
      }
    }
    this.records.set(record.previewId, record);
  }

  /** The record, or undefined if unknown or past its lifetime. */
  get(previewId: string): DdlPreviewRecord | undefined {
    const record = this.records.get(previewId);
    if (record !== undefined && Date.parse(record.expiresAt) < Date.now()) {
      this.records.delete(previewId);
      return undefined;
    }
    return record;
  }

  recordDryRun(previewId: string, result: DryRunResult): void {
    const record = this.records.get(previewId);
    if (record !== undefined) {
      record.dryRun = result;
    }
  }

  /** Remove the record once an apply has run, whatever its outcome: the ledger has moved on. */
  consume(previewId: string): void {
    this.records.delete(previewId);
  }
}
