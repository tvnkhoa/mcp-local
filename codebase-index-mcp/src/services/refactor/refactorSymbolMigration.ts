/**
 * Symbol migration previews - moving or re-pointing a symbol across files.
 *
 * Builds on `buildRefactorPreview` rather than re-implementing the site search, so a migration
 * inherits the same guards, caps and ambiguity rules as a plain replace.
 */

import type { RefactorRiskFlag } from "../../types/index.js";
import type { GraphStore } from "../../repositories/graphStore.js";
import type { PreviewCandidateHunk, RefactorSymbolMigrationInput } from "./refactorTypes.js";
import {
  safeReadText,
  assertSafeRepoFilePath,
  inferLanguageFromPath,
  escapeRegExp,
  findInitializerMemberAssignment,
  isDottedMemberPath,
  resolveInitializerRewriteTargetMember
} from "./refactorUtils.js";
import { buildRefactorPreview } from "./refactorPreviewBuild.js";

export function buildSymbolMigrationPreview(
  store: GraphStore,
  repoPath: string,
  repoId: string,
  migration: RefactorSymbolMigrationInput,
  scopePaths: string[]
): {
  hunks: PreviewCandidateHunk[];
  affectedFiles: string[];
  rejectedSites: { filePath: string; line: number; rule: string; detail: string }[];
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
      // MCP-ISSUE-043: this was hardcoded to ["property", "field"], and the kind guard runs BEFORE the
      // owner guard — so migrating a METHOD dropped every site (inferSymbolKind classifies any
      // `Name(` as "method") and reported 0 matches where the plain preview found 3. The tool
      // description never said property/field-only, and the owner-type prover was never even reached.
      // Empty means "any kind"; a caller that wants the old behaviour passes it explicitly.
      symbolKinds: migration.symbolKinds ?? [],
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
      affectedFiles: [...new Set(guardedHunks.map((x) => x.filePath))].sort((a, b) => a.localeCompare(b)),
      rejectedSites: preview.rejectedSites
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
    affectedFiles: [...new Set(hunks.map((x) => x.filePath))].sort((a, b) => a.localeCompare(b)),
    rejectedSites: preview.rejectedSites
  };
}
