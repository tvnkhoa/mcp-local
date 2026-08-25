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
import { isMigrationSymbol, isTestPath } from "../indexing/fileFilter.js";
import { RANKED_KIND_BONUS, TEST_PATH_PENALTY, extractIntentTokens } from "./symbolSearchFts.js";

/**
 * How far a row is pushed down the intent ranking regardless of how well it matches (MCP-ISSUE-049).
 *
 * `0` production code · `1` test paths · `2` EF migrations. Migrations rank below tests deliberately:
 * a test at least exercises the behaviour asked about, whereas a migration only mentions the words.
 *
 * This is a *tier*, not a score, because a score cannot win against `matched`. See the sort below.
 */
function demotionTierFor(row: SymbolRecord & { parentName?: string | null }): 0 | 1 | 2 {
  if (isMigrationSymbol(row.filePath, row.name, row.parentName)) return 2;
  if (isTestPath(row.filePath)) return 1;
  return 0;
}

/**
 * MCP-ISSUE-060: `repoId` is nullable, meaning "every indexed repo".
 *
 * `search_symbols({ranked:true})` without a `repoId` returned 0 results for every query and every
 * strategy — while dropping `ranked` made cross-repo search work, and adding `repoId` made `ranked`
 * work. Only the combination failed, and it failed silently: a well-formed empty response,
 * indistinguishable from "this symbol exists nowhere". The cause was the handler passing
 * `args.repoId ?? ""` into a `where s.repo_id = ?` that then matched no row in any repo.
 */
export function getSymbolCandidatesImpl(
  db: Database.Database,
  repoId: string | null,
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
  // MCP-ISSUE-060: an absent repoId scopes to the whole index rather than to a repo named "".
  // Kept as a clause + params pair so both query branches bind identically whichever way it goes.
  const repoWhere = repoId == null || repoId === "" ? "" : "s.repo_id = ? and";
  const repoParams: unknown[] = repoId == null || repoId === "" ? [] : [repoId];

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
        where ${repoWhere} (${tokenClauses}) ${filterWhere}
        -- MCP-ISSUE-049: this was \`order by length(s.name)\` alone, which decided the candidate POOL
        -- before any scoring ran. \`Up\` and \`Down\` are the shortest method names in an EF repo, so a
        -- repo with many migrations spent the whole \`fetchLimit\` window on them and long, relevant
        -- names were discarded before they could be scored at all. Pushing demoted paths to the back
        -- of the pool makes the window describe candidates rather than short names.
        order by
          case when replace(s.file_path, char(92), '/') like '%/migrations/%'
                 or replace(s.file_path, char(92), '/') like 'migrations/%' then 1 else 0 end,
          length(s.name)
        limit ?
        `
      )
      .all(...repoParams, ...tokenParams, ...filterParams, fetchLimit) as (SymbolRecord & { parentName?: string | null })[];
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
      return { row, matched, matchType, confidenceRaw, demotionTier: demotionTierFor(row) };
    });
    // MCP-ISSUE-049: demotion is the PRIMARY key. It used to live only in `confidenceRaw`, the
    // second key, so a migration matching one more token than the real symbol outranked it however
    // heavily it was penalized — and a business-phrase query matches migration class names on more
    // tokens than anything else, because those names are a log of every schema change ever made.
    // Ordering by tier first also repairs the test-path penalty, which had the same weakness.
    scored.sort(
      (a, b) =>
        a.demotionTier - b.demotionTier ||
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
      where ${repoWhere} (s.name = ? or s.name like ?) ${filterWhere}
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
    .all(...repoParams, name, `%${name}%`, ...filterParams, name, `${name}%`, fetchLimit) as (SymbolRecord & { parentName?: string | null })[];
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
