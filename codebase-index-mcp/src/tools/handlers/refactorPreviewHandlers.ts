/**
 * The preview-side tool handlers: `rename_assist` and `refactor_replace_preview`.
 *
 * A preview is where the approval token is issued, so these handlers decide what a later apply
 * is permitted to do. `assertValidRegexMode` rejects a malformed pattern here rather than
 * letting it fail mid-scan.
 */

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { randomUUID } from "node:crypto";
import { buildRefactorPreview, applyCompilerAssistToPreview } from "../../services/refactor/refactorEngine.js";
import {
  resolveApprovalSecret,
  countPreviewRisks,
  createPreviewDigest,
  issueApprovalToken,
  groupPreviewHunks,
  noLlmAudit,
  escapeRegExp
} from "../../services/refactor/refactorUtils.js";
import type {
  RefactorScopeInput,
  RefactorGuardsInput,
  RefactorModeInput,
  RefactorCompilerAssistInput
} from "../../services/refactor/refactorTypes.js";
import type { RefactorPreviewRecord, RefactorPreviewHunkRecord } from "../../types/index.js";
import { resolveResponseProfile } from "../../middleware/responseFormatter.js";
import type { HandlerContext } from "./handlerContext.js";

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
  // MCP-ISSUE-049: the DECLARING file belongs in the blast radius. The advisory built this set from
  // callers + importers only and reported `affectedFileCount: 2`, while `emitPreview:true` scoped its
  // preview to `[symbol.filePath, ...affectedFiles]` — 3 files — for the very same rename. An advisory
  // that understates what the apply will touch is worse than no advisory. Declaring file first, since
  // that is where the rename actually happens.
  const affectedFiles = [
    ...new Set([
      result.symbol.filePath,
      ...result.callers.map((c) => c.fromFilePath).filter(Boolean),
      ...result.importers.map((i) => i.fromFilePath).filter(Boolean)
    ])
  ] as string[];

  // emitPreview: turn the advisory rename into an applyable refactor preview (previewId + approvalToken)
  // scoped to the symbol's own file + affected files, matching the identifier on word boundaries.
  if (args.emitPreview) {
    const repo = store.getRepository(args.repoId);
    if (!repo) throw new McpError(ErrorCode.InvalidParams, `rename_assist: unknown repoId '${args.repoId}'. Run index_repository first.`);
    const wholeWord = args.wholeWord !== false;
    // `affectedFiles` already leads with the declaring file; the Set is kept because
    // `RefactorScopeInput.includePaths` must not carry a duplicate.
    const includePaths = [...new Set(affectedFiles)];
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

  // MCP-ISSUE-049: `hints` embeds a path INSIDE a sentence, and the response normalizer is
  // key-scoped — it rewrites the value of a path-named key, and cannot reach a path spliced into
  // free text. So this payload returned `affectedFiles` with forward slashes and `hints` with
  // backslashes. Normalized at the source instead.
  const hints = affectedFiles.map((fp) => `In ${fp.replace(/\\/g, "/")}: rename '${result.symbol!.name}' → '${args.newName}'`);
  // Derived from the set above rather than from `result.affectedFileCount`, which counts callers and
  // importers only — the count and the list have to describe the same thing.
  const affectedFileCount = affectedFiles.length;
  if (profile === "nano") {
    return ctx.asText({ oldName: result.symbol.name, newName: args.newName, symbolId: args.symbolId, affectedFileCount, affectedFiles }, profile);
  }
  return ctx.asText({
    symbol: { symbolId: result.symbol.symbolId, name: result.symbol.name, kind: result.symbol.kind, filePath: result.symbol.filePath, line: result.symbol.line },
    newName: args.newName,
    affectedFileCount,
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

  // Guard diagnostics (MCP-ISSUE-043 / B-13). This handler surfaced neither before, so an owner guard
  // that dropped every site read as "the identifier does not appear in scope". Counts at every profile,
  // detail above nano: `rejectedSites` are sites a guard REFUSED (proven wrong kind/owner);
  // `ambiguousReasons` are sites KEPT but unprovable, and therefore blocked from apply.
  const guardCounts = {
    ...(previewResult.rejectedSites.length > 0 && { rejectedSiteCount: previewResult.rejectedSites.length }),
    ...(previewResult.ambiguousReasons.length > 0 && { unprovenOwnerCount: previewResult.ambiguousReasons.length })
  };
  const guardDetail = {
    ...guardCounts,
    ...(previewResult.rejectedSites.length > 0 && { rejectedSites: previewResult.rejectedSites.slice(0, 20) }),
    ...(previewResult.ambiguousReasons.length > 0 && { ambiguousReasons: previewResult.ambiguousReasons.slice(0, 20) })
  };

  // nano: summary only — no hunk content (best for checking blast radius before requesting detail)
  if (profile === "nano") {
    return ctx.asText({ previewId, approvalToken, totalMatches: effectiveHunks.length, affectedFileCount: effectiveAffectedFiles.length, affectedFiles: effectiveAffectedFiles, riskFlags, ...guardCounts, ambiguity, diagnostics, executionPolicy, expiresAt }, profile);
  }

  // compact: hunks without before/after text (saves 50-80% tokens on large refactors)
  if (profile === "compact") {
    const byFile = new Map<string, typeof hunkRecords>();
    for (const h of hunkRecords) { const list = byFile.get(h.filePath) ?? []; list.push(h); byFile.set(h.filePath, list); }
    const compactHunks = [...byFile.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([filePath, items]) => ({
      filePath, hunkCount: items.length,
      hunks: items.map((h) => ({ hunkId: h.hunkId, line: h.line, replacementText: h.replacementText, symbolKind: h.symbolKind, confidence: h.confidence, riskFlags: h.riskFlags }))
    }));
    return ctx.asText({ previewId, mode: args.mode, totalMatches: effectiveHunks.length, affectedFiles: effectiveAffectedFiles, groupedPreviewHunks: compactHunks, riskFlags, ...guardDetail, ambiguity, diagnostics, executionPolicy, approvalToken, expiresAt }, profile);
  }

  return ctx.asText({
    previewId, mode: args.mode, totalMatches: effectiveHunks.length, affectedFiles: effectiveAffectedFiles,
    groupedPreviewHunks: groupPreviewHunks(hunkRecords),
    riskFlags,
    ...guardDetail,
    compilerAssist: compilerAssistOutcome
      ? { enabled: true, totalDiagnostics: compilerAssistOutcome.totalDiagnostics, acceptedDiagnostics: compilerAssistOutcome.acceptedDiagnostics, matchedDiagnostics: compilerAssistOutcome.matchedDiagnostics, filteredOutHunks: compilerAssistOutcome.filteredOutHunks, lineWindow: compilerAssistOutcome.lineWindow, codes: compilerAssistOutcome.codes }
      : { enabled: false },
    ambiguity, diagnostics, executionPolicy, approvalToken, expiresAt
  });
}

// ── refactor_replace_apply ────────────────────────────────────────────────────
