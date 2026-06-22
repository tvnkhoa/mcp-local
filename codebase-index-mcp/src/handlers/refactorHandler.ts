import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import * as fs from "node:fs";
import { randomUUID } from "node:crypto";
import {
  buildRefactorPreview,
  applyCompilerAssistToPreview,
  buildSymbolMigrationPreview,
  executeRefactorApplyPlan
} from "../refactorEngine.js";
import { buildValueRepresentationPreview, type ValueRepresentationInput } from "../valueRepresentation.js";
import {
  resolveApprovalSecret,
  PolicyViolationError,
  collectExpectedApplyFiles,
  countPreviewRisks,
  createPreviewDigest,
  issueApprovalToken,
  verifyApprovalToken,
  groupPreviewHunks,
  noLlmAudit,
  deriveApplyStatus,
  mapPreviewStatusFromApplyStatus,
  assertSafeRepoFilePath,
  safeReadText,
  escapeRegExp
} from "../refactorUtils.js";
import type {
  RefactorScopeInput,
  RefactorGuardsInput,
  RefactorModeInput,
  RefactorCompilerAssistInput,
  RefactorSymbolMigrationInput
} from "../refactorTypes.js";
import type {
  RefactorPreviewRecord,
  RefactorPreviewHunkRecord,
  RefactorApplyRecord,
  RefactorApplyHunkRecord,
  RefactorRollbackRecord
} from "../types.js";
import { collectGitChangedFiles } from "../gitHelpers.js";
import { resolveResponseProfile } from "../responseFormatter.js";
import { buildCoverageBlock } from "../coverage.js";
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
function applyPreviewExclusively(
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

export function handleRenameAssist(
  args: { repoId: string; symbolId: string; newName: string; limit: number; emitPreview?: boolean; wholeWord?: boolean; profile: string },
  ctx: HandlerContext
): CallToolResult {
  const { store } = ctx;
  const profile = resolveResponseProfile(args.profile as Parameters<typeof resolveResponseProfile>[0]);
  const result = store.getRenameImpact(args.repoId, args.symbolId, args.limit);
  if (!result.symbol) {
    throw new McpError(ErrorCode.InvalidParams, `rename_assist: symbol '${args.symbolId}' not found in repo '${args.repoId}'.`);
  }
  const affectedFiles = [...new Set([...result.callers.map((c) => c.fromFilePath).filter(Boolean), ...result.importers.map((i) => i.fromFilePath).filter(Boolean)])] as string[];

  // emitPreview: turn the advisory rename into an applyable refactor preview (previewId + approvalToken)
  // scoped to the symbol's own file + affected files, matching the identifier on word boundaries.
  if (args.emitPreview) {
    const repo = store.getRepository(args.repoId);
    if (!repo) throw new McpError(ErrorCode.InvalidParams, `rename_assist: unknown repoId '${args.repoId}'. Run index_repository first.`);
    const wholeWord = args.wholeWord !== false;
    const includePaths = [...new Set([result.symbol.filePath, ...affectedFiles])];
    return createReplacePreview(
      ctx,
      repo.repoPath,
      {
        repoId: args.repoId,
        find: wholeWord ? `\\b${escapeRegExp(result.symbol.name)}\\b` : result.symbol.name,
        // escape `$` so an identifier with `$` isn't mistaken for a regex replacement token
        replaceExpression: args.newName.replace(/\$/g, "$$$$"),
        findMode: wholeWord ? "regex" : "literal",
        scope: { includePaths, excludePaths: [], fileGlobs: [] },
        guards: { symbolKinds: [], allowOwnerTypes: [], disallowOwnerTypes: [], disallowTypeList: [] },
        mode: "text",
        ambiguityThresholdPercent: 100
      },
      profile
    );
  }

  const hints = affectedFiles.map((fp) => `In ${fp}: rename '${result.symbol!.name}' → '${args.newName}'`);
  if (profile === "nano") {
    return ctx.asText({ oldName: result.symbol.name, newName: args.newName, symbolId: args.symbolId, affectedFileCount: result.affectedFileCount, affectedFiles }, profile);
  }
  return ctx.asText({
    symbol: { symbolId: result.symbol.symbolId, name: result.symbol.name, kind: result.symbol.kind, filePath: result.symbol.filePath, line: result.symbol.line },
    newName: args.newName,
    affectedFileCount: result.affectedFileCount,
    affectedFiles,
    callerCount: result.callers.length,
    importerCount: result.importers.length,
    callers: profile === "verbose" ? result.callers : result.callers.map((c) => ({ fromId: c.fromId, fromName: c.fromName, fromFilePath: c.fromFilePath, confidence: c.confidence ?? null })),
    importers: profile === "verbose" ? result.importers : result.importers.map((i) => ({ fromId: i.fromId, fromName: i.fromName, fromFilePath: i.fromFilePath, confidence: i.confidence ?? null })),
    hints
  }, profile);
}

// ── refactor_replace_preview ──────────────────────────────────────────────────

type CreateReplacePreviewArgs = {
  repoId: string;
  find: string;
  replaceExpression: string;
  findMode: "literal" | "regex";
  regexFlags?: string;
  scope: RefactorScopeInput;
  guards: RefactorGuardsInput;
  mode: RefactorModeInput;
  ambiguityThresholdPercent: number;
  compilerAssist?: RefactorCompilerAssistInput;
};

/** Validate a regex find pattern in the handler layer (where McpError is available) before engine use. */
function assertValidRegexMode(findMode: "literal" | "regex", find: string, regexFlags: string | undefined, tool: string): void {
  if (findMode !== "regex") return;
  try {
    new RegExp(find, `g${(regexFlags ?? "").replace(/[^ims]/g, "")}`);
  } catch (e) {
    throw new McpError(ErrorCode.InvalidParams, `${tool}: invalid regex pattern — ${(e as Error).message}`);
  }
}

export function handleRefactorReplacePreview(
  args: CreateReplacePreviewArgs & { profile?: string },
  ctx: HandlerContext
): CallToolResult {
  const { store } = ctx;
  const profile = resolveResponseProfile((args.profile ?? "standard") as Parameters<typeof resolveResponseProfile>[0]);
  const repo = store.getRepository(args.repoId);
  if (!repo) {
    throw new McpError(ErrorCode.InvalidParams, `refactor_replace_preview: repo '${args.repoId}' not found. Run index_repository first.`);
  }
  assertValidRegexMode(args.findMode, args.find, args.regexFlags, "refactor_replace_preview");
  return createReplacePreview(ctx, repo.repoPath, args, profile);
}

// Shared preview builder: buildPreview → (optional) compilerAssist → records → save → token → profile-shaped
// response. Used by refactor_replace_preview and rename_assist(emitPreview=true).
function createReplacePreview(
  ctx: HandlerContext,
  repoPath: string,
  args: CreateReplacePreviewArgs,
  profile: ReturnType<typeof resolveResponseProfile>
): CallToolResult {
  const { store, constants } = ctx;
  const previewResult = buildRefactorPreview(store, repoPath, args.repoId, args.find, args.replaceExpression, args.scope, args.guards, args.mode, args.findMode, args.regexFlags);
  const compilerAssistOutcome = args.compilerAssist ? applyCompilerAssistToPreview(previewResult.hunks, args.compilerAssist) : null;
  const effectiveHunks = compilerAssistOutcome?.hunks ?? previewResult.hunks;
  const effectiveAffectedFiles = [...new Set(effectiveHunks.map((x) => x.filePath))].sort((a, b) => a.localeCompare(b));

  const riskCounts = countPreviewRisks(effectiveHunks);
  const ambiguousRatio = effectiveHunks.length > 0 ? (riskCounts.ambiguous / effectiveHunks.length) * 100 : 0;
  const blockedByAmbiguity = ambiguousRatio > args.ambiguityThresholdPercent;
  const compilerAssistNoMatch = Boolean(compilerAssistOutcome && compilerAssistOutcome.acceptedDiagnostics > 0 && compilerAssistOutcome.matchedDiagnostics === 0);

  const now = new Date();
  const expiresAt = new Date(now.getTime() + constants.REFACTOR_PREVIEW_TTL_MS).toISOString();
  const digest = createPreviewDigest(args.repoId, args.find, args.replaceExpression, effectiveHunks);
  const previewId = `preview_${randomUUID()}`;

  const previewRecord: RefactorPreviewRecord = {
    previewId, repoId: args.repoId, findPattern: args.find, replaceExpression: args.replaceExpression,
    mode: args.mode, ambiguityThresholdPercent: args.ambiguityThresholdPercent,
    createdAt: now.toISOString(), expiresAt, digest, status: "ready",
    totalMatches: effectiveHunks.length, affectedFileCount: effectiveAffectedFiles.length,
    riskAmbiguousCount: riskCounts.ambiguous, riskCrossTypeCount: riskCounts.crossType, riskGeneratedCount: riskCounts.generated
  };

  const hunkRecords: RefactorPreviewHunkRecord[] = effectiveHunks.map((hunk, index) => ({
    previewId, hunkId: `${previewId}_${String(index + 1).padStart(6, "0")}`,
    filePath: hunk.filePath, line: hunk.line, startOffset: hunk.startOffset, endOffset: hunk.endOffset,
    beforeText: hunk.beforeText, afterText: hunk.afterText, replacementText: hunk.afterText,
    ownerType: hunk.ownerType, symbolKind: hunk.symbolKind, confidence: hunk.confidence,
    riskFlags: hunk.riskFlags, fileHashBefore: hunk.fileHashBefore
  }));

  store.saveRefactorPreview(previewRecord, hunkRecords);
  const approvalToken = issueApprovalToken(previewId, digest, expiresAt, resolveApprovalSecret(constants.REFACTOR_APPROVAL_SECRET, constants.REFACTOR_STRICT_APPROVAL));

  const unsubstitutedBackreferences = effectiveHunks.filter((h) => h.riskFlags.includes("unsubstituted_backreference")).length;
  const riskFlags = { ambiguousTargets: riskCounts.ambiguous, crossTypeReplacements: riskCounts.crossType, generatedFiles: riskCounts.generated, unsubstitutedBackreferences };
  const diagnostics = { code: unsubstitutedBackreferences > 0 ? "PREVIEW_HAS_UNSUBSTITUTED_BACKREFERENCE" : blockedByAmbiguity ? "PREVIEW_BLOCKED_BY_AMBIGUITY" : compilerAssistNoMatch ? "PREVIEW_NO_DIAGNOSTIC_MATCH" : "PREVIEW_READY", machineReadable: true };
  const executionPolicy = noLlmAudit(constants.REFACTOR_STRICT_APPROVAL);

  const ambiguity = { ratioPercent: Number(ambiguousRatio.toFixed(2)), thresholdPercent: args.ambiguityThresholdPercent, blockedByPolicy: blockedByAmbiguity };

  // nano: summary only — no hunk content (best for checking blast radius before requesting detail)
  if (profile === "nano") {
    return ctx.asText({ previewId, approvalToken, totalMatches: effectiveHunks.length, affectedFileCount: effectiveAffectedFiles.length, affectedFiles: effectiveAffectedFiles, riskFlags, ambiguity, diagnostics, executionPolicy, expiresAt }, profile);
  }

  // compact: hunks without before/after text (saves 50-80% tokens on large refactors)
  if (profile === "compact") {
    const byFile = new Map<string, typeof hunkRecords>();
    for (const h of hunkRecords) { const list = byFile.get(h.filePath) ?? []; list.push(h); byFile.set(h.filePath, list); }
    const compactHunks = [...byFile.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([filePath, items]) => ({
      filePath, hunkCount: items.length,
      hunks: items.map((h) => ({ hunkId: h.hunkId, line: h.line, replacementText: h.replacementText, symbolKind: h.symbolKind, confidence: h.confidence, riskFlags: h.riskFlags }))
    }));
    return ctx.asText({ previewId, mode: args.mode, totalMatches: effectiveHunks.length, affectedFiles: effectiveAffectedFiles, groupedPreviewHunks: compactHunks, riskFlags, ambiguity, diagnostics, executionPolicy, approvalToken, expiresAt }, profile);
  }

  return ctx.asText({
    previewId, mode: args.mode, totalMatches: effectiveHunks.length, affectedFiles: effectiveAffectedFiles,
    groupedPreviewHunks: groupPreviewHunks(hunkRecords),
    riskFlags,
    compilerAssist: compilerAssistOutcome
      ? { enabled: true, totalDiagnostics: compilerAssistOutcome.totalDiagnostics, acceptedDiagnostics: compilerAssistOutcome.acceptedDiagnostics, matchedDiagnostics: compilerAssistOutcome.matchedDiagnostics, filteredOutHunks: compilerAssistOutcome.filteredOutHunks, lineWindow: compilerAssistOutcome.lineWindow, codes: compilerAssistOutcome.codes }
      : { enabled: false },
    ambiguity, diagnostics, executionPolicy, approvalToken, expiresAt
  });
}

// ── refactor_replace_apply ────────────────────────────────────────────────────

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

export async function handleRefactorSymbolMigration(
  args: {
    repoId: string;
    migrations: RefactorSymbolMigrationInput[];
    scopePaths?: string[];
    dryRun: boolean;
  },
  ctx: HandlerContext
): Promise<CallToolResult> {
  const { store, constants } = ctx;
  const repo = store.getRepository(args.repoId);
  if (!repo) {
    throw new McpError(ErrorCode.InvalidParams, `refactor_symbol_migration: repo '${args.repoId}' not found.`);
  }

  const migrationResults: Array<{
    fromSymbol: string; toSymbol: string; requiredOwnerType: string;
    previewId: string; totalMatches: number; unresolvedOccurrences: number;
    previewSummary: ReturnType<typeof groupPreviewHunks>;
    applyId?: string; rollbackId?: string;
  }> = [];
  const suggestedFollowUpFiles = new Set<string>();

  for (const migration of args.migrations) {
    const previewResult = buildSymbolMigrationPreview(store, repo.repoPath, args.repoId, migration, args.scopePaths ?? []);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + constants.REFACTOR_PREVIEW_TTL_MS).toISOString();
    const digest = createPreviewDigest(args.repoId, migration.fromSymbol, migration.toSymbol, previewResult.hunks);
    const previewId = `preview_${randomUUID()}`;
    const riskCounts = countPreviewRisks(previewResult.hunks);

    const hunkRecords: RefactorPreviewHunkRecord[] = previewResult.hunks.map((hunk, index) => ({
      previewId, hunkId: `${previewId}_${String(index + 1).padStart(6, "0")}`,
      filePath: hunk.filePath, line: hunk.line, startOffset: hunk.startOffset, endOffset: hunk.endOffset,
      beforeText: hunk.beforeText, afterText: hunk.afterText, replacementText: hunk.afterText,
      ownerType: hunk.ownerType, symbolKind: hunk.symbolKind, confidence: hunk.confidence,
      riskFlags: hunk.riskFlags, fileHashBefore: hunk.fileHashBefore
    }));

    const previewRecord: RefactorPreviewRecord = {
      previewId, repoId: args.repoId, findPattern: migration.fromSymbol, replaceExpression: migration.toSymbol,
      mode: "symbol-aware", ambiguityThresholdPercent: 1, createdAt: now.toISOString(), expiresAt, digest, status: "ready",
      totalMatches: previewResult.hunks.length, affectedFileCount: previewResult.affectedFiles.length,
      riskAmbiguousCount: riskCounts.ambiguous, riskCrossTypeCount: riskCounts.crossType, riskGeneratedCount: riskCounts.generated
    };
    store.saveRefactorPreview(previewRecord, hunkRecords);

    const resultRow: typeof migrationResults[number] = {
      fromSymbol: migration.fromSymbol, toSymbol: migration.toSymbol, requiredOwnerType: migration.requiredOwnerType,
      previewId, totalMatches: hunkRecords.length,
      unresolvedOccurrences: hunkRecords.filter((x) => x.riskFlags.includes("ambiguous_target")).length,
      previewSummary: groupPreviewHunks(hunkRecords)
    };
    for (const hunk of hunkRecords) suggestedFollowUpFiles.add(hunk.filePath);

    if (!args.dryRun) {
      const expectedApplyFiles = collectExpectedApplyFiles(hunkRecords, false, constants.REFACTOR_LOW_CONFIDENCE_THRESHOLD);
      const applied = await applyPreviewExclusively(
        store, repo.repoPath, args.repoId, previewId, hunkRecords, expectedApplyFiles,
        { maxFilesPerBatch: 50, stopOnFirstConflict: true, includeLowConfidence: false, lowConfidenceThreshold: constants.REFACTOR_LOW_CONFIDENCE_THRESHOLD }
      );
      resultRow.applyId = applied.applyId;
      resultRow.rollbackId = applied.rollbackId;
    }
    migrationResults.push(resultRow);
  }

  return ctx.asText({
    repoId: args.repoId, dryRun: args.dryRun, migrationMap: migrationResults,
    exactSymbolOccurrencesChanged: migrationResults.reduce((sum, x) => sum + x.totalMatches, 0),
    unresolvedOccurrences: migrationResults.reduce((sum, x) => sum + x.unresolvedOccurrences, 0),
    suggestedFollowUpFiles: [...suggestedFollowUpFiles].sort((a, b) => a.localeCompare(b)),
    executionPolicy: noLlmAudit(constants.REFACTOR_STRICT_APPROVAL)
  });
}

