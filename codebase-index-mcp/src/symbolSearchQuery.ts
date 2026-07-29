/**
 * `search_symbols` and its suggestion fallback.
 *
 * This is the entry point for almost every MCP session, and the reason the workspace rules warn
 * that it is a token matcher rather than a semantic search: a prose query produces no FTS terms
 * that match an identifier. The suggestion path exists to make that failure legible instead of
 * returning a bare empty list.
 */

import type Database from "better-sqlite3";
import type { SymbolRecord } from "./types.js";
import { vectorSearchSymbols, isVectorEnabled } from "./vectorStore.js";
import { buildFtsQuery, buildIntentFtsQuery, extractIntentTokens } from "./symbolSearchFts.js";

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

    // Hybrid: if FTS returns few results and vector is available, augment with vector search
    if (ftsResults.length < 3 && isVectorEnabled() && repoId) {
      const vecResults = vectorSearchSymbols(db, repoId, query, limit);
      const seen = new Set(ftsResults.map((r) => r.symbolId));
      for (const vr of vecResults) {
        if (ftsResults.length >= limit) break;
        if (seen.has(vr.symbolId)) continue;
        const sym = db.prepare(`
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
        `).get(repoId, vr.symbolId) as (SymbolRecord & { repoPath: string | null }) | undefined;
        if (sym) {
          ftsResults.push(sym);
          seen.add(vr.symbolId);
        }
      }
    }

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
