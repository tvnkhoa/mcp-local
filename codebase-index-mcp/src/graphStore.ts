import Database from "better-sqlite3";

import type {
  RefactorApplyHunkRecord,
  EdgeRecord,
  FileRecord,
  GraphHealth,
  IndexRunSummary,
  RefactorApplyChangeRecord,
  RefactorApplyRecord,
  RefactorPreviewHunkRecord,
  RefactorPreviewRecord,
  RefactorRollbackRecord,
  ReliabilitySummary,
  ResolvedEdge,
  ResolutionStats,
  RouteRecord,
  SymbolRecord
} from "./types.js";
import {
  resolveUnlinkedEdges as resolveUnlinkedEdgesImpl,
  resolveImportEdges as resolveImportEdgesImpl,
  resolveCallEdges as resolveCallEdgesImpl,
  resolveTypeRefEdges as resolveTypeRefEdgesImpl,
  resolvePropertyEdges as resolvePropertyEdgesImpl,
  resolveImplementsEdges as resolveImplementsEdgesImpl
} from "./edgeResolver.js";
import {
  linkTestsToSource as linkTestsToSourceImpl,
  getDeadCodeCandidates as getDeadCodeCandidatesImpl,
  detectCircularDependencies as detectCircularDependenciesImpl,
  findEntryPoints as findEntryPointsImpl,
  findImplementations as findImplementationsImpl
} from "./staticAnalyzer.js";
import {
  upsertDocsImpl,
  upsertDocMentionsImpl,
  rebuildDocsFtsImpl,
  resolveMentionsImpl,
  searchDocsImpl,
  findStaleDocsImpl,
  findDocCoverageImpl
} from "./docsStore.js";
import {
  parseRiskFlags,
  saveRefactorPreviewImpl,
  getRefactorPreviewImpl,
  markRefactorPreviewStatusImpl,
  recordRefactorApplyImpl,
  getApplyByRollbackIdImpl,
  recordRefactorRollbackImpl
} from "./refactorStore.js";
import {
  upsertCrossRepoDepImpl,
  getCrossRepoDepsImpl,
  getCrossRepoImpactImpl,
  findPackageConsumersImpl,
  getPackageBridgeStatsImpl
} from "./crossRepoStore.js";
import {
  buildFtsQuery,
  extractIntentTokens,
  buildIntentFtsQuery,
  rebuildFtsImpl,
  searchSymbolsImpl,
  getSearchSuggestionsImpl,
  getSymbolDetailImpl,
  findCallersByNameImpl,
  findSymbolAtLineImpl,
  findReferencesImpl,
  getContextByNameImpl,
  getSymbolCandidatesImpl
} from "./symbolSearch.js";
import {
  TRIVIAL_CALLEE_TOKENS,
  TRIVIAL_CALLEE_IN_CLAUSE,
  normalizePath,
  resolveCanonicalFilePath,
  findModuleSymbolId,
  getEdgeDefaults,
  buildReliabilitySummaryImpl,
  countUnresolvedEdgesForFileImpl,
  getImpactSurfaceImpl,
  getImpactFilesImpl,
  getFileSummaryImpl,
  getFileContextImpl,
  getBatchContextImpl,
  getChangeContextImpl,
  getRenameImpactImpl,
  traceExecutionFlowImpl,
  getFolderSummaryImpl,
  groupFilesByModuleImpl,
  getRouteMapImpl,
  getRepoSchemaSnapshotImpl,
  runReadOnlyGraphQueryImpl,
  listIndexedFilesImpl,
  listRepositoriesImpl
} from "./impactAnalyzer.js";

// TRIVIAL_CALLEE_TOKENS, TRIVIAL_CALLEE_IN_CLAUSE → impactAnalyzer.ts
// parseRiskFlags → refactorStore.ts
// createEmptyResolutionStats → edgeResolver.ts

export class GraphStore {
  private readonly db: Database.Database;
  private readonly runInTransactionInternal: (fn: () => void) => void;

  // Cached prepared statements for the hot indexing write path.
  private stmtUpsertFile!: Database.Statement;
  private stmtDeleteEdgesForFile!: Database.Statement;
  private stmtDeleteSymbolsForFile!: Database.Statement;
  private stmtInsertSymbol!: Database.Statement;
  private stmtDeleteRoutesForFile!: Database.Statement;
  private stmtInsertEdge!: Database.Statement;
  private stmtInsertRoute!: Database.Statement;

