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

/**
 * How the registry defines a name, strongest first (wec.aria's review of release D's reverse queue):
 * a table row's first cell (several names split on `,` and `/`); a heading naming it in backticks
 * (`### 4.12 task_type`); a backticked name inside another cell of a row (an element field described
 * in its parent's row); a backticked name in prose (a name a mapping section mints).
 */
export type DefinitionKind = "row" | "heading" | "nested" | "prose";
const KIND_RANK: Record<DefinitionKind, number> = { row: 0, heading: 1, nested: 2, prose: 3 };

export type RegistryRow = { line: number; section: string | null; sectionLine: number | null; definedBy: DefinitionKind; text: string };
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
  // `\|` is a pipe inside a cell (`string \| null`), not a separator.
  return t.replace(/^\|/, "").replace(/(?<!\\)\|\s*$/, "").split(/(?<!\\)\|/).map((c) => c.trim());
}

const IDENT = /^[A-Za-z_$][\w$]*$/;

/** First-cell names: `` `a`, `b` `` and `a / b` define each. */
function definedNames(cells: readonly string[]): string[] {
  return cellKey(cells[0] ?? "").split(/\s*[,/]\s*/).filter((n) => IDENT.test(n));
}

/** Identifiers inside backtick spans: `` `{ document_id, then_version_id }` `` names both. */
function backtickedNames(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/`([^`]+)`/g)) {
    for (const tok of m[1]!.split(/[^\w$]+/)) if (IDENT.test(tok)) out.push(tok);
  }
  return out;
}

/** Every name one line defines, each with its strongest kind. */
function lineDefinitions(text: string, isHeading: boolean): Map<string, DefinitionKind> {
  const out = new Map<string, DefinitionKind>();
  const put = (name: string, kind: DefinitionKind) => {
    const had = out.get(name);
    if (!had || KIND_RANK[kind] < KIND_RANK[had]) out.set(name, kind);
  };
  if (isHeading) {
    for (const n of backtickedNames(text)) put(n, "heading");
    return out;
  }
  const cells = tableCells(text);
  if (cells) {
    for (const n of definedNames(cells)) put(n, "row");
    for (const c of cells.slice(1)) for (const n of backtickedNames(c)) put(n, "nested");
    return out;
  }
  for (const n of backtickedNames(text)) put(n, "prose");
  return out;
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
  const headingLines = new Set(headings.map((h) => h.line));
  const definitions: RegistryRow[] = [];
  const mentions: RegistryMention[] = [];
  let mentionCount = 0;
  for (const { line, text } of proseLines(lines)) {
    if (!word.test(text)) continue;
    const sec = sectionAt(headings, line);
    const kind = lineDefinitions(text, headingLines.has(line)).get(term);
    if (kind) {
      definitions.push({ line, section: sec?.text ?? null, sectionLine: sec?.line ?? null, definedBy: kind, text: text.trim().slice(0, MAX_TEXT) });
      continue;
    }
    if (headingLines.has(line)) continue;
    mentionCount++;
    if (mentions.length < maxMentions) mentions.push({ line, section: sec?.text ?? null, text: text.trim().slice(0, MAX_TEXT) });
  }
  // A nested or prose naming defines the name only when no row or heading does; beside one, it is a
  // mention (docs/10 §3.7's `citations` row names `kb_version_ids`, which §3.13's row defines).
  const strong = definitions.filter((d) => d.definedBy === "row" || d.definedBy === "heading");
  if (strong.length === 0 || strong.length === definitions.length) {
    definitions.sort((a, b) => KIND_RANK[a.definedBy] - KIND_RANK[b.definedBy] || a.line - b.line);
    return { definitions, mentions, mentionCount };
  }
  const demoted = definitions.filter((d) => !strong.includes(d));
  mentionCount += demoted.length;
  const allMentions = [...mentions, ...demoted.map((d) => ({ line: d.line, section: d.section, text: d.text }))].sort((a, b) => a.line - b.line);
  return { definitions: strong.sort((a, b) => KIND_RANK[a.definedBy] - KIND_RANK[b.definedBy] || a.line - b.line), mentions: allMentions.slice(0, maxMentions), mentionCount };
}

/** Every name the registry defines, with its strongest kind and that line — for the reverse report. */
export function registryDefinedNames(lines: readonly string[]): Map<string, { kind: DefinitionKind; line: number }> {
  const headingLines = new Set(listHeadings(lines).map((h) => h.line));
  const out = new Map<string, { kind: DefinitionKind; line: number }>();
  for (const { line, text } of proseLines(lines)) {
    for (const [name, kind] of lineDefinitions(text, headingLines.has(line))) {
      const had = out.get(name);
      if (!had || KIND_RANK[kind] < KIND_RANK[had.kind]) out.set(name, { kind, line });
    }
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
const LOWER_WORD = /^[a-z][a-z0-9]*$/;

export type ReverseRow = { key: string; confidence: "high" | "medium"; reason: string; declaredAt: { filePath: string; line: number; owner: string | null }[] };

export type ReverseReport = {
  keysScanned: number;
  /** Keys the registry defines, by the strongest way it does. */
  defined: Record<DefinitionKind, number>;
  ignored: number;
  missing: ReverseRow[];
};

/**
 * Schema keys with no registry definition of any kind. Scanned: every snake_case key, and every
 * lower-case key of a schema that has at least one snake_case key (`wants` beside `aria_did`).
 * `high`: the registry never names it; `medium`: it is named, bare, but nothing defines it.
 * `ignore` is the repo's `termIgnore` — names it cannot rename (an external API's `json_schema`).
 */
export function reverseReport(keys: readonly SchemaKey[], registryLines: readonly string[], ignore: readonly string[] = []): ReverseReport {
  const defined = registryDefinedNames(registryLines);
  const text = proseLines(registryLines).map((l) => l.text).join("\n");
  const snakeOwners = new Set(keys.filter((k) => SNAKE.test(k.key)).map((k) => `${k.filePath}#${k.owner ?? ""}`));
  const ignored = new Set(ignore);
  const byKey = new Map<string, SchemaKey[]>();
  for (const k of keys) {
    if (!SNAKE.test(k.key) && !(LOWER_WORD.test(k.key) && snakeOwners.has(`${k.filePath}#${k.owner ?? ""}`))) continue;
    const list = byKey.get(k.key) ?? [];
    list.push(k);
    byKey.set(k.key, list);
  }
  const missing: ReverseRow[] = [];
  const definedCount: Record<DefinitionKind, number> = { row: 0, heading: 0, nested: 0, prose: 0 };
  let ignoredCount = 0;
  for (const [key, decls] of byKey) {
    if (ignored.has(key)) {
      ignoredCount++;
      continue;
    }
    const def = defined.get(key);
    if (def) {
      definedCount[def.kind]++;
      continue;
    }
    const named = new RegExp(`(?<![\\w$])${escapeRegex(key)}(?![\\w$])`).test(text);
    missing.push({
      key,
      confidence: named ? "medium" : "high",
      reason: named ? "named in the registry, but never in a row, a heading or backticks" : "the registry never names it",
      declaredAt: decls.slice(0, 5).map((d) => ({ filePath: d.filePath, line: d.line, owner: d.owner }))
    });
  }
  missing.sort((a, b) => (a.confidence === b.confidence ? a.key.localeCompare(b.key) : a.confidence === "high" ? -1 : 1));
  return { keysScanned: byKey.size, defined: definedCount, ignored: ignoredCount, missing };
}
