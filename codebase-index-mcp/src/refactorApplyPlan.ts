/**
 * Executing an approved apply plan: the only part of the engine that writes to disk.
 *
 * Ordering is the whole problem. Hunks are applied back-to-front within a file so earlier
 * offsets stay valid, and the per-file result records enough to reverse it - a rollback that
 * cannot reconstruct the original bytes is worse than no rollback at all.
 */

import fs from "node:fs";
import type { RefactorPreviewHunkRecord, RefactorApplyChangeRecord, RefactorApplyHunkRecord } from "./types.js";
import {
  sha256,
  safeReadText,
  assertSafeRepoFilePath,
  inferLanguageFromPath,
  findEnclosingObjectInitializer,
  isInvalidCsharpInitializerReplacement,
  isApplyRunnableHunk,
  buildFinalOffsetMap
} from "./refactorUtils.js";

export function executeRefactorApplyPlan(
  repoPath: string,
  applyId: string,
  hunks: RefactorPreviewHunkRecord[],
  maxFilesPerBatch: number,
  stopOnFirstConflict: boolean,
  includeLowConfidence: boolean,
  lowConfidenceThreshold: number,
  recentAppliedHashByFile: Map<string, string> = new Map()
): {
  changes: RefactorApplyChangeRecord[];
  appliedHunks: RefactorApplyHunkRecord[];
  lane: { highConfidenceEdits: number; lowConfidenceEdits: number; lowConfidenceSkipped: number };
} {
  const groupedByFile = new Map<string, RefactorPreviewHunkRecord[]>();
  for (const hunk of hunks) {
    const list = groupedByFile.get(hunk.filePath) ?? [];
    list.push(hunk);
    groupedByFile.set(hunk.filePath, list);
  }

  const changes: RefactorApplyChangeRecord[] = [];
  const appliedHunks: RefactorApplyHunkRecord[] = [];
  const fileEntries = [...groupedByFile.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  let stop = false;
  let highConfidenceEdits = 0;
  let lowConfidenceEdits = 0;
  let lowConfidenceSkipped = 0;

  for (let i = 0; i < fileEntries.length; i += Math.max(1, maxFilesPerBatch)) {
    if (stop) {
      break;
    }
    const chunk = fileEntries.slice(i, i + Math.max(1, maxFilesPerBatch));
    for (const [filePath, allHunks] of chunk) {
      if (stop) {
        break;
      }

      const absolute = assertSafeRepoFilePath(repoPath, filePath);
      const beforeContent = safeReadText(absolute);
      const beforeHash = sha256(beforeContent);

      const blockedHunks = allHunks.filter((h) => h.riskFlags.length > 0);
      const lowConfidenceHunks = allHunks.filter((h) => h.riskFlags.length === 0 && h.confidence < lowConfidenceThreshold);
      lowConfidenceSkipped += includeLowConfidence ? 0 : lowConfidenceHunks.length;
      const runnableHunks = allHunks.filter((h) => isApplyRunnableHunk(h, includeLowConfidence, lowConfidenceThreshold));

      if (runnableHunks.length === 0) {
        changes.push({
          applyId,
          filePath,
          replacementCount: 0,
          status: "skipped",
          reason: blockedHunks.length > 0
            ? "RISK_FLAG_BLOCKED"
            : lowConfidenceHunks.length > 0 && !includeLowConfidence
              ? "LOW_CONFIDENCE_BLOCKED"
              : "NO_EFFECTIVE_CHANGES",
          fileHashBefore: beforeHash,
          fileHashAfter: beforeHash,
          beforeContent,
          afterContent: beforeContent
        });
        continue;
      }

      if (beforeHash !== runnableHunks[0].fileHashBefore) {
        // If the file's current content is exactly what a prior apply produced, this preview was
        // invalidated by a concurrent/overlapping apply of the same file — not an external edit.
        const staleReason =
          recentAppliedHashByFile.get(filePath) === beforeHash
            ? "FILE_CHANGED_BY_CONCURRENT_APPLY"
            : "FILE_CHANGED_AFTER_PREVIEW";
        changes.push({
          applyId,
          filePath,
          replacementCount: 0,
          status: "conflict",
          reason: staleReason,
          fileHashBefore: beforeHash,
          fileHashAfter: null,
          beforeContent,
          afterContent: null
        });
        if (stopOnFirstConflict) {
          stop = true;
        }
        continue;
      }

      const sortedHunks = [...runnableHunks].sort((a, b) => b.startOffset - a.startOffset || b.hunkId.localeCompare(a.hunkId));
      const finalOffsetByHunkId = buildFinalOffsetMap(sortedHunks);
      let updated = beforeContent;
      let appliedCount = 0;
      let fileHighConfidenceEdits = 0;
      let fileLowConfidenceEdits = 0;
      let conflictReason: string | null = null;

      for (const hunk of sortedHunks) {
        const target = updated.slice(hunk.startOffset, hunk.endOffset);
        if (target !== hunk.beforeText) {
          conflictReason = "OFFSET_MISMATCH_DURING_APPLY";
          break;
        }
        if (inferLanguageFromPath(filePath) === "csharp" && isInvalidCsharpInitializerReplacement(hunk.replacementText)) {
          const enclosingInitializer = findEnclosingObjectInitializer(updated, hunk.startOffset);
          if (enclosingInitializer && /\s*=/.test(hunk.beforeText)) {
            conflictReason = "INVALID_CSHARP_INITIALIZER_REWRITE";
            break;
          }
        }
        updated = `${updated.slice(0, hunk.startOffset)}${hunk.replacementText}${updated.slice(hunk.endOffset)}`;
        appliedCount += 1;
        if (hunk.confidence < lowConfidenceThreshold) {
          fileLowConfidenceEdits += 1;
        } else {
          fileHighConfidenceEdits += 1;
        }
      }

      if (conflictReason) {
        changes.push({
          applyId,
          filePath,
          replacementCount: 0,
          status: "conflict",
          reason: conflictReason,
          fileHashBefore: beforeHash,
          fileHashAfter: null,
          beforeContent,
          afterContent: null
        });
        if (stopOnFirstConflict) {
          stop = true;
        }
        continue;
      }

      if (appliedCount > 0) {
        fs.writeFileSync(absolute, updated, "utf8");
        for (const hunk of sortedHunks) {
          const startOffsetApplied = finalOffsetByHunkId.get(hunk.hunkId);
          if (startOffsetApplied === undefined) {
            continue;
          }
          appliedHunks.push({
            applyId,
            filePath,
            hunkId: hunk.hunkId,
            startOffsetApplied,
            endOffsetApplied: startOffsetApplied + hunk.replacementText.length,
            beforeText: hunk.beforeText,
            afterText: hunk.replacementText
          });
        }
        highConfidenceEdits += fileHighConfidenceEdits;
        lowConfidenceEdits += fileLowConfidenceEdits;
        changes.push({
          applyId,
          filePath,
          replacementCount: appliedCount,
          status: "applied",
          reason: null,
          fileHashBefore: beforeHash,
          fileHashAfter: sha256(updated),
          beforeContent,
          afterContent: updated
        });
      } else {
        changes.push({
          applyId,
          filePath,
          replacementCount: 0,
          status: "skipped",
          reason: "NO_EFFECTIVE_CHANGES",
          fileHashBefore: beforeHash,
          fileHashAfter: beforeHash,
          beforeContent,
          afterContent: beforeContent
        });
      }
    }
  }

  return {
    changes,
    appliedHunks,
    lane: {
      highConfidenceEdits,
      lowConfidenceEdits,
      lowConfidenceSkipped
    }
  };
}
