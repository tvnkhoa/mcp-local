/**
 * `refactor_symbol_migration` and `change_value_representation`.
 *
 * Both produce a preview through the same approval path as a plain replace; they are grouped
 * because each is a preview built from a higher-level intent than a find/replace.
 */

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { randomUUID } from "node:crypto";
import { buildSymbolMigrationPreview } from "../../services/refactor/refactorEngine.js";
import { buildValueRepresentationPreview, type ValueRepresentationInput } from "../../services/analysis/valueRepresentation.js";
import {
  collectExpectedApplyFiles,
  countPreviewRisks,
  createPreviewDigest,
  groupPreviewHunks,
  issueApprovalToken,
  noLlmAudit,
  resolveApprovalSecret,
  verifyApprovalToken,
  PolicyViolationError
} from "../../services/refactor/refactorUtils.js";
import type { RefactorSymbolMigrationInput } from "../../services/refactor/refactorTypes.js";
import type { RefactorPreviewRecord, RefactorPreviewHunkRecord } from "../../types/index.js";
import { resolveResponseProfile } from "../../middleware/responseFormatter.js";
import type { HandlerContext } from "./handlerContext.js";
import { applyPreviewExclusively } from "./refactorApplyGate.js";

/**
 * The approval gate these two tools were missing. MCP-ISSUE-060, open since 2026-08-25.
 *
 * `refactor_replace_preview` → `refactor_replace_apply` requires an HMAC token minted by the
 * preview and verified against the stored record. These two tools took `dryRun: false` and wrote in
 * the SAME round trip, with no token anywhere in their schema — annotated `destructiveHint: true`,
 * which is what protects a host that reads annotations, but with no second gate for one that does
 * not. A single argument flip was the whole distance between "show me" and "rewrite my repository".
 *
 * The token is an HMAC over `{previewId, digest, expiresAt}`, so it can only be verified against a
 * STORED preview — which is the right shape anyway: it means the caller approves the specific change
 * they were shown. Three checks, in the order that fails most cheaply first:
 *
 *   1. the preview exists and has not expired;
 *   2. the token verifies against it;
 *   3. the digest computed from the CURRENT source still equals the approved one.
 *
 * (3) is what a bare token cannot give. The digest is derived from the hunks, so if the code moved
 * between the dry run and the apply, the approval no longer describes what would be written, and it
 * must not authorize it.
 */
function assertApprovedApply(
  ctx: HandlerContext,
  toolName: string,
  args: { dryRun: boolean; previewId?: string; approvalToken?: string },
  freshDigest: string
): void {
  if (args.dryRun) return;

  if (!args.previewId || !args.approvalToken) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `${toolName}: dryRun=false requires previewId and approvalToken from a prior dryRun=true call. ` +
        `Run it with dryRun=true (the default), read the preview, then pass back the previewId and approvalToken it returned.`
    );
  }

  const stored = ctx.store.getRefactorPreview(args.previewId);
  if (!stored) {
    throw new McpError(ErrorCode.InvalidParams, `${toolName}: preview '${args.previewId}' not found. Previews expire; create a fresh one.`);
  }
  if (Date.parse(stored.preview.expiresAt) < Date.now()) {
    throw new PolicyViolationError("PREVIEW_EXPIRED", `${toolName}: preview expired. Create a fresh preview before apply.`);
  }

  verifyApprovalToken(
    args.approvalToken,
    stored.preview.previewId,
    stored.preview.digest,
    stored.preview.expiresAt,
    resolveApprovalSecret(ctx.constants.REFACTOR_APPROVAL_SECRET, ctx.constants.REFACTOR_STRICT_APPROVAL)
  );

  if (stored.preview.digest !== freshDigest) {
    throw new PolicyViolationError(
      "PREVIEW_DIGEST_MISMATCH",
      `${toolName}: the source changed since the preview you approved, so the approval no longer describes what would be written. Re-run with dryRun=true and review the new preview.`
    );
  }
}