// ── change_value_representation ─────────────────────────────────────────────────

/**
 * ENH-029-A — promote a property's literal values to enum members across assignments, object
 * initializers, equality comparisons, and assertion arguments. Sites are located via the C# AST
 * (no user-authored backreference, so it sidesteps the MCP-ISSUE-029 capture-group failure mode)
 * and rewritten through the existing preview → apply → rollback pipeline.
 */
export async function handleChangeValueRepresentation(
  args: {
    repoId: string;
    property: string;
    requiredOwnerType: string;
    valueMap: Record<string, string>;
    includeComparisons?: boolean;
    scopePaths?: string[];
    dryRun: boolean;
    profile?: string;
  },
  ctx: HandlerContext
): Promise<CallToolResult> {
  const { store, constants } = ctx;
  const profile = resolveResponseProfile((args.profile ?? "standard") as Parameters<typeof resolveResponseProfile>[0]);
  const repo = store.getRepository(args.repoId);
  if (!repo) {
    throw new McpError(ErrorCode.InvalidParams, `change_value_representation: repo '${args.repoId}' not found.`);
  }

  const input: ValueRepresentationInput = {
    property: args.property,
    requiredOwnerType: args.requiredOwnerType,
    valueMap: args.valueMap,
    includeComparisons: args.includeComparisons
  };

  const previewResult = buildValueRepresentationPreview(store, repo.repoPath, args.repoId, input, args.scopePaths ?? []);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + constants.REFACTOR_PREVIEW_TTL_MS).toISOString();
  const findLabel = `${args.requiredOwnerType}.${args.property}`;
  const replaceLabel = Object.entries(args.valueMap).map(([k, v]) => `${k}=>${v}`).join(", ");
  const digest = createPreviewDigest(args.repoId, findLabel, replaceLabel, previewResult.hunks);
  const previewId = `preview_${randomUUID()}`;
  const riskCounts = countPreviewRisks(previewResult.hunks);

  const hunkRecords: RefactorPreviewHunkRecord[] = previewResult.hunks.map((hunk, index) => ({
    previewId, hunkId: `${previewId}_${String(index + 1).padStart(6, "0")}`,
    filePath: hunk.filePath, line: hunk.line, startOffset: hunk.startOffset, endOffset: hunk.endOffset,
    beforeText: hunk.beforeText, afterText: hunk.afterText, replacementText: hunk.afterText,
    ownerType: hunk.ownerType, symbolKind: hunk.symbolKind, confidence: hunk.confidence,
    riskFlags: hunk.riskFlags, fileHashBefore: hunk.fileHashBefore
  }));

  const previewRecord: RefactorPreviewRecord = {
    previewId, repoId: args.repoId, findPattern: findLabel, replaceExpression: replaceLabel,
    mode: "symbol-aware", ambiguityThresholdPercent: 1, createdAt: now.toISOString(), expiresAt, digest, status: "ready",
    totalMatches: hunkRecords.length, affectedFileCount: previewResult.affectedFiles.length,
    riskAmbiguousCount: riskCounts.ambiguous, riskCrossTypeCount: riskCounts.crossType, riskGeneratedCount: riskCounts.generated
  };
  store.saveRefactorPreview(previewRecord, hunkRecords);

  const result: {
    repoId: string; dryRun: boolean; property: string; requiredOwnerType: string;
    previewId: string; totalMatches: number; ambiguousOccurrences: number;
    affectedFiles: string[]; previewSummary: ReturnType<typeof groupPreviewHunks>;
    applyId?: string; rollbackId?: string; applyStatus?: string;
    executionPolicy: ReturnType<typeof noLlmAudit>;
  } = {
    repoId: args.repoId, dryRun: args.dryRun, property: args.property, requiredOwnerType: args.requiredOwnerType,
    previewId, totalMatches: hunkRecords.length,
    ambiguousOccurrences: hunkRecords.filter((x) => x.riskFlags.includes("ambiguous_target")).length,
    affectedFiles: previewResult.affectedFiles, previewSummary: groupPreviewHunks(hunkRecords),
    executionPolicy: noLlmAudit(constants.REFACTOR_STRICT_APPROVAL)
  };

  if (!args.dryRun) {
    const expectedApplyFiles = collectExpectedApplyFiles(hunkRecords, false, constants.REFACTOR_LOW_CONFIDENCE_THRESHOLD);
    const applied = await applyPreviewExclusively(
      store, repo.repoPath, args.repoId, previewId, hunkRecords, expectedApplyFiles,
      { maxFilesPerBatch: 50, stopOnFirstConflict: true, includeLowConfidence: false, lowConfidenceThreshold: constants.REFACTOR_LOW_CONFIDENCE_THRESHOLD }
    );
    result.applyId = applied.applyId;
    result.rollbackId = applied.rollbackId;
    result.applyStatus = applied.applyRecord.status;
  }

  return ctx.asText(result, profile);
}

