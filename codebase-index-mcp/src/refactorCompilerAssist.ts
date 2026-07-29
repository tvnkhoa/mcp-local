/**
 * Folding compiler diagnostics into an existing preview.
 *
 * The only part of the engine that takes input from outside the graph, which is why it is
 * separate: a diagnostic path comes from a build tool and needs resolving back to a hunk path
 * before it can be trusted.
 */

import type {
  PreviewCandidateHunk,
  RefactorCompilerAssistInput,
  CompilerAssistOutcome
} from "./refactorTypes.js";
import {
  normalizeRelativePath,
  hasNormalizedPathPrefix,
  resolveDiagnosticPathToHunkPath
} from "./refactorUtils.js";

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
