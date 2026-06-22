import fs from "node:fs";

import { globSync } from "glob";

import type { RefactorRiskFlag, RefactorPreviewHunkRecord, RefactorApplyChangeRecord, RefactorApplyHunkRecord } from "./types.js";
import type { GraphStore } from "./graphStore.js";
import type {
  PreviewCandidateHunk,
  RefactorScopeInput,
  RefactorGuardsInput,
  RefactorModeInput,
  RefactorSymbolMigrationInput,
  RefactorCompilerAssistInput,
  CompilerAssistOutcome
} from "./refactorTypes.js";
import {
  normalizeRelativePath,
  sha256,
  safeReadText,
  assertSafeRepoFilePath,
  inferLanguageFromPath,
  isGeneratedFilePath,
  offsetToLine,
  escapeRegExp,
  findOwnerType,
  inferSymbolKind,
  pathStartsWithAny,
  hasNormalizedPathPrefix,
  resolveDiagnosticPathToHunkPath,
  findInitializerMemberAssignment,
  isDottedMemberPath,
  findEnclosingObjectInitializer,
  isInvalidCsharpInitializerReplacement,
  resolveInitializerRewriteTargetMember,
  isApplyRunnableHunk,
  buildFinalOffsetMap
} from "./refactorUtils.js";

// Match caps for regex find mode — bound work on pathological patterns / huge repos.
const REGEX_PER_FILE_MATCH_CAP = 2000;
const REGEX_GLOBAL_MATCH_CAP = 5000;

// Recognizes regex replacement backreference tokens: `$$`, `$&`, `$1`..`$99`, `$<name>`, `${name}`.
const BACKREFERENCE_TOKEN = /\$(\$|&|\d{1,2}|<([^>]+)>|\{([^}]+)\})/g;

/** Expand `$&`, `$$`, `$1`..`$99`, and named groups (`$<name>`/`${name}`) in a regex replacement template against a match. */
function expandRegexReplacement(template: string, match: RegExpExecArray): string {
  return template.replace(BACKREFERENCE_TOKEN, (_full, token: string, angleName?: string, braceName?: string) => {
    if (token === "$") return "$";
    if (token === "&") return match[0];
    const name = angleName ?? braceName;
    if (name !== undefined) return match.groups?.[name] ?? "";
    return match[Number(token)] ?? "";
  });
}

/**
 * True if `template` references a capture group — numbered or named — that the pattern does not
 * declare at all (a typo like `$1` against a group-less pattern, or `$<typo>`). Such a reference is
 * silently substituted with an empty string (data loss) or risks landing a stray backreference
 * token, so the preview should flag it rather than apply silently (defense-in-depth for MCP-ISSUE-029).
 *
 * A reference to a group that the pattern *does* declare but which did not participate in this match
 * (an optional group like `(x)?` → `match[n] === undefined`) is NOT missing: substituting empty is
 * the correct, standard `String.replace` behavior, so flagging it would wrongly block valid refactors.
 * We distinguish the two by group existence: `n < match.length` for numbered groups, and `name in
 * match.groups` for named groups (JS populates `match.groups` with every declared name, even if its
 * value is undefined because the group did not participate).
 */
function hasMissingBackreference(template: string, match: RegExpExecArray): boolean {
  let missing = false;
  template.replace(BACKREFERENCE_TOKEN, (_full, token: string, angleName?: string, braceName?: string) => {
    if (token === "$" || token === "&") return "";
    const name = angleName ?? braceName;
    if (name !== undefined) {
      // Missing only when the pattern declares no group of this name (typo), not when an existing
      // optional group simply didn't participate (then `name` is still a key of match.groups).
      if (!match.groups || !(name in match.groups)) missing = true;
    } else if (Number(token) >= match.length) {
      // Missing only when the index exceeds the declared group count. An in-range index whose value
      // is undefined is a non-participating optional group → legitimate empty substitution.
      missing = true;
    }
    return "";
  });
  return missing;
}