// ── trace_execution_flow ──────────────────────────────────────────────────────

export function handleTraceExecutionFlow(
  args: { repoId: string; entrySymbolId: string; maxDepth: number; maxNodes: number; profile: string },
  ctx: HandlerContext
): CallToolResult {
  const { store } = ctx;
  const profile = resolveResponseProfile(args.profile as Parameters<typeof resolveResponseProfile>[0]);
  const result = store.traceExecutionFlow(args.repoId, args.entrySymbolId, args.maxDepth, args.maxNodes);
  if (!result.entrySymbol) {
    throw new McpError(ErrorCode.InvalidParams, `trace_execution_flow: entry symbol '${args.entrySymbolId}' not found in repo '${args.repoId}'.`);
  }
  const coverage = buildCoverageBlock({ resultCount: result.nodes.length, truncated: result.truncated, kind: "execution_flow", query: result.entrySymbol.name });
  if (profile === "nano") {
    return ctx.asText({ entrySymbol: { name: result.entrySymbol.name, filePath: result.entrySymbol.filePath }, nodeCount: result.nodes.length, edgeCount: result.edges.length, depthReached: result.depthReached, truncated: result.truncated, topCallees: result.edges.slice(0, 10).map((e) => e.toName), coverage: coverage.confidence }, profile);
  }
  if (profile === "compact") {
    return ctx.asText({
      entrySymbol: { symbolId: result.entrySymbol.symbolId, name: result.entrySymbol.name, kind: result.entrySymbol.kind, filePath: result.entrySymbol.filePath },
      nodeCount: result.nodes.length, edgeCount: result.edges.length, depthReached: result.depthReached, truncated: result.truncated,
      nodes: result.nodes.map((n) => ({ symbolId: n.symbolId, name: n.name, kind: n.kind, filePath: n.filePath })),
      edges: result.edges.map((e) => ({ fromId: e.fromId, toId: e.toId, fromName: e.fromName, toName: e.toName, confidence: e.confidence })),
      coverage
    }, profile);
  }
  return ctx.asText({ entrySymbol: result.entrySymbol, nodeCount: result.nodes.length, edgeCount: result.edges.length, depthReached: result.depthReached, truncated: result.truncated, nodes: result.nodes, edges: result.edges, coverage }, profile);
}
