import Database from "better-sqlite3";

import type { EdgeRecord, FileRecord, IndexRunSummary, ResolvedEdge, SymbolRecord } from "./types.js";

export class GraphStore {
  private readonly db: Database.Database;
  private readonly runInTransactionInternal: (fn: () => void) => void;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("cache_size = -64000"); // 64MB cache
    this.db.pragma("temp_store = MEMORY");
    this.runInTransactionInternal = this.db.transaction((fn: () => void) => fn());
    this.initSchema();
  }

  close(): void {
    this.db.close();
  }

  runInTransaction(fn: () => void): void {
    this.runInTransactionInternal(fn);
  }

  upsertFile(record: FileRecord): void {
    this.db
      .prepare(
        `
        insert into files (repo_id, path, content_hash, language, updated_at)
        values (@repoId, @path, @contentHash, @language, @updatedAt)
        on conflict(repo_id, path) do update set
          content_hash = excluded.content_hash,
          language = excluded.language,
          updated_at = excluded.updated_at
        `
      )
      .run(record);
  }

  ensureRepository(repoId: string, repoPath: string): void {
    this.db
      .prepare(
        `
        insert into repositories (repo_id, repo_path, updated_at)
        values (?, ?, ?)
        on conflict(repo_id) do update set
          repo_path = excluded.repo_path,
          updated_at = excluded.updated_at
        `
      )
      .run(repoId, repoPath, new Date().toISOString());
  }

  getFileHash(repoId: string, filePath: string): string | null {
    const row = this.db
      .prepare(
        `
        select content_hash as contentHash
        from files
        where repo_id = ? and path = ?
        limit 1
        `
      )
      .get(repoId, filePath) as { contentHash: string } | undefined;

    return row?.contentHash ?? null;
  }

  replaceSymbolsForFile(repoId: string, filePath: string, symbols: SymbolRecord[]): void {
    this.db.prepare(`delete from symbols where repo_id = ? and file_path = ?`).run(repoId, filePath);

    const stmt = this.db.prepare(
      `
      insert into symbols (repo_id, symbol_id, file_path, name, kind, line)
      values (@repoId, @symbolId, @filePath, @name, @kind, @line)
      `
    );

    const tx = this.db.transaction((rows: SymbolRecord[]) => {
      for (const row of rows) {
        stmt.run(row);
      }
    });

    tx(symbols);
  }

  replaceEdgesForFile(repoId: string, fromId: string, edges: EdgeRecord[]): void {
    this.db.prepare(`delete from edges where repo_id = ? and from_id = ?`).run(repoId, fromId);

    const stmt = this.db.prepare(
      `
      insert into edges (repo_id, from_id, to_id, type)
      values (@repoId, @fromId, @toId, @type)
      `
    );

    const tx = this.db.transaction((rows: EdgeRecord[]) => {
      for (const row of rows) {
        stmt.run(row);
      }
    });

    tx(edges);
  }

  recordRun(summary: IndexRunSummary): void {
    this.db
      .prepare(
        `
        insert into index_runs (
          run_id, repo_id, mode, status, started_at, finished_at,
          files_scanned, files_indexed, files_skipped, symbols_upserted,
          edges_upserted, parse_failures, elapsed_ms
        ) values (
          @runId, @repoId, @mode, @status, @startedAt, @finishedAt,
          @filesScanned, @filesIndexed, @filesSkipped, @symbolsUpserted,
          @edgesUpserted, @parseFailures, @elapsedMs
        )
        `
      )
      .run(summary);
  }

  getLatestRun(repoId: string): IndexRunSummary | null {
    const row = this.db
      .prepare(
        `
        select
          run_id as runId,
          repo_id as repoId,
          mode,
          status,
          started_at as startedAt,
          finished_at as finishedAt,
          files_scanned as filesScanned,
          files_indexed as filesIndexed,
          files_skipped as filesSkipped,
          symbols_upserted as symbolsUpserted,
          edges_upserted as edgesUpserted,
          parse_failures as parseFailures,
          elapsed_ms as elapsedMs
        from index_runs
        where repo_id = ?
        order by started_at desc
        limit 1
        `
      )
      .get(repoId) as IndexRunSummary | undefined;

    return row ?? null;
  }

  getDependencies(repoId: string, fromId: string, limit: number): EdgeRecord[] {
    return this.db
      .prepare(
        `
        select repo_id as repoId, from_id as fromId, to_id as toId, type
        from edges
        where repo_id = ? and from_id = ? and type in ('IMPORTS', 'DEPENDS_ON')
        limit ?
        `
      )
      .all(repoId, fromId, limit) as EdgeRecord[];
  }

  getCallEdges(repoId: string, symbolId: string, direction: "callers" | "callees", limit: number): EdgeRecord[] {
    if (direction === "callees") {
      return this.db
        .prepare(
          `
          select repo_id as repoId, from_id as fromId, to_id as toId, type
          from edges
          where repo_id = ? and from_id = ? and type = 'CALLS'
          limit ?
          `
        )
        .all(repoId, symbolId, limit) as EdgeRecord[];
    }

    return this.db
      .prepare(
        `
        select repo_id as repoId, from_id as fromId, to_id as toId, type
        from edges
        where repo_id = ? and to_id = ? and type = 'CALLS'
        limit ?
        `
      )
      .all(repoId, symbolId, limit) as EdgeRecord[];
  }

  getImpactSurface(repoId: string, filePath: string, limit: number): { symbolId: string; name: string }[] {
    return this.db
      .prepare(
        `
        select symbol_id as symbolId, name
        from symbols
        where repo_id = ? and file_path = ?
        limit ?
        `
      )
      .all(repoId, filePath, limit) as { symbolId: string; name: string }[];
  }

  getModuleFlow(repoId: string, filePath: string, limit: number): ResolvedEdge[] {
    return this.db
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
        from symbols s
        inner join edges e
          on e.repo_id = s.repo_id
         and e.from_id = s.symbol_id
        left join symbols sf
          on sf.repo_id = e.repo_id and sf.symbol_id = e.from_id
        left join symbols st
          on st.repo_id = e.repo_id and st.symbol_id = e.to_id
        where s.repo_id = ?
          and s.file_path = ?
        limit ?
        `
      )
      .all(repoId, filePath, limit) as ResolvedEdge[];
  }

  getSymbolsByIds(repoId: string, symbolIds: string[]): SymbolRecord[] {
    if (symbolIds.length === 0) {
      return [];
    }

    const placeholders = symbolIds.map(() => "?").join(", ");
    return this.db
      .prepare(
        `
        select
          repo_id as repoId,
          symbol_id as symbolId,
          file_path as filePath,
          name,
          kind,
          line
        from symbols
        where repo_id = ? and symbol_id in (${placeholders})
        `
      )
      .all(repoId, ...symbolIds) as SymbolRecord[];
  }

  getRepository(repoId: string): { repoId: string; repoPath: string; updatedAt: string } | null {
    const row = this.db
      .prepare(
        `
        select repo_id as repoId, repo_path as repoPath, updated_at as updatedAt
        from repositories
        where repo_id = ?
        limit 1
        `
      )
      .get(repoId) as { repoId: string; repoPath: string; updatedAt: string } | undefined;

    return row ?? null;
  }

  upsertCrossRepoDep(fromRepoId: string, fromSymbolId: string, toRepoId: string, toSymbolId: string, type: string): void {
    this.db
      .prepare(
        `
        insert into cross_repo_deps (from_repo_id, from_symbol_id, to_repo_id, to_symbol_id, type)
        values (?, ?, ?, ?, ?)
        on conflict do nothing
        `
      )
      .run(fromRepoId, fromSymbolId, toRepoId, toSymbolId, type);
  }

  getCrossRepoDeps(fromRepoId: string, fromSymbolId: string, limit: number): {
    toRepoId: string;
    toSymbolId: string;
    type: string;
  }[] {
    return this.db
      .prepare(
        `
        select to_repo_id as toRepoId, to_symbol_id as toSymbolId, type
        from cross_repo_deps
        where from_repo_id = ? and from_symbol_id = ?
        limit ?
        `
      )
      .all(fromRepoId, fromSymbolId, limit) as { toRepoId: string; toSymbolId: string; type: string }[];
  }

  listRepositories(): { repoId: string; repoPath: string; updatedAt: string; filesIndexed: number; symbolCount: number; lastRunStatus: string | null; lastRunAt: string | null }[] {
    return this.db
      .prepare(
        `
        select
          r.repo_id as repoId,
          r.repo_path as repoPath,
          r.updated_at as updatedAt,
          coalesce(f.file_count, 0) as filesIndexed,
          coalesce(s.sym_count, 0) as symbolCount,
          lr.status as lastRunStatus,
          lr.finished_at as lastRunAt
        from repositories r
        left join (
          select repo_id, count(*) as file_count from files group by repo_id
        ) f on f.repo_id = r.repo_id
        left join (
          select repo_id, count(*) as sym_count from symbols group by repo_id
        ) s on s.repo_id = r.repo_id
        left join (
          select repo_id, status, finished_at,
                 row_number() over (partition by repo_id order by started_at desc) as rn
          from index_runs
        ) lr on lr.repo_id = r.repo_id and lr.rn = 1
        order by r.updated_at desc
        `
      )
      .all() as { repoId: string; repoPath: string; updatedAt: string; filesIndexed: number; symbolCount: number; lastRunStatus: string | null; lastRunAt: string | null }[];
  }

  rebuildFts(): void {
    this.db.exec(`insert into symbols_fts(symbols_fts) values('rebuild')`);
  }

  searchSymbols(query: string, repoId: string | null, language: string | null, kind: string | null, limit: number): (SymbolRecord & { repoPath: string | null })[] {
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

    // Use FTS5 when available; fall back to LIKE for safety
    let useFts = false;
    try {
      this.db.prepare("select * from symbols_fts limit 0").all();
      useFts = true;
    } catch {
      useFts = false;
    }

    if (useFts) {
      const ftsWhere = conditions.length > 0 ? `and ${conditions.join(" and ")}` : "";
      return this.db
        .prepare(
          `
          select
            s.repo_id as repoId,
            s.symbol_id as symbolId,
            s.file_path as filePath,
            s.name,
            s.kind,
            s.line,
            r.repo_path as repoPath
          from symbols_fts fts
          inner join symbols s on s.rowid = fts.rowid
          ${langJoin}
          inner join repositories r on r.repo_id = s.repo_id
          where fts.name match ?
          ${ftsWhere}
          order by rank
          limit ?
          `
        )
        .all(`"${query.replace(/"/g, '""')}"*`, ...params, limit) as (SymbolRecord & { repoPath: string | null })[];
    }

    conditions.unshift("s.name like ?");
    params.unshift(`%${query}%`);
    const where = conditions.join(" and ");
    return this.db
      .prepare(
        `
        select
          s.repo_id as repoId,
          s.symbol_id as symbolId,
          s.file_path as filePath,
          s.name,
          s.kind,
          s.line,
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

  getSymbolDetail(repoId: string, symbolId: string, limit: number): {
    symbol: SymbolRecord | null;
    edgesOut: ResolvedEdge[];
    edgesIn: ResolvedEdge[];
  } {
    const symbol = this.db
      .prepare(
        `
        select repo_id as repoId, symbol_id as symbolId, file_path as filePath, name, kind, line
        from symbols
        where repo_id = ? and symbol_id = ?
        limit 1
        `
      )
      .get(repoId, symbolId) as SymbolRecord | undefined;

    if (!symbol) {
      return { symbol: null, edgesOut: [], edgesIn: [] };
    }

    const edgesOut = this.db
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

    const edgesIn = this.db
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

  getFileContext(repoId: string, filePath: string, limit: number): { symbols: SymbolRecord[]; edges: ResolvedEdge[] } {
    const symbols = this.db
      .prepare(
        `
        select repo_id as repoId, symbol_id as symbolId, file_path as filePath, name, kind, line
        from symbols
        where repo_id = ? and file_path = ?
        limit ?
        `
      )
      .all(repoId, filePath, limit) as SymbolRecord[];

    if (symbols.length === 0) {
      return { symbols: [], edges: [] };
    }

    const symbolIds = symbols.map((s) => s.symbolId);
    const placeholders = symbolIds.map(() => "?").join(", ");
    const edges = this.db
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
        where e.repo_id = ? and (e.from_id in (${placeholders}) or e.to_id in (${placeholders}))
        limit ?
        `
      )
      .all(repoId, ...symbolIds, ...symbolIds, limit) as ResolvedEdge[];

    return { symbols, edges };
  }

  getBatchContext(repoId: string, filePaths: string[], limit: number): { symbols: SymbolRecord[]; edges: ResolvedEdge[] } {
    if (filePaths.length === 0) {
      return { symbols: [], edges: [] };
    }
    const placeholders = filePaths.map(() => "?").join(", ");
    const symbols = this.db
      .prepare(
        `
        select repo_id as repoId, symbol_id as symbolId, file_path as filePath, name, kind, line
        from symbols
        where repo_id = ? and file_path in (${placeholders})
        limit ?
        `
      )
      .all(repoId, ...filePaths, limit) as SymbolRecord[];

    if (symbols.length === 0) {
      return { symbols: [], edges: [] };
    }

    const symbolIds = symbols.map((s) => s.symbolId);
    const symPlaceholders = symbolIds.map(() => "?").join(", ");
    const edges = this.db
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
        where e.repo_id = ? and (e.from_id in (${symPlaceholders}) or e.to_id in (${symPlaceholders}))
        limit ?
        `
      )
      .all(repoId, ...symbolIds, ...symbolIds, limit) as ResolvedEdge[];

    return { symbols, edges };
  }

  resolveUnlinkedEdges(repoId: string): number {
    // Find edge toIds that don't exist in this repo's symbols
    const unlinked = this.db
      .prepare(
        `
        select distinct e.from_id as fromId, e.to_id as toId, e.type
        from edges e
        where e.repo_id = ?
          and not exists (
            select 1 from symbols s where s.repo_id = ? and s.symbol_id = e.to_id
          )
        limit 5000
        `
      )
      .all(repoId, repoId) as { fromId: string; toId: string; type: string }[];

    if (unlinked.length === 0) {
      return 0;
    }

    // Find which other repos have these symbolIds
    const toIds = [...new Set(unlinked.map((r) => r.toId))];
    const placeholders = toIds.map(() => "?").join(", ");
    const matches = this.db
      .prepare(
        `
        select repo_id as toRepoId, symbol_id as toSymbolId
        from symbols
        where repo_id != ? and symbol_id in (${placeholders})
        `
      )
      .all(repoId, ...toIds) as { toRepoId: string; toSymbolId: string }[];

    if (matches.length === 0) {
      return 0;
    }

    const matchMap = new Map(matches.map((m) => [m.toSymbolId, m.toRepoId]));

    const upsertStmt = this.db.prepare(
      `
      insert into cross_repo_deps (from_repo_id, from_symbol_id, to_repo_id, to_symbol_id, type)
      values (?, ?, ?, ?, ?)
      on conflict do nothing
      `
    );

    let count = 0;
    const tx = this.db.transaction(() => {
      for (const row of unlinked) {
        const toRepoId = matchMap.get(row.toId);
        if (toRepoId) {
          upsertStmt.run(repoId, row.fromId, toRepoId, row.toId, row.type);
          count += 1;
        }
      }
    });
    tx();

    return count;
  }

  private initSchema(): void {
    this.db.exec(`
      create table if not exists repositories (
        repo_id text primary key,
        repo_path text not null,
        updated_at text not null
      );

      create table if not exists files (
        repo_id text not null,
        path text not null,
        content_hash text not null,
        language text,
        updated_at text not null,
        primary key (repo_id, path)
      );

      create table if not exists symbols (
        repo_id text not null,
        symbol_id text not null,
        file_path text not null,
        name text not null,
        kind text not null,
        line integer not null,
        primary key (repo_id, symbol_id)
      );

      create table if not exists edges (
        repo_id text not null,
        from_id text not null,
        to_id text not null,
        type text not null
      );

      create table if not exists index_runs (
        run_id text primary key,
        repo_id text not null,
        mode text not null,
        status text not null,
        started_at text not null,
        finished_at text not null,
        files_scanned integer not null,
        files_indexed integer not null,
        files_skipped integer not null,
        symbols_upserted integer not null,
        edges_upserted integer not null,
        parse_failures integer not null,
        elapsed_ms integer not null
      );

      create index if not exists idx_edges_repo_from on edges(repo_id, from_id);
      create index if not exists idx_edges_repo_to on edges(repo_id, to_id);
      create index if not exists idx_symbols_repo_file on symbols(repo_id, file_path);
      create index if not exists idx_runs_repo_started on index_runs(repo_id, started_at desc);
      create index if not exists idx_files_repo_path on files(repo_id, path);

      create table if not exists cross_repo_deps (
        from_repo_id text not null,
        from_symbol_id text not null,
        to_repo_id text not null,
        to_symbol_id text not null,
        type text not null,
        primary key (from_repo_id, from_symbol_id, to_repo_id, to_symbol_id, type)
      );

      create index if not exists idx_cross_repo_from on cross_repo_deps(from_repo_id, from_symbol_id);
      create index if not exists idx_cross_repo_to on cross_repo_deps(to_repo_id, to_symbol_id);

      create virtual table if not exists symbols_fts using fts5(
        name,
        symbol_id unindexed,
        repo_id unindexed,
        content='symbols',
        content_rowid='rowid'
      );
    `);
  }
}
