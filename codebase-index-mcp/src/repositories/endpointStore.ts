/**
 * Endpoint lookups behind get_cross_repo_impact (R9, MCP-ISSUE-081): which contract symbols stand
 * for a controller action, which endpoint tokens a consumer holds, and which files import a file.
 */

import type Database from "better-sqlite3";

/** The `DEPENDS_ON endpoint:` tokens a consumer symbol holds, with their reasons. */
export function getEndpointDependenciesImpl(
  db: Database.Database,
  repoId: string,
  fromSymbolId: string
): { toId: string; reason: string | null }[] {
  return db
    .prepare(
      `select to_id as toId, reason from edges
       where repo_id = ? and from_id = ? and type = 'DEPENDS_ON' and to_id like 'endpoint:%'
       order by to_id`
    )
    .all(repoId, fromSymbolId) as { toId: string; reason: string | null }[];
}

/**
 * The endpoint contract symbols that stand for a symbol on the provider side: itself when it IS one,
 * the contract minted for each route it handles (a controller action) or declares (a controller),
 * and any contract the signature fallback minted on the same line of the same file.
 */
export function findEndpointContractSymbolsImpl(
  db: Database.Database,
  repoId: string,
  symbolId: string
): { symbolId: string; signature: string }[] {
  return db
    .prepare(
      `
      select distinct e.symbol_id as symbolId, e.signature as signature
      from symbols s
      join symbols e
        on e.repo_id = s.repo_id and e.file_path = s.file_path and e.signature like 'endpoint:%'
      where s.repo_id = ? and s.symbol_id = ?
        and (
          e.symbol_id = s.symbol_id
          or e.line = s.line
          or exists (
            select 1 from routes r
            where r.repo_id = s.repo_id and r.file_path = s.file_path and r.line = e.line
              and (r.handler_symbol_id = s.symbol_id or r.controller_symbol_id = s.symbol_id)
          )
        )
      order by e.line, e.symbol_id
      limit 500
      `
    )
    .all(repoId, symbolId) as { symbolId: string; signature: string }[];
}

/** Every symbol declared in one file, for a file-level cross-repo query. Bounded. */
export function getSymbolIdsInFileImpl(db: Database.Database, repoId: string, filePath: string, limit: number): string[] {
  return (
    db
      .prepare(`select symbol_id as symbolId from symbols where repo_id = ? and file_path = ? order by line, symbol_id limit ?`)
      .all(repoId, filePath, limit) as { symbolId: string }[]
  ).map((r) => r.symbolId);
}

/** Files whose module imports `filePath`'s module (resolved IMPORTS edges), plus nothing else. */
export function findImportingFilesImpl(db: Database.Database, repoId: string, filePath: string, limit: number): string[] {
  return (
    db
      .prepare(
        `
        select distinct f.file_path as filePath
        from symbols m
        join edges e on e.repo_id = m.repo_id and e.to_id = m.symbol_id and e.type = 'IMPORTS'
        join symbols f on f.repo_id = e.repo_id and f.symbol_id = e.from_id
        where m.repo_id = ? and m.file_path = ? and m.kind = 'module'
        order by f.file_path
        limit ?
        `
      )
      .all(repoId, filePath, limit) as { filePath: string }[]
  ).map((r) => r.filePath);
}

