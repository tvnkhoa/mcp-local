/**
 * The apply mutex.
 *
 * Two concurrent applies against one preview could both pass the digest check and then write
 * interleaved bytes, so every apply path serializes through here. Its own file because it is a
 * correctness gate shared by three handlers, not a helper of any one of them.
 */

import { randomUUID } from "node:crypto";
import { executeRefactorApplyPlan } from "../refactorEngine.js";
import { deriveApplyStatus, mapPreviewStatusFromApplyStatus } from "../refactorUtils.js";
import type { RefactorPreviewHunkRecord, RefactorApplyRecord } from "../types.js";
import { collectGitChangedFiles } from "../gitHelpers.js";
import type { HandlerContext } from "./handlerContext.js";

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
  opts: { maxFilesPerBatch: number; stopOnFirstConflict: boolean; includeLowConfidence: boolean; lowConfidenceThreshold: number }
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
      totalFiles: appliedFiles.length, totalReplacements: appliedFiles.reduce((sum, item) => sum + item.replacementCount, 0), conflictCount
    };
    store.recordRefactorApply(applyRecord, applyOutcome.changes, applyOutcome.appliedHunks);
    store.markRefactorPreviewStatus(previewId, mapPreviewStatusFromApplyStatus(applyRecord.status));
    return { applyId, rollbackId, applyOutcome, applyRecord, beforeChangedFiles, afterChangedFiles };
  });
}

// ── rename_assist ─────────────────────────────────────────────────────────────
