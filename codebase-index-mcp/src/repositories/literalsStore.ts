import type Database from "better-sqlite3";
import type { StringLiteralRecord } from "../types/index.js";
import { indexLog, indexWarn } from "../services/indexing/indexProgress.js";

// ISSUE-023 — string-literal lane storage. Bảng riêng + FTS5 external-content
// (mirror docs_fts): KHÔNG nhét vào symbols để không phá ranking search_symbols
// lẫn dead_code_scan.

export function replaceLiteralsForFileImpl(
  db: Database.Database,
  repoId: string,
  filePath: string,
  literals: StringLiteralRecord[]
): void {
  const del = db.prepare(`delete from string_literals where repo_id = ? and file_path = ?`);
  const ins = db.prepare(
    `insert or replace into string_literals (repo_id, literal_id, file_path, line, value, enclosing_symbol_id, language, kind)
     values (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const write = () => {
    del.run(repoId, filePath);
    for (const lit of literals) {
      ins.run(lit.repoId, lit.literalId, lit.filePath, lit.line, lit.value, lit.enclosingSymbolId, lit.language, lit.kind);
    }
  };
  if (db.inTransaction) {
    write();
    return;
  }
  db.transaction(write)();
}

export function rebuildLiteralsFtsImpl(db: Database.Database): void {
  const start = Date.now();
  try {
    const { cnt } = db.prepare(`select count(*) as cnt from string_literals`).get() as { cnt: number };
    if (cnt === 0) return;

    try {
      // External-content FTS5 không cho DELETE FROM thường — dùng lệnh 'delete-all'.
      db.prepare(`insert into literals_fts(literals_fts) values('delete-all')`).run();
    } catch {
      indexLog(`[index-literals-fts] literals_fts malformed, recreating...`);
      db.exec(`drop table if exists literals_fts`);
      db.exec(`
        create virtual table if not exists literals_fts using fts5(
          value,
          literal_id unindexed,
          repo_id unindexed,
          content='string_literals',
          content_rowid='rowid'
        )
      `);
    }

    const chunkSize = 5000;
    for (let offset = 0; offset < cnt; offset += chunkSize) {
      db.prepare(
        `insert into literals_fts(rowid, value, literal_id, repo_id)
         select rowid, value, literal_id, repo_id from string_literals
         order by rowid limit ? offset ?`
      ).run(chunkSize, offset);
    }
    db.prepare(`insert into literals_fts(literals_fts) values('optimize')`).run();
    indexLog(`[index-literals-fts] indexed ${cnt} literals in ${Date.now() - start}ms`);
  } catch (e) {
    indexWarn(`[index-literals-fts-error] ${e instanceof Error ? e.message : String(e)}`);
  }
}

export type LiteralSearchResult = {
  value: string;
  filePath: string;
  line: number;
  kind: string;
  language: string;
  enclosingSymbol: { symbolId: string; name: string; kind: string } | null;
};

export function searchLiteralsImpl(
  db: Database.Database,
  repoId: string,
  query: string,
  limit: number,
  filePathFilter: string | null
): LiteralSearchResult[] {
  const pathClause = filePathFilter ? "and l.file_path like ?" : "";
  const pathParams = filePathFilter ? [`%${filePathFilter}%`] : [];

  // FTS trước (prefix-OR từng token), LIKE fallback — mirror searchDocsImpl.
  let rows: (Omit<LiteralSearchResult, "enclosingSymbol"> & { symbolId: string | null; symbolName: string | null; symbolKind: string | null })[] = [];
  try {
    const ftsQuery = query
      .trim()
      .split(/\s+/)
      .filter((t) => t.length >= 2)
      .map((t) => `"${t.replace(/"/g, '""')}"*`)
      .join(" OR ");
    if (ftsQuery) {
      rows = db
        .prepare(
          `
          select l.value, l.file_path as filePath, l.line, l.kind, l.language,
                 s.symbol_id as symbolId, s.name as symbolName, s.kind as symbolKind
          from literals_fts f
          inner join string_literals l on l.rowid = f.rowid
          left join symbols s on s.repo_id = l.repo_id and s.symbol_id = l.enclosing_symbol_id
          where l.repo_id = ? and literals_fts match ? ${pathClause}
          order by rank
          limit ?
          `
        )
        .all(repoId, ftsQuery, ...pathParams, limit) as typeof rows;
    }
  } catch {
    rows = [];
  }

  if (rows.length === 0) {
    rows = db
      .prepare(
        `
        select l.value, l.file_path as filePath, l.line, l.kind, l.language,
               s.symbol_id as symbolId, s.name as symbolName, s.kind as symbolKind
        from string_literals l
        left join symbols s on s.repo_id = l.repo_id and s.symbol_id = l.enclosing_symbol_id
        where l.repo_id = ? and l.value like ? ${pathClause}
        order by l.file_path, l.line
        limit ?
        `
      )
      .all(repoId, `%${query}%`, ...pathParams, limit) as typeof rows;
  }

  return rows.map((r) => ({
    value: r.value,
    filePath: r.filePath,
    line: r.line,
    kind: r.kind,
    language: r.language,
    enclosingSymbol: r.symbolId && r.symbolName ? { symbolId: r.symbolId, name: r.symbolName, kind: r.symbolKind ?? "unknown" } : null
  }));
}
