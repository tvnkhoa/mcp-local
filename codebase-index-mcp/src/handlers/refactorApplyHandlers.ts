/**
 * `refactor_replace_apply` and `refactor_replace_rollback` - the two handlers that mutate.
 *
 * Both verify an HMAC approval token before doing anything, and the digest check makes an
 * apply fail closed if the working tree moved since the preview was built.
 */

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import * as fs from "node:fs";
import {
  resolveApprovalSecret,
  PolicyViolationError,
  collectExpectedApplyFiles,
  verifyApprovalToken,
  noLlmAudit,
  assertSafeRepoFilePath,
  safeReadText
} from "../refactorUtils.js";
import type { RefactorApplyHunkRecord, RefactorRollbackRecord } from "../types.js";
import { resolveResponseProfile } from "../response/responseFormatter.js";
import type { HandlerContext } from "./handlerContext.js";
import { applyPreviewExclusively } from "./refactorApplyGate.js";

export async function handleRefactorReplaceApply(
  args: {
    previewId: string;
    approvalToken: string;
    maxFilesPerBatch: number;
    stopOnFirstConflict: boolean;
    includeLowConfidence: boolean;
    profile?: string;
  },
  ctx: HandlerContext
): Promise<CallToolResult> {
  const { store, constants } = ctx;
  const profile = resolveResponseProfile((args.profile ?? "standard") as Parameters<typeof resolveResponseProfile>[0]);
  const preview = store.getRefactorPreview(args.previewId);
  if (!preview) {
    throw new McpError(ErrorCode.InvalidParams, `refactor_replace_apply: preview '${args.previewId}' not found.`);
  }
  if (Date.parse(preview.preview.expiresAt) < Date.now()) {
    throw new PolicyViolationError("PREVIEW_EXPIRED", "refactor_replace_apply: preview expired. Create a fresh preview before apply.");
  }
  const ambiguousRatio = preview.preview.totalMatches > 0 ? (preview.preview.riskAmbiguousCount / preview.preview.totalMatches) * 100 : 0;
  if (ambiguousRatio > preview.preview.ambiguityThresholdPercent) {
    throw new PolicyViolationError("AMBIGUITY_THRESHOLD_EXCEEDED", `refactor_replace_apply: ambiguous ratio ${ambiguousRatio.toFixed(2)}% exceeds threshold ${preview.preview.ambiguityThresholdPercent}%.`);
  }
  verifyApprovalToken(args.approvalToken, preview.preview.previewId, preview.preview.digest, preview.preview.expiresAt, resolveApprovalSecret(constants.REFACTOR_APPROVAL_SECRET, constants.REFACTOR_STRICT_APPROVAL));

  const repo = store.getRepository(preview.preview.repoId);
  if (!repo) {
    throw new McpError(ErrorCode.InvalidParams, `refactor_replace_apply: repo '${preview.preview.repoId}' not found.`);
  }

  const expectedApplyFiles = collectExpectedApplyFiles(preview.hunks, args.includeLowConfidence, constants.REFACTOR_LOW_CONFIDENCE_THRESHOLD);
  // Run the read-modify-write AND its persistence under one mutex so a following apply both sees the
  // committed change and detects it (FILE_CHANGED_BY_CONCURRENT_APPLY) instead of interleaving.
  const { applyId, rollbackId, applyOutcome, applyRecord, beforeChangedFiles, afterChangedFiles } = await applyPreviewExclusively(
    store, repo.repoPath, preview.preview.repoId, preview.preview.previewId, preview.hunks, expectedApplyFiles,
    { maxFilesPerBatch: args.maxFilesPerBatch, stopOnFirstConflict: args.stopOnFirstConflict, includeLowConfidence: args.includeLowConfidence, lowConfidenceThreshold: constants.REFACTOR_LOW_CONFIDENCE_THRESHOLD }
  );
  const newlyChangedFiles = [...afterChangedFiles].filter((x) => !beforeChangedFiles.has(x));
  const unexpectedChangedFiles = newlyChangedFiles.filter((x) => !expectedApplyFiles.has(x));
  const scopeDriftPercent = expectedApplyFiles.size > 0 ? (unexpectedChangedFiles.length / expectedApplyFiles.size) * 100 : 0;
  const scopeDriftDetected = scopeDriftPercent > 5;

  const changes = applyOutcome.changes;
  const appliedFiles = changes.filter((x) => x.status === "applied");
  const conflicted = changes.filter((x) => x.status === "conflict");
  const totalReplacements = appliedFiles.reduce((sum, item) => sum + item.replacementCount, 0);
  const applyStatus = applyRecord.status;

  const diagnostics = { code: scopeDriftDetected ? "SCOPE_DRIFT_DETECTED" : applyStatus !== "applied" ? "APPLY_PARTIAL_OR_CONFLICT" : "APPLY_OK", machineReadable: true };
  const executionPolicy = noLlmAudit(constants.REFACTOR_STRICT_APPROVAL);

  // nano: just the outcome summary — fastest confirmation that apply worked
  if (profile === "nano") {
    return ctx.asText({ applyId, rollbackId, filesChanged: appliedFiles.length, totalHunksApplied: totalReplacements, success: applyStatus === "applied", diagnostics }, profile);
  }

  // compact: no scopeCheck.expectedFiles (can be hundreds of entries)
  if (profile === "compact") {
    return ctx.asText({
      applyId, rollbackId,
      appliedFiles: appliedFiles.map((x) => x.filePath),
      appliedReplacementsCount: totalReplacements,
      skippedReplacements: changes.filter((x) => x.status !== "applied").map((x) => ({ filePath: x.filePath, status: x.status, reason: x.reason })),
      patchSummary: appliedFiles.map((x) => ({ filePath: x.filePath, replacementCount: x.replacementCount })),
      scopeCheck: { driftPercent: Number(scopeDriftPercent.toFixed(2)), driftThresholdPercent: 5, unexpectedFiles: unexpectedChangedFiles.sort((a, b) => a.localeCompare(b)) },
      diagnostics, executionPolicy
    }, profile);
  }

  return ctx.asText({
    applyId, rollbackId,
    appliedFiles: appliedFiles.map((x) => x.filePath),
    appliedReplacementsCount: totalReplacements,
    skippedReplacements: changes.filter((x) => x.status !== "applied").map((x) => ({ filePath: x.filePath, status: x.status, reason: x.reason })),
    laneBreakdown: {
      highConfidenceEdits: applyOutcome.lane.highConfidenceEdits, lowConfidenceEdits: applyOutcome.lane.lowConfidenceEdits,
      lowConfidenceSkipped: applyOutcome.lane.lowConfidenceSkipped, lowConfidenceThreshold: constants.REFACTOR_LOW_CONFIDENCE_THRESHOLD,
      includeLowConfidence: args.includeLowConfidence
    },
    scopeCheck: {
      expectedFiles: [...expectedApplyFiles].sort((a, b) => a.localeCompare(b)),
      newlyChangedFiles: newlyChangedFiles.sort((a, b) => a.localeCompare(b)),
      unexpectedFiles: unexpectedChangedFiles.sort((a, b) => a.localeCompare(b)),
      driftPercent: Number(scopeDriftPercent.toFixed(2)), driftThresholdPercent: 5
    },
    patchSummary: appliedFiles.map((x) => ({ filePath: x.filePath, replacementCount: x.replacementCount })),
    diagnostics, executionPolicy
  });
}

