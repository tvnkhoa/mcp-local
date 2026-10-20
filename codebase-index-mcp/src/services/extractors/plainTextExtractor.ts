/**
 * The plain-text lane (MCP-ISSUE-076): YAML, Dockerfiles, Makefiles, shell, nginx `.conf` /
 * `.template`, `.txt`, `.example`, `.code-workspace`, dotfile configs and JSONL — language `text`.
 *
 * A text file gets exactly one symbol, its `module` (minted by `extractGraphData`), and no edges. What
 * putting it in the index buys is reach: `search_regex` reads indexed files without `scanAll`, so a
 * CI workflow or a Dockerfile is found by the default call, and its quoted strings go to the literal
 * lane, so `search_literals("gd-020")` finds the eval case that names it in a `.jsonl`.
 *
 * What becomes a literal:
 *  - JSONL / NDJSON: every string VALUE of each line's JSON document (keys are schema, not content),
 *    on that line. A line that does not parse falls back to the quoted-string scan.
 *  - everything else: single-line `"…"` and `'…'` strings, outside `#` comments (every format here
 *    but `.txt` comments with `#`, and an apostrophe in a comment would otherwise open a string);
 *  - YAML additionally: plain (unquoted) scalar values — `image: postgres:16`, `- npm test` — since
 *    most YAML values carry no quotes at all.
 *
 * The same policy as the code lanes applies (`minLength`, `maxPerFile`, one row per distinct value per
 * file, values over 500 characters skipped as blobs). The source has already been through
 * `redactSensitive`, so a credential-shaped value is stored as `[REDACTED]`, as it is everywhere else.
 */

import type { StringLiteralRecord } from "../../types/index.js";
import type { ExtractInput } from "./extractorTypes.js";
import { stableId } from "./extractorPrimitives.js";

export type TextLiteralPolicy = { minLength: number; maxPerFile: number };

/** Longer values are embedded blobs (base64, a pasted dump), not text anyone searches for by value. */
const MAX_LITERAL_LENGTH = 500;

/** Candidates looked at per file before the cap is applied — a bound on work, far above any cap. */
const MAX_CANDIDATES = 20_000;

/** An identifier-shaped value: one token, no spaces, short — `gd-020`, `postgres:16-alpine`, `out_of_scope`. */
const TOKEN_LIKE = /^\S{1,80}$/;

/**
 * Collects literal rows for one file with the shared policy. Used by this lane and by the JSON lane,
 * so both spell `literalId` exactly as `literalExtractor.ts` does.
 *
 * The per-file cap is applied AFTER ranking, not in reading order. A data file is mostly prose
 * (`notes`, `input`, `must_not_contain` sentences), and in reading order the cap — 100 per file under
 * the `large` profile — ran out at line 9 of wec.aria's `evals/cases/guardrails.jsonl`, so the case
 * ids after it (`gd-020` is on line 20) never reached the lane. Identifier-shaped values are what a
 * literal search is for, so they go first; prose fills what is left, both in reading order.
 */
export class LiteralCollector {
  private readonly candidates: StringLiteralRecord[] = [];
  private readonly seen = new Set<string>();

  constructor(
    private readonly input: ExtractInput,
    private readonly policy: TextLiteralPolicy
  ) {}

  /** True once enough candidates are held that reading further is wasted work. */
  get full(): boolean {
    return this.candidates.length >= MAX_CANDIDATES;
  }

  add(raw: string, line: number): void {
    if (this.full) return;
    const value = raw.trim();
    if (value.length < this.policy.minLength || value.length > MAX_LITERAL_LENGTH) return;
    if (this.seen.has(value)) return;
    this.seen.add(value);
    this.candidates.push({
      repoId: this.input.repoId,
      literalId: stableId(`${this.input.repoId}:${this.input.filePath}:literal:${value}`),
      filePath: this.input.filePath,
      line,
      value,
      enclosingSymbolId: null,
      language: this.input.language,
      kind: "string"
    });
  }

  /** The rows to store: identifier-shaped values first, then the rest, capped at `maxPerFile`. */
  get rows(): StringLiteralRecord[] {
    if (this.candidates.length <= this.policy.maxPerFile) return this.candidates;
    const tokens = this.candidates.filter((c) => TOKEN_LIKE.test(c.value));
    const prose = this.candidates.filter((c) => !TOKEN_LIKE.test(c.value));
    return [...tokens, ...prose].slice(0, this.policy.maxPerFile);
  }
}

export function extractPlainText(input: ExtractInput, policy: TextLiteralPolicy): StringLiteralRecord[] {
  const collector = new LiteralCollector(input, policy);
  const lower = input.filePath.toLowerCase();
  const lines = input.source.split(/\r?\n/);

  if (/\.(jsonl|ndjson)$/.test(lower)) {
    for (let i = 0; i < lines.length && !collector.full; i += 1) {
      const text = lines[i]?.trim() ?? "";
      if (!text) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        scanQuoted(text, i + 1, false, collector);
        continue;
      }
      collectJsonStrings(parsed, i + 1, collector);
    }
    return collector.rows;
  }

  const hashComments = !lower.endsWith(".txt");
  const yaml = /\.ya?ml$/.test(lower);
  for (let i = 0; i < lines.length && !collector.full; i += 1) {
    const line = lines[i] ?? "";
    const code = scanQuoted(line, i + 1, hashComments, collector);
    if (yaml) collectYamlPlainScalar(code, i + 1, collector);
  }
  return collector.rows;
}

/** Every string value in a parsed JSON document, depth-first, all on one line number. */
export function collectJsonStrings(value: unknown, line: number, collector: LiteralCollector): void {
  if (collector.full) return;
  if (typeof value === "string") {
    collector.add(value, line);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectJsonStrings(item, line, collector);
    return;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) collectJsonStrings(item, line, collector);
  }
}

/**
 * Add the single-line quoted strings of `line` and return the line's code part (before any `#`
 * comment), which the YAML pass reads. A quote left open at the end of the line is not a string.
 */
function scanQuoted(line: string, lineNumber: number, hashComments: boolean, collector: LiteralCollector): string {
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    if (hashComments && ch === "#" && (i === 0 || /\s/.test(line[i - 1] ?? ""))) {
      return line.slice(0, i);
    }
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      let value = "";
      let closed = false;
      while (j < line.length) {
        const c = line[j];
        if (c === "\\" && ch === '"' && j + 1 < line.length) {
          value += line[j + 1];
          j += 2;
          continue;
        }
        if (c === ch) {
          closed = true;
          break;
        }
        value += c;
        j += 1;
      }
      if (!closed) return line;
      collector.add(value, lineNumber);
      i = j + 1;
      continue;
    }
    i += 1;
  }
  return line;
}

/** `key: value` / `- value` with an unquoted scalar value. Flow collections and block markers are skipped. */
function collectYamlPlainScalar(code: string, lineNumber: number, collector: LiteralCollector): void {
  const match = /^\s*(?:-\s+)?(?:[\w.$/-]+\s*:\s+)?(.+?)\s*$/.exec(code);
  if (!match) return;
  const value = match[1] ?? "";
  // Quoted values were taken by the quoted scan; flow collections, block scalars, anchors and the
  // key-only line (`steps:`) are not values.
  if (/^["'[{|>&*!]/.test(value) || value.endsWith(":")) return;
  // A line that is only a key with a nested block (`jobs:`) has no captured value after the key.
  if (!/:\s/.test(code) && !/^\s*-\s/.test(code)) return;
  collector.add(value, lineNumber);
}