export function buildRefactorPreview(
  store: GraphStore,
  repoPath: string,
  repoId: string,
  findText: string,
  replaceText: string,
  scope: RefactorScopeInput,
  guards: RefactorGuardsInput,
  mode: RefactorModeInput,
  findMode: "literal" | "regex" = "literal",
  regexFlags?: string
): {
  hunks: PreviewCandidateHunk[];
  affectedFiles: string[];
} {
  const indexedFiles = store.listIndexedFiles(repoId).map((x) => normalizeRelativePath(x.path));
  const includePaths = (scope.includePaths ?? []).map((x) => normalizeRelativePath(x));
  const excludePaths = (scope.excludePaths ?? []).map((x) => normalizeRelativePath(x));
  const globPaths = (scope.fileGlobs ?? []).map((x) => normalizeRelativePath(x));

  let allowedByGlob: Set<string> | null = null;
  if (globPaths.length > 0) {
    allowedByGlob = new Set<string>();
    for (const pattern of globPaths) {
      const matches = globSync(pattern, { cwd: repoPath, nodir: true, dot: false, windowsPathsNoEscape: true });
      for (const match of matches) {
        allowedByGlob.add(normalizeRelativePath(match));
      }
    }
  }

  const selectedFiles = indexedFiles
    .filter((filePath) => pathStartsWithAny(filePath, includePaths))
    .filter((filePath) => !excludePaths.some((prefix) => normalizeRelativePath(filePath).toLowerCase().startsWith(prefix.toLowerCase())))
    .filter((filePath) => (allowedByGlob ? allowedByGlob.has(normalizeRelativePath(filePath)) : true))
    .sort((a, b) => a.localeCompare(b));

  const hunks: PreviewCandidateHunk[] = [];
  const affected = new Set<string>();

  // Compile the regex once when in regex mode (only i/m/s flags honored; `g` is forced).
  const compiledRegex =
    findMode === "regex" ? new RegExp(findText, `g${(regexFlags ?? "").replace(/[^ims]/g, "")}`) : null;
  let totalMatchCount = 0;

  for (const filePath of selectedFiles) {
    if (totalMatchCount >= REGEX_GLOBAL_MATCH_CAP) break;
    const language = inferLanguageFromPath(filePath);
    if (guards.language && language !== guards.language) {
      continue;
    }

    const safeAbsolute = assertSafeRepoFilePath(repoPath, filePath);
    if (!fs.existsSync(safeAbsolute)) {
      continue;
    }

    const content = fs.readFileSync(safeAbsolute, "utf8");
    const fileHashBefore = sha256(content);

    // Collect raw matches (literal substring, or regex with capture-group substitution).
    const rawMatches: { start: number; end: number; replacement: string; unsubstituted: boolean }[] = [];
    if (compiledRegex) {
      compiledRegex.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = compiledRegex.exec(content)) !== null) {
        rawMatches.push({ start: m.index, end: m.index + m[0].length, replacement: expandRegexReplacement(replaceText, m), unsubstituted: hasMissingBackreference(replaceText, m) });
        if (m[0].length === 0) compiledRegex.lastIndex++; // avoid infinite loop on zero-length matches
        if (rawMatches.length >= REGEX_PER_FILE_MATCH_CAP) break;
      }
    } else {
      let cursor = 0;
      while (true) {
        const start = content.indexOf(findText, cursor);
        if (start < 0) break;
        rawMatches.push({ start, end: start + findText.length, replacement: replaceText, unsubstituted: false });
        cursor = start + findText.length;
      }
    }

    const fileLines = content.split(/\r?\n/);
    for (const { start, end, replacement, unsubstituted } of rawMatches) {
      if (totalMatchCount >= REGEX_GLOBAL_MATCH_CAP) break;
      const line = offsetToLine(content, start);
      const lineText = fileLines[line - 1] ?? "";
      const ownerType = findOwnerType(content, start);
      const symbolKind = inferSymbolKind(lineText);

      if (guards.symbolKinds.length > 0) {
        if (!symbolKind || !guards.symbolKinds.includes(symbolKind)) continue;
      }
      if (guards.allowOwnerTypes.length > 0) {
        if (!ownerType || !guards.allowOwnerTypes.some((x) => x.toLowerCase() === ownerType.toLowerCase())) continue;
      }

      const riskFlags: RefactorRiskFlag[] = [];
      if ((mode === "symbol-aware" || mode === "syntax-aware") && !ownerType) {
        riskFlags.push("ambiguous_target");
      }
      const disallowNames = new Set([...guards.disallowOwnerTypes, ...guards.disallowTypeList].map((x) => x.toLowerCase()));
      if (ownerType && disallowNames.has(ownerType.toLowerCase())) {
        riskFlags.push("cross_type");
      }
      if (isGeneratedFilePath(filePath)) {
        riskFlags.push("generated_file");
      }
      if (unsubstituted) {
        riskFlags.push("unsubstituted_backreference");
      }

      let confidence = mode === "text" ? 0.85 : 0.95;
      if (!ownerType) confidence -= 0.25;
      if (riskFlags.includes("cross_type")) confidence -= 0.4;
      if (riskFlags.includes("generated_file")) confidence -= 0.2;
      confidence = Math.max(0, Math.min(1, Number(confidence.toFixed(2))));

      hunks.push({
        filePath,
        line,
        startOffset: start,
        endOffset: end,
        beforeText: content.slice(start, end),
        afterText: replacement,
        ownerType,
        symbolKind,
        confidence,
        riskFlags,
        fileHashBefore
      });
      affected.add(filePath);
      totalMatchCount++;
    }
  }

  hunks.sort((a, b) => a.filePath.localeCompare(b.filePath) || a.startOffset - b.startOffset);
  return {
    hunks,
    affectedFiles: [...affected].sort((a, b) => a.localeCompare(b))
  };
}

