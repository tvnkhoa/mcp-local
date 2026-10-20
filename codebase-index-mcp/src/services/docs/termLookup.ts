/**
 * Release D (R4) — `query_docs{ mode:"term" }`: one canonical name, answered from three places.
 *
 *   - the registry doc the repo names in `.codebase-index/citations.json` (`registryDoc`): the
 *     field-table rows that DEFINE the name (first cell is the name) and the lines that only mention it;
 *   - the Zod schema shapes that declare it as a key;
 *   - (the handler adds) its typed reads and writes.
 *
 * Without a term, the reverse report: schema keys the registry has no row for, as a review queue.
 *
 * Pure — text in, records out — and lexical. A schema key here is a `key: z.…` / `key: x_schema…`
 * line in a file that imports zod, owned by the nearest `const NAME =` above it at column 0. That is
 * a declaration finder for the review queue, not a type resolution; reads and writes come from the
 * typed path (`find_field_accesses`).
 */

import { listHeadings, type DocHeading } from "../analysis/docSection.js";

export type RegistryRow = { line: number; section: string | null; sectionLine: number | null; cells: string[]; text: string };
export type RegistryMention = { line: number; section: string | null; text: string };
export type SchemaKey = { key: string; filePath: string; line: number; owner: string | null };

const MAX_TEXT = 600;
const FENCE = /^\s{0,3}(`{3,}|~{3,})/;

function cellKey(cell: string): string {
  return cell.replace(/[`*~]/g, "").trim();
}

/** Table cells of a markdown row; null when the line is not a row or is the separator. */
function tableCells(line: string): string[] | null {
  const t = line.trim();
  if (!t.startsWith("|")) return null;
  if (/^\|?\s*:?-{2,}/.test(t)) return null;
  return t.replace(/^\|/, "").replace(/\|\s*$/, "").split("|").map((c) => c.trim());
}

/** First cell as a bare identifier (`` `kb_version_ids` `` → kb_version_ids), or null. */
function definedName(cells: readonly string[]): string | null {
  const first = cellKey(cells[0] ?? "");
  return /^[A-Za-z_$][\w$]*$/.test(first) ? first : null;
}

