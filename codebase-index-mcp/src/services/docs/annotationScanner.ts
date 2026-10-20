/**
 * Release C (R5, R6, comments-as-prose) — what a file says ABOUT other things, read from its text:
 *
 *   - citations: a repo's own shorthand (`docs/15 #737`, `adr/0057`, `<!--inv:by=test:…-->`), matched
 *     by the patterns in `.codebase-index/citations.json`, in markdown prose, in code comments and
 *     (format v1.1, opt-in `scan.codeStrings`) in string literals assigned to named properties;
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

type TextLine = { line: number; text: string };

/** Characters that, right before `=`, make it a comparison or compound operator, not an assignment. */
const NOT_ASSIGNMENT = new Set(["=", "!", "<", ">", "+", "-", "*", "/", "%", "&", "|", "^", "?", ":"]);

/**
 * Format v1.1 `scan.codeStrings`: the string literals ASSIGNED TO one of `propertyNames`, as lines with
 * their real line numbers, for `findCitations`. "Assigned" is lexical — the literal is the first token
 * after `name:` (object-literal property, `"name":` key) or `name =` (class field, member or variable
 * assignment, C# initializer, Python keyword argument). Every other string stays unscanned.
 *
 * Comments are skipped (a string inside a comment is the comment's, and counted there only). A
 * template literal's static parts are scanned, each `${…}` cutting the line so two parts never join
 * into a match neither holds; a multi-line literal reports each line at its own number. C# verbatim
 * (`@"…"`), interpolated (`$"…"`) and raw (`"""…"""`) strings and Python prefixed/triple-quoted
 * strings are read with their own rules. Known limit, shared with `extractComments`: a JS regex literal
 * holding a quote (`/'/`) is not recognised as a regex.
 */
