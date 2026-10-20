/**
 * `query_docs{ mode:"section" }` — one document section by heading prefix, under a token budget.
 *
 * Agents in wec.aria read docs with `sed -n 1,40p` about 1 170 times, plus a home-grown script that
 * cuts sections out by heading prefix. Line numbers go stale with every edit to the text above them;
 * a heading does not. So the address is the heading, never a line, and an address that matches
 * nothing is an error naming the nearest headings — not an empty section that reads as "says nothing".
 *
 * Reads the file as it is on disk, not the indexed copy: a section is text, and the current text is
 * the answer even when the index is behind. Pure apart from the caller's file read.
 */

export type DocHeading = { text: string; level: number; line: number };

export type DocSectionResult = {
  heading: string;
  level: number;
  startLine: number;
  /** Last line returned. Equals `sectionEndLine` unless the budget cut the section short. */
  endLine: number;
  sectionEndLine: number;
  text: string;
  truncated: boolean;
  /** First line NOT included when `truncated`; read on from here, or ask for a subsection. */
  truncatedAtLine?: number;
  estimatedTokens: number;
  subsections: DocHeading[];
  /** Other headings the same prefix matched, when it was not unique. */
  otherMatches: DocHeading[];
};

const FENCE = /^\s{0,3}(`{3,}|~{3,})/;
const ATX = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const SETEXT_1 = /^\s{0,3}=+\s*$/;
const SETEXT_2 = /^\s{0,3}-+\s*$/;

/** ATX and setext headings outside fenced code, 1-based lines. */
export function listHeadings(lines: readonly string[]): DocHeading[] {
  const out: DocHeading[] = [];
  let fence: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const f = FENCE.exec(line);
    if (f) {
      const marker = f[1]!;
      if (fence === null) fence = marker[0]!;
      else if (marker[0] === fence) fence = null;
      continue;
    }
    if (fence !== null) continue;
    const atx = ATX.exec(line);
    if (atx) {
      out.push({ text: atx[2]!, level: atx[1]!.length, line: i + 1 });
      continue;
    }
    const next = lines[i + 1] ?? "";
    if (line.trim() !== "" && !/^\s{0,3}[-*_>|]/.test(line) && (SETEXT_1.test(next) || SETEXT_2.test(next))) {
      out.push({ text: line.trim(), level: SETEXT_1.test(next) ? 1 : 2, line: i + 1 });
      i += 1;
    }
  }
  return out;
}

/** Case-insensitive, and blind to inline markup, so `` `tenant`, not `dealer` `` matches "tenant, not". */
function normalizeHeading(s: string): string {
  return s.replace(/[`*_]/g, "").replace(/\s+/g, " ").trim().toLowerCase();
}

export function matchHeadings(headings: readonly DocHeading[], prefix: string): DocHeading[] {
  const p = normalizeHeading(prefix);
  const matches = headings.filter((h) => normalizeHeading(h.text).startsWith(p));
  // An exact heading beats a longer one that merely starts with it ("3.7" vs "3.70").
  const exact = matches.filter((h) => normalizeHeading(h.text) === p);
  return exact.length > 0 ? [...exact, ...matches.filter((h) => !exact.includes(h))] : matches;
}

/** Headings that contain the prefix anywhere, then the top-level outline — what to say on a miss. */
export function nearestHeadings(headings: readonly DocHeading[], prefix: string, max = 10): DocHeading[] {
  const p = normalizeHeading(prefix);
  const words = p.split(" ").filter((w) => w.length > 2);
  const containing = headings.filter((h) => {
    const t = normalizeHeading(h.text);
    return t.includes(p) || (words.length > 0 && words.every((w) => t.includes(w)));
  });
  if (containing.length > 0) return containing.slice(0, max);
  const top = Math.min(...headings.map((h) => h.level));
  return headings.filter((h) => h.level <= top + 1).slice(0, max);
}

export function extractSection(lines: readonly string[], headings: readonly DocHeading[], target: DocHeading, maxTokens: number, otherMatches: DocHeading[]): DocSectionResult {
  const after = headings.filter((h) => h.line > target.line);
  const end = after.find((h) => h.level <= target.level);
  const endLine = end ? end.line - 1 : lines.length;
  const subsections = after.filter((h) => h.line <= endLine);

  const budgetChars = Math.max(1, maxTokens) * 4;
  const kept: string[] = [];
  let used = 0;
  let truncatedAtLine: number | undefined;
  for (let n = target.line; n <= endLine; n++) {
    const line = lines[n - 1] ?? "";
    // Always keep the heading line itself; past it, stop at the first line that would overflow.
    if (kept.length > 0 && used + line.length + 1 > budgetChars) {
      truncatedAtLine = n;
      break;
    }
    kept.push(line);
    used += line.length + 1;
  }
  const text = kept.join("\n").replace(/\s+$/, "");
  return {
    heading: target.text,
    level: target.level,
    startLine: target.line,
    endLine: truncatedAtLine === undefined ? endLine : truncatedAtLine - 1,
    sectionEndLine: endLine,
    text,
    truncated: truncatedAtLine !== undefined,
    ...(truncatedAtLine !== undefined && { truncatedAtLine }),
    estimatedTokens: Math.ceil(text.length / 4),
    subsections,
    otherMatches
  };
}
