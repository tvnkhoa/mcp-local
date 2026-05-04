import Database from "better-sqlite3";

import type { EdgeRecord, FileRecord, IndexRunSummary, SymbolRecord } from "./types.js";

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

  getModuleFlow(repoId: string, filePath: string, limit: number): EdgeRecord[] {
    return this.db
      .prepare(
        `
        select e.repo_id as repoId, e.from_id as fromId, e.to_id as toId, e.type
        from symbols s
        inner join edges e
          on e.repo_id = s.repo_id
         and e.from_id = s.symbol_id
        where s.repo_id = ?
          and s.file_path = ?
        limit ?
        `
      )
      .all(repoId, filePath, limit) as EdgeRecord[];
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
    `);
  }
}