// ── refactor_replace_rollback ─────────────────────────────────────────────────

export function handleRefactorReplaceRollback(
  args: { rollbackId: string },
  ctx: HandlerContext
): CallToolResult {
  const { store, constants } = ctx;
  const payload = store.getApplyByRollbackId(args.rollbackId);
  if (!payload) {
    throw new McpError(ErrorCode.InvalidParams, `refactor_replace_rollback: rollbackId '${args.rollbackId}' not found.`);
  }
  const repo = store.getRepository(payload.apply.repoId);
  if (!repo) {
    throw new McpError(ErrorCode.InvalidParams, `refactor_replace_rollback: repo '${payload.apply.repoId}' not found.`);
  }

  let restored = 0;
  let conflicts = 0;
  const touchedFiles = new Set<string>();

  if (payload.hunks.length > 0) {
    const hunkByFile = new Map<string, RefactorApplyHunkRecord[]>();
    for (const hunk of payload.hunks) {
      const list = hunkByFile.get(hunk.filePath) ?? [];
      list.push(hunk);
      hunkByFile.set(hunk.filePath, list);
    }
    for (const [filePath, hunks] of hunkByFile.entries()) {
      const absolute = assertSafeRepoFilePath(repo.repoPath, filePath);
      if (!fs.existsSync(absolute)) { conflicts += 1; continue; }
      let content = safeReadText(absolute);
      let fileRestoredSegments = 0;
      try {
        for (const hunk of [...hunks].sort((a, b) => b.startOffsetApplied - a.startOffsetApplied || b.hunkId.localeCompare(a.hunkId))) {
          const expectedCurrent = content.slice(hunk.startOffsetApplied, hunk.endOffsetApplied);
          if (expectedCurrent !== hunk.afterText) { conflicts += 1; continue; }
          content = `${content.slice(0, hunk.startOffsetApplied)}${hunk.beforeText}${content.slice(hunk.endOffsetApplied)}`;
          fileRestoredSegments += 1;
        }
        if (fileRestoredSegments > 0) { fs.writeFileSync(absolute, content, "utf8"); touchedFiles.add(filePath); }
      } catch { conflicts += 1; }
    }
  } else {
    for (const change of payload.changes) {
      if (change.status !== "applied") continue;
      if (change.beforeContent == null) { conflicts += 1; continue; }
      const absolute = assertSafeRepoFilePath(repo.repoPath, change.filePath);
      if (!fs.existsSync(absolute)) { conflicts += 1; continue; }
      try { fs.writeFileSync(absolute, change.beforeContent, "utf8"); touchedFiles.add(change.filePath); }
      catch { conflicts += 1; }
    }
  }

  restored = touchedFiles.size;
  const status: RefactorRollbackRecord["status"] = conflicts > 0 ? (restored > 0 ? "partial" : "failed") : "restored";
  store.recordRefactorRollback({ rollbackId: args.rollbackId, applyId: payload.apply.applyId, status, createdAt: new Date().toISOString(), completedAt: new Date().toISOString(), restoredFiles: restored, conflictCount: conflicts });
  if (status === "restored") store.markRefactorPreviewStatus(payload.apply.previewId, "rolled_back");

  return ctx.asText({
    rollbackId: args.rollbackId,
    restoredFilesCount: restored,
    conflicts,
    diagnostics: { code: conflicts > 0 ? "ROLLBACK_PARTIAL" : "ROLLBACK_OK", machineReadable: true },
    executionPolicy: noLlmAudit(constants.REFACTOR_STRICT_APPROVAL)
  });
}

// ── refactor_symbol_migration ─────────────────────────────────────────────────
