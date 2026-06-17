import fs from "node:fs";

import { glob } from "glob";

import type { GraphStore } from "./graphStore.js";
import type { SymbolRecord } from "./types.js";
import {
  isTestPath,
  isBinary,
  isLikelyMinified,
  hasExcludedPathSegment,
  INDEX_IGNORE_GLOBS
} from "./fileFilter.js";
import { assertSafeRepoFilePath, normalizeRelativePath } from "./refactorUtils.js";
import { numberFromEnv } from "./envConfig.js";

// Bound cost per query. PER_FILE_MATCH_CAP is deliberately tighter than refactorEngine's
// REGEX_PER_FILE_MATCH_CAP (2000): this is an interactive search lane, not a bulk rewrite, so
// 200 hits/file is plenty of signal. The global cap is the caller's `limit`; filesScanned is
// capped so one search can't read tens of thousands of files in a huge repo.
const PER_FILE_MATCH_CAP = 200;
const MAX_FILES_SCANNED = 5_000;
// Honor the same env knob the indexer uses (index.ts) so search and index agree on which
// files are in scope — a file the indexer kept must not be silently skipped here.
const MAX_FILE_SIZE_BYTES = numberFromEnv("CODEBASE_INDEX_MAX_FILE_SIZE_BYTES", 500_000);

export type RegexSearchOptions = {
  pattern: string;
  regexFlags?: string;
  filePathPrefix?: string;
  language?: string;
  excludeTests?: boolean;
  scanAll?: boolean;
  contextLines?: number;
  limit: number;
  maxFileSizeBytes?: number;
};

export type RegexSearchMatch = {
  filePath: string;
  line: number;
  column: number;
  matchText: string;
  beforeContext: string[];
  afterContext: string[];
  enclosingSymbol: { symbolId: string; name: string; kind: string } | null;
  language: string | null;
};

export type RegexSearchResult = {
  matches: RegexSearchMatch[];
  filesScanned: number;
  truncated: boolean;
  /** Why truncation stopped the scan, when it did — surfaced so callers never silently cap. */
  truncationReason: "limit_reached" | "files_cap_reached" | null;
};

export class RegexSearchError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** Char offsets where each line begins, so a match offset maps back to a 1-based line + column. */
function buildLineStarts(content: string): number[] {
  const starts = [0];
  for (let i = 0; i < content.length; i++) {
    if (content.charCodeAt(i) === 10 /* \n */) starts.push(i + 1);
  }
  return starts;
}

/** Largest line index whose start offset is <= offset (binary search over ascending starts). */
function lineIndexForOffset(lineStarts: number[], offset: number): number {
  let lo = 0;
  let hi = lineStarts.length - 1;
  let ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lineStarts[mid] <= offset) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

/**
 * Run a regex over a repo's source and return matches with context lines + the enclosing
 * symbol. Reads files from disk (raw content is not persisted in SQLite). Default scope is
 * the graph's indexed files; scanAll walks all non-binary text files under the repo root,
 * applying the same path/binary/minified/size filters the indexer uses.
 *
 * Matching runs against whole-file content (not line-by-line) so the `s` (dotall) and
 * multi-line patterns behave as written — a pattern spanning a newline matches.
 */
