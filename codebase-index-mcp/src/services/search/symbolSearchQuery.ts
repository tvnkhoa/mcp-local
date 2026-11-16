/**
 * `search_symbols` and its suggestion fallback.
 *
 * This is the entry point for almost every MCP session, and the reason the workspace rules warn
 * that it is a token matcher rather than a semantic search: a prose query produces no FTS terms
 * that match an identifier. The suggestion path exists to make that failure legible instead of
 * returning a bare empty list.
 */

import type Database from "better-sqlite3";
import type { SymbolRecord } from "../../types/index.js";
import { isVectorEnabled } from "../../repositories/vectorStore.js";
import { buildFtsQuery, buildIntentFtsQuery, extractIntentTokens } from "./symbolSearchFts.js";

/**
 * PY-9: `Owner.member` (or `pkg.Owner.member`) → the owner's simple name and the member; null for anything
 * that is not a dotted identifier path. The owner is the segment right before the member.
 */
export function parseQualifiedQuery(query: string): { owner: string; member: string } | null {
  const q = query.trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)+$/.test(q)) return null;
  const parts = q.split(".");
  const member = parts[parts.length - 1]!;
  const owner = parts[parts.length - 2]!;
  return { owner, member };
}

export function searchSymbolsImpl(
  db: Database.Database,
  query: string,
  repoId: string | null,
  language: string | null,
  kind: string | null,
  filePath: string | null,
  limit: number,
  strategy: "name" | "intent" = "name"
): (SymbolRecord & { repoPath: string | null })[] {
  const langJoin = language
    ? `inner join files f on f.repo_id = s.repo_id and f.path = s.file_path and f.language = '${language.replace(/'/g, "''")}'`
    : "left join files f on f.repo_id = s.repo_id and f.path = s.file_path";

  const conditions: string[] = [];
  const params: unknown[] = [];

  if (repoId) {
    conditions.push("s.repo_id = ?");
    params.push(repoId);
  }
  if (kind) {
    conditions.push("s.kind = ?");
    params.push(kind);
  }
  if (filePath) {
    conditions.push("s.file_path like ?");
    params.push(`%${filePath}%`);
  }

  // PY-9: `FixStage.run` names a member by its owner. Neither FTS nor the substring fallback matches a dotted
  // query against a bare member name, so it answered 0 for a symbol that exists. Matched on the parent link.
  const qualified = strategy === "name" ? parseQualifiedQuery(query) : null;
  if (qualified) {
    const rows = db
      .prepare(
        `
        select s.repo_id as repoId, s.symbol_id as symbolId, s.file_path as filePath, s.name, s.kind, s.line,
               s.signature, r.repo_path as repoPath
        from symbols s
        inner join symbols p on p.repo_id = s.repo_id and p.symbol_id = s.parent_symbol_id
        ${langJoin}
        inner join repositories r on r.repo_id = s.repo_id
        where s.name = ? and p.name = ? ${conditions.length > 0 ? `and ${conditions.join(" and ")}` : ""}
        order by s.file_path, s.line
        limit ?
        `
      )
      .all(qualified.member, qualified.owner, ...params, limit) as (SymbolRecord & { repoPath: string | null })[];
    if (rows.length > 0) return rows;
  }

  let useFts = false;
  try {
    db.prepare("select * from symbols_fts limit 0").all();
    useFts = true;
  } catch {
    useFts = false;
  }

  if (useFts) {
    const ftsWhere = conditions.length > 0 ? `and ${conditions.join(" and ")}` : "";
    const ftsQuery = strategy === "intent" ? buildIntentFtsQuery(query) : buildFtsQuery(query);
    const ftsResults = db
      .prepare(
        `
        select
          s.repo_id as repoId,
          s.symbol_id as symbolId,
          s.file_path as filePath,
          s.name,
          s.kind,
          s.line,
          s.signature,
          r.repo_path as repoPath
        from symbols_fts
        inner join symbols s on s.rowid = symbols_fts.rowid
        ${langJoin}
        inner join repositories r on r.repo_id = s.repo_id
        where symbols_fts match ?
        ${ftsWhere}
        order by rank
        limit ?
        `
      )
      .all(ftsQuery, ...params, limit) as (SymbolRecord & { repoPath: string | null })[];

    // Vector near-neighbour padding is NOT done here (MCP-ISSUE-132): its KNN is a brute-force scan that blocked
    // the server thread 0.3-2.9 s. `search_symbols` asks `needsVectorPadding` and fetches the neighbours from the
    // vector-search worker (vectorSearchWorkerClient.ts), then `appendVectorNeighbours` adds them here.
    return ftsResults;
  }

  if (strategy === "intent") {
    const tokens = extractIntentTokens(query);
    if (tokens.length > 0) {
      const tokenClauses = tokens.map(() => "(s.name like ? or s.signature like ?)");
      conditions.unshift(`(${tokenClauses.join(" or ")})`);
      const tokenParams: string[] = [];
      for (const token of tokens) {
        tokenParams.push(`%${token}%`, `%${token}%`);
      }
      params.unshift(...tokenParams);
    } else {
      conditions.unshift("(s.name like ? or s.signature like ?)");
      params.unshift(`%${query}%`, `%${query}%`);
    }
  } else {
    conditions.unshift("(s.name like ? or s.signature like ?)");
    params.unshift(`%${query}%`, `%${query}%`);
  }
  const where = conditions.join(" and ");
  return db
    .prepare(
      `
      select
        s.repo_id as repoId,
        s.symbol_id as symbolId,
        s.file_path as filePath,
        s.name,
        s.kind,
        s.line,
        s.signature,
        r.repo_path as repoPath
      from symbols s
      ${langJoin}
      inner join repositories r on r.repo_id = s.repo_id
      where ${where}
      order by s.name
      limit ?
      `
    )
    .all(...params, limit) as (SymbolRecord & { repoPath: string | null })[];
}

