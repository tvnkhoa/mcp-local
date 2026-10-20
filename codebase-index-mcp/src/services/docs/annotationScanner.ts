/**
 * Release C (R5, R6, comments-as-prose) — what a file says ABOUT other things, read from its text:
 *
 *   - citations: a repo's own shorthand (`docs/15 #737`, `adr/0057`, `<!--inv:by=test:…-->`), matched
 *     by the patterns in `.codebase-index/citations.json`, in markdown prose and in code comments;
 *   - code comments: the prose of a code file, so a docs search reaches "a stage threw" written in a
 *     comment, not only in a markdown file.
 *
 * Pure — text in, records out — and deliberately lexical. The citation target is stored as the
 * substituted spec (`docs/adr/0021-*.md`) and resolved at query time, so a dirty-mode run that sees
 * only three files still records correct citations, and a cited row is read as it is now.
 */

import type { CompiledCitation } from "./citationConfig.js";

export type CitationHit = {
  patternId: string;
  line: number;
  raw: string;
  targetSpec: string;
  anchorKind: CompiledCitation["anchor"]["kind"];
  anchorValue: string | null;
  anchorColumn: number;
};

export type CommentChunk = { startLine: number; endLine: number; text: string };

const C_LIKE = new Set(["typescript", "javascript", "csharp", "proto"]);
const HASH_COMMENT = new Set(["python"]);

/** Comment languages the scanner understands. Markdown is scanned as prose, not as comments. */
export function scansComments(language: string | null): boolean {
  return language !== null && (C_LIKE.has(language) || HASH_COMMENT.has(language));
}

/**
 * Comments of a C-like or `#` language, with string literals skipped so `"// not a comment"` stays
 * code. Consecutive line comments merge into one chunk; a block comment is one chunk. Comment
 * markers and a leading `*` per line are stripped.
 */
export function extractComments(source: string, language: string): CommentChunk[] {
  const out: CommentChunk[] = [];
  const hash = HASH_COMMENT.has(language);
  let i = 0;
  let line = 1;
  let pending: CommentChunk | null = null;
  const flushPending = () => {
    if (pending && pending.text.trim()) out.push({ ...pending, text: pending.text.trim() });
    pending = null;
  };
  const n = source.length;
  while (i < n) {
    const ch = source[i]!;
    const next = source[i + 1];
    if (ch === "\n") {
      line++;
      i++;
      continue;
    }
    // Strings: skip with escapes. Template literals are skipped whole (no nested-expression parsing).
    if (ch === '"' || ch === "'" || (ch === "`" && !hash)) {
      const quote = ch;
      i++;
      while (i < n && source[i] !== quote) {
        if (source[i] === "\\") i++;
        else if (source[i] === "\n") {
          line++;
          if (quote !== "`" && !hash) break; // unterminated: stop at end of line
        }
        i++;
      }
      i++;
      continue;
    }
    const lineComment = hash ? ch === "#" : ch === "/" && next === "/";
    if (lineComment) {
      const start = i + (hash ? 1 : 2);
      let end = source.indexOf("\n", start);
      if (end < 0) end = n;
      const text = source.slice(start, end).replace(/^\/+/, "").replace(/^!/, "").trim();
      const isContinuation = pending !== null && (pending as CommentChunk).endLine === line - 1;
      if (isContinuation && pending) {
        (pending as CommentChunk).text += "\n" + text;
        (pending as CommentChunk).endLine = line;
      } else {
        flushPending();
        pending = { startLine: line, endLine: line, text };
      }
      i = end;
      continue;
    }
    if (!hash && ch === "/" && next === "*") {
      flushPending();
      const startLine = line;
      const close = source.indexOf("*/", i + 2);
      const end = close < 0 ? n : close;
      const body = source.slice(i + 2, end);
      const lines = body.split("\n");
      line += lines.length - 1;
      const cleaned = lines.map((l) => l.replace(/^\s*\*?\s?/, "").replace(/^\*/, "").trimEnd());
      // Start at the first non-empty line, so `/**\n * text` reports text's own line, not the opener's.
      const first = cleaned.findIndex((l) => l.trim() !== "");
      if (first >= 0) {
        let last = cleaned.length - 1;
        while (last > first && cleaned[last]!.trim() === "") last--;
        out.push({ startLine: startLine + first, endLine: startLine + last, text: cleaned.slice(first, last + 1).join("\n") });
      }
      i = close < 0 ? n : close + 2;
      continue;
    }
    // Any other code on a line ends a run of line comments.
    if (pending && !/\s/.test(ch)) flushPending();
    i++;
  }
  flushPending();
  return out;
}

/** Markdown lines outside fenced code, 1-based — where prose citations live. */
export function markdownProseLines(source: string): { line: number; text: string }[] {
  const out: { line: number; text: string }[] = [];
  let fence: string | null = null;
  source.split(/\r?\n/).forEach((text, idx) => {
    const f = /^\s{0,3}(`{3,}|~{3,})/.exec(text);
    if (f) {
      const marker = f[1]![0]!;
      fence = fence === null ? marker : marker === fence ? null : fence;
      return;
    }
    if (fence === null) out.push({ line: idx + 1, text });
  });
  return out;
}

function substitute(template: string, m: RegExpExecArray): string {
  return template.replace(/\{(\d)\}/g, (_, d: string) => m[Number(d)] ?? "");
}

/** Every citation in the given lines. One line may carry several, each its own hit. */
export function findCitations(lines: readonly { line: number; text: string }[], citations: readonly CompiledCitation[]): CitationHit[] {
  const hits: CitationHit[] = [];
  for (const { line, text } of lines) {
    for (const c of citations) {
      c.regex.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = c.regex.exec(text)) !== null) {
        hits.push({
          patternId: c.id,
          line,
          raw: m[0].slice(0, 300),
          targetSpec: substitute(c.target, m).replace(/\\/g, "/"),
          anchorKind: c.anchor.kind,
          anchorValue: c.anchor.value ? substitute(c.anchor.value, m).trim() : null,
          anchorColumn: c.anchor.column
        });
        if (m[0].length === 0) c.regex.lastIndex++;
      }
    }
  }
  return hits;
}

/** Comment chunks as lines with their real line numbers, for `findCitations`. */
export function commentLines(chunks: readonly CommentChunk[]): { line: number; text: string }[] {
  return chunks.flatMap((c) => c.text.split("\n").map((text, k) => ({ line: c.startLine + k, text })));
}
