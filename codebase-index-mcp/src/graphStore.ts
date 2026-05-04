import Database from "better-sqlite3";

import type { EdgeRecord, FileRecord, GraphHealth, IndexRunSummary, ResolvedEdge, ResolutionStats, SymbolRecord } from "./types.js";

function createEmptyResolutionStats(): ResolutionStats {
  return {
    attempts: 0,
    resolved: 0,
    unresolvedByReason: {
      no_candidate: 0,
      ambiguous_candidates: 0,
      boundary_blocked: 0,
      low_confidence: 0
    }
  };
}

export class GraphStore {
  private readonly db: Database.Database;
  private readonly runInTransactionInternal: (fn: () => void) => void;

  private normalizePath(filePath: string): string {
    return filePath.replace(/\\/g, "/");
  }

  private resolveCanonicalFilePath(repoId: string, filePath: string): string {
    const normalized = this.normalizePath(filePath);

    const fileRow = this.db
      .prepare(
        `
        select path as filePath
        from files
        where repo_id = ? and replace(path, char(92), '/') = ?
        order by case when path = ? then 0 else 1 end
        limit 1
        `
      )
      .get(repoId, normalized, filePath) as { filePath: string } | undefined;

    if (fileRow?.filePath) {
      return fileRow.filePath;
    }

    const symbolRow = this.db
      .prepare(
        `
        select file_path as filePath
        from symbols
        where repo_id = ? and replace(file_path, char(92), '/') = ?
        order by case when file_path = ? then 0 else 1 end
        limit 1
        `
      )
      .get(repoId, normalized, filePath) as { filePath: string } | undefined;

    if (symbolRow?.filePath) {
      return symbolRow.filePath;
    }

    return normalized;
  }

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("cache_size = -64000"); // 64MB cache
    this.db.pragma("temp_store = MEMORY");
    this.runInTransactionInternal = this.db.transaction((fn: () => void) => fn());
    this.initSchema();
    this.runMigrations();
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
      insert into symbols (repo_id, symbol_id, file_path, name, kind, line, signature)
      values (@repoId, @symbolId, @filePath, @name, @kind, @line, @signature)
      `
    );

    const tx = this.db.transaction((rows: SymbolRecord[]) => {
      for (const row of rows) {
        stmt.run({ ...row, signature: row.signature ?? null });
      }
    });

    tx(symbols);
  }

  /**
   * Remove files (and their symbols/edges) for a repo that are no longer in the current file set.
   * Used after a full-mode index to clean up deleted files.
   * Returns the number of stale files removed.
   */
  pruneStaleFiles(repoId: string, currentRelativePaths: string[]): number {
    const existing = this.db
      .prepare(`select path from files where repo_id = ?`)
      .all(repoId) as { path: string }[];

    const currentSet = new Set(currentRelativePaths);
    const stale = existing.filter((r) => !currentSet.has(r.path)).map((r) => r.path);
    return this.pruneFiles(repoId, stale);
  }

  pruneFiles(repoId: string, relativePaths: string[]): number {
    if (relativePaths.length === 0) {
      return 0;
    }

    const uniquePaths = [...new Set(relativePaths)];
    const deleteTx = this.db.transaction((paths: string[]) => {
      for (const filePath of paths) {
        this.db.prepare(`delete from symbols where repo_id = ? and file_path = ?`).run(repoId, filePath);
        this.db.prepare(`delete from docs where repo_id = ? and file_path = ?`).run(repoId, filePath);
        this.db.prepare(`delete from files where repo_id = ? and path = ?`).run(repoId, filePath);
      }
    });
    deleteTx(uniquePaths);

    return uniquePaths.length;
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

  recordRun(summary: IndexRunSummary & { crossRepoLinked?: number; callEdgesResolved?: number; importEdgesResolved?: number; mentionsResolved?: number }): void {
    this.db
      .prepare(
        `
        insert into index_runs (
          run_id, repo_id, mode, status, started_at, finished_at,
          files_scanned, files_indexed, files_skipped, symbols_upserted,
          edges_upserted, docs_upserted, mentions_upserted, parse_failures,
          cross_repo_linked, call_edges_resolved, import_edges_resolved, mentions_resolved,
          elapsed_ms,
          cross_repo_attempts, cross_repo_resolved,
          unresolved_no_candidate, unresolved_ambiguous,
          unresolved_boundary_blocked, unresolved_low_confidence
        ) values (
          ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?,
          ?, ?, ?, ?,
          ?, ?, ?, ?,
          ?,
          ?, ?,
          ?, ?,
          ?, ?
        )
        `
      )
      .run(
        summary.runId,
        summary.repoId,
        summary.mode,
        summary.status,
        summary.startedAt,
        summary.finishedAt,
        summary.filesScanned,
        summary.filesIndexed,
        summary.filesSkipped,
        summary.symbolsUpserted,
        summary.edgesUpserted,
        summary.docsUpserted,
        summary.mentionsUpserted,
        summary.parseFailures,
        summary.crossRepoLinked ?? 0,
        summary.callEdgesResolved ?? 0,
        summary.importEdgesResolved ?? 0,
        summary.mentionsResolved ?? 0,
        summary.elapsedMs,
        summary.crossRepoAttempts ?? 0,
        summary.crossRepoResolved ?? 0,
        summary.unresolvedNoCandidate ?? 0,
        summary.unresolvedAmbiguous ?? 0,
        summary.unresolvedBoundaryBlocked ?? 0,
        summary.unresolvedLowConfidence ?? 0
      );
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
          docs_upserted as docsUpserted,
          mentions_upserted as mentionsUpserted,
          parse_failures as parseFailures,
          cross_repo_linked as crossRepoLinked,
          call_edges_resolved as callEdgesResolved,
          import_edges_resolved as importEdgesResolved,
          mentions_resolved as mentionsResolved,
          elapsed_ms as elapsedMs,
          cross_repo_attempts as crossRepoAttempts,
          cross_repo_resolved as crossRepoResolved,
          unresolved_no_candidate as unresolvedNoCandidate,
          unresolved_ambiguous as unresolvedAmbiguous,
          unresolved_boundary_blocked as unresolvedBoundaryBlocked,
          unresolved_low_confidence as unresolvedLowConfidence
        from index_runs
        where repo_id = ?
        order by finished_at desc, started_at desc, rowid desc
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

  getModuleFlow(repoId: string, filePath: string, limit: number): {
    edges: ResolvedEdge[];
    unresolvedCalls: { count: number; samples: string[] };
  } {
    const canonicalFilePath = this.resolveCanonicalFilePath(repoId, filePath);

    const all = this.db
      .prepare(
        `
        with target_symbols as (
          select symbol_id
          from symbols
          where repo_id = ? and file_path = ?
        )
        select
          e.from_id as fromId,
          sf.name as fromName,
          sf.file_path as fromFilePath,
          e.to_id as toId,
          st.name as toName,
          st.file_path as toFilePath,
          e.type
        from edges e
        left join symbols sf
          on sf.repo_id = e.repo_id and sf.symbol_id = e.from_id
        left join symbols st
          on st.repo_id = e.repo_id and st.symbol_id = e.to_id
        where e.repo_id = ?
          and (
            e.from_id in (select symbol_id from target_symbols)
            or e.to_id in (select symbol_id from target_symbols)
          )
        order by
          case
            when sf.file_path = ? and st.file_path = ? then 0
            when sf.file_path = ? then 1
            when st.file_path = ? then 2
            else 3
          end,
          e.type
        limit ?
        `
      )
      .all(repoId, canonicalFilePath, repoId, canonicalFilePath, canonicalFilePath, canonicalFilePath, canonicalFilePath, limit) as ResolvedEdge[];

    const edges: ResolvedEdge[] = [];
    const unresolvedNames: string[] = [];

    for (const row of all) {
      if (row.toId.startsWith("callee:")) {
        unresolvedNames.push(row.toId.slice(7));
      } else {
        edges.push(row);
      }
    }

    // Dedupe and cap samples
    const uniqueNames = [...new Set(unresolvedNames)];
    return {
      edges,
      unresolvedCalls: {
        count: unresolvedNames.length,
        samples: uniqueNames.slice(0, 20)
      }
    };
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
          line,
          signature
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

  searchSymbols(query: string, repoId: string | null, language: string | null, kind: string | null, filePath: string | null, limit: number): (SymbolRecord & { repoPath: string | null })[] {
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
        .all(this.buildFtsQuery(query), ...params, limit) as (SymbolRecord & { repoPath: string | null })[];
    }

    conditions.unshift("(s.name like ? or s.signature like ?)");
    params.unshift(`%${query}%`, `%${query}%`);
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

  getSymbolDetail(repoId: string, symbolId: string, limit: number): {
    symbol: SymbolRecord | null;
    edgesOut: ResolvedEdge[];
    edgesIn: ResolvedEdge[];
  } {
    const symbol = this.db
      .prepare(
        `
        select repo_id as repoId, symbol_id as symbolId, file_path as filePath, name, kind, line, signature
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