export function applyCompilerAssistToPreview(
  hunks: PreviewCandidateHunk[],
  compilerAssist: RefactorCompilerAssistInput
): CompilerAssistOutcome {
  const normalizedCodes = new Set(compilerAssist.codes.map((x) => x.trim().toUpperCase()).filter(Boolean));
  const lineWindow = compilerAssist.lineWindow;
  const pathPrefix = compilerAssist.filePathPrefix ? normalizeRelativePath(compilerAssist.filePathPrefix).toLowerCase() : null;
  const hunkPathByLower = new Map<string, string>();
  for (const hunk of hunks) {
    const normalizedHunkPath = normalizeRelativePath(hunk.filePath).toLowerCase();
    if (!hunkPathByLower.has(normalizedHunkPath)) {
      hunkPathByLower.set(normalizedHunkPath, hunk.filePath);
    }
  }

  const acceptedDiagnostics = compilerAssist.diagnostics.flatMap((diag) => {
    const code = diag.code.trim().toUpperCase();
    if (normalizedCodes.size > 0 && !normalizedCodes.has(code)) {
      return [];
    }

    const resolvedPath = resolveDiagnosticPathToHunkPath(diag.filePath, hunkPathByLower);
    const diagPathForPrefix = resolvedPath
      ? normalizeRelativePath(resolvedPath).toLowerCase()
      : normalizeRelativePath(diag.filePath).toLowerCase();

    if (pathPrefix && !hasNormalizedPathPrefix(diagPathForPrefix, pathPrefix)) {
      return [];
    }

    return [{ ...diag, resolvedPath }];
  });

  if (acceptedDiagnostics.length === 0) {
    return {
      hunks,
      totalDiagnostics: compilerAssist.diagnostics.length,
      acceptedDiagnostics: 0,
      matchedDiagnostics: 0,
      filteredOutHunks: 0,
      lineWindow,
      codes: [...normalizedCodes].sort((a, b) => a.localeCompare(b))
    };
  }

  const diagnosticsByFile = new Map<string, Array<{ line: number; key: string }>>();
  for (const diag of acceptedDiagnostics) {
    if (!diag.resolvedPath) {
      continue;
    }
    const normalizedPath = normalizeRelativePath(diag.resolvedPath).toLowerCase();
    const list = diagnosticsByFile.get(normalizedPath) ?? [];
    list.push({ line: diag.line, key: `${normalizedPath}:${diag.line}:${diag.code.trim().toUpperCase()}` });
    diagnosticsByFile.set(normalizedPath, list);
  }

  const matchedDiagnosticKeys = new Set<string>();
  const selectedHunks = hunks.filter((hunk) => {
    const normalizedPath = normalizeRelativePath(hunk.filePath).toLowerCase();
    const candidates = diagnosticsByFile.get(normalizedPath);
    if (!candidates || candidates.length === 0) {
      return false;
    }
    for (const candidate of candidates) {
      if (Math.abs(candidate.line - hunk.line) <= lineWindow) {
        matchedDiagnosticKeys.add(candidate.key);
        return true;
      }
    }
    return false;
  });

  const effectiveHunks = selectedHunks;

  return {
    hunks: effectiveHunks,
    totalDiagnostics: compilerAssist.diagnostics.length,
    acceptedDiagnostics: acceptedDiagnostics.length,
    matchedDiagnostics: matchedDiagnosticKeys.size,
    filteredOutHunks: Math.max(0, hunks.length - effectiveHunks.length),
    lineWindow,
    codes: [...normalizedCodes].sort((a, b) => a.localeCompare(b))
  };
}