// ── Vector near-neighbour padding (MCP-ISSUE-132) ─────────────────────

/**
 * Whether a name search should be padded with vector near-neighbours: fewer than three name matches, one repo, and
 * vectors on. Only when the symbols_fts table exists — the LIKE fallback never padded.
 *
 * MCP-ISSUE-058(b): the padding answered `count: 50` for a symbol that does not exist — all vector neighbours, none
 * a name match. It is worth keeping (it rescues a near-miss spelling), but LABELLED (`matchType: "fuzzy"`), so a
 * caller can tell "here are five things a bit like it" from "here it is".
 */
export function needsVectorPadding(db: Database.Database, matches: number, repoId: string | null): repoId is string {
  if (matches >= 3 || !repoId || !isVectorEnabled()) return false;
  try {
    db.prepare("select * from symbols_fts limit 0").all();
    return true;
  } catch {
    return false;
  }
}

/** Append the neighbours (already ranked, from the vector-search worker) as `fuzzy` rows, up to `limit` in all. */
export function appendVectorNeighbours(
  db: Database.Database,
  rows: (SymbolRecord & { repoPath: string | null })[],
  repoId: string,
  neighbours: readonly { symbolId: string }[],
  limit: number
): (SymbolRecord & { repoPath: string | null })[] {
  const out = [...rows];
  const seen = new Set(out.map((r) => r.symbolId));
  const stmt = db.prepare(`
    select
      s.repo_id as repoId,
      s.symbol_id as symbolId,
      s.file_path as filePath,
      s.name,
      s.kind,
      s.line,
      s.signature,
      r.repo_path as repoPath
    from symbols s
    inner join repositories r on r.repo_id = s.repo_id
    where s.repo_id = ? and s.symbol_id = ?
    limit 1
  `);
  for (const vr of neighbours) {
    if (out.length >= limit) break;
    if (seen.has(vr.symbolId)) continue;
    const sym = stmt.get(repoId, vr.symbolId) as (SymbolRecord & { repoPath: string | null }) | undefined;
    if (sym) {
      out.push({ ...sym, matchType: "fuzzy" });
      seen.add(vr.symbolId);
    }
  }
  return out;
}

// ── getSearchSuggestions ───────────────────────────────────────────────

export function getSearchSuggestionsImpl(
  db: Database.Database,
  query: string,
  repoId: string | null,
  limit: number
): string[] {
  const cappedLimit = Math.max(1, Math.min(limit, 10));
  const tokens = extractIntentTokens(query).slice(0, 6);

  const conditions: string[] = [];
  const params: unknown[] = [];

  if (repoId) {
    conditions.push("s.repo_id = ?");
    params.push(repoId);
  }

  if (tokens.length > 0) {
    const tokenClauses = tokens.map(() => "s.name like ?");
    conditions.push(`(${tokenClauses.join(" or ")})`);
    for (const token of tokens) {
      params.push(`%${token}%`);
    }
  } else {
    conditions.push("s.name like ?");
    params.push(`%${query.trim()}%`);
  }

  const where = conditions.join(" and ");
  const rows = db
    .prepare(
      `
      select s.name as name, count(*) as hits
      from symbols s
      where ${where}
      group by s.name
      order by hits desc, length(s.name) asc, s.name asc
      limit ?
      `
    )
    .all(...params, cappedLimit) as { name: string; hits: number }[];

  return rows.map((r) => r.name);
}

// ── getSymbolDetail ────────────────────────────────────────────────────