export async function handleRefactorSymbolMigration(
  args: {
    repoId: string;
    migrations: RefactorSymbolMigrationInput[];
    scopePaths?: string[];
    dryRun: boolean;
    includeLowConfidence?: boolean;
    previewId?: string;
    approvalToken?: string;
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
    previewId: string; approvalToken: string; totalMatches: number; unresolvedOccurrences: number;
    previewSummary: ReturnType<typeof groupPreviewHunks>;
    rejectedSiteCount?: number;
    rejectedSites?: { filePath: string; line: number; rule: string; detail: string }[];
    ambiguousReasons?: { filePath: string; line: number; rule: string; detail: string }[];
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
      previewId,
      // Minted on every call, including a dry run — that is the point: the dry run is where the
      // caller gets the credential that authorizes the apply.
      approvalToken: issueApprovalToken(previewId, digest, expiresAt, resolveApprovalSecret(constants.REFACTOR_APPROVAL_SECRET, constants.REFACTOR_STRICT_APPROVAL)),
      totalMatches: hunkRecords.length,
      unresolvedOccurrences: hunkRecords.filter((x) => x.riskFlags.includes("ambiguous_target")).length,
      previewSummary: groupPreviewHunks(hunkRecords),
      // MCP-ISSUE-043: say which guard dropped what, so a 0-match result is diagnosable instead of
      // being indistinguishable from "the symbol does not appear in scope".
      ...(previewResult.rejectedSites.length > 0 && {
        rejectedSiteCount: previewResult.rejectedSites.length,
        rejectedSites: previewResult.rejectedSites.slice(0, 20)
      }),
      // B-13: a site whose owner could not be PROVEN is kept and flagged rather than dropped, so it
      // is counted in `unresolvedOccurrences`. This names the rule that failed for each one.
      ...(previewResult.ambiguousReasons.length > 0 && {
        ambiguousReasons: previewResult.ambiguousReasons.slice(0, 20)
      })
    };
    for (const hunk of hunkRecords) suggestedFollowUpFiles.add(hunk.filePath);

    assertApprovedApply(ctx, "refactor_symbol_migration", args, digest);

    if (!args.dryRun) {
      const includeLowConfidence = args.includeLowConfidence ?? false;
      const expectedApplyFiles = collectExpectedApplyFiles(hunkRecords, includeLowConfidence, constants.REFACTOR_LOW_CONFIDENCE_THRESHOLD);
      const applied = await applyPreviewExclusively(
        store, repo.repoPath, args.repoId, previewId, hunkRecords, expectedApplyFiles,
        { maxFilesPerBatch: 50, stopOnFirstConflict: true, includeLowConfidence, lowConfidenceThreshold: constants.REFACTOR_LOW_CONFIDENCE_THRESHOLD }
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
    includeLowConfidence?: boolean;
    profile?: string;
    previewId?: string;
    approvalToken?: string;
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
    previewId: string; approvalToken: string; totalMatches: number; ambiguousOccurrences: number;
    affectedFiles: string[]; previewSummary: ReturnType<typeof groupPreviewHunks>;
    ambiguousReasons?: { filePath: string; line: number; rule: string; detail: string }[];
    rejectedSites?: { filePath: string; line: number; rule: string; detail: string }[];
    applyBlockedNote?: string;
    applyId?: string; rollbackId?: string; applyStatus?: string;
    executionPolicy: ReturnType<typeof noLlmAudit>;
  } = {
    repoId: args.repoId, dryRun: args.dryRun, property: args.property, requiredOwnerType: args.requiredOwnerType,
    previewId,
    approvalToken: issueApprovalToken(previewId, digest, expiresAt, resolveApprovalSecret(constants.REFACTOR_APPROVAL_SECRET, constants.REFACTOR_STRICT_APPROVAL)),
    totalMatches: hunkRecords.length,
    ambiguousOccurrences: hunkRecords.filter((x) => x.riskFlags.includes("ambiguous_target")).length,
    affectedFiles: previewResult.affectedFiles, previewSummary: groupPreviewHunks(hunkRecords),
    executionPolicy: noLlmAudit(constants.REFACTOR_STRICT_APPROVAL)
  };

  // MCP-ISSUE-043: `ambiguous_target` is a RISK FLAG, and apply rejects any hunk carrying one
  // regardless of `includeLowConfidence` — so the documented workaround cannot reach this lane. Say
  // which rule failed to prove each owner instead of reporting a bare count.
  if (previewResult.ambiguousReasons.length > 0) {
    result.ambiguousReasons = previewResult.ambiguousReasons.slice(0, 20);
    result.applyBlockedNote =
      "sites flagged ambiguous_target cannot be applied: the apply gate rejects any hunk with a risk flag, and includeLowConfidence does not lift a flag (it only lifts a low-confidence score). Resolve the owner (assign through a bare typed local) or use refactor_replace_preview with an explicit scope.";
  }
  if (previewResult.rejectedSites.length > 0) {
    result.rejectedSites = previewResult.rejectedSites.slice(0, 20);
  }

  assertApprovedApply(ctx, "change_value_representation", args, digest);

  if (!args.dryRun) {
    const includeLowConfidence = args.includeLowConfidence ?? false;
    const expectedApplyFiles = collectExpectedApplyFiles(hunkRecords, includeLowConfidence, constants.REFACTOR_LOW_CONFIDENCE_THRESHOLD);
    const applied = await applyPreviewExclusively(
      store, repo.repoPath, args.repoId, previewId, hunkRecords, expectedApplyFiles,
      { maxFilesPerBatch: 50, stopOnFirstConflict: true, includeLowConfidence, lowConfidenceThreshold: constants.REFACTOR_LOW_CONFIDENCE_THRESHOLD }
    );
    result.applyId = applied.applyId;
    result.rollbackId = applied.rollbackId;
    result.applyStatus = applied.applyRecord.status;
  }

  return ctx.asText(result, profile);
}

// ── trace_execution_flow ──────────────────────────────────────────────────────