  // buildNamedCandidateMap, pickBestNamedCandidate → edgeResolver.ts

  // getEdgeDefaults, buildReliabilitySummary, normalizePath, resolveCanonicalFilePath → impactAnalyzer.ts

  private isSqliteUniqueConstraintError(error: unknown): boolean {
    if (!error || typeof error !== "object") {
      return false;
    }

    const sqliteCode = (error as { code?: string }).code;
    if (typeof sqliteCode === "string" && sqliteCode.startsWith("SQLITE_CONSTRAINT")) {
      return true;
    }

    const message = (error as { message?: string }).message;
    if (typeof message === "string" && /UNIQUE constraint failed/i.test(message)) {
      return true;
    }

    return false;
  }

  private buildSymbolCollisionError(row: SymbolRecord, error: unknown): Error {
    const existing = this.db
      .prepare(
        `
        select file_path as filePath, name, kind
        from symbols
        where repo_id = ? and symbol_id = ?
        limit 1
        `
      )
      .get(row.repoId, row.symbolId) as { filePath: string; name: string; kind: string } | undefined;

    const existingDetails = existing
      ? `existingFile=${existing.filePath} existingName=${existing.name} existingKind=${existing.kind}`
      : "existingSymbol=unknown";
    const incomingDetails = `incomingFile=${row.filePath} incomingName=${row.name} incomingKind=${row.kind}`;
    const causeMessage = error instanceof Error ? error.message : String(error);

    return new Error(
      `[index-collision] symbol_id collision repoId=${row.repoId} symbolId=${row.symbolId} ${incomingDetails} ${existingDetails} cause=${causeMessage}`
    );
  }