export function extractPropertyStrings(source: string, language: string, propertyNames: readonly string[]): TextLine[] {
  if (propertyNames.length === 0 || !scansComments(language)) return [];
  const names = new Set(propertyNames);
  const python = HASH_COMMENT.has(language);
  const csharp = language === "csharp";
  const templates = language === "typescript" || language === "javascript";
  const n = source.length;
  const out: TextLine[] = [];
  let i = 0;
  let line = 1;

  /** The property a literal starting at `start` is assigned to, or null. */
  const assignedTo = (start: number): string | null => {
    let j = start - 1;
    while (j >= 0 && /\s/.test(source[j]!)) j--;
    const op = source[j];
    if (op === "=") {
      if (NOT_ASSIGNMENT.has(source[j - 1] ?? "")) return null;
    } else if (op !== ":") {
      return null;
    } else if (source[j - 1] === ":") {
      return null; // `::`
    }
    j--;
    while (j >= 0 && /\s/.test(source[j]!)) j--;
    if (op === ":" && source[j] === "?") j--; // `owner?: '…'`
    const q = source[j];
    if (op === ":" && (q === '"' || q === "'")) {
      const open = source.lastIndexOf(q, j - 1);
      return open < 0 ? null : source.slice(open + 1, j);
    }
    const end = j + 1;
    while (j >= 0 && /[\w$]/.test(source[j]!)) j--;
    return end > j + 1 ? source.slice(j + 1, end) : null;
  };

  const skipLineComment = () => {
    while (i < n && source[i] !== "\n") i++;
  };
  const skipBlockComment = () => {
    const close = source.indexOf("*/", i + 2);
    const end = close < 0 ? n : close + 2;
    for (let k = i; k < end; k++) if (source[k] === "\n") line++;
    i = end;
  };

  /**
   * Reads the literal whose opening quote is at `i` (any prefix already consumed), leaves `i` after it,
   * keeps `line` current, and returns its text as segments with their starting line.
   */
  const readString = (prefix: string): TextLine[] => {
    const quote = source[i]!;
    let run = 1;
    while (source[i + run] === quote) run++;
    // Triple-quoted: Python ''' / """, C# raw """ (three or more). An empty "" is a run of 2.
    const verbatim = csharp && prefix.includes("@");
    const triple = (python && run >= 3) || (csharp && !verbatim && quote === '"' && run >= 3);
    const raw = (python && /r/i.test(prefix)) || verbatim || (csharp && triple);
    if (run === 2 && !triple) {
      i += 2;
      return [];
    }
    const width = triple ? (python ? 3 : run) : 1;
    i += width;
    const startLine = line;
    let text = "";
    while (i < n) {
      const ch = source[i]!;
      if (ch === quote) {
        if (verbatim && !triple && source[i + 1] === quote) {
          text += quote;
          i += 2;
          continue;
        }
        if (width === 1 || source.startsWith(quote.repeat(width), i)) {
          i += width;
          break;
        }
      }
      if (ch === "\\" && !(csharp && raw)) {
        const nx = source[i + 1] ?? "";
        if (nx === "\n") line++;
        text += raw || !/["'`\\]/.test(nx) ? ch + nx : nx;
        i += 2;
        continue;
      }
      if (ch === "\n") {
        line++;
        if (width === 1 && !verbatim) {
          i++;
          break; // unterminated single-line literal: stop at end of line
        }
      }
      text += ch;
      i++;
    }
    return [{ line: startLine, text }];
  };

  /** Skips a `${…}` expression from `i` (just after `${`) to just after its closing brace. */
  const skipExpression = () => {
    let depth = 1;
    while (i < n) {
      const ch = source[i]!;
      const next = source[i + 1];
      if (ch === "\n") line++;
      if (ch === "/" && next === "/") skipLineComment();
      else if (ch === "/" && next === "*") skipBlockComment();
      else if (ch === "`") readTemplate();
      else if (ch === '"' || ch === "'") readString("");
      else {
        if (ch === "{") depth++;
        if (ch === "}" && --depth === 0) {
          i++;
          return;
        }
        i++;
      }
    }
  };

  /** A template literal from its opening backtick at `i`: its static parts, `${…}` cutting between them. */
  const readTemplate = (): TextLine[] => {
    const segs: TextLine[] = [];
    i++;
    let segLine = line;
    let text = "";
    while (i < n) {
      const ch = source[i]!;
      if (ch === "`") {
        i++;
        break;
      }
      if (ch === "\\") {
        const nx = source[i + 1] ?? "";
        if (nx === "\n") line++;
        text += /[`\\$]/.test(nx) ? nx : ch + nx;
        i += 2;
        continue;
      }
      if (ch === "$" && source[i + 1] === "{") {
        segs.push({ line: segLine, text });
        i += 2;
        skipExpression();
        segLine = line;
        text = "";
        continue;
      }
      if (ch === "\n") line++;
      text += ch;
      i++;
    }
    segs.push({ line: segLine, text });
    return segs;
  };

  const emit = (segs: readonly TextLine[]) => {
    for (const seg of segs) {
      seg.text.split("\n").forEach((t, k) => {
        const text = t.replace(/\r$/, "");
        if (text.trim()) out.push({ line: seg.line + k, text });
      });
    }
  };

  while (i < n) {
    const ch = source[i]!;
    const next = source[i + 1];
    if (ch === "\n") {
      line++;
      i++;
      continue;
    }
    if (python ? ch === "#" : ch === "/" && next === "/") {
      skipLineComment();
      continue;
    }
    if (!python && ch === "/" && next === "*") {
      skipBlockComment();
      continue;
    }
    if (ch === '"' || ch === "'" || (ch === "`" && templates)) {
      // A prefix glued to the quote: Python r/b/f/u, C# @ and $. It is part of the literal.
      let start = i;
      if (python) while (start > 0 && /[rRbBfFuU]/.test(source[start - 1]!) && i - start < 2) start--;
      if (csharp) while (start > 0 && (source[start - 1] === "@" || source[start - 1] === "$")) start--;
      if (start < i && start > 0 && /[\w$]/.test(source[start - 1]!) && python) start = i; // part of a longer identifier
      const prefix = source.slice(start, i);
      const name = assignedTo(start);
      const segs = ch === "`" ? readTemplate() : readString(prefix);
      if (name !== null && names.has(name)) emit(segs);
      continue;
    }
    i++;
  }
  return out;
}
