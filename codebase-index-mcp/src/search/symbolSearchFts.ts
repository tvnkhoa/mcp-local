/**
 * The FTS5 query layer: turning a user's query string into something SQLite will match, and
 * the ranking constants that decide which of several namesakes wins.
 *
 * `buildFtsQuery` and `buildIntentFtsQuery` are the two dialects behind strategy "name" and
 * strategy "intent". The ranking constants live here rather than with the searches because the
 * bonus and the penalty are calibrated against each other -- TEST_PATH_PENALTY has to outweigh
 * RANKED_KIND_BONUS plus a few positions of tie-break, or a test stub outranks production code.
 */

import type Database from "better-sqlite3";
import { indexLog, indexWarn } from "../indexing/indexProgress.js";

// Kinds that carry graph edges / are usually what a developer means; ranked above
// edgeless namesakes (constructor shares the class name, module shares the file name).
// `record` / `record struct` are class-like (CQRS commands/queries are records) — they were
// indexed as `class` before ISSUE-015, so list them here to keep the same ranking parity.
export const RANKED_KIND_BONUS = ["method", "function", "class", "interface", "struct", "record", "record struct"];

// ISSUE-024: rank penalty cho test paths khi ranked=true. Phải lớn hơn RANKED_KIND_BONUS (0.03)
// cộng vài bậc position penalty (0.01/bậc) để production thắng stub cùng coverage, nhưng đủ nhỏ
// để test file có token coverage TỐT HƠN thật sự (sort key chính) vẫn xếp trên.
export const TEST_PATH_PENALTY = 0.08;

// SQL ORDER-BY fragment: prefer substantive kinds over their edgeless namesakes when
// names tie (e.g. class before its same-named constructor). `col` is the qualified column.
export const kindPriorityOrder = (col: string): string =>
  `case ${col}
     when 'class' then 0 when 'record' then 0 when 'interface' then 1
     when 'struct' then 2 when 'record struct' then 2
     when 'method' then 3 when 'function' then 4
     when 'constructor' then 8 when 'module' then 9
     else 5
   end`;

// ── FTS query builders ─────────────────────────────────────────────────

export function buildFtsQuery(query: string): string {
  const raw = query.trim();

  const spaceTokens = raw.split(/\s+/).filter((t) => t.length >= 2);

  if (spaceTokens.length === 1) {
    const pascal = raw.replace(/([A-Z][a-z]+|[A-Z]{2,}(?=[A-Z][a-z]|$)|[A-Z]{2,})/g, " $1").trim().split(/\s+/).filter((t) => t.length >= 2);
    if (pascal.length > 1) {
      const andClause = pascal.map((t) => `"${t.replace(/"/g, '""')}"*`).join(" ");
      return `(${andClause}) OR "${raw.replace(/"/g, '""')}"*`;
    }
    const q = raw.replace(/"/g, '""');
    return `"${q}"*`;
  }

  const andClause = spaceTokens.map((t) => `"${t.replace(/"/g, '""')}"*`).join(" ");

  const expandedTokens = new Set<string>(spaceTokens);
  for (const tok of spaceTokens) {
    const pascal = tok.replace(/([A-Z][a-z]+|[A-Z]{2,}(?=[A-Z][a-z]|$)|[A-Z]{2,})/g, " $1").trim().split(/\s+/).filter((t) => t.length >= 2);
    for (const p of pascal) expandedTokens.add(p);
    const snakeParts = tok.split("_").filter((t) => t.length >= 2);
    for (const p of snakeParts) expandedTokens.add(p);
  }

  if (expandedTokens.size > spaceTokens.length) {
    const orClause = [...expandedTokens].map((t) => `"${t.replace(/"/g, '""')}"*`).join(" OR ");
    return `(${andClause}) OR (${orClause})`;
  }

  return andClause;
}

export function extractIntentTokens(query: string): string[] {
  const rawTokens = query
    .split(/[^\p{L}\p{N}_]+/u)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2);

  const expanded = new Set<string>();
  for (const token of rawTokens) {
    expanded.add(token);
    const pascalParts = token
      .replace(/([A-Z][a-z]+|[A-Z]{2,}(?=[A-Z][a-z]|$)|[A-Z]{2,})/g, " $1")
      .trim()
      .split(/\s+/)
      .filter((t) => t.length >= 2);
    for (const part of pascalParts) {
      expanded.add(part);
    }
    const snakeParts = token.split("_").filter((t) => t.length >= 2);
    for (const part of snakeParts) {
      expanded.add(part);
    }
  }

  return [...expanded].slice(0, 12);
}

export function buildIntentFtsQuery(query: string): string {
  const tokens = extractIntentTokens(query);
  if (tokens.length === 0) {
    return buildFtsQuery(query);
  }

  return tokens.map((t) => `"${t.replace(/"/g, '""')}"*`).join(" OR ");
}

// ── rebuildFts ─────────────────────────────────────────────────────────

export function rebuildFtsImpl(db: Database.Database): void {
  const start = Date.now();
  try {
    db.exec(`insert into symbols_fts(symbols_fts) values('rebuild')`);
    db.exec(`insert into symbols_fts(symbols_fts) values('optimize')`);
    const elapsed = Date.now() - start;
    indexLog(`[index-fts] rebuilt symbols_fts in ${elapsed}ms`);
  } catch (e) {
    indexWarn(`[index-fts-error] symbols_fts rebuild failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ── searchSymbols ──────────────────────────────────────────────────────