  // getEdgeDefaults → impactAnalyzer.ts (getEdgeDefaults)
  // buildReliabilitySummary → impactAnalyzer.ts (buildReliabilitySummaryImpl)
  // normalizePath → impactAnalyzer.ts (normalizePath)
  // resolveCanonicalFilePath → impactAnalyzer.ts (resolveCanonicalFilePath)

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("cache_size = -64000"); // 64MB cache
    this.db.pragma("temp_store = MEMORY");
    this.db.pragma("page_size = 4096"); // Standard 4KB page size
    this.db.pragma("busy_timeout = 5000"); // 5s timeout for locks
    this.runInTransactionInternal = this.db.transaction((fn: () => void) => fn());
    this.initSchema();
    this.runMigrations();
    this.initCachedStatements();
  }

  private initCachedStatements(): void {
    this.stmtUpsertFile = this.db.prepare(
      `
      insert into files (repo_id, path, content_hash, language, updated_at)
      values (@repoId, @path, @contentHash, @language, @updatedAt)
      on conflict(repo_id, path) do update set
        content_hash = excluded.content_hash,
        language = excluded.language,
        updated_at = excluded.updated_at
      `
    );
    this.stmtDeleteEdgesForFile = this.db.prepare(
      `
      delete from edges
      where repo_id = ?
        and from_id in (
          select symbol_id
          from symbols
          where repo_id = ? and file_path = ?
        )
      `
    );
    this.stmtDeleteSymbolsForFile = this.db.prepare(
      `delete from symbols where repo_id = ? and file_path = ?`
    );
    this.stmtInsertSymbol = this.db.prepare(
      `
      insert into symbols (repo_id, symbol_id, file_path, name, kind, line, signature)
      values (@repoId, @symbolId, @filePath, @name, @kind, @line, @signature)
      `
    );
    this.stmtDeleteRoutesForFile = this.db.prepare(
      `delete from routes where repo_id = ? and file_path = ?`
    );
    this.stmtInsertEdge = this.db.prepare(
      `
      insert into edges (repo_id, from_id, to_id, type, confidence, reason)
      values (@repoId, @fromId, @toId, @type, @confidence, @reason)
      `
    );
    this.stmtInsertRoute = this.db.prepare(
      `
      insert into routes (repo_id, file_path, controller_symbol_id, handler_symbol_id, http_method, route_template, line)
      values (@repoId, @filePath, @controllerSymbolId, @handlerSymbolId, @httpMethod, @routeTemplate, @line)
      `
    );
  }

  close(): void {
    this.db.close();
  }

  runInTransaction(fn: () => void): void {
    this.runInTransactionInternal(fn);
  }

  /** Flush WAL contents into main database file (GitNexus pattern for batch indexing). */
  checkpoint(): void {
    try {
      this.db.pragma("wal_checkpoint(PASSIVE)");
    } catch {
      // Ignore checkpoint errors to avoid interrupting indexing flow.
    }
  }

  upsertFile(record: FileRecord): void {
    this.stmtUpsertFile.run(record);
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
    // Remove previous edges emitted by symbols in this file before replacing symbols.
    this.stmtDeleteEdgesForFile.run(repoId, repoId, filePath);
    this.stmtDeleteSymbolsForFile.run(repoId, filePath);

    const writeRows = (rows: SymbolRecord[]) => {
      for (const row of rows) {
        try {
          this.stmtInsertSymbol.run({ ...row, signature: row.signature ?? null });
        } catch (error) {
          if (this.isSqliteUniqueConstraintError(error)) {
            throw this.buildSymbolCollisionError(row, error);
          }
          throw error;
        }
      }
    };

    if (this.db.inTransaction) {
      writeRows(symbols);
      return;
    }

    this.db.transaction((rows: SymbolRecord[]) => {
      writeRows(rows);
    })(symbols);
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
        this.db
          .prepare(
            `
            delete from edges
            where repo_id = ?
              and from_id in (
                select symbol_id
                from symbols
                where repo_id = ? and file_path = ?
              )
            `
          )
          .run(repoId, repoId, filePath);
        this.db.prepare(`delete from symbols where repo_id = ? and file_path = ?`).run(repoId, filePath);
        this.db.prepare(`delete from docs where repo_id = ? and file_path = ?`).run(repoId, filePath);
        this.db.prepare(`delete from routes where repo_id = ? and file_path = ?`).run(repoId, filePath);
        this.db.prepare(`delete from files where repo_id = ? and path = ?`).run(repoId, filePath);
      }
    });
    deleteTx(uniquePaths);

    return uniquePaths.length;
  }

  pruneOrphanedEdges(repoId: string): number {
    const result = this.db
      .prepare(
        `
        DELETE FROM edges
        WHERE repo_id = ?
          AND from_id NOT LIKE 'callee:%'
          AND from_id NOT IN (SELECT symbol_id FROM symbols WHERE repo_id = ?)
        `
      )
      .run(repoId, repoId);
    return result.changes;
  }

  replaceEdgesForFile(repoId: string, filePath: string, edges: EdgeRecord[]): void {
    // replaceSymbolsForFile already cleared edges for this file, but we delete again here as a
    // safety net for callers that invoke replaceEdgesForFile independently.
    this.stmtDeleteEdgesForFile.run(repoId, repoId, filePath);

    const writeRows = (rows: EdgeRecord[]) => {
      for (const row of rows) {
        const defaults = getEdgeDefaults(row);
        this.stmtInsertEdge.run({
          ...row,
          confidence: row.confidence ?? defaults.confidence,
          reason: row.reason ?? defaults.reason
        });
      }
    };

    if (this.db.inTransaction) {
      writeRows(edges);
      return;
    }

    this.db.transaction((rows: EdgeRecord[]) => {
      writeRows(rows);
    })(edges);
  }

  replaceRoutesForFile(repoId: string, filePath: string, routes: RouteRecord[]): void {
    this.stmtDeleteRoutesForFile.run(repoId, filePath);

    if (routes.length === 0) {
      return;
    }

    const writeRows = (rows: RouteRecord[]) => {
      for (const row of rows) {
        this.stmtInsertRoute.run(row);
      }
    };

    if (this.db.inTransaction) {
      writeRows(routes);
      return;
    }

    this.db.transaction((rows: RouteRecord[]) => {
      writeRows(rows);
    })(routes);
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
          unresolved_boundary_blocked, unresolved_low_confidence,
          commit_sha
        ) values (
          ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?,
          ?, ?, ?, ?,
          ?, ?, ?, ?,
          ?,
          ?, ?,
          ?, ?,
          ?, ?,
          ?
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
        summary.unresolvedLowConfidence ?? 0,
        summary.commitSha ?? null
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
          unresolved_low_confidence as unresolvedLowConfidence,
          commit_sha as commitSha
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

  findModuleSymbolId(repoId: string, filePath: string): string | null {
    return findModuleSymbolId(this.db, repoId, filePath);
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
    const canonicalFilePath = resolveCanonicalFilePath(this.db, repoId, filePath);

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
    upsertCrossRepoDepImpl(this.db, fromRepoId, fromSymbolId, toRepoId, toSymbolId, type);
  }

  getCrossRepoDeps(fromRepoId: string, fromSymbolId: string, limit: number): {
    toRepoId: string;
    toSymbolId: string;
    type: string;
  }[] {
    return getCrossRepoDepsImpl(this.db, fromRepoId, fromSymbolId, limit);
  }

  getCrossRepoImpact(
    repoId: string,
    symbolId: string,
    direction: "outbound" | "inbound",
    limit: number
  ): {
    fromRepoId: string;
    fromSymbolId: string;
    toRepoId: string;
    toSymbolId: string;
    type: string;
    relatedName: string | null;
    relatedKind: string | null;
    relatedFilePath: string | null;
    relatedSignature: string | null;
  }[] {
    return getCrossRepoImpactImpl(this.db, repoId, symbolId, direction, limit);
  }

  findPackageConsumers(
    packageContractId: string,
    repoId: string | null,
    limit: number
  ): {
    consumerRepoId: string;
    consumerSymbolId: string;
    consumerName: string | null;
    consumerKind: string | null;
    consumerFilePath: string | null;
    packageContractId: string;
    dependencyReason: string | null;
    providerRepoId: string | null;
    providerSymbolId: string | null;
  }[] {
    return findPackageConsumersImpl(this.db, packageContractId, repoId, limit);
  }

  getPackageBridgeStats(repoId: string): {
    packageAttempts: number;
    packageResolved: number;
    packageNoCandidate: number;
  } {
    return getPackageBridgeStatsImpl(this.db, repoId);
  }

  linkTestsToSource(
    repoId: string,
    filePath: string | null,
    limit: number,
    maxCandidates: number,
    minScore: number
  ): {
    testFile: string;
    sourceFile: string;
    score: number;
    reasons: string[];
  }[] {
    return linkTestsToSourceImpl(this.db, repoId, filePath, limit, maxCandidates, minScore);
  }

  getDeadCodeCandidates(
    repoId: string,
    filePathPrefix: string | null,
    language: string | null,
    kind: string | null,
    includePrivate: boolean,
    limit: number
  ): {
    candidates: {
      symbolId: string;
      name: string;
      kind: string;
      filePath: string;
      line: number;
      signature: string | null;
      language: string | null;
      incomingCalls: number;
      incomingTypeRefs: number;
      incomingImports: number;
      deadReason: string;
    }[];
    suppressed: {
      total: number;
      reasons: Record<string, number>;
    };
    scanPolicy: {
      mode: "skip_low_confidence";
      note: string;
    };
  } {
    return getDeadCodeCandidatesImpl(this.db, repoId, filePathPrefix, language, kind, includePrivate, limit);
  }


  detectCircularDependencies(
    repoId: string,
    filePathPrefix: string | null,
    mode: "module" | "symbol",
    includeCalls: boolean,
    maxDepth: number,
    maxCycles: number
  ): {
    mode: "module" | "symbol";
    cycleCount: number;
    cycles: { path: string[]; edgeTypes: string[]; length: number }[];
  } {
    return detectCircularDependenciesImpl(this.db, repoId, filePathPrefix, mode, includeCalls, maxDepth, maxCycles);
  }

  listRepositories(): { repoId: string; repoPath: string; updatedAt: string; filesIndexed: number; symbolCount: number; lastRunStatus: string | null; lastRunAt: string | null }[] {
    return listRepositoriesImpl(this.db);
  }

  getRouteMap(repoId: string, filePathPrefix: string | null, httpMethod: string | null, limit: number): { filePath: string; controllerSymbolId: string; controllerName: string | null; handlerSymbolId: string; handlerName: string | null; httpMethod: string; routeTemplate: string; line: number }[] {
    return getRouteMapImpl(this.db, repoId, filePathPrefix, httpMethod, limit);
  }

  getRepoSchemaSnapshot(repoId: string): { repoId: string; fileCount: number; symbolCount: number; edgeCount: number; routeCount: number; languages: { language: string; fileCount: number }[] } {
    return getRepoSchemaSnapshotImpl(this.db, repoId);
  }

  runReadOnlyGraphQuery(sql: string, namedParams: Record<string, string | number | boolean | null>, limit: number, timeoutMs?: number): { columns: string[]; rows: Record<string, unknown>[]; rowCount: number; truncated: boolean; elapsedMs: number; timedOut: boolean } {
    return runReadOnlyGraphQueryImpl(this.db, sql, namedParams, limit, timeoutMs);
  }

  rebuildFts(): void {
    rebuildFtsImpl(this.db);
  }

  searchSymbols(query: string, repoId: string | null, language: string | null, kind: string | null, filePath: string | null, limit: number, strategy: "name" | "intent" = "name"): (SymbolRecord & { repoPath: string | null })[] {
    return searchSymbolsImpl(this.db, query, repoId, language, kind, filePath, limit, strategy);
  }

  getSearchSuggestions(query: string, repoId: string | null, limit: number): string[] {
    return getSearchSuggestionsImpl(this.db, query, repoId, limit);
  }

  getSymbolDetail(repoId: string, symbolId: string, limit: number): { symbol: SymbolRecord | null; edgesOut: ResolvedEdge[]; edgesIn: ResolvedEdge[] } {
    return getSymbolDetailImpl(this.db, repoId, symbolId, limit);
  }

  getFileContext(repoId: string, filePath: string, limit: number, compact = false): { symbols: SymbolRecord[] | { name: string; kind: string; line: number }[]; edges: ResolvedEdge[]; graphHealth: GraphHealth } {
    return getFileContextImpl(this.db, repoId, filePath, limit, compact);
  }

  getBatchContext(repoId: string, filePaths: string[], limit: number, compact = false): { symbols: SymbolRecord[] | { name: string; kind: string; filePath: string; line: number }[]; edges: ResolvedEdge[] } {
    return getBatchContextImpl(this.db, repoId, filePaths, limit, compact);
  }

  resolveUnlinkedEdges(repoId: string): ResolutionStats {
    return resolveUnlinkedEdgesImpl(this.db, repoId);
  }

  resolveImportEdges(repoId: string, maxUnresolvedRows = 0): number {
    return resolveImportEdgesImpl(this.db, repoId, maxUnresolvedRows);
  }

  resolveCallEdges(repoId: string, maxUnresolvedRows = 0): number {
    return resolveCallEdgesImpl(this.db, repoId, maxUnresolvedRows);
  }

  resolveTypeRefEdges(repoId: string, maxUnresolvedRows = 0): number {
    return resolveTypeRefEdgesImpl(this.db, repoId, maxUnresolvedRows);
  }

  resolvePropertyEdges(repoId: string, maxUnresolvedRows = 0): number {
    return resolvePropertyEdgesImpl(this.db, repoId, maxUnresolvedRows);
  }

  getImpactSurface(repoId: string, filePath: string, limit: number): { callers: { callerName: string; callerFile: string; callerLine: number; symbolAffected: string; edgeType: string; confidence: number; reason: string | null }[]; graphHealth: GraphHealth; reliabilitySummary: ReliabilitySummary } {
    return getImpactSurfaceImpl(this.db, repoId, filePath, limit);
  }

  getImpactFiles(repoId: string, filePath: string, limit: number): { impactedFiles: { filePath: string; reason: string; confidence: number; symbolsAffected: string[] }[]; graphHealth: GraphHealth; reliabilitySummary: ReliabilitySummary } {
    return getImpactFilesImpl(this.db, repoId, filePath, limit);
  }

  getFileSummary(repoId: string, filePath: string): { file: { filePath: string; language: string | null }; exports: SymbolRecord[]; imports: ResolvedEdge[]; importedBy: { fromFilePath: string; edgeType: string }[]; graphHealth: GraphHealth } {
    return getFileSummaryImpl(this.db, repoId, filePath);
  }

  getChangeContext(repoId: string, symbolId: string, callerDepth: number, calleeDepth: number, limit: number): { symbol: SymbolRecord | null; callers: (ResolvedEdge & { distance: number })[]; callees: ResolvedEdge[]; typeDeps: ResolvedEdge[]; graphHealth: GraphHealth; reliabilitySummary: ReliabilitySummary } {
    return getChangeContextImpl(this.db, repoId, symbolId, callerDepth, calleeDepth, limit);
  }

  findCallersByName(repoId: string, symbolName: string, limit: number): { symbolName: string; callers: { callerName: string; callerFile: string; callerLine: number; kind: string }[] } {
    return findCallersByNameImpl(this.db, repoId, symbolName, limit);
  }

  /**
   * Find the symbol that encloses a given line number (nearest symbol with line <= target).
   * Useful for mapping stack-trace file+line → symbolId without an extra search hop.
   */
  findSymbolAtLine(repoId: string, filePath: string, line: number): SymbolRecord | null {
    return findSymbolAtLineImpl(this.db, repoId, filePath, line, (rid, fp) => resolveCanonicalFilePath(this.db, rid, fp));
  }

  /**
   * Find all callers (CALLS edges) and importing files (IMPORTS edges) for a symbol by name.
   * Does not require symbolId — resolves by name match first.
   */
  findReferences(repoId: string, symbolName: string, limit: number): { symbolName: string; matchedSymbols: SymbolRecord[]; callers: { callerName: string; callerFile: string; callerLine: number; kind: string }[]; importedByFiles: string[]; totalFound: number } {
    return findReferencesImpl(this.db, repoId, symbolName, limit);
  }

  /**
   * Single-call context lookup by symbol name — avoids the 2-hop search_symbols → get_symbol_detail pattern.
   * Returns the best-matching symbol plus its callers, callees, and importing files.
   */
  getContextByName(repoId: string, name: string, limit: number): { symbol: SymbolRecord | null; callers: { callerName: string; callerFile: string; callerLine: number; kind: string }[]; callees: { calleeName: string; calleeFile: string | null; calleeLine: number | null; kind: string | null }[]; importedByFiles: string[]; allMatchedSymbols: SymbolRecord[] } {
    return getContextByNameImpl(this.db, repoId, name, limit);
  }

  getSymbolCandidates(repoId: string, name: string, limit: number): { symbolId: string; name: string; kind: string; filePath: string; line: number; signature: string | null; matchType: "exact" | "prefix" | "contains"; score: number; confidence: number }[] {
    return getSymbolCandidatesImpl(this.db, repoId, name, limit);
  }

  getFolderSummary(repoId: string, folderPath: string, maxFiles: number): { folderPath: string; totalFiles: number; directFiles: number; subfolders: string[]; files: { filePath: string; language: string | null; symbolCount: number; exportedCount: number; callerCount: number }[] } {
    return getFolderSummaryImpl(this.db, repoId, folderPath, maxFiles);
  }

  /**
   * Find entry points in priority order:
   * 1. Runtime bootstrap files: Program.cs, Startup.cs, main.ts/js, index.ts (top-level)
   * 2. Public symbols with 0 incoming CALLS edges (not called internally)
   * Excludes modules, properties, constructors from the uncalled-symbol scan to reduce noise.
   */
  findEntryPoints(
    repoId: string,
    filePathPrefix: string | null,
    kind: string | null,
    limit: number
  ): { symbolId: string; name: string; kind: string; filePath: string; line: number; signature: string | null; entryReason: string }[] {
    return findEntryPointsImpl(this.db, repoId, filePathPrefix, kind, limit);
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
    return findImplementationsImpl(this.db, repoId, interfaceName, limit);
  }

  /**
   * Resolve IMPLEMENTS edges — convert iface:InterfaceName placeholders to real symbolIds.
   * Should be called after indexing C# files.
   */
  resolveImplementsEdges(repoId: string): number {
    return resolveImplementsEdgesImpl(this.db, repoId);
  }

  upsertDocs(docs: import("./types.js").DocRecord[]): void {
    upsertDocsImpl(this.db, docs);
  }

  upsertDocMentions(mentions: import("./types.js").DocMentionRecord[]): void {
    upsertDocMentionsImpl(this.db, mentions);
  }

  rebuildDocsFts(): void {
    rebuildDocsFtsImpl(this.db);
  }

  /**
   * Resolve unresolved doc mentions to symbol IDs.
   * Strategy:
   * - Backtick mentions: exact name match, then fuzzy match (threshold 0.8)
   * - Filepath mentions: extract module path, find symbols from that file
   * - Heading mentions: low priority, keyword matching with fuzzy logic
   */
  resolveMentions(repoId: string): number {
    return resolveMentionsImpl(this.db, repoId);
  }

  // stringSimilarity, levenshteinDistance → docsStore.ts

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

    // Add commit_sha for staleness detection.
    if (!runCols.some((c) => c.name === "commit_sha")) {
      this.db.exec(`alter table index_runs add column commit_sha text`);
    }

    const edgeCols = this.db.prepare("pragma table_info(edges)").all() as { name: string }[];
    const ensureEdgeColumn = (name: string, sqlType: string, defaultExpr?: string) => {
      if (!edgeCols.some((c) => c.name === name)) {
        const suffix = defaultExpr ? ` default ${defaultExpr}` : "";
        this.db.exec(`alter table edges add column ${name} ${sqlType}${suffix}`);
      }
    };

    ensureEdgeColumn("confidence", "real", "1.0");
    ensureEdgeColumn("reason", "text");

    this.db.exec(`
      create table if not exists routes (
        repo_id text not null,
        file_path text not null,
        controller_symbol_id text not null,
        handler_symbol_id text not null,
        http_method text not null,
        route_template text not null,
        line integer not null
      );
      create index if not exists idx_routes_repo_file on routes(repo_id, file_path);
      create index if not exists idx_routes_repo_method on routes(repo_id, http_method);
      create index if not exists idx_routes_repo_handler on routes(repo_id, handler_symbol_id);
    `);

    this.db.exec(`
      update edges
      set confidence = case
          when to_id like 'callee:%' then 0.4
          when to_id like 'import:%' then 0.5
          when to_id like 'type:%' then 0.45
          when to_id like 'property:%' then 0.5
          when type = 'IMPORTS' then 0.95
          when type = 'TYPE_REF' then 0.9
          when type = 'PROPERTY_REF' then 0.85
          when type = 'PROPERTY_WRITE' then 0.82
          else 1.0
        end,
        reason = case
          when to_id like 'callee:%' then 'unresolved callee token'
          when to_id like 'import:%' then 'unresolved import token'
          when to_id like 'type:%' then 'unresolved type token'
          when to_id like 'property:%' then 'unresolved property token'
          when type = 'IMPORTS' then 'resolved import edge'
          when type = 'TYPE_REF' then 'resolved type reference'
          when type = 'PROPERTY_REF' then 'resolved property read'
          when type = 'PROPERTY_WRITE' then 'resolved property write'
          when type = 'CALLS' then 'resolved call edge'
          else coalesce(reason, 'direct edge')
        end
      where reason is null or confidence is null
    `);
  }

  // --- Phase 7A: module grouping helper ---
  groupFilesByModule(files: string[]): Record<string, string[]> {
    return groupFilesByModuleImpl(files);
  }

  // --- Phase 7B-2: rename impact ---
  getRenameImpact(repoId: string, symbolId: string, limit: number): {
    symbol: SymbolRecord | null;
    callers: ResolvedEdge[];
    importers: ResolvedEdge[];
    affectedFileCount: number;
  } {
    return getRenameImpactImpl(this.db, repoId, symbolId, limit);
  }

  // --- Phase 7C: execution flow BFS ---
  traceExecutionFlow(repoId: string, entrySymbolId: string, maxDepth: number, maxNodes: number): {
    entrySymbol: SymbolRecord | null;
    nodes: SymbolRecord[];
    edges: { fromId: string; toId: string; fromName: string; toName: string; confidence: number | null }[];
    depthReached: number;
    truncated: boolean;
  } {
    return traceExecutionFlowImpl(this.db, repoId, entrySymbolId, maxDepth, maxNodes);
  }

  // buildFtsQuery, extractIntentTokens, buildIntentFtsQuery → symbolSearch.ts

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
    return searchDocsImpl(this.db, repoId, query, limit, buildFtsQuery, buildIntentFtsQuery);
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
    return findStaleDocsImpl(this.db, repoId, symbolIds);
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
    return findDocCoverageImpl(this.db, repoId, filePath);
  }

  // countUnresolvedEdgesForFile → impactAnalyzer.ts

  listIndexedFiles(repoId: string): { path: string; language: string | null }[] {
    return listIndexedFilesImpl(this.db, repoId);
  }

  saveRefactorPreview(preview: RefactorPreviewRecord, hunks: RefactorPreviewHunkRecord[]): void {
    saveRefactorPreviewImpl(this.db, preview, hunks);
  }

  getRefactorPreview(previewId: string): { preview: RefactorPreviewRecord; hunks: RefactorPreviewHunkRecord[] } | null {
    return getRefactorPreviewImpl(this.db, previewId);
  }

  markRefactorPreviewStatus(previewId: string, status: RefactorPreviewRecord["status"]): void {
    markRefactorPreviewStatusImpl(this.db, previewId, status);
  }

  recordRefactorApply(
    apply: RefactorApplyRecord,
    changes: RefactorApplyChangeRecord[],
    hunks: RefactorApplyHunkRecord[]
  ): void {
    recordRefactorApplyImpl(this.db, apply, changes, hunks);
  }

  getApplyByRollbackId(rollbackId: string): {
    apply: RefactorApplyRecord;
    changes: RefactorApplyChangeRecord[];
    hunks: RefactorApplyHunkRecord[];
  } | null {
    return getApplyByRollbackIdImpl(this.db, rollbackId);
  }

  recordRefactorRollback(rollback: RefactorRollbackRecord): void {
    recordRefactorRollbackImpl(this.db, rollback);
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
        type text not null,
        confidence real not null default 1.0,
        reason text
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

      create table if not exists routes (
        repo_id text not null,
        file_path text not null,
        controller_symbol_id text not null,
        handler_symbol_id text not null,
        http_method text not null,
        route_template text not null,
        line integer not null
      );

      create index if not exists idx_routes_repo_file on routes(repo_id, file_path);
      create index if not exists idx_routes_repo_method on routes(repo_id, http_method);
      create index if not exists idx_routes_repo_handler on routes(repo_id, handler_symbol_id);

      create table if not exists refactor_previews (
        preview_id text primary key,
        repo_id text not null,
        find_pattern text not null,
        replace_expression text not null,
        mode text not null,
        ambiguity_threshold_percent real not null,
        created_at text not null,
        expires_at text not null,
        digest text not null,
        status text not null,
        total_matches integer not null,
        affected_file_count integer not null,
        risk_ambiguous_count integer not null,
        risk_cross_type_count integer not null,
        risk_generated_count integer not null
      );

      create index if not exists idx_refactor_previews_repo_created on refactor_previews(repo_id, created_at desc);

      create table if not exists refactor_preview_hunks (
        preview_id text not null,
        hunk_id text not null,
        file_path text not null,
        line integer not null,
        start_offset integer not null,
        end_offset integer not null,
        before_text text not null,
        after_text text not null,
        replacement_text text not null,
        owner_type text,
        symbol_kind text,
        confidence real not null,
        risk_flags text not null,
        file_hash_before text not null,
        primary key (preview_id, hunk_id)
      );

      create index if not exists idx_refactor_hunks_preview_file on refactor_preview_hunks(preview_id, file_path, start_offset);

      create table if not exists refactor_applies (
        apply_id text primary key,
        rollback_id text not null unique,
        preview_id text not null,
        repo_id text not null,
        status text not null,
        created_at text not null,
        completed_at text not null,
        total_files integer not null,
        total_replacements integer not null,
        conflict_count integer not null
      );

      create index if not exists idx_refactor_applies_preview on refactor_applies(preview_id);
      create index if not exists idx_refactor_applies_repo_created on refactor_applies(repo_id, created_at desc);

      create table if not exists refactor_apply_changes (
        apply_id text not null,
        file_path text not null,
        replacement_count integer not null,
        status text not null,
        reason text,
        file_hash_before text not null,
        file_hash_after text,
        -- before_content / after_content are capped to APPLY_CONTENT_STORE_MAX_BYTES and stored
        -- as NULL when the file exceeds that threshold. Rollback falls back to refactor_apply_hunks
        -- in that case. The PK assumes at most one change record per file per apply run; if
        -- multi-pass batching is introduced this constraint must be revisited.
        before_content text,
        after_content text,
        primary key (apply_id, file_path)
      );

      create table if not exists refactor_apply_hunks (
        apply_id text not null,
        file_path text not null,
        hunk_id text not null,
        start_offset_applied integer not null,
        end_offset_applied integer not null,
        before_text text not null,
        after_text text not null,
        primary key (apply_id, hunk_id)
      );

      create index if not exists idx_refactor_apply_hunks_apply_file_offset
      on refactor_apply_hunks(apply_id, file_path, start_offset_applied desc);

      create table if not exists refactor_rollbacks (
        rollback_id text primary key,
        apply_id text not null,
        status text not null,
        created_at text not null,
        completed_at text not null,
        restored_files integer not null,
        conflict_count integer not null
      );
    `);
  }
}