function sectionAt(headings: readonly DocHeading[], line: number): DocHeading | null {
  let hit: DocHeading | null = null;
  for (const h of headings) {
    if (h.line > line) break;
    hit = h;
  }
  return hit;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Lines outside fenced code, 1-based. */
function proseLines(lines: readonly string[]): { line: number; text: string }[] {
  const out: { line: number; text: string }[] = [];
  let fence: string | null = null;
  lines.forEach((text, idx) => {
    const f = FENCE.exec(text);
    if (f) {
      const marker = f[1]![0]!;
      fence = fence === null ? marker : marker === fence ? null : fence;
      return;
    }
    if (fence === null) out.push({ line: idx + 1, text });
  });
  return out;
}

/** Where the registry defines `term` (a table row whose first cell is it) and where it only mentions it. */
export function registryEntries(lines: readonly string[], term: string, maxMentions: number): { definitions: RegistryRow[]; mentions: RegistryMention[]; mentionCount: number } {
  const headings = listHeadings(lines);
  const word = new RegExp(`(?<![\\w$])${escapeRegex(term)}(?![\\w$])`);
  const definitions: RegistryRow[] = [];
  const mentions: RegistryMention[] = [];
  let mentionCount = 0;
  for (const { line, text } of proseLines(lines)) {
    if (!word.test(text)) continue;
    const sec = sectionAt(headings, line);
    const cells = tableCells(text);
    if (cells && definedName(cells) === term) {
      definitions.push({ line, section: sec?.text ?? null, sectionLine: sec?.line ?? null, cells, text: text.trim().slice(0, MAX_TEXT) });
      continue;
    }
    if (headings.some((h) => h.line === line)) continue;
    mentionCount++;
    if (mentions.length < maxMentions) mentions.push({ line, section: sec?.text ?? null, text: text.trim().slice(0, MAX_TEXT) });
  }
  return { definitions, mentions, mentionCount };
}

/** Every name the registry defines (first cell of a table row), with its line — for the reverse report. */
export function registryDefinedNames(lines: readonly string[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const { line, text } of proseLines(lines)) {
    const cells = tableCells(text);
    const name = cells ? definedName(cells) : null;
    if (name && !out.has(name)) out.set(name, line);
  }
  return out;
}

const IMPORTS_ZOD = /\bfrom\s+['"]zod(?:\/[\w/]+)?['"]|\brequire\(\s*['"]zod['"]\s*\)/;
const KEY_LINE = /^\s*(['"]?)([A-Za-z_$][\w$]*)\1\s*:\s*(.*)$/;
const ZOD_VALUE = /^(?:z\b|[A-Za-z_$][\w$]*(?:_schema|Schema)\b)/;
const OWNER_LINE = /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]*)?=/;

/** True when the file imports zod — only those files can declare a schema key. */
export function importsZod(source: string): boolean {
  return IMPORTS_ZOD.test(source);
}

/**
 * Zod shape keys of one file: `key: z.…` or `key: other_schema…`, owned by the nearest column-0
 * `const NAME =` above. A value that starts on the next line (`key:\n  z.string()`) is followed one line.
 */
export function schemaKeys(source: string, filePath: string): SchemaKey[] {
  if (!importsZod(source)) return [];
  const lines = source.split(/\r?\n/);
  const out: SchemaKey[] = [];
  let owner: string | null = null;
  let inBlockComment = false;
  lines.forEach((text, idx) => {
    if (inBlockComment) {
      if (text.includes("*/")) inBlockComment = false;
      return;
    }
    if (/^\s*\/\*/.test(text) && !text.includes("*/")) {
      inBlockComment = true;
      return;
    }
    const o = OWNER_LINE.exec(text);
    if (o) owner = o[1]!;
    const m = KEY_LINE.exec(text);
    if (!m) return;
    const value = m[3]!.trim() || (lines[idx + 1] ?? "").trim();
    if (!ZOD_VALUE.test(value)) return;
    out.push({ key: m[2]!, filePath, line: idx + 1, owner });
  });
  return out;
}

/** `### 3.13 Audit event` → `audit_event`; the owner it names starts with this. */
export function sectionStem(section: string | null): string | null {
  if (!section) return null;
  const words = section.replace(/[`*]/g, "").replace(/^[\d.]+[a-z]?\s+/i, "").trim().toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  return words.length > 0 ? words.join("_") : null;
}

/** Whether a schema key's owner is the entity a registry row sits under (`audit_event_common_fields` ~ "3.13 Audit event"). */
export function ownerMatchesSection(owner: string | null, section: string | null): boolean {
  const stem = sectionStem(section);
  return Boolean(owner && stem && owner.toLowerCase().startsWith(stem));
}

const SNAKE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/;

export type ReverseRow = { key: string; confidence: "high" | "medium"; reason: string; declaredAt: { filePath: string; line: number; owner: string | null }[] };

/**
 * Snake_case schema keys with no registry row. `high`: the registry never names it; `medium`: it is
 * named in prose or another cell but has no row of its own (often a key that belongs to a nested
 * shape the registry documents inline).
 */
export function reverseReport(keys: readonly SchemaKey[], registryLines: readonly string[]): { keysScanned: number; defined: number; missing: ReverseRow[] } {
  const defined = registryDefinedNames(registryLines);
  const text = proseLines(registryLines).map((l) => l.text).join("\n");
  const byKey = new Map<string, SchemaKey[]>();
  for (const k of keys) {
    if (!SNAKE.test(k.key)) continue;
    const list = byKey.get(k.key) ?? [];
    list.push(k);
    byKey.set(k.key, list);
  }
  const missing: ReverseRow[] = [];
  let definedCount = 0;
  for (const [key, decls] of byKey) {
    if (defined.has(key)) {
      definedCount++;
      continue;
    }
    const named = new RegExp(`(?<![\\w$])${escapeRegex(key)}(?![\\w$])`).test(text);
    missing.push({
      key,
      confidence: named ? "medium" : "high",
      reason: named ? "named in the registry, but no table row defines it" : "the registry never names it",
      declaredAt: decls.slice(0, 5).map((d) => ({ filePath: d.filePath, line: d.line, owner: d.owner }))
    });
  }
  missing.sort((a, b) => (a.confidence === b.confidence ? a.key.localeCompare(b.key) : a.confidence === "high" ? -1 : 1));
  return { keysScanned: byKey.size, defined: definedCount, missing };
}