export function buildSymbolMigrationPreview(
  store: GraphStore,
  repoPath: string,
  repoId: string,
  migration: RefactorSymbolMigrationInput,
  scopePaths: string[]
): {
  hunks: PreviewCandidateHunk[];
  affectedFiles: string[];
} {
  const preview = buildRefactorPreview(
    store,
    repoPath,
    repoId,
    migration.fromSymbol,
    migration.toSymbol,
    {
      includePaths: scopePaths,
      excludePaths: [],
      fileGlobs: []
    },
    {
      language: undefined,
      symbolKinds: ["property", "field"],
      allowOwnerTypes: [migration.requiredOwnerType],
      disallowOwnerTypes: migration.forbiddenOwnerTypes,
      disallowTypeList: migration.forbiddenOwnerTypes
    },
    "symbol-aware"
  );

  const fileCache = new Map<string, string>();

  if (!migration.initializerRewrite && isDottedMemberPath(migration.toSymbol)) {
    const guardedHunks = preview.hunks.map((hunk) => {
      if (inferLanguageFromPath(hunk.filePath) !== "csharp") {
        return hunk;
      }

      let content = fileCache.get(hunk.filePath);
      if (!content) {
        content = safeReadText(assertSafeRepoFilePath(repoPath, hunk.filePath));
        fileCache.set(hunk.filePath, content);
      }

      const assignment = findInitializerMemberAssignment(content, hunk.startOffset, migration.fromSymbol);
      if (!assignment || assignment.initializer.typeName.toLowerCase() !== migration.requiredOwnerType.toLowerCase()) {
        return hunk;
      }

      const blockedRiskFlags: RefactorRiskFlag[] = [...new Set([...hunk.riskFlags, "ambiguous_target"] as RefactorRiskFlag[])];
      return {
        ...hunk,
        line: assignment.line,
        startOffset: assignment.assignmentStart,
        endOffset: assignment.assignmentEnd,
        beforeText: assignment.assignmentText,
        afterText: assignment.assignmentText,
        confidence: Math.min(hunk.confidence, 0.5),
        riskFlags: blockedRiskFlags
      };
    });

    return {
      hunks: guardedHunks.sort((a, b) => a.filePath.localeCompare(b.filePath) || a.startOffset - b.startOffset || a.beforeText.localeCompare(b.beforeText)),
      affectedFiles: [...new Set(guardedHunks.map((x) => x.filePath))].sort((a, b) => a.localeCompare(b))
    };
  }

  if (!migration.initializerRewrite) {
    return preview;
  }

  const retainedHunks: PreviewCandidateHunk[] = [];
  const rewrittenHunks: PreviewCandidateHunk[] = [];
  const groupedAssignments = new Map<string, Array<{ hunk: PreviewCandidateHunk; assignment: ReturnType<typeof findInitializerMemberAssignment> & object }>>();
  const targetMember = resolveInitializerRewriteTargetMember(migration);

  for (const hunk of preview.hunks) {
    if (inferLanguageFromPath(hunk.filePath) !== "csharp") {
      retainedHunks.push(hunk);
      continue;
    }

    let content = fileCache.get(hunk.filePath);
    if (!content) {
      content = safeReadText(assertSafeRepoFilePath(repoPath, hunk.filePath));
      fileCache.set(hunk.filePath, content);
    }

    const assignment = findInitializerMemberAssignment(content, hunk.startOffset, migration.fromSymbol);
    if (!assignment || assignment.initializer.typeName.toLowerCase() !== migration.requiredOwnerType.toLowerCase()) {
      retainedHunks.push(hunk);
      continue;
    }

    if (assignment.hasSiblingAssignments) {
      const blockedRiskFlags: RefactorRiskFlag[] = [...new Set([...hunk.riskFlags, "ambiguous_target"] as RefactorRiskFlag[])];
      rewrittenHunks.push({
        ...hunk,
        line: assignment.line,
        startOffset: assignment.assignmentStart,
        endOffset: assignment.assignmentEnd,
        beforeText: assignment.assignmentText,
        afterText: assignment.assignmentText,
        confidence: Math.min(hunk.confidence, 0.5),
        riskFlags: blockedRiskFlags
      });
      continue;
    }

    const groupKey = [
      hunk.filePath,
      String(assignment.initializer.openBraceOffset),
      migration.initializerRewrite.objectProperty,
      migration.initializerRewrite.objectType
    ].join(":");
    const list = groupedAssignments.get(groupKey) ?? [];
    list.push({ hunk, assignment });
    groupedAssignments.set(groupKey, list);
  }

  for (const entries of groupedAssignments.values()) {
    const ordered = [...entries].sort((a, b) => a.assignment.assignmentStart - b.assignment.assignmentStart);
    const first = ordered[0];
    let content = fileCache.get(first.hunk.filePath);
    if (!content) {
      content = safeReadText(assertSafeRepoFilePath(repoPath, first.hunk.filePath));
      fileCache.set(first.hunk.filePath, content);
    }

    const initializerBody = content.slice(first.assignment.initializer.openBraceOffset + 1, first.assignment.initializer.endOffset);
    const existingOwnedPropertyPattern = new RegExp(`\\b${escapeRegExp(migration.initializerRewrite!.objectProperty)}\\s*=`);
    const combinedRiskFlags = [...new Set(ordered.flatMap((x) => x.hunk.riskFlags))];
    const baseConfidence = Math.min(...ordered.map((x) => x.hunk.confidence));

    if (existingOwnedPropertyPattern.test(initializerBody)) {
      const blockedRiskFlags: RefactorRiskFlag[] = [...new Set([...combinedRiskFlags, "ambiguous_target"] as RefactorRiskFlag[])];
      rewrittenHunks.push({
        ...first.hunk,
        line: first.assignment.line,
        startOffset: first.assignment.assignmentStart,
        endOffset: first.assignment.assignmentEnd,
        beforeText: first.assignment.assignmentText,
        afterText: first.assignment.assignmentText,
        confidence: Math.min(baseConfidence, 0.5),
        riskFlags: blockedRiskFlags
      });
      continue;
    }

    const memberAssignments = ordered.map(({ assignment }) => `${targetMember} = ${assignment.expressionText}`);
    const replacementText = `${first.assignment.indent}${migration.initializerRewrite!.objectProperty} = new ${migration.initializerRewrite!.objectType} { ${memberAssignments.join(", ")} }${first.assignment.trailingComma ? "," : ""}${first.assignment.lineEnding}`;

    rewrittenHunks.push({
      ...first.hunk,
      line: first.assignment.line,
      startOffset: first.assignment.assignmentStart,
      endOffset: first.assignment.assignmentEnd,
      beforeText: first.assignment.assignmentText,
      afterText: replacementText,
      confidence: Math.max(baseConfidence, 0.97),
      ownerType: migration.requiredOwnerType,
      symbolKind: "property",
      riskFlags: combinedRiskFlags
    });

    for (const entry of ordered.slice(1)) {
      rewrittenHunks.push({
        ...entry.hunk,
        line: entry.assignment.line,
        startOffset: entry.assignment.assignmentStart,
        endOffset: entry.assignment.assignmentEnd,
        beforeText: entry.assignment.assignmentText,
        afterText: "",
        confidence: Math.max(baseConfidence, 0.97),
        ownerType: migration.requiredOwnerType,
        symbolKind: "property",
        riskFlags: combinedRiskFlags
      });
    }
  }

  const hunks = [...retainedHunks, ...rewrittenHunks]
    .sort((a, b) => a.filePath.localeCompare(b.filePath) || a.startOffset - b.startOffset || a.beforeText.localeCompare(b.beforeText));

  return {
    hunks,
    affectedFiles: [...new Set(hunks.map((x) => x.filePath))].sort((a, b) => a.localeCompare(b))
  };
}

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