export function searchRegexImpl(
  store: GraphStore,
  repoId: string,
  opts: RegexSearchOptions
): RegexSearchResult {
  const repo = store.getRepository(repoId);
  if (!repo) {
    throw new RegexSearchError("UNKNOWN_REPO", `unknown repoId '${repoId}'. Run index_repository first.`);
  }
  const repoPath = repo.repoPath;

  // Compile once. Flags sanitized to [ims] and `g` forced — identical policy to refactorEngine.
  let regex: RegExp;
  try {
    const flags = `g${(opts.regexFlags ?? "").replace(/[^ims]/g, "")}`;
    regex = new RegExp(opts.pattern, flags);
  } catch (err) {
    throw new RegexSearchError("INVALID_PATTERN", `invalid regex pattern: ${(err as Error).message}`);
  }

  const prefix = opts.filePathPrefix ? normalizeRelativePath(opts.filePathPrefix).toLowerCase() : null;
  const contextLines = opts.contextLines ?? 2;
  const maxFileSize = opts.maxFileSizeBytes ?? MAX_FILE_SIZE_BYTES;

  // Build the candidate file list as repo-relative POSIX paths + a known language (when available).
  let candidates: { path: string; language: string | null }[];
  if (opts.scanAll) {
    const globbed = glob.sync("**/*", {
      cwd: repoPath,
      nodir: true,
      windowsPathsNoEscape: true,
      ignore: INDEX_IGNORE_GLOBS
    });
    // Apply the indexer's broader directory exclusions (bin, obj, out, .vs, …) that the glob
    // ignore list alone doesn't cover, so scanAll doesn't dredge compiled/tooling artifacts.
    candidates = globbed
      .map((p) => normalizeRelativePath(p))
      .filter((p) => !hasExcludedPathSegment(p))
      .map((p) => ({ path: p, language: null }));
  } else {
    candidates = store.listIndexedFiles(repoId).map((f) => ({ path: normalizeRelativePath(f.path), language: f.language }));
  }

  const selected = candidates
    .filter((f) => (prefix ? f.path.toLowerCase().startsWith(prefix) : true))
    .filter((f) => (opts.language ? f.language === opts.language : true))
    .filter((f) => (opts.excludeTests ? !isTestPath(f.path) : true))
    .sort((a, b) => a.path.localeCompare(b.path));

  const matches: RegexSearchMatch[] = [];
  let filesScanned = 0;
  let truncationReason: RegexSearchResult["truncationReason"] = null;

  for (const file of selected) {
    if (matches.length >= opts.limit) {
      truncationReason = "limit_reached";
      break;
    }
    if (filesScanned >= MAX_FILES_SCANNED) {
      truncationReason = "files_cap_reached";
      break;
    }

    let absolute: string;
    try {
      absolute = assertSafeRepoFilePath(repoPath, file.path);
    } catch {
      continue; // path escaped the repo root — skip defensively
    }

    // Size guard before reading so a huge file is never pulled into memory.
    let size: number;
    try {
      size = fs.statSync(absolute).size;
    } catch {
      continue; // vanished between glob and read
    }
    if (size > maxFileSize) continue;

    let buf: Buffer;
    try {
      buf = fs.readFileSync(absolute);
    } catch {
      continue;
    }
    if (buf.length === 0) continue;
    if (isBinary(buf) || isLikelyMinified(buf)) continue;
    filesScanned++;

    const content = buf.toString("utf8");
    const lines = content.split(/\r?\n/);
    const lineStarts = buildLineStarts(content);
    // One findSymbolAtLine query per distinct line, not per match (multiple matches share a line).
    const symbolByLine = new Map<number, SymbolRecord | null>();
    let perFileMatches = 0;

    regex.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = regex.exec(content)) !== null) {
      if (matches.length >= opts.limit) {
        truncationReason = "limit_reached";
        break;
      }
      if (perFileMatches >= PER_FILE_MATCH_CAP) break;

      const startIdx = m.index;
      const startLine = lineIndexForOffset(lineStarts, startIdx);
      const endLine = m[0].length > 0 ? lineIndexForOffset(lineStarts, startIdx + m[0].length - 1) : startLine;
      const lineNumber = startLine + 1;

      let enclosing = symbolByLine.get(lineNumber);
      if (enclosing === undefined) {
        enclosing = store.findSymbolAtLine(repoId, file.path, lineNumber);
        symbolByLine.set(lineNumber, enclosing);
      }

      matches.push({
        filePath: file.path,
        line: lineNumber,
        column: startIdx - lineStarts[startLine] + 1,
        matchText: m[0],
        beforeContext: lines.slice(Math.max(0, startLine - contextLines), startLine),
        afterContext: lines.slice(endLine + 1, Math.min(lines.length, endLine + 1 + contextLines)),
        enclosingSymbol: enclosing
          ? { symbolId: enclosing.symbolId, name: enclosing.name, kind: enclosing.kind }
          : null,
        language: file.language
      });
      perFileMatches++;

      // Guard against zero-width matches looping forever (e.g. pattern `a*` or `^` with m flag).
      if (m.index === regex.lastIndex) regex.lastIndex++;
    }
  }

  return {
    matches,
    filesScanned,
    truncated: truncationReason !== null,
    truncationReason
  };
}
