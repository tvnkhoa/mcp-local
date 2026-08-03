/**
 * Candidate resolution for a bare name: score every symbol that could be meant, and say how
 * confident the best match is.
 *
 * Separate from `search_symbols` because the question is different -- not "what matches this
 * query" but "which single symbol did the caller mean" -- and a wrong answer here silently
 * points a later tool call at the wrong symbol.
 */

import type Database from "better-sqlite3";
import type { SymbolRecord } from "../../types/index.js";
import { isTestPath } from "../indexing/fileFilter.js";
import { RANKED_KIND_BONUS, TEST_PATH_PENALTY, extractIntentTokens } from "./symbolSearchFts.js";

export function getSymbolCandidatesImpl(
  db: Database.Database,
  repoId: string,
  name: string,
  limit: number,
  strategy: "name" | "intent" = "name",
  filters: { kind?: string | null; language?: string | null; filePath?: string | null; excludeTests?: boolean } = {}
): {
  symbolId: string;
  name: string;
  kind: string;
  filePath: string;
  line: number;
  signature: string | null;
  /** ISSUE-024: "EnclosingType.Member" khi symbol có parent (C# methods/properties) — phân biệt 20 hit cùng tên Handle. */
  qualifiedName?: string;
  matchType: "exact" | "prefix" | "contains";
  score: number;
  confidence: number;
}[] {
  // Filter clauses (kind/language/filePath) — previously dropped on the ranked path.
  const filterConds: string[] = [];
  const filterParams: unknown[] = [];
  const langJoin = filters.language
    ? "inner join files f on f.repo_id = s.repo_id and f.path = s.file_path"
    : "";
  if (filters.language) {
    filterConds.push("f.language = ?");
    filterParams.push(filters.language);
  }
  if (filters.kind) {
    filterConds.push("s.kind = ?");
    filterParams.push(filters.kind);
  }
  if (filters.filePath) {
    filterConds.push("s.file_path like ?");
    filterParams.push(`%${filters.filePath}%`);
  }
  const filterWhere = filterConds.length > 0 ? `and ${filterConds.join(" and ")}` : "";

  const tokens = strategy === "intent" ? extractIntentTokens(name) : [];

  // Intent: OR the tokens across name+signature (mirrors searchSymbolsImpl's intent branch),
  // then rank by token coverage. Without this, a multi-word query falls to the substring
  // path below and matches nothing (no symbol name contains the whole phrase) → 0 results.
  if (strategy === "intent" && tokens.length > 0) {
    // ISSUE-024: parent (enclosing type) name tham gia pre-filter + scoring haystack — token
    // domain ("ConversationAssigned") match vào tên CLASS của member tên generic (Handle).
    const tokenClauses = tokens.map(() => "(s.name like ? or s.signature like ? or p.name like ?)").join(" or ");
    const tokenParams: string[] = [];
    for (const t of tokens) tokenParams.push(`%${t}%`, `%${t}%`, `%${t}%`);
    const fetchLimit = Math.min(Math.max(limit * 4, 50), 500);
    const allRows = db
      .prepare(
        `
        select s.repo_id as repoId, s.symbol_id as symbolId, s.file_path as filePath,
               s.name, s.kind, s.line, s.signature, p.name as parentName
        from symbols s
        left join symbols p on p.repo_id = s.repo_id and p.symbol_id = s.parent_symbol_id
        ${langJoin}
        where s.repo_id = ? and (${tokenClauses}) ${filterWhere}
        order by length(s.name)
        limit ?
        `
      )
      .all(repoId, ...tokenParams, ...filterParams, fetchLimit) as (SymbolRecord & { parentName?: string | null })[];
    const rows = filters.excludeTests ? allRows.filter((r) => !isTestPath(r.filePath)) : allRows;

    const lowerTokens = tokens.map((t) => t.toLowerCase());
    const scored = rows.map((row) => {
      const hay = `${row.name} ${row.signature ?? ""} ${row.parentName ?? ""}`.toLowerCase();
      const matched = lowerTokens.filter((t) => hay.includes(t)).length;
      const coverage = matched / lowerTokens.length;
      const kindBonus = RANKED_KIND_BONUS.includes(row.kind) ? 0.03 : 0;
      const testPenalty = isTestPath(row.filePath) ? TEST_PATH_PENALTY : 0;
      const confidenceRaw = Math.max(0, Math.min(1, 0.5 + 0.45 * coverage + kindBonus - testPenalty));
      const matchType: "exact" | "prefix" | "contains" = coverage >= 1 ? "exact" : "contains";
      return { row, matched, matchType, confidenceRaw };
    });
    scored.sort(
      (a, b) =>
        b.matched - a.matched ||
        b.confidenceRaw - a.confidenceRaw ||
        a.row.name.length - b.row.name.length ||
        a.row.name.localeCompare(b.row.name)
    );
    return scored.slice(0, limit).map(({ row, matchType, confidenceRaw }, index) => {
      const confidence = Math.max(0, Math.min(1, confidenceRaw - Math.min(index * 0.01, 0.2)));
      return {
        symbolId: row.symbolId,
        name: row.name,
        kind: row.kind,
        filePath: row.filePath,
        line: row.line,
        signature: row.signature ?? null,
        ...(row.parentName ? { qualifiedName: `${row.parentName}.${row.name}` } : {}),
        matchType,
        score: Math.round(confidence * 100),
        confidence
      };
    });
  }

  // strategy === "name" (default) — substring/exact ranking, behavior preserved.
  // excludeTests post-filter có thể loại bớt rows nên over-fetch x2 để vẫn lấp đủ limit.
  const fetchLimit = filters.excludeTests ? limit * 2 : limit;
  const allRows = db
    .prepare(
      `
      select s.repo_id as repoId, s.symbol_id as symbolId, s.file_path as filePath,
             s.name, s.kind, s.line, s.signature, p.name as parentName
      from symbols s
      left join symbols p on p.repo_id = s.repo_id and p.symbol_id = s.parent_symbol_id
      ${langJoin}
      where s.repo_id = ? and (s.name = ? or s.name like ?) ${filterWhere}
      order by
        case
          when lower(s.name) = lower(?) then 0
          when lower(s.name) like lower(?) then 1
          else 2
        end,
        length(s.name),
        s.file_path,
        s.line
      limit ?
      `
    )
    .all(repoId, name, `%${name}%`, ...filterParams, name, `${name}%`, fetchLimit) as (SymbolRecord & { parentName?: string | null })[];
  const rows = (filters.excludeTests ? allRows.filter((r) => !isTestPath(r.filePath)) : allRows).slice(0, limit);

  const normalizedQuery = name.toLowerCase();
  return rows.map((row, index) => {
    const normalizedName = row.name.toLowerCase();
    const matchType: "exact" | "prefix" | "contains" =
      normalizedName === normalizedQuery
        ? "exact"
        : normalizedName.startsWith(normalizedQuery)
          ? "prefix"
          : "contains";

    const base = matchType === "exact" ? 0.96 : matchType === "prefix" ? 0.88 : 0.72;
    const kindBonus = RANKED_KIND_BONUS.includes(row.kind) ? 0.03 : 0;
    const testPenalty = isTestPath(row.filePath) ? TEST_PATH_PENALTY : 0;
    const positionPenalty = Math.min(index * 0.01, 0.2);
    const confidence = Math.max(0, Math.min(1, base + kindBonus - testPenalty - positionPenalty));

    return {
      symbolId: row.symbolId,
      name: row.name,
      kind: row.kind,
      filePath: row.filePath,
      line: row.line,
      signature: row.signature ?? null,
      ...(row.parentName ? { qualifiedName: `${row.parentName}.${row.name}` } : {}),
      matchType,
      score: Math.round(confidence * 100),
      confidence
    };
  });
}
