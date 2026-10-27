/**
 * The apply mutex.
 *
 * Two concurrent applies against one preview could both pass the digest check and then write
 * interleaved bytes, so every apply path serializes through here. Its own file because it is a
 * correctness gate shared by three handlers, not a helper of any one of them.
 */

import { randomUUID } from "node:crypto";
import { executeRefactorApplyPlan } from "../../services/refactor/refactorEngine.js";
import { PolicyViolationError, deriveApplyStatus, mapPreviewStatusFromApplyStatus } from "../../services/refactor/refactorUtils.js";
import type { RefactorPreviewHunkRecord, RefactorApplyRecord, RefactorPreviewRecord } from "../../types/index.js";
import { collectGitChangedFiles } from "../../services/git/gitHelpers.js";
import type { HandlerContext } from "./handlerContext.js";

/**
 * R4: one served process, many clients. A preview belongs to the client that created it — stamp it
 * with {@link previewOwnerOf} when saving, check it with this before applying. A preview with no
 * owner (written before R4, or on stdio when the parent process is unresolvable) stays appliable by
 * anyone, as it always was.
 *
 * MCP-ISSUE-108: the owner is the client *process* when it resolves, so a client that re-initializes a
 * new session after a server restart keeps its previews; otherwise it is the session id, which a
 * restart does not keep (fail closed). A row stamped with a session id (before 108) still matches it.
 */
export function assertPreviewOwner(preview: RefactorPreviewRecord, ctx: HandlerContext, toolName: string): void {
  if (!ownedByCaller(preview.clientSession ?? null, ctx)) {
    throw new PolicyViolationError(
      "PREVIEW_OWNED_BY_ANOTHER_SESSION",
      `${toolName}: preview '${preview.previewId}' was created by another client session; only that session may apply it. Create your own preview.`
    );
  }
}

/** The same rule for refactor_replace_rollback: only the session that applied may undo it. */
export function assertApplyOwner(apply: RefactorApplyRecord, ctx: HandlerContext, toolName: string): void {
  if (!ownedByCaller(apply.clientSession ?? null, ctx)) {
    throw new PolicyViolationError(
      "APPLY_OWNED_BY_ANOTHER_SESSION",
      `${toolName}: rollback '${apply.rollbackId}' undoes an apply made by another client session; only that session may roll it back.`
    );
  }
}

/**
 * MCP-ISSUE-108: the tools that stamp or check an owner, and so the only ones that wait for the client identity
 * (a netstat + PowerShell lookup at a session's start, seconds in the worst case). A tool missing here would
 * stamp the session id instead: stricter, never looser.
 */
export const OWNERSHIP_TOOLS: ReadonlySet<string> = new Set([
  "rename_assist",
  "refactor_replace_preview",
  "refactor_replace_apply",
  "refactor_replace_rollback",
  "refactor_symbol_migration",
  "change_value_representation"
]);

export function previewOwnerOf(ctx: HandlerContext): string | null {
  return ctx.clientIdentity ?? ctx.clientSessionId ?? null;
}

function ownedByCaller(owner: string | null, ctx: HandlerContext): boolean {
  return owner === null || owner === ctx.clientIdentity || owner === ctx.clientSessionId;
}

// Serializes the read-modify-write phase of refactor applies. Two concurrent applies that touch the
// same file would otherwise interleave: the first write shifts offsets / changes the file hash, so
// the second sees a stale preview and fails. Serializing makes the ordering deterministic (and lets
// the second apply report FILE_CHANGED_BY_CONCURRENT_APPLY rather than corrupting the file).
let applyMutex: Promise<unknown> = Promise.resolve();
function runExclusiveApply<T>(fn: () => T): Promise<T> {
  const run = applyMutex.then(fn, fn);
  applyMutex = run.then(() => undefined, () => undefined);
  return run;
}

type ExclusiveApplyResult = {
  applyId: string;
  rollbackId: string;
  applyOutcome: ReturnType<typeof executeRefactorApplyPlan>;
  applyRecord: RefactorApplyRecord;
  beforeChangedFiles: Set<string>;
  afterChangedFiles: Set<string>;
};

/**
 * Apply a saved preview's hunks under the shared apply mutex, recording the apply and updating the
 * preview status inside the same critical section. Centralizing the read-modify-write here means
 * every apply entry point (refactor_replace, refactor_symbol_migration, change_value_representation)
 * gets identical concurrency handling — serialized writes plus concurrent-apply detection via
 * `recentAppliedHashByFile` (it was the earlier copy-paste of this block that let symbol_migration
 * silently drift out of that guarantee).
 */
export function applyPreviewExclusively(
  store: HandlerContext["store"],
  repoPath: string,
  repoId: string,
  previewId: string,
  hunks: RefactorPreviewHunkRecord[],
  expectedApplyFiles: Set<string>,
  opts: { maxFilesPerBatch: number; stopOnFirstConflict: boolean; includeLowConfidence: boolean; lowConfidenceThreshold: number; clientSession: string | null }
): Promise<ExclusiveApplyResult> {
  return runExclusiveApply(() => {
    const applyId = `apply_${randomUUID()}`;
    const rollbackId = `rollback_${randomUUID()}`;
    const beforeChangedFiles = collectGitChangedFiles(repoPath);
    const recentAppliedHashByFile = store.getRecentAppliedFileHashes(repoId, [...expectedApplyFiles]);
    const applyOutcome = executeRefactorApplyPlan(
      repoPath, applyId, hunks,
      opts.maxFilesPerBatch, opts.stopOnFirstConflict, opts.includeLowConfidence, opts.lowConfidenceThreshold,
      recentAppliedHashByFile
    );
    const afterChangedFiles = collectGitChangedFiles(repoPath);
    const appliedFiles = applyOutcome.changes.filter((x) => x.status === "applied");
    const conflictCount = applyOutcome.changes.filter((x) => x.status === "conflict").length;
    const applyRecord: RefactorApplyRecord = {
      applyId, rollbackId, previewId, repoId,
      status: deriveApplyStatus(applyOutcome.changes), createdAt: new Date().toISOString(), completedAt: new Date().toISOString(),
      totalFiles: appliedFiles.length, totalReplacements: appliedFiles.reduce((sum, item) => sum + item.replacementCount, 0), conflictCount,
      clientSession: opts.clientSession
    };
    store.recordRefactorApply(applyRecord, applyOutcome.changes, applyOutcome.appliedHunks);
    store.markRefactorPreviewStatus(previewId, mapPreviewStatusFromApplyStatus(applyRecord.status));
    // MCP-ISSUE-042: apply does not re-index either. Here the working tree at least goes dirty, so
    // git-based staleness still reports something — but recording the files keeps the two halves of
    // the refactor lifecycle symmetric and survives a later `git stash`/commit that cleans the tree.
    store.recordPendingReindexFiles(repoId, appliedFiles.map((x) => x.filePath), "written by refactor apply");
    return { applyId, rollbackId, applyOutcome, applyRecord, beforeChangedFiles, afterChangedFiles };
  });
}

// ── rename_assist ─────────────────────────────────────────────────────────────
