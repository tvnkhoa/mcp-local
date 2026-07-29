/**
 * Resolving one symbol, and finding what touches it: detail, symbol-at-line, callers by name,
 * and references.
 *
 * Grouped because they answer the same question from different starting points -- a symbolId, a
 * file and line from a stack trace, or a bare name -- and all four end up needing the same
 * caller/reference edges.
 */

import type Database from "better-sqlite3";
import type { ResolvedEdge, SymbolRecord } from "./types.js";

export function getSymbolDetailImpl(
  db: Database.Database,
  repoId: string,
  symbolId: string,
  limit: number
): {
  symbol: SymbolRecord | null;
  edgesOut: ResolvedEdge[];
  edgesIn: ResolvedEdge[];
} {
  const symbol = db
    .prepare(
      `
      select repo_id as repoId, symbol_id as symbolId, file_path as filePath, name, kind, line, end_line as endLine, signature
      from symbols
      where repo_id = ? and symbol_id = ?
      limit 1
      `
    )
    .get(repoId, symbolId) as SymbolRecord | undefined;

  if (!symbol) {
    return { symbol: null, edgesOut: [], edgesIn: [] };
  }

  const edgesOut = db
    .prepare(
      `
      select
        e.from_id as fromId,
        sf.name as fromName,
        sf.file_path as fromFilePath,
        e.to_id as toId,
        st.name as toName,
        st.file_path as toFilePath,
        e.type
      from edges e
      left join symbols sf on sf.repo_id = e.repo_id and sf.symbol_id = e.from_id
      left join symbols st on st.repo_id = e.repo_id and st.symbol_id = e.to_id
      where e.repo_id = ? and e.from_id = ?
      limit ?
      `
    )
    .all(repoId, symbolId, limit) as ResolvedEdge[];

  const edgesIn = db
    .prepare(
      `
      select
        e.from_id as fromId,
        sf.name as fromName,
        sf.file_path as fromFilePath,
        e.to_id as toId,
        st.name as toName,
        st.file_path as toFilePath,
        e.type
      from edges e
      left join symbols sf on sf.repo_id = e.repo_id and sf.symbol_id = e.from_id
      left join symbols st on st.repo_id = e.repo_id and st.symbol_id = e.to_id
      where e.repo_id = ? and e.to_id = ?
      limit ?
      `
    )
    .all(repoId, symbolId, limit) as ResolvedEdge[];

  return { symbol, edgesOut, edgesIn };
}

// ── findCallersByName ──────────────────────────────────────────────────

export function findCallersByNameImpl(
  db: Database.Database,
  repoId: string,
  symbolName: string,
  limit: number
): {
  symbolName: string;
  callers: { callerName: string; callerFile: string; callerLine: number; kind: string }[];
} {
  const targets = db
    .prepare(`select symbol_id as symbolId from symbols where repo_id = ? and name = ?`)
    .all(repoId, symbolName) as { symbolId: string }[];

  if (targets.length === 0) {
    return { symbolName, callers: [] };
  }

  const ph = targets.map(() => "?").join(",");
  const callers = db
    .prepare(
      `
      select distinct sf.name as callerName, sf.file_path as callerFile, sf.line as callerLine, sf.kind
      from edges e
      inner join symbols sf on sf.repo_id = e.repo_id and sf.symbol_id = e.from_id
      where e.repo_id = ? and e.type = 'CALLS' and e.to_id in (${ph})
      order by sf.file_path, sf.line
      limit ?
      `
    )
    .all(repoId, ...targets.map((t) => t.symbolId), limit) as {
    callerName: string;
    callerFile: string;
    callerLine: number;
    kind: string;
  }[];

  return { symbolName, callers };
}

// ── findSymbolAtLine ───────────────────────────────────────────────────

export function findSymbolAtLineImpl(
  db: Database.Database,
  repoId: string,
  filePath: string,
  line: number,
  resolveCanonicalFilePath: (repoId: string, fp: string) => string
): SymbolRecord | null {
  const canonicalFilePath = resolveCanonicalFilePath(repoId, filePath);

  const row = db
    .prepare(
      `
      select repo_id as repoId, symbol_id as symbolId, file_path as filePath,
             name, kind, line, signature
      from symbols
      where repo_id = ? and file_path = ? and kind != 'module' and line <= ?
      order by line desc
      limit 1
      `
    )
    .get(repoId, canonicalFilePath, line) as SymbolRecord | undefined;

  return row ?? null;
}

// ── findReferences ─────────────────────────────────────────────────────

export function findReferencesImpl(
  db: Database.Database,
  repoId: string,
  symbolName: string,
  limit: number
): {
  symbolName: string;
  matchedSymbols: SymbolRecord[];
  callers: { callerName: string; callerFile: string; callerLine: number; kind: string }[];
  importedByFiles: string[];
  totalFound: number;
} {
  const targets = db
    .prepare(
      `select repo_id as repoId, symbol_id as symbolId, file_path as filePath,
              name, kind, line, signature
       from symbols where repo_id = ? and name = ?`
    )
    .all(repoId, symbolName) as SymbolRecord[];

  if (targets.length === 0) {
    return { symbolName, matchedSymbols: [], callers: [], importedByFiles: [], totalFound: 0 };
  }

  const ph = targets.map(() => "?").join(",");
  const targetIds = targets.map((t) => t.symbolId);

  const callers = db
    .prepare(
      `
      select distinct sf.name as callerName, sf.file_path as callerFile, sf.line as callerLine, sf.kind
      from edges e
      inner join symbols sf on sf.repo_id = e.repo_id and sf.symbol_id = e.from_id
      where e.repo_id = ? and e.type = 'CALLS' and e.to_id in (${ph})
      order by sf.file_path, sf.line
      limit ?
      `
    )
    .all(repoId, ...targetIds, limit) as {
    callerName: string;
    callerFile: string;
    callerLine: number;
    kind: string;
  }[];

  const importedByRows = db
    .prepare(
      `
      select distinct sf.file_path as importerFile
      from edges e
      inner join symbols sf on sf.repo_id = e.repo_id and sf.symbol_id = e.from_id
      where e.repo_id = ? and e.type = 'IMPORTS' and e.to_id in (${ph})
        and sf.file_path not in (${ph})
      order by sf.file_path
      limit ?
      `
    )
    .all(repoId, ...targetIds, ...targetIds.map((id) => {
      const sym = targets.find((t) => t.symbolId === id);
      return sym?.filePath ?? "";
    }), limit) as { importerFile: string }[];

  const importedByFiles = importedByRows.map((r) => r.importerFile);
  const totalFound = callers.length + importedByFiles.length;

  return { symbolName, matchedSymbols: targets, callers, importedByFiles, totalFound };
}

// ── getContextByName ───────────────────────────────────────────────────
