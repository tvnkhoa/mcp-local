/**
 * Building a refactor preview: find the sites, decide which are safe, emit hunks.
 *
 * The two regex helpers exist because a replacement template is user input. An unresolvable
 * backreference must be detected *before* any file is touched, or a preview would be built
 * from expansions that silently dropped a group.
 */

import fs from "node:fs";
import { globSync } from "glob";
import type { RefactorRiskFlag } from "../types.js";
import type { GraphStore } from "../store/graphStore.js";
import type {
  PreviewCandidateHunk,
  RefactorScopeInput,
  RefactorGuardsInput,
  RefactorModeInput
} from "./refactorTypes.js";
import {
  normalizeRelativePath,
  sha256,
  assertSafeRepoFilePath,
  inferLanguageFromPath,
  isGeneratedFilePath,
  offsetToLine,
  findOwnerType,
  inferSymbolKind,
  pathStartsWithAny
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