  getFileContext(repoId: string, filePath: string, limit: number, compact = false): { symbols: SymbolRecord[] | { name: string; kind: string; line: number }[]; edges: ResolvedEdge[] } {
    const symbols = this.db
      .prepare(
        `
        select repo_id as repoId, symbol_id as symbolId, file_path as filePath, name, kind, line, signature
        from symbols
        where repo_id = ? and file_path = ?
        limit ?
        `
      )
      .all(repoId, filePath, limit) as SymbolRecord[];

    if (symbols.length === 0) {
      return { symbols: [], edges: [] };
    }

    if (compact) {
      return { symbols: symbols.map((s) => ({ name: s.name, kind: s.kind, line: s.line })), edges: [] };
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

  getBatchContext(repoId: string, filePaths: string[], limit: number, compact = false): { symbols: SymbolRecord[] | { name: string; kind: string; filePath: string; line: number }[]; edges: ResolvedEdge[] } {
    if (filePaths.length === 0) {
      return { symbols: [], edges: [] };
    }
    const placeholders = filePaths.map(() => "?").join(", ");
    const symbols = this.db
      .prepare(
        `
        select repo_id as repoId, symbol_id as symbolId, file_path as filePath, name, kind, line, signature
        from symbols
        where repo_id = ? and file_path in (${placeholders})
        limit ?
        `
      )
      .all(repoId, ...filePaths, limit) as SymbolRecord[];

    if (symbols.length === 0) {
      return { symbols: [], edges: [] };
    }

    if (compact) {
      return { symbols: symbols.map((s) => ({ name: s.name, kind: s.kind, filePath: s.filePath, line: s.line })), edges: [] };
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

  resolveUnlinkedEdges(repoId: string): ResolutionStats {
    const stats = createEmptyResolutionStats();

    // Find edge toIds that don't exist in this repo's symbols.
    // Exclude unresolved placeholders that are handled by dedicated resolvers.
    const unlinked = this.db
      .prepare(
        `
        select distinct e.from_id as fromId, e.to_id as toId, e.type
        from edges e
        where e.repo_id = ?
          and e.to_id not like 'import:%'
          and e.to_id not like 'callee:%'
          and not exists (
            select 1 from symbols s where s.repo_id = ? and s.symbol_id = e.to_id
          )
        limit 5000
        `
      )
      .all(repoId, repoId) as { fromId: string; toId: string; type: string }[];

    if (unlinked.length === 0) {
      return stats;
    }

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

    const candidatesBySymbolId = new Map<string, string[]>();
    for (const row of matches) {
      const list = candidatesBySymbolId.get(row.toSymbolId) ?? [];
      list.push(row.toRepoId);
      candidatesBySymbolId.set(row.toSymbolId, list);
    }

    const upsertStmt = this.db.prepare(
      `
      insert into cross_repo_deps (from_repo_id, from_symbol_id, to_repo_id, to_symbol_id, type)
      values (?, ?, ?, ?, ?)
      on conflict do nothing
      `
    );

    const tx = this.db.transaction(() => {
      for (const row of unlinked) {
        stats.attempts += 1;
        const candidates = candidatesBySymbolId.get(row.toId) ?? [];
        if (candidates.length === 0) {
          stats.unresolvedByReason.no_candidate += 1;
          continue;
        }
        if (candidates.length > 1) {
          stats.unresolvedByReason.ambiguous_candidates += 1;
          continue;
        }

        upsertStmt.run(repoId, row.fromId, candidates[0], row.toId, row.type);
        stats.resolved += 1;
      }
    });
    tx();

    return stats;
  }

  resolveImportEdges(repoId: string): number {
    // Find all IMPORTS edges with unresolved plain-text toId ("import:<path>")
    const unresolved = this.db
      .prepare(
        `
        select distinct e.from_id as fromId, e.to_id as toId, sf.file_path as fromFile
        from edges e
        inner join symbols sf on sf.repo_id = e.repo_id and sf.symbol_id = e.from_id
        where e.repo_id = ? and e.type = 'IMPORTS' and e.to_id like 'import:%'
        `
      )
      .all(repoId) as { fromId: string; toId: string; fromFile: string }[];

    if (unresolved.length === 0) return 0;

    const updateStmt = this.db.prepare(
      `update edges set to_id = ? where repo_id = ? and from_id = ? and to_id = ?`
    );

    // Build a map of all file paths in this repo → module symbolId
    const fileToModuleId = new Map<string, string>();
    const moduleRows = this.db
      .prepare(`select file_path as filePath, symbol_id as symbolId from symbols where repo_id = ? and kind = 'module'`)
      .all(repoId) as { filePath: string; symbolId: string }[];
    for (const row of moduleRows) {
      // Normalize path separators
      const normalizedPath = row.filePath.replace(/\\/g, "/");
      fileToModuleId.set(normalizedPath, row.symbolId);
    }

    let count = 0;
    const tx = this.db.transaction(() => {
      for (const row of unresolved) {
        const importPath = row.toId.slice(7); // strip "import:"
        const fromDir = row.fromFile.replace(/\\/g, "/").split("/").slice(0, -1).join("/");

        // Only attempt resolution for relative imports
        if (!importPath.startsWith(".")) continue;

        // Resolve relative path
        const parts = `${fromDir}/${importPath}`.split("/");
        const resolved: string[] = [];
        for (const part of parts) {
          if (part === ".." && resolved.length > 0) resolved.pop();
          else if (part !== ".") resolved.push(part);
        }
        const resolvedBase = resolved.join("/");

        // Try with various extensions and index files
        const candidates = [
          resolvedBase,
          `${resolvedBase}.ts`,
          `${resolvedBase}.js`,
          `${resolvedBase}.tsx`,
          `${resolvedBase}.mts`,
          `${resolvedBase}/index.ts`,
          `${resolvedBase}/index.js`,
          // Strip known extensions to allow .js → .ts rewrite
          resolvedBase.replace(/\.js$/, ".ts"),
          resolvedBase.replace(/\.mjs$/, ".ts"),
        ];

        let matched: string | undefined;
        for (const candidate of candidates) {
          if (fileToModuleId.has(candidate)) {
            matched = candidate;
            break;
          }
        }

        if (matched) {
          const actualId = fileToModuleId.get(matched)!;
          updateStmt.run(actualId, repoId, row.fromId, row.toId);
          count += 1;
        }
      }
    });
    tx();

    return count;
  }

  resolveCallEdges(repoId: string): number {
    // Find all CALLS edges with unresolved plain-text toId ("callee:<name>")
    // Join symbols to get the caller's file for same-file resolution priority
    const unresolved = this.db
      .prepare(
        `
        select distinct e.from_id as fromId, e.to_id as toId, s.file_path as fromFile
        from edges e
        inner join symbols s on s.repo_id = e.repo_id and s.symbol_id = e.from_id
        where e.repo_id = ? and e.type = 'CALLS' and e.to_id like 'callee:%'
        `
      )
      .all(repoId) as { fromId: string; toId: string; fromFile: string }[];

    if (unresolved.length === 0) return 0;

    const updateStmt = this.db.prepare(
      `update edges set to_id = ? where repo_id = ? and from_id = ? and to_id = ?`
    );

    let count = 0;
    const tx = this.db.transaction(() => {
      for (const row of unresolved) {
        const calleeName = row.toId.slice(7); // strip "callee:"
        // Prefer same-file symbols, then by kind priority
        const match = this.db
          .prepare(
            `
            select symbol_id as symbolId from symbols
            where repo_id = ? and name = ?
            order by
              case when file_path = ? then 0 else 1 end,
              case kind
                when 'function' then 0
                when 'method' then 1
                when 'constructor' then 2
                when 'class' then 3
                else 4
              end
            limit 1
            `
          )
          .get(repoId, calleeName, row.fromFile) as { symbolId: string } | undefined;

        if (match) {
          updateStmt.run(match.symbolId, repoId, row.fromId, row.toId);
          count += 1;
        }
      }
    });
    tx();

    return count;
  }

  getImpactSurface(repoId: string, filePath: string, limit: number): {
    callerName: string;
    callerFile: string;
    callerLine: number;
    symbolAffected: string;
    edgeType: string;
  }[] {
    const canonicalFilePath = this.resolveCanonicalFilePath(repoId, filePath);

    return this.db
      .prepare(
        `
        select
          sf.name as callerName,
          sf.file_path as callerFile,
          sf.line as callerLine,
          s.name as symbolAffected,
          e.type as edgeType
        from symbols s
        inner join edges e
          on e.repo_id = s.repo_id
          and (
            e.to_id = s.symbol_id
            or (e.type = 'CALLS' and e.to_id = ('callee:' || s.name))
          )
        inner join symbols sf on sf.repo_id = e.repo_id and sf.symbol_id = e.from_id
        where s.repo_id = ? and s.file_path = ? and sf.file_path != s.file_path
        order by sf.file_path, e.type
        limit ?
        `
      )
      .all(repoId, canonicalFilePath, limit) as {
        callerName: string;
        callerFile: string;
        callerLine: number;
        symbolAffected: string;
        edgeType: string;
      }[];
  }

  getImpactFiles(repoId: string, filePath: string, limit: number): {
    impactedFiles: { filePath: string; reason: string; symbolsAffected: string[] }[];
    graphHealth: GraphHealth;
  } {
    const canonicalFilePath = this.resolveCanonicalFilePath(repoId, filePath);

    const rows = this.db
      .prepare(
        `
        select
          sf.file_path as callerFile,
          e.type as edgeType,
          s.name as symbolAffected
        from symbols s
        inner join edges e
          on e.repo_id = s.repo_id
          and (
            e.to_id = s.symbol_id
            or (e.type = 'CALLS' and e.to_id = ('callee:' || s.name))
          )
        inner join symbols sf on sf.repo_id = e.repo_id and sf.symbol_id = e.from_id
        where s.repo_id = ? and s.file_path = ? and sf.file_path != s.file_path
        order by sf.file_path
        limit ?
        `
      )
      .all(repoId, canonicalFilePath, limit) as {
        callerFile: string;
        edgeType: string;
        symbolAffected: string;
      }[];

    // Group by callerFile
    const byFile = new Map<string, { reason: string; symbolsAffected: Set<string> }>();
    for (const row of rows) {
      const existing = byFile.get(row.callerFile);
      if (existing) {
        existing.symbolsAffected.add(row.symbolAffected);
      } else {
        byFile.set(row.callerFile, { reason: row.edgeType, symbolsAffected: new Set([row.symbolAffected]) });
      }
    }

    const impactedFiles = Array.from(byFile.entries()).map(([fp, v]) => ({
      filePath: fp,
      reason: v.reason,
      symbolsAffected: Array.from(v.symbolsAffected)
    }));

    return {
      impactedFiles,
      graphHealth: this.countUnresolvedEdgesForFile(repoId, canonicalFilePath)
    };
  }

  getFileSummary(repoId: string, filePath: string): {
    file: { filePath: string; language: string | null };
    exports: SymbolRecord[];
    imports: ResolvedEdge[];
    importedBy: { fromFilePath: string; edgeType: string }[];
    graphHealth: GraphHealth;
  } {
    const canonicalFilePath = this.resolveCanonicalFilePath(repoId, filePath);

    const fileRow = this.db
      .prepare(
        `
        select path as filePath, language
        from files
        where repo_id = ? and replace(path, char(92), '/') = ?
        order by case when path = ? then 0 else 1 end
        limit 1
        `
      )
      .get(repoId, this.normalizePath(filePath), filePath) as { filePath: string; language: string | null } | undefined;

    const exports = this.db
      .prepare(
        `select repo_id as repoId, symbol_id as symbolId, file_path as filePath, name, kind, line, signature
         from symbols where repo_id = ? and file_path = ? and kind != 'module'
         order by line limit 50`
      )
      .all(repoId, canonicalFilePath) as SymbolRecord[];

    const moduleSymbol = this.db
      .prepare(`select symbol_id as symbolId from symbols where repo_id = ? and file_path = ? and kind = 'module' limit 1`)
      .get(repoId, canonicalFilePath) as { symbolId: string } | undefined;

    const symbolIds = exports.map((s) => s.symbolId);
    if (moduleSymbol) symbolIds.unshift(moduleSymbol.symbolId);

    const imports = symbolIds.length > 0
      ? this.db
          .prepare(
            `
            select e.from_id as fromId, sf.name as fromName, sf.file_path as fromFilePath,
                   e.to_id as toId, st.name as toName, st.file_path as toFilePath, e.type
            from edges e
            left join symbols sf on sf.repo_id = e.repo_id and sf.symbol_id = e.from_id
            left join symbols st on st.repo_id = e.repo_id and st.symbol_id = e.to_id
            where e.repo_id = ? and e.from_id in (${symbolIds.map(() => "?").join(",")})
              and e.type = 'IMPORTS'
            limit 20
            `
          )
          .all(repoId, ...symbolIds) as ResolvedEdge[]
      : [];

    const importedBy = symbolIds.length > 0
      ? (this.db
          .prepare(
            `
            select distinct sf.file_path as fromFilePath, e.type as edgeType
            from edges e
            inner join symbols sf on sf.repo_id = e.repo_id and sf.symbol_id = e.from_id
            where e.repo_id = ? and e.to_id in (${symbolIds.map(() => "?").join(",")})
              and sf.file_path != ?
            order by sf.file_path
            limit 20
            `
          )
          .all(repoId, ...symbolIds, canonicalFilePath) as { fromFilePath: string; edgeType: string }[])
      : [];

    return {
      file: fileRow ?? { filePath: canonicalFilePath, language: null },
      exports,
      imports,
      importedBy,
      graphHealth: this.countUnresolvedEdgesForFile(repoId, canonicalFilePath)
    };
  }

  getChangeContext(
    repoId: string,
    symbolId: string,
    callerDepth: number,
    calleeDepth: number,
    limit: number
  ): {
    symbol: SymbolRecord | null;
    callers: (ResolvedEdge & { distance: number })[];
    callees: ResolvedEdge[];
    typeDeps: ResolvedEdge[];
    graphHealth: GraphHealth;
  } {
    const symbol = this.db
      .prepare(
        `select repo_id as repoId, symbol_id as symbolId, file_path as filePath, name, kind, line, signature
         from symbols where repo_id = ? and symbol_id = ? limit 1`
      )
      .get(repoId, symbolId) as SymbolRecord | undefined;

    if (!symbol) return { symbol: null, callers: [], callees: [], typeDeps: [], graphHealth: { unresolvedCalls: 0, unresolvedImports: 0, note: "symbol not found" } };

    // BFS callers up to callerDepth
    const callers: (ResolvedEdge & { distance: number })[] = [];
    const visitedCallers = new Set<string>([symbolId]);
    let frontier = [symbolId];
    for (let depth = 1; depth <= callerDepth && frontier.length > 0 && callers.length < limit; depth++) {
      const ph = frontier.map(() => "?").join(",");
      const rows = this.db
        .prepare(
          `
          select e.from_id as fromId, sf.name as fromName, sf.file_path as fromFilePath,
                 e.to_id as toId, st.name as toName, st.file_path as toFilePath, e.type
          from edges e
          left join symbols sf on sf.repo_id = e.repo_id and sf.symbol_id = e.from_id
          left join symbols st on st.repo_id = e.repo_id and st.symbol_id = e.to_id
          where e.repo_id = ? and e.type = 'CALLS' and e.to_id in (${ph})
          limit ?
          `
        )
        .all(repoId, ...frontier, limit - callers.length) as ResolvedEdge[];

      const nextFrontier: string[] = [];
      for (const row of rows) {
        if (!visitedCallers.has(row.fromId)) {
          visitedCallers.add(row.fromId);
          callers.push({ ...row, distance: depth });
          nextFrontier.push(row.fromId);
        }
      }
      frontier = nextFrontier;
    }

    // Callees (depth 1)
    const callees = this.db
      .prepare(
        `
        select e.from_id as fromId, sf.name as fromName, sf.file_path as fromFilePath,
               e.to_id as toId, st.name as toName, st.file_path as toFilePath, e.type
        from edges e
        left join symbols sf on sf.repo_id = e.repo_id and sf.symbol_id = e.from_id
        left join symbols st on st.repo_id = e.repo_id and st.symbol_id = e.to_id
        where e.repo_id = ? and e.from_id = ? and e.type = 'CALLS'
        limit 20
        `
      )
      .all(repoId, symbolId) as ResolvedEdge[];

    // Type deps: IMPORTS from same file
    const moduleSymbol = this.db
      .prepare(`select symbol_id as symbolId from symbols where repo_id = ? and file_path = ? and kind = 'module' limit 1`)
      .get(repoId, symbol.filePath) as { symbolId: string } | undefined;

    const typeDeps = moduleSymbol
      ? (this.db
          .prepare(
            `
            select e.from_id as fromId, sf.name as fromName, sf.file_path as fromFilePath,
                   e.to_id as toId, st.name as toName, st.file_path as toFilePath, e.type
            from edges e
            left join symbols sf on sf.repo_id = e.repo_id and sf.symbol_id = e.from_id
            left join symbols st on st.repo_id = e.repo_id and st.symbol_id = e.to_id
            where e.repo_id = ? and e.from_id = ? and e.type = 'IMPORTS'
            limit 10
            `
          )
          .all(repoId, moduleSymbol.symbolId) as ResolvedEdge[])
      : [];

    return {
      symbol,
      callers,
      callees,
      typeDeps,
      graphHealth: symbol ? this.countUnresolvedEdgesForFile(repoId, symbol.filePath) : { unresolvedCalls: 0, unresolvedImports: 0, note: "symbol not found" }
    };
  }

  findCallersByName(repoId: string, symbolName: string, limit: number): {
    symbolName: string;
    callers: { callerName: string; callerFile: string; callerLine: number; kind: string }[];
  } {
    const targets = this.db
      .prepare(`select symbol_id as symbolId from symbols where repo_id = ? and name = ?`)
      .all(repoId, symbolName) as { symbolId: string }[];

    if (targets.length === 0) {
      return { symbolName, callers: [] };
    }

    const ph = targets.map(() => "?").join(",");
    const callers = this.db
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

  /**
   * Find the symbol that encloses a given line number (nearest symbol with line <= target).
   * Useful for mapping stack-trace file+line → symbolId without an extra search hop.
   */
  findSymbolAtLine(repoId: string, filePath: string, line: number): SymbolRecord | null {
    const row = this.db
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
      .get(repoId, filePath, line) as SymbolRecord | undefined;

    return row ?? null;
  }

  /**
   * Find all callers (CALLS edges) and importing files (IMPORTS edges) for a symbol by name.
   * Does not require symbolId — resolves by name match first.
   */
  findReferences(repoId: string, symbolName: string, limit: number): {
    symbolName: string;
    matchedSymbols: SymbolRecord[];
    callers: { callerName: string; callerFile: string; callerLine: number; kind: string }[];
    importedByFiles: string[];
    totalFound: number;
  } {
    const targets = this.db
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

    const callers = this.db
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

    const importedByRows = this.db
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

  /**
   * Single-call context lookup by symbol name — avoids the 2-hop search_symbols → get_symbol_detail pattern.
   * Returns the best-matching symbol plus its callers, callees, and importing files.
   */
  getContextByName(
    repoId: string,
    name: string,
    limit: number
  ): {
    symbol: SymbolRecord | null;
    callers: { callerName: string; callerFile: string; callerLine: number; kind: string }[];
    callees: { calleeName: string; calleeFile: string | null; calleeLine: number | null; kind: string | null }[];
    importedByFiles: string[];
    allMatchedSymbols: SymbolRecord[];
  } {
    // FTS or LIKE search for the best match — prefer exact name, then FTS rank
    let candidates: SymbolRecord[] = [];
    let useFts = false;
    try {
      this.db.prepare("select * from symbols_fts limit 0").all();
      useFts = true;
    } catch { useFts = false; }

    if (useFts) {
      candidates = this.db
        .prepare(
          `
          select s.repo_id as repoId, s.symbol_id as symbolId, s.file_path as filePath,
                 s.name, s.kind, s.line, s.signature
          from symbols_fts
          inner join symbols s on s.rowid = symbols_fts.rowid
          where s.repo_id = ? and symbols_fts match ?
          order by case when s.name = ? then 0 else 1 end, rank
          limit ?
          `
        )
        .all(repoId, this.buildFtsQuery(name), name, limit) as SymbolRecord[];
    } else {
      candidates = this.db
        .prepare(
          `select repo_id as repoId, symbol_id as symbolId, file_path as filePath,
                  name, kind, line, signature
           from symbols where repo_id = ? and (name = ? or name like ?)
           order by case when name = ? then 0 else 1 end, name
           limit ?`
        )
        .all(repoId, name, `%${name}%`, name, limit) as SymbolRecord[];
    }

    if (candidates.length === 0) {
      return { symbol: null, callers: [], callees: [], importedByFiles: [], allMatchedSymbols: [] };
    }

    const symbol = candidates[0];
    const targetIds = candidates.map((c) => c.symbolId);
    const ph = targetIds.map(() => "?").join(",");

    const callers = this.db
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
      .all(repoId, ...targetIds, limit) as { callerName: string; callerFile: string; callerLine: number; kind: string }[];

    const calleeRows = this.db
      .prepare(
        `
        select st.name as calleeName, st.file_path as calleeFile, st.line as calleeLine, st.kind
        from edges e
        left join symbols st on st.repo_id = e.repo_id and st.symbol_id = e.to_id
        where e.repo_id = ? and e.from_id = ? and e.type = 'CALLS'
        limit ?
        `
      )
      .all(repoId, symbol.symbolId, limit) as { calleeName: string | null; calleeFile: string | null; calleeLine: number | null; kind: string | null }[];

    const callees = calleeRows
      .filter((r) => r.calleeName != null)
      .map((r) => ({ calleeName: r.calleeName!, calleeFile: r.calleeFile, calleeLine: r.calleeLine, kind: r.kind }));

    const importedByRows = this.db
      .prepare(
        `
        select distinct sf.file_path as importerFile
        from edges e
        inner join symbols sf on sf.repo_id = e.repo_id and sf.symbol_id = e.from_id
        where e.repo_id = ? and e.type = 'IMPORTS' and e.to_id in (${ph})
        order by sf.file_path
        limit ?
        `
      )
      .all(repoId, ...targetIds, limit) as { importerFile: string }[];

    return {
      symbol,
      callers,
      callees,
      importedByFiles: importedByRows.map((r) => r.importerFile),
      allMatchedSymbols: candidates
    };
  }

  /**
   * Resolve ambiguous symbol names to ranked candidates.
   * Used by AI agents to pick the right symbol before deeper graph calls.
   */
  getSymbolCandidates(
    repoId: string,
    name: string,
    limit: number
  ): {
    symbolId: string;
    name: string;
    kind: string;
    filePath: string;
    line: number;
    signature: string | null;
    matchType: "exact" | "prefix" | "contains";
    score: number;
    confidence: number;
  }[] {
    const rows = this.db
      .prepare(
        `
        select repo_id as repoId, symbol_id as symbolId, file_path as filePath,
               name, kind, line, signature
        from symbols
        where repo_id = ? and (name = ? or name like ?)
        order by
          case
            when lower(name) = lower(?) then 0
            when lower(name) like lower(?) then 1
            else 2
          end,
          length(name),
          file_path,
          line
        limit ?
        `
      )
      .all(repoId, name, `%${name}%`, name, `${name}%`, limit) as SymbolRecord[];

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
      const kindBonus = ["method", "function", "class", "interface", "struct"].includes(row.kind) ? 0.03 : 0;
      const positionPenalty = Math.min(index * 0.01, 0.2);
      const confidence = Math.max(0, Math.min(1, base + kindBonus - positionPenalty));

      return {
        symbolId: row.symbolId,
        name: row.name,
        kind: row.kind,
        filePath: row.filePath,
        line: row.line,
        signature: row.signature ?? null,
        matchType,
        score: Math.round(confidence * 100),
        confidence
      };
    });
  }

  /**
   * Folder summary — returns per-file stats for all files under a folder prefix.
   * Useful for Plan mode orientation without reading file contents.
   */
  getFolderSummary(
    repoId: string,
    folderPath: string,
    maxFiles: number
  ): {
    folderPath: string;
    totalFiles: number;
    files: {
      filePath: string;
      language: string | null;
      symbolCount: number;
      exportedCount: number;
      callerCount: number;
    }[];
  } {
    const normalized = folderPath.replace(/\\/g, "/").replace(/\/$/, "");
    const prefix = `${normalized}/`;

    const files = this.db
      .prepare(
        `
        select
          f.path as filePath,
          f.language,
          count(distinct s.symbol_id) as symbolCount,
          sum(case when s.kind in ('function','method','class','interface','struct','property') then 1 else 0 end) as exportedCount
        from files f
        left join symbols s on s.repo_id = f.repo_id and s.file_path = f.path and s.kind != 'module'
        where f.repo_id = ? and (f.path like ? or f.path like ?)
        group by f.path, f.language
        order by f.path
        limit ?
        `
      )
      .all(repoId, `${prefix}%`, `${normalized}%`, maxFiles) as {
        filePath: string;
        language: string | null;
        symbolCount: number;
        exportedCount: number;
      }[];

    // Add caller count per file (files that import/call symbols in each file)
    const result = files.map((f) => {
      const callerCount = (this.db
        .prepare(
          `
          select count(distinct sf.file_path) as cnt
          from symbols s
          inner join edges e on e.repo_id = s.repo_id and e.to_id = s.symbol_id
          inner join symbols sf on sf.repo_id = e.repo_id and sf.symbol_id = e.from_id
          where s.repo_id = ? and s.file_path = ? and sf.file_path != s.file_path
          `
        )
        .get(repoId, f.filePath) as { cnt: number } | undefined)?.cnt ?? 0;

      return { ...f, callerCount };
    });

    return { folderPath: normalized, totalFiles: result.length, files: result };
  }

  /**
   * Find entry points — symbols with 0 incoming CALLS edges.
   * These are publicly callable symbols no other code in the repo calls internally.
   */
  findEntryPoints(
    repoId: string,
    filePathPrefix: string | null,
    kind: string | null,
    limit: number
  ): { symbolId: string; name: string; kind: string; filePath: string; line: number; signature: string | null }[] {
    const conditions: string[] = ["s.repo_id = ?", "s.kind != 'module'", "s.kind != 'property'"];
    const params: unknown[] = [repoId];

    if (filePathPrefix) {
      conditions.push("s.file_path like ?");
      params.push(`${filePathPrefix.replace(/\\/g, "/")}%`);
    }
    if (kind) {
      conditions.push("s.kind = ?");
      params.push(kind);
    }

    const where = conditions.join(" and ");
    params.push(repoId, limit);

    return this.db
      .prepare(
        `
        select s.symbol_id as symbolId, s.name, s.kind, s.file_path as filePath, s.line, s.signature
        from symbols s
        where ${where}
          and not exists (
            select 1 from edges e
            where e.repo_id = ? and e.type = 'CALLS' and e.to_id = s.symbol_id
          )
        order by s.file_path, s.line
        limit ?
        `
      )
      .all(...params) as { symbolId: string; name: string; kind: string; filePath: string; line: number; signature: string | null }[];
  }

  /**
   * Find all classes/structs implementing a named interface (via IMPLEMENTS edges).
   * Requires Phase 4 C# extractor changes to populate iface: edges.
   */
  findImplementations(
    repoId: string,
    interfaceName: string,
    limit: number
  ): { symbolId: string; name: string; kind: string; filePath: string; line: number; signature: string | null }[] {
    // Find resolved IMPLEMENTS edges (toId = symbolId of interface)
    const targets = this.db
      .prepare(`select symbol_id as symbolId from symbols where repo_id = ? and name = ? and kind = 'interface'`)
      .all(repoId, interfaceName) as { symbolId: string }[];

    // Also check unresolved iface: placeholder edges
    const rows: { symbolId: string; name: string; kind: string; filePath: string; line: number; signature: string | null }[] = [];

    if (targets.length > 0) {
      const ph = targets.map(() => "?").join(",");
      const fromResolved = this.db
        .prepare(
          `
          select distinct s.symbol_id as symbolId, s.name, s.kind, s.file_path as filePath, s.line, s.signature
          from edges e
          inner join symbols s on s.repo_id = e.repo_id and s.symbol_id = e.from_id
          where e.repo_id = ? and e.type = 'IMPLEMENTS' and e.to_id in (${ph})
          order by s.file_path, s.line
          limit ?
          `
        )
        .all(repoId, ...targets.map((t) => t.symbolId), limit) as { symbolId: string; name: string; kind: string; filePath: string; line: number; signature: string | null }[];
      rows.push(...fromResolved);
    }

    // Also check unresolved iface: placeholders
    const fromUnresolved = this.db
      .prepare(
        `
        select distinct s.symbol_id as symbolId, s.name, s.kind, s.file_path as filePath, s.line, s.signature
        from edges e
        inner join symbols s on s.repo_id = e.repo_id and s.symbol_id = e.from_id
        where e.repo_id = ? and e.type = 'IMPLEMENTS' and e.to_id = ?
        order by s.file_path, s.line
        limit ?
        `
      )
      .all(repoId, `iface:${interfaceName}`, limit) as { symbolId: string; name: string; kind: string; filePath: string; line: number; signature: string | null }[];

    for (const r of fromUnresolved) {
      if (!rows.some((existing) => existing.symbolId === r.symbolId)) {
        rows.push(r);
      }
    }

    return rows.slice(0, limit);
  }

  /**
   * Resolve IMPLEMENTS edges — convert iface:InterfaceName placeholders to real symbolIds.
   * Should be called after indexing C# files.
   */
  resolveImplementsEdges(repoId: string): number {
    const unresolved = this.db
      .prepare(
        `
        select distinct e.from_id as fromId, e.to_id as toId
        from edges e
        where e.repo_id = ? and e.type = 'IMPLEMENTS' and e.to_id like 'iface:%'
        `
      )
      .all(repoId) as { fromId: string; toId: string }[];

    if (unresolved.length === 0) return 0;

    const updateStmt = this.db.prepare(
      `update edges set to_id = ? where repo_id = ? and from_id = ? and to_id = ? and type = 'IMPLEMENTS'`
    );

    let count = 0;
    const tx = this.db.transaction(() => {
      for (const row of unresolved) {
        const ifaceName = row.toId.slice(6); // strip "iface:"
        const match = this.db
          .prepare(
            `select symbol_id as symbolId from symbols
             where repo_id = ? and name = ? and kind = 'interface'
             limit 1`
          )
          .get(repoId, ifaceName) as { symbolId: string } | undefined;

        if (match) {
          updateStmt.run(match.symbolId, repoId, row.fromId, row.toId);
          count += 1;
        }
      }
    });
    tx();

    return count;
  }

  upsertDocs(docs: import("./types.js").DocRecord[]): void {
    const stmt = this.db.prepare(
      `
      insert into docs (repo_id, doc_id, file_path, heading_path, content_type, text, level)
      values (@repoId, @docId, @filePath, @headingPath, @contentType, @text, @level)
      on conflict(repo_id, doc_id) do update set
        text = excluded.text,
        level = excluded.level
      `
    );

    const tx = this.db.transaction((rows: import("./types.js").DocRecord[]) => {
      for (const row of rows) {
        // Ensure level is present (as undefined which will bind as NULL)
        const normalized = { ...row, level: row.level ?? undefined };
        stmt.run(normalized);
      }
    });

    tx(docs);
  }

  upsertDocMentions(mentions: import("./types.js").DocMentionRecord[]): void {
    const stmt = this.db.prepare(
      `
      insert into doc_mentions (repo_id, doc_id, symbol_id, mention_type, confidence, mention_text)
      values (@repoId, @docId, @symbolId, @mentionType, @confidence, @mentionText)
      on conflict(repo_id, doc_id, symbol_id, mention_type, mention_text) do update set
        confidence = excluded.confidence
      `
    );

    const tx = this.db.transaction((rows: import("./types.js").DocMentionRecord[]) => {
      for (const row of rows) {
        stmt.run(row);
      }
    });

    tx(mentions);
  }

  rebuildDocsFts(): void {
    try {
      this.db.prepare(`delete from docs_fts`).run();
      const docs = this.db
        .prepare(`select doc_id, repo_id, text from docs`)
        .all() as { doc_id: string; repo_id: string; text: string | null }[];

      const insertStmt = this.db.prepare(`insert into docs_fts(rowid, doc_id, repo_id, text) values (?, ?, ?, ?)`);
      const tx = this.db.transaction((rows: typeof docs) => {
        for (const row of rows) {
          insertStmt.run(null, row.doc_id, row.repo_id, row.text ?? "");
        }
      });
      tx(docs);
    } catch {
      // Non-fatal: FTS rebuild failure shouldn't stop indexing
    }
  }

  /**
   * Resolve unresolved doc mentions to symbol IDs.
   * Strategy:
   * - Backtick mentions: exact name match, then fuzzy match (threshold 0.8)
   * - Filepath mentions: extract module path, find symbols from that file
   * - Heading mentions: low priority, keyword matching with fuzzy logic
   */
  resolveMentions(repoId: string): number {
    // Get all unresolved mentions
    const unresolved = this.db
      .prepare(
        `
        select doc_id, symbol_id, mention_type, mention_text
        from doc_mentions
        where repo_id = ? and symbol_id is null
        `
      )
      .all(repoId) as {
      doc_id: string;
      symbol_id: string | null;
      mention_type: string;
      mention_text: string;
    }[];

    if (unresolved.length === 0) return 0;

    // Use REPLACE to handle conflicts (DELETE + INSERT)
    const updateStmt = this.db.prepare(
      `update or replace doc_mentions set symbol_id = ? where repo_id = ? and doc_id = ? and mention_type = ? and mention_text = ? and symbol_id is null`
    );

    let count = 0;
    const tx = this.db.transaction(() => {
      for (const mention of unresolved) {
        let resolvedSymbolId: string | undefined;

        if (mention.mention_type === "backtick") {
          // Try exact match first (priority: class > interface > function > method > variable)
          const exactMatch = this.db
            .prepare(
              `
              select symbol_id from symbols
              where repo_id = ? and name = ?
              order by case kind
                when 'class' then 0
                when 'interface' then 1
                when 'function' then 2
                when 'method' then 3
                when 'variable' then 4
                else 5
              end
              limit 1
              `
            )
            .get(repoId, mention.mention_text) as { symbol_id: string } | undefined;

          if (exactMatch) {
            resolvedSymbolId = exactMatch.symbol_id;
          }

          // If no exact match, try fuzzy matching
          if (!resolvedSymbolId) {
            const candidates = this.db
              .prepare(
                `
                select symbol_id, name from symbols
                where repo_id = ?
                order by case kind
                  when 'class' then 0
                  when 'interface' then 1
                  when 'function' then 2
                  when 'method' then 3
                  when 'variable' then 4
                  else 5
                end
                limit 100
                `
              )
              .all(repoId) as { symbol_id: string; name: string }[];

            // Simple fuzzy matching: check if mention is substring or similarity > 0.8
            for (const candidate of candidates) {
              if (
                candidate.name.includes(mention.mention_text) ||
                mention.mention_text.includes(candidate.name) ||
                this.stringSimilarity(mention.mention_text, candidate.name) > 0.8
              ) {
                resolvedSymbolId = candidate.symbol_id;
                break;
              }
            }
          }
        } else if (mention.mention_type === "filepath") {
          // Extract file path and find symbols from that file
          // mention_text e.g., "src/graphStore.ts" or "src/graphStore"
          const normalizedPath = mention.mention_text
            .replace(/^src\//, "")
            .replace(/\.(ts|js|tsx|jsx)$/, "");

          // Find module symbol from that file
          const moduleResult = this.db
            .prepare(
              `
              select symbol_id from symbols
              where repo_id = ? and file_path like ?
              and kind = 'module'
              limit 1
              `
            )
            .get(repoId, `%${normalizedPath}%`) as { symbol_id: string } | undefined;

          if (moduleResult) {
            resolvedSymbolId = moduleResult.symbol_id;
          }

          // Fallback: just take first symbol from file
          if (!resolvedSymbolId) {
            const fallbackResult = this.db
              .prepare(
                `
                select symbol_id from symbols
                where repo_id = ? and file_path like ?
                order by line asc
                limit 1
                `
              )
              .get(repoId, `%${normalizedPath}%`) as { symbol_id: string } | undefined;

            if (fallbackResult) {
              resolvedSymbolId = fallbackResult.symbol_id;
            }
          }
        }
        // Heading mentions are low priority, skip for now

        if (resolvedSymbolId) {
          updateStmt.run(resolvedSymbolId, repoId, mention.doc_id, mention.mention_type, mention.mention_text);
          count += 1;
        }
      }
    });
    tx();

    return count;
  }

  /**
   * Simple string similarity calculation (0.0 to 1.0)
   * Based on longest common subsequence
   */
  private stringSimilarity(a: string, b: string): number {
    const aLower = a.toLowerCase();
    const bLower = b.toLowerCase();
    if (aLower === bLower) return 1.0;

    const longer = aLower.length > bLower.length ? aLower : bLower;
    const shorter = longer === aLower ? bLower : aLower;

    if (longer.length === 0) return 1.0; // Both empty
    if (shorter.length === 0) return 0.0; // One empty

    // Edit distance based similarity
    const dist = this.levenshteinDistance(aLower, bLower);
    return 1.0 - dist / longer.length;
  }

  /**
   * Calculate Levenshtein distance between two strings
   */
  private levenshteinDistance(a: string, b: string): number {
    const m = a.length;
    const n = b.length;
    const dp: number[][] = Array(m + 1)
      .fill(null)
      .map(() => Array(n + 1).fill(0));

    for (let i = 0; i <= m; i++) dp[i][0] = i;
    for (let j = 0; j <= n; j++) dp[0][j] = j;

    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        if (a[i - 1] === b[j - 1]) {
          dp[i][j] = dp[i - 1][j - 1];
        } else {
          dp[i][j] = 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
        }
      }
    }

    return dp[m][n];
  }

  private runMigrations(): void {
    // Add signature column to symbols if missing (backward-compatible with existing DBs)
    const symbolsCols = this.db.prepare("pragma table_info(symbols)").all() as { name: string }[];
    if (!symbolsCols.some((c) => c.name === "signature")) {
      this.db.exec("alter table symbols add column signature text");
    }

    // Refresh symbols_fts if it doesn't have the signature column yet
    try {
      this.db.prepare("select signature from symbols_fts limit 0").all();
    } catch {
      this.db.exec(`
        drop table if exists symbols_fts;
        create virtual table symbols_fts using fts5(
          name,
          signature,
          symbol_id unindexed,
          repo_id unindexed,
          content='symbols',
          content_rowid='rowid'
        );
      `);
    }

    // Add detailed cross-repo resolution metrics to index_runs for rollout diagnostics.
    const runCols = this.db.prepare("pragma table_info(index_runs)").all() as { name: string }[];
    const ensureRunColumn = (name: string) => {
      if (!runCols.some((c) => c.name === name)) {
        this.db.exec(`alter table index_runs add column ${name} integer not null default 0`);
      }
    };

    ensureRunColumn("cross_repo_attempts");
    ensureRunColumn("cross_repo_resolved");
    ensureRunColumn("unresolved_no_candidate");
    ensureRunColumn("unresolved_ambiguous");
    ensureRunColumn("unresolved_boundary_blocked");
    ensureRunColumn("unresolved_low_confidence");
  }

  private buildFtsQuery(query: string): string {
    const tokens = query.trim().split(/\s+/).filter((t) => t.length >= 2);
    if (tokens.length <= 1) {
      const q = (tokens[0] ?? query.trim()).replace(/"/g, '""');
      return `"${q}"*`;
    }
    return tokens.map((t) => `"${t.replace(/"/g, '""')}"*`).join(" OR ");
  }

  searchDocs(
    repoId: string,
    query: string,
    limit: number
  ): {
    docId: string;
    filePath: string;
    headingPath: string;
    contentType: string;
    text: string | null;
    level: number | null;
    resolvedMentions: { symbolId: string; symbolName: string | null; mentionText: string }[];
  }[] {
    const ftsQuery = this.buildFtsQuery(query);
    let docIds: string[] = [];
    let usedFts = false;

    try {
      this.db.prepare("select * from docs_fts limit 0").all();
      const ftsRows = this.db
        .prepare(
          `
          select fts.doc_id as docId
          from docs_fts fts
          inner join docs d on d.doc_id = fts.doc_id and d.repo_id = ?
          where fts match ?
          order by rank
          limit ?
          `
        )
        .all(repoId, ftsQuery, limit) as { docId: string }[];
      docIds = ftsRows.map((r) => r.docId);
      usedFts = true;
    } catch {
      // FTS unavailable
    }

    if (!usedFts || docIds.length === 0) {
      const likeRows = this.db
        .prepare(
          `select doc_id as docId from docs where repo_id = ? and text like ? order by rowid limit ?`
        )
        .all(repoId, `%${query}%`, limit) as { docId: string }[];
      docIds = likeRows.map((r) => r.docId);
    }

    if (docIds.length === 0) return [];

    const ph = docIds.map(() => "?").join(",");
    const docs = this.db
      .prepare(
        `select doc_id as docId, file_path as filePath, heading_path as headingPath,
                content_type as contentType, text, level
         from docs where repo_id = ? and doc_id in (${ph})`
      )
      .all(repoId, ...docIds) as {
      docId: string;
      filePath: string;
      headingPath: string;
      contentType: string;
      text: string | null;
      level: number | null;
    }[];

    const mentionRows = this.db
      .prepare(
        `select dm.doc_id as docId, dm.symbol_id as symbolId,
                dm.mention_text as mentionText, s.name as symbolName
         from doc_mentions dm
         left join symbols s on s.repo_id = ? and s.symbol_id = dm.symbol_id
         where dm.repo_id = ? and dm.doc_id in (${ph}) and dm.symbol_id is not null`
      )
      .all(repoId, repoId, ...docIds) as {
      docId: string;
      symbolId: string;
      mentionText: string;
      symbolName: string | null;
    }[];

    const mentionsByDoc = new Map<
      string,
      { symbolId: string; symbolName: string | null; mentionText: string }[]
    >();
    for (const row of mentionRows) {
      if (!mentionsByDoc.has(row.docId)) mentionsByDoc.set(row.docId, []);
      mentionsByDoc
        .get(row.docId)!
        .push({ symbolId: row.symbolId, symbolName: row.symbolName, mentionText: row.mentionText });
    }

    // Preserve FTS relevance order
    const orderMap = new Map(docIds.map((id, i) => [id, i]));
    return docs
      .sort((a, b) => (orderMap.get(a.docId) ?? 99) - (orderMap.get(b.docId) ?? 99))
      .map((doc) => ({ ...doc, resolvedMentions: mentionsByDoc.get(doc.docId) ?? [] }));
  }

  findStaleDocs(
    repoId: string,
    symbolIds: string[]
  ): {
    docId: string;
    filePath: string;
    headingPath: string;
    text: string | null;
    mentionText: string;
    symbolName: string | null;
  }[] {
    if (symbolIds.length === 0) return [];
    const ph = symbolIds.map(() => "?").join(",");
    return this.db
      .prepare(
        `
        select dm.doc_id as docId, d.file_path as filePath, d.heading_path as headingPath,
               d.text, dm.mention_text as mentionText, s.name as symbolName
        from doc_mentions dm
        inner join docs d on d.repo_id = dm.repo_id and d.doc_id = dm.doc_id
        left join symbols s on s.repo_id = dm.repo_id and s.symbol_id = dm.symbol_id
        where dm.repo_id = ? and dm.symbol_id in (${ph})
        order by d.file_path, d.heading_path
        limit 200
        `
      )
      .all(repoId, ...symbolIds) as {
      docId: string;
      filePath: string;
      headingPath: string;
      text: string | null;
      mentionText: string;
      symbolName: string | null;
    }[];
  }

  findDocCoverage(
    repoId: string,
    filePath: string
  ): {
    symbolId: string;
    name: string;
    kind: string;
    line: number;
    signature: string | null;
    hasDocs: boolean;
    mentionCount: number;
  }[] {
    return this.db
      .prepare(
        `
        select
          s.symbol_id as symbolId,
          s.name,
          s.kind,
          s.line,
          s.signature,
          case when count(dm.doc_id) > 0 then 1 else 0 end as hasDocs,
          count(dm.doc_id) as mentionCount
        from symbols s
        left join doc_mentions dm on dm.repo_id = s.repo_id and dm.symbol_id = s.symbol_id
        where s.repo_id = ? and replace(s.file_path, char(92), '/') = replace(?, char(92), '/') and s.kind != 'module'
        group by s.symbol_id, s.name, s.kind, s.line, s.signature
        order by s.line
        limit 200
        `
      )
      .all(repoId, filePath) as {
      symbolId: string;
      name: string;
      kind: string;
      line: number;
      signature: string | null;
      hasDocs: boolean;
      mentionCount: number;
    }[];
  }

  private countUnresolvedEdgesForFile(repoId: string, filePath: string): GraphHealth {
    const canonicalFilePath = this.resolveCanonicalFilePath(repoId, filePath);

    const row = this.db
      .prepare(
        `
        select
          count(case when e.to_id like 'callee:%' then 1 end) as unresolvedCalls,
          count(case when e.to_id like 'import:%' then 1 end) as unresolvedImports
        from edges e
        inner join symbols s on s.repo_id = e.repo_id and s.symbol_id = e.from_id
        where e.repo_id = ? and replace(s.file_path, char(92), '/') = replace(?, char(92), '/')
        `
      )
      .get(repoId, canonicalFilePath) as { unresolvedCalls: number; unresolvedImports: number };

    const { unresolvedCalls, unresolvedImports } = row ?? { unresolvedCalls: 0, unresolvedImports: 0 };
    let note: string;
    if (unresolvedCalls === 0 && unresolvedImports === 0) {
      note = "graph data complete";
    } else {
      const parts: string[] = [];
      if (unresolvedCalls > 0) parts.push(`${unresolvedCalls} call edge${unresolvedCalls > 1 ? "s" : ""} unresolved`);
      if (unresolvedImports > 0) parts.push(`${unresolvedImports} import edge${unresolvedImports > 1 ? "s" : ""} unresolved`);
      note = `${parts.join(", ")} — results may be incomplete`;
    }

    return { unresolvedCalls, unresolvedImports, note };
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
        signature text,
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
        docs_upserted integer not null default 0,
        mentions_upserted integer not null default 0,
        parse_failures integer not null,
        cross_repo_linked integer not null default 0,
        call_edges_resolved integer not null default 0,
        import_edges_resolved integer not null default 0,
        mentions_resolved integer not null default 0,
        elapsed_ms integer not null,
        cross_repo_attempts integer not null default 0,
        cross_repo_resolved integer not null default 0,
        unresolved_no_candidate integer not null default 0,
        unresolved_ambiguous integer not null default 0,
        unresolved_boundary_blocked integer not null default 0,
        unresolved_low_confidence integer not null default 0
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
        signature,
        symbol_id unindexed,
        repo_id unindexed,
        content='symbols',
        content_rowid='rowid'
      );

      create table if not exists docs (
        repo_id text not null,
        doc_id text not null,
        file_path text not null,
        heading_path text not null,
        content_type text not null,
        text text,
        level integer,
        primary key (repo_id, doc_id)
      );

      create table if not exists doc_mentions (
        repo_id text not null,
        doc_id text not null,
        symbol_id text,
        mention_type text not null,
        confidence real not null,
        mention_text text not null,
        primary key (repo_id, doc_id, symbol_id, mention_type, mention_text)
      );

      create virtual table if not exists docs_fts using fts5(
        text,
        doc_id unindexed,
        repo_id unindexed,
        content='docs',
        content_rowid='rowid'
      );

      create index if not exists idx_docs_repo_file on docs(repo_id, file_path);
      create index if not exists idx_docs_repo_heading on docs(repo_id, heading_path);
      create index if not exists idx_doc_mentions_repo_doc on doc_mentions(repo_id, doc_id);
      create index if not exists idx_doc_mentions_repo_symbol on doc_mentions(repo_id, symbol_id);
    `);
  }
}
