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

// Trivial single-word callee tokens that are standard JS/TS prototype or runtime methods.
// These are never resolvable to user-defined symbols and should not count as graph gaps.
const TRIVIAL_CALLEE_TOKENS = new Set([
  "map", "filter", "find", "findIndex", "findLast", "forEach", "reduce", "reduceRight",
  "some", "every", "flat", "flatMap", "includes", "indexOf", "lastIndexOf", "join",
  "sort", "reverse", "slice", "splice", "pop", "push", "shift", "unshift", "fill",
  "entries", "keys", "values", "at", "concat", "copyWithin",
  "trim", "trimStart", "trimEnd", "split", "replace", "replaceAll", "startsWith", "endsWith",
  "padStart", "padEnd", "substring", "toUpperCase", "toLowerCase", "charAt", "charCodeAt",
  "then", "catch", "finally", "resolve", "reject", "all", "allSettled", "race", "any",
  "get", "set", "has", "delete", "clear", "add", "size",
  "call", "apply", "bind", "toString", "valueOf", "hasOwnProperty",
  "next", "done", "return", "throw",
  "on", "off", "once", "emit", "pipe", "removeListener", "removeAllListeners",
  "write", "end", "close", "destroy",
  "log", "warn", "error", "info", "debug",
  "prepare", "run", "exec", "iterate",
  "from", "assign", "freeze", "create", "hasOwn", "fromEntries", "is", "keys",
  "now", "parse", "stringify",
  "randomUUID", "createHash", "createHmac", "update", "digest",
  "glob", "stat", "readFile", "writeFile", "mkdir", "rmdir", "unlink",
  "relative", "basename", "dirname", "extname", "resolve", "normalize",
  "execSync", "execFileSync", "spawnSync",
]);

const TRIVIAL_CALLEE_IN_CLAUSE = [...TRIVIAL_CALLEE_TOKENS]
  .map((t) => `'callee:${t}'`)
  .join(", ");

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

function parseRiskFlags(raw: string): ("ambiguous_target" | "cross_type" | "generated_file")[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter((item): item is "ambiguous_target" | "cross_type" | "generated_file" => {
      return item === "ambiguous_target" || item === "cross_type" || item === "generated_file";
    });
  } catch {
    return [];
  }
}

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

  private buildNamedCandidateMap(repoId: string, allowedKinds?: readonly string[]): Map<string, { symbolId: string; filePath: string; kind: string }[]> {
    const rows = allowedKinds && allowedKinds.length > 0
      ? this.db
          .prepare(
            `
            select symbol_id as symbolId, name, file_path as filePath, kind
            from symbols
            where repo_id = ? and kind in (${allowedKinds.map(() => "?").join(", ")})
            `
          )
          .all(repoId, ...allowedKinds) as { symbolId: string; name: string; filePath: string; kind: string }[]
      : this.db
          .prepare(
            `
            select symbol_id as symbolId, name, file_path as filePath, kind
            from symbols
            where repo_id = ?
            `
          )
          .all(repoId) as { symbolId: string; name: string; filePath: string; kind: string }[];

    const byName = new Map<string, { symbolId: string; filePath: string; kind: string }[]>();
    for (const row of rows) {
      const list = byName.get(row.name) ?? [];
      list.push({ symbolId: row.symbolId, filePath: row.filePath, kind: row.kind });
      byName.set(row.name, list);
    }

    return byName;
  }

  private pickBestNamedCandidate(
    candidates: { symbolId: string; filePath: string; kind: string }[],
    fromFile: string,
    kindPriority: readonly string[]
  ): { symbolId: string; filePath: string; kind: string } | undefined {
    if (candidates.length === 0) {
      return undefined;
    }

    const rank = new Map(kindPriority.map((kind, index) => [kind, index]));
    let best = candidates[0];
    let bestScore = Number.POSITIVE_INFINITY;

    for (const candidate of candidates) {
      const sameFilePenalty = candidate.filePath === fromFile ? 0 : 100;
      const kindPenalty = rank.get(candidate.kind) ?? 999;
      const score = sameFilePenalty + kindPenalty;
      if (score < bestScore) {
        best = candidate;
        bestScore = score;
      }
    }

    return best;
  }

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

  private getEdgeDefaults(edge: EdgeRecord): { confidence: number; reason: string } {
    if (edge.toId.startsWith("callee:")) {
      return { confidence: 0.4, reason: "unresolved callee token" };
    }
    if (edge.toId.startsWith("import:")) {
      return { confidence: 0.5, reason: "unresolved import token" };
    }
    if (edge.toId.startsWith("type:")) {
      return { confidence: 0.45, reason: "unresolved type token" };
    }
    if (edge.toId.startsWith("property:")) {
      return { confidence: 0.5, reason: "unresolved property token" };
    }

    if (edge.type === "CALLS") {
      return { confidence: 1.0, reason: "resolved call edge" };
    }
    if (edge.type === "IMPORTS") {
      return { confidence: 0.95, reason: "resolved import edge" };
    }
    if (edge.type === "TYPE_REF") {
      return { confidence: 0.9, reason: "resolved type reference" };
    }
    if (edge.type === "PROPERTY_REF") {
      return { confidence: 0.85, reason: "resolved property read" };
    }
    if (edge.type === "PROPERTY_WRITE") {
      return { confidence: 0.82, reason: "resolved property write" };
    }

    return { confidence: 1.0, reason: "direct edge" };
  }

  private buildReliabilitySummary(confidences: number[], graphHealth: GraphHealth): ReliabilitySummary {
    // Filter out external edge confidences (0.8 = node_builtin or npm_package) from median
    // computation so they don't skew the reliability signal for internal graph edges.
    const internalConf = confidences.filter((c) => c !== 0.8);
    const sorted = [...internalConf].sort((a, b) => a - b);
    const edgeCount = sorted.length;
    const medianConfidence = edgeCount === 0
      ? 1
      : (edgeCount % 2 === 0
          ? (sorted[edgeCount / 2 - 1] + sorted[edgeCount / 2]) / 2
          : sorted[Math.floor(edgeCount / 2)]);

    const lowConfidenceEdgeCount = sorted.filter((c) => c < 0.75).length;
    // Split unresolved into internal (cross-file gaps) vs external (SDK/builtins — expected)
    // unresolvedImports already excludes node_builtin/npm_package via countUnresolvedEdgesForFile
    const internalUnresolved = graphHealth.unresolvedCalls + graphHealth.unresolvedImports + graphHealth.unresolvedTypeRefs;
    const unresolvedTotal = internalUnresolved;
    const unresolvedRatio = edgeCount + unresolvedTotal > 0
      ? unresolvedTotal / (edgeCount + unresolvedTotal)
      : 0;

    // Only warn when there are actual internal gaps (unresolved cross-file calls/imports/types)
    const warning = (medianConfidence < 0.75 || (internalUnresolved > 0 && unresolvedRatio > 0.5))
      ? internalUnresolved > 0
        ? `${internalUnresolved} internal edge${internalUnresolved > 1 ? "s" : ""} unresolved — results may be incomplete`
        : "low confidence edges — verify critical results"
      : null;

    return {
      edgeCount,
      medianConfidence,
      lowConfidenceEdgeCount,
      unresolvedRatio,
      warning
    };
  }

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
        where repo_id = ? and lower(replace(path, char(92), '/')) = lower(?)
        order by case when lower(path) = lower(?) then 0 else 1 end
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
        where repo_id = ? and lower(replace(file_path, char(92), '/')) = lower(?)
        order by case when lower(file_path) = lower(?) then 0 else 1 end
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
        const defaults = this.getEdgeDefaults(row);
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
    const row = this.db
      .prepare(
        `select symbol_id as symbolId from symbols
         where repo_id = ? and replace(file_path, char(92), '/') = replace(?, char(92), '/') and kind = 'module'
         limit 1`
      )
      .get(repoId, filePath) as { symbolId: string } | undefined;
    return row?.symbolId ?? null;
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
  }[] {
    if (direction === "outbound") {
      return this.db
        .prepare(
          `
          select
            c.from_repo_id as fromRepoId,
            c.from_symbol_id as fromSymbolId,
            c.to_repo_id as toRepoId,
            c.to_symbol_id as toSymbolId,
            c.type as type,
            s.name as relatedName,
            s.kind as relatedKind,
            s.file_path as relatedFilePath
          from cross_repo_deps c
          left join symbols s
            on s.repo_id = c.to_repo_id and s.symbol_id = c.to_symbol_id
          where c.from_repo_id = ? and c.from_symbol_id = ?
          order by c.to_repo_id, c.to_symbol_id
          limit ?
          `
        )
        .all(repoId, symbolId, limit) as {
        fromRepoId: string;
        fromSymbolId: string;
        toRepoId: string;
        toSymbolId: string;
        type: string;
        relatedName: string | null;
        relatedKind: string | null;
        relatedFilePath: string | null;
      }[];
    }

    return this.db
      .prepare(
        `
        select
          c.from_repo_id as fromRepoId,
          c.from_symbol_id as fromSymbolId,
          c.to_repo_id as toRepoId,
          c.to_symbol_id as toSymbolId,
          c.type as type,
          s.name as relatedName,
          s.kind as relatedKind,
          s.file_path as relatedFilePath
        from cross_repo_deps c
        left join symbols s
          on s.repo_id = c.from_repo_id and s.symbol_id = c.from_symbol_id
        where c.to_repo_id = ? and c.to_symbol_id = ?
        order by c.from_repo_id, c.from_symbol_id
        limit ?
        `
      )
      .all(repoId, symbolId, limit) as {
      fromRepoId: string;
      fromSymbolId: string;
      toRepoId: string;
      toSymbolId: string;
      type: string;
      relatedName: string | null;
      relatedKind: string | null;
      relatedFilePath: string | null;
    }[];
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
    const normalizePath = (v: string) => v.replace(/\\/g, "/");
    const testPathRegex = /(^|\/)(__tests__|tests?)\/|\.(test|spec)\.[^.]+$|(^|\/)test_[^/]+\.py$|_test\.py$|Tests\.cs$/i;
    const isTestPath = (v: string) => testPathRegex.test(normalizePath(v));
    const normalizeBase = (v: string) => {
      const base = normalizePath(v).split("/").pop() ?? v;
      return base
        .replace(/\.(tsx?|jsx?|mjs|cjs|py|cs)$/i, "")
        .replace(/(\.test|\.spec|_test|test_|tests?)$/i, "")
        .replace(/[^a-z0-9]/gi, "")
        .toLowerCase();
    };

    const files = this.db
      .prepare(`select path as filePath from files where repo_id = ? order by path`)
      .all(repoId) as { filePath: string }[];

    const allPaths = files.map((x) => normalizePath(x.filePath));
    const testFiles = allPaths.filter(isTestPath);
    const sourceFiles = allPaths.filter((x) => !isTestPath(x));

    const targetNormalized = filePath ? normalizePath(filePath) : null;
    const selectedTests = targetNormalized
      ? (isTestPath(targetNormalized)
          ? testFiles.filter((x) => x === targetNormalized)
          : testFiles.filter((x) => normalizeBase(x) === normalizeBase(targetNormalized) || x.includes(normalizeBase(targetNormalized))).slice(0, Math.max(limit * 2, 20)))
      : testFiles.slice(0, Math.max(limit * 3, 100));

    const output: {
      testFile: string;
      sourceFile: string;
      score: number;
      reasons: string[];
    }[] = [];

    for (const testFile of selectedTests) {
      const testBase = normalizeBase(testFile);
      const sourceScoreMap = new Map<string, { score: number; reasons: Set<string> }>();

      const addScore = (sourceFile: string, score: number, reason: string) => {
        const current = sourceScoreMap.get(sourceFile) ?? { score: 0, reasons: new Set<string>() };
        current.score += score;
        current.reasons.add(reason);
        sourceScoreMap.set(sourceFile, current);
      };

      for (const sourceFile of sourceFiles) {
        if (normalizeBase(sourceFile) === testBase && testBase.length > 0) {
          addScore(sourceFile, 0.55, "name_similarity");
        }
      }

      const importedSourceFiles = this.db
        .prepare(
          `
          select distinct st.file_path as sourceFile
          from edges e
          inner join symbols sf on sf.repo_id = e.repo_id and sf.symbol_id = e.from_id
          inner join symbols st on st.repo_id = e.repo_id and st.symbol_id = e.to_id
          where e.repo_id = ? and e.type = 'IMPORTS' and replace(sf.file_path, char(92), '/') = ?
          limit 500
          `
        )
        .all(repoId, testFile) as { sourceFile: string }[];

      for (const row of importedSourceFiles) {
        addScore(normalizePath(row.sourceFile), 0.3, "import_trace");
      }

      const calledSourceFiles = this.db
        .prepare(
          `
          select distinct st.file_path as sourceFile
          from edges e
          inner join symbols sf on sf.repo_id = e.repo_id and sf.symbol_id = e.from_id
          inner join symbols st on st.repo_id = e.repo_id and st.symbol_id = e.to_id
          where e.repo_id = ? and e.type = 'CALLS' and replace(sf.file_path, char(92), '/') = ?
          limit 500
          `
        )
        .all(repoId, testFile) as { sourceFile: string }[];

      for (const row of calledSourceFiles) {
        addScore(normalizePath(row.sourceFile), 0.25, "call_trace");
      }

      const ranked = [...sourceScoreMap.entries()]
        .map(([sourceFile, v]) => ({
          testFile,
          sourceFile,
          score: Math.min(1, Number(v.score.toFixed(4))),
          reasons: [...v.reasons]
        }))
        .filter((x) => x.score >= minScore)
        .sort((a, b) => b.score - a.score || a.sourceFile.localeCompare(b.sourceFile))
        .slice(0, maxCandidates);

      output.push(...ranked);
      if (output.length >= limit) {
        break;
      }
    }

    return output.slice(0, limit);
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
    const conditions: string[] = [
      "s.repo_id = ?",
      "s.kind not in ('module', 'property', 'constructor', 'type', 'interface')"
    ];
    const params: unknown[] = [repoId];

    if (filePathPrefix) {
      conditions.push("replace(s.file_path, char(92), '/') like ?");
      params.push(`${filePathPrefix.replace(/\\/g, "/")}%`);
    }
    if (language) {
      conditions.push("coalesce(f.language, '') = ?");
      params.push(language.toLowerCase());
    }
    if (kind) {
      conditions.push("s.kind = ?");
      params.push(kind);
    }
    if (!includePrivate) {
      conditions.push("coalesce(s.signature, '') not like 'private %'");
      conditions.push("s.name not like '_%'");
    }

    const where = conditions.join(" and ");
    const stmt = this.db.prepare(
      `
      select
        s.symbol_id as symbolId,
        s.name as name,
        s.kind as kind,
        s.file_path as filePath,
        s.line as line,
        s.signature as signature,
        f.language as language,
        (select count(*)
           from edges e
          where e.repo_id = s.repo_id
            and e.type = 'CALLS'
            and (
              e.to_id = s.symbol_id
              or e.to_id = ('callee:' || s.name)
            )) as incomingCalls,
        (select count(*)
           from edges e
          where e.repo_id = s.repo_id
            and e.type = 'TYPE_REF'
            and (
              e.to_id = s.symbol_id
              or e.to_id = ('type:' || s.name)
            )) as incomingTypeRefs,
        (select count(*) from edges e where e.repo_id = s.repo_id and e.to_id = s.symbol_id and e.type = 'IMPORTS') as incomingImports,
        (select count(*) from edges e where e.repo_id = s.repo_id and e.from_id = s.symbol_id and e.type = 'CALLS') as outgoingCalls,
        (
          select count(*)
          from edges e
          inner join symbols sf on sf.repo_id = e.repo_id and sf.symbol_id = e.from_id
          inner join symbols st on st.repo_id = e.repo_id and st.symbol_id = e.to_id
          where e.repo_id = s.repo_id
            and st.file_path = s.file_path
            and sf.file_path != st.file_path
            and e.type in ('CALLS', 'IMPORTS', 'TYPE_REF')
        ) as fileIncomingUsages
      from symbols s
      left join files f on f.repo_id = s.repo_id and f.path = s.file_path
      where ${where}
      order by s.file_path, s.line
      limit ? offset ?
      `
    );
    const chunkSize = Math.max(limit * 3, 100);
    const rows: {
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
      outgoingCalls: number;
      fileIncomingUsages: number;
    }[] = [];
    for (let offset = 0; ; offset += chunkSize) {
      const batch = stmt.all(...params, chunkSize, offset) as {
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
        outgoingCalls: number;
        fileIncomingUsages: number;
      }[];
      if (batch.length === 0) {
        break;
      }
      rows.push(...batch);
      if (batch.length < chunkSize) {
        break;
      }
    }

    const bootstrapFileNames = [
      "Program.cs", "Startup.cs", "main.ts", "main.js", "index.ts", "index.js",
      "App.tsx", "App.ts", "server.ts", "server.js"
    ];

    const results: {
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
    }[] = [];
    const suppressedReasons = new Map<string, number>();
    const recordSuppressed = (reason: string) => {
      suppressedReasons.set(reason, (suppressedReasons.get(reason) ?? 0) + 1);
    };

    const utilityNamePattern = /^(to|from|get|set|map|parse|format|build|create|validate|convert|helper|util)/i;
    const entryNamePattern = /^(main|init|initialize|bootstrap|start|run|handle|on|process|execute|dispatch|trigger)/i;
    const csharpUtilityClassNamePattern = /(extractor|helper|extensions|codec|composer|factory|builder|parser|formatter|normalizer|provider)$/i;
    const csharpConstantContainerNamePattern = /(constants?|errorcodes|statuscodes|codes|types|keys|outcomes|reasons|roles|policies|claimtypes|headernames|items)$/i;
    const csharpUtilityMethodNamePattern = /^(create|build|compose|format|normalize|parse|tryparse|failure|success|from|to)/i;
    const csharpValidatorHelperMethodNamePattern = /^(be|have|is|can|should|must|tryparse|normalize|format|supports?)/i;

    const fileContexts = new Map<string, {
      hasValidatorClass: boolean;
      hasInterfaceImplementationClass: boolean;
      hasAttributeClass: boolean;
      hasStaticUtilityClass: boolean;
      hasServiceLikeClass: boolean;
      isConstantContainerFile: boolean;
    }>();

    for (const row of rows) {
      if ((row.language ?? "").toLowerCase() !== "csharp" || row.kind !== "class") {
        continue;
      }

      const signatureLower = (row.signature ?? "").toLowerCase();
      const fileContext = fileContexts.get(row.filePath) ?? {
        hasValidatorClass: false,
        hasInterfaceImplementationClass: false,
        hasAttributeClass: false,
        hasStaticUtilityClass: false,
        hasServiceLikeClass: false,
        isConstantContainerFile: false
      };
      const normalizedPath = row.filePath.replace(/\\/g, "/").toLowerCase();

      if (
        /validator$/i.test(row.name) ||
        signatureLower.includes("abstractvalidator<") ||
        signatureLower.includes("ivalidator<")
      ) {
        fileContext.hasValidatorClass = true;
      }

      if (
        /(?:public|internal)(?:\s+(?:sealed|abstract|partial|static))*\s+class\s+/i.test(row.signature ?? "") &&
        /\s:\s*i[a-z]/.test(signatureLower) &&
        !/\s:\s*attribute\b/.test(signatureLower)
      ) {
        fileContext.hasInterfaceImplementationClass = true;
      }

      if (/attribute$/i.test(row.name) || /\s:\s*attribute\b/.test(signatureLower)) {
        fileContext.hasAttributeClass = true;
      }

      if (
        /(public|internal|file) static class /i.test(row.signature ?? "") &&
        (
          csharpUtilityClassNamePattern.test(row.name) ||
          csharpConstantContainerNamePattern.test(row.name)
        )
      ) {
        fileContext.hasStaticUtilityClass = true;
      }

      if (
        /(service|resolver|worker)$/i.test(row.name) ||
        /:\s*backgroundservice\b/.test(signatureLower)
      ) {
        fileContext.hasServiceLikeClass = true;
      }

      if (normalizedPath.includes("/constants/")) {
        fileContext.isConstantContainerFile = true;
      }

      fileContexts.set(row.filePath, fileContext);
    }

    const isLikelyEntryPoint = (row: {
      kind: string;
      name: string;
      filePath: string;
      signature: string | null;
      language: string | null;
      outgoingCalls: number;
    }): boolean => {
      // Keep the heuristic narrow to reduce cross-language false negatives.
      if ((row.language ?? "").toLowerCase() !== "csharp") {
        return false;
      }

      if (row.outgoingCalls < 2) {
        return false;
      }

      const normalizedPath = row.filePath.replace(/\\/g, "/").toLowerCase();
      const signatureLower = (row.signature ?? "").toLowerCase();
      const name = row.name;
      const fileContext = fileContexts.get(row.filePath) ?? {
        hasValidatorClass: false,
        hasInterfaceImplementationClass: false,
        hasAttributeClass: false,
        hasStaticUtilityClass: false,
        hasServiceLikeClass: false,
        isConstantContainerFile: false
      };

      const hasEntryName = entryNamePattern.test(name);
      const hasUtilityName = utilityNamePattern.test(name);
      const inEntryPath =
        normalizedPath.endsWith("/program.cs") ||
        normalizedPath.endsWith("/startup.cs") ||
        normalizedPath.includes("/controllers/") ||
        normalizedPath.includes("/handlers/") ||
        normalizedPath.includes("/hubs/") ||
        normalizedPath.includes("/backgroundservices/") ||
        normalizedPath.includes("/hostedservices/") ||
        normalizedPath.includes("/api/");
      const isPublicLike = signatureLower.startsWith("public ") || signatureLower.includes(" public ");

      // Lightweight score inspired by GitNexus entry-point scoring:
      // require outgoing calls, then combine path/name/visibility hints.
      let score = 0;
      if (isPublicLike) score += 1;
      if (hasEntryName) score += 1;
      if (inEntryPath) score += 1;
      if (row.outgoingCalls >= 3) score += 1;
      if (hasUtilityName) score -= 1;

      return score >= 2 && (hasEntryName || inEntryPath);
    };

    const getCSharpSuppressionReason = (row: {
      kind: string;
      name: string;
      filePath: string;
      signature: string | null;
      language: string | null;
      outgoingCalls: number;
      fileIncomingUsages: number;
    }): string | null => {
      if ((row.language ?? "").toLowerCase() !== "csharp") {
        return null;
      }

      const normalizedPath = row.filePath.replace(/\\/g, "/").toLowerCase();
      const signatureLower = (row.signature ?? "").toLowerCase();
      const name = row.name;
      const fileContext = fileContexts.get(row.filePath) ?? {
        hasValidatorClass: false,
        hasInterfaceImplementationClass: false,
        hasAttributeClass: false,
        hasStaticUtilityClass: false,
        hasServiceLikeClass: false,
        isConstantContainerFile: false
      };

      const isExtensionMethod =
        row.kind === "method" && /\(\s*this\s+/i.test(row.signature ?? "");
      if (isExtensionMethod) {
        return "heuristic_runtime_or_convention_usage";
      }

      const isMigrationOrDesignerArtifact =
        normalizedPath.includes("/migrations/") ||
        normalizedPath.endsWith(".designer.cs");
      if (isMigrationOrDesignerArtifact) {
        return "heuristic_runtime_or_convention_usage";
      }

      const isValidatorClass =
        row.kind === "class" && (
          normalizedPath.includes("/validators/") ||
          /validator$/i.test(name) ||
          signatureLower.includes("abstractvalidator<") ||
          signatureLower.includes("ivalidator<")
        );
      if (isValidatorClass) {
        return "heuristic_runtime_or_convention_usage";
      }

      const isValidatorHelperMethod =
        row.kind === "method" &&
        fileContext.hasValidatorClass &&
        signatureLower.startsWith("private ") &&
        csharpValidatorHelperMethodNamePattern.test(name);
      if (isValidatorHelperMethod) {
        return "heuristic_runtime_or_convention_usage";
      }

      const fileName = normalizedPath.split("/").pop() ?? "";
      const isInterfaceContractMethod =
        row.kind === "method" && (
          normalizedPath.includes("/interfaces/") ||
          normalizedPath.includes("/contracts/") ||
          normalizedPath.includes("/abstractions/") ||
          /^i[a-z].*\.cs$/.test(fileName)
        );
      if (isInterfaceContractMethod) {
        return "heuristic_contract_declaration";
      }

      const isAbstractContractMethod =
        row.kind === "method" && (
          signatureLower.startsWith("public abstract ") ||
          signatureLower.startsWith("protected abstract ") ||
          /abstractions?\.cs$/.test(fileName)
        );
      if (isAbstractContractMethod) {
        return "heuristic_contract_declaration";
      }

      const isInterfaceImplementationClass =
        row.kind === "class" &&
        fileContext.hasInterfaceImplementationClass &&
        /(?:public|internal)(?:\s+(?:sealed|abstract|partial|static))*\s+class\s+/i.test(row.signature ?? "");
      if (isInterfaceImplementationClass) {
        return "heuristic_runtime_or_convention_usage";
      }

      const isInterfaceImplementationMethod =
        row.kind === "method" &&
        fileContext.hasInterfaceImplementationClass &&
        signatureLower.startsWith("public ") &&
        !signatureLower.includes(" static ");
      if (isInterfaceImplementationMethod) {
        return "heuristic_runtime_or_convention_usage";
      }

      const isReflectionTargetInInterfaceImplementationFile =
        row.kind === "method" &&
        fileContext.hasInterfaceImplementationClass &&
        signatureLower.startsWith("private ") &&
        /(internal|handle|resolve|publish|send|map|serialize|execute|observe)/i.test(name);
      if (isReflectionTargetInInterfaceImplementationFile) {
        return "heuristic_runtime_or_convention_usage";
      }

      const isAttributeClass =
        row.kind === "class" &&
        fileContext.hasAttributeClass &&
        (/attribute$/i.test(name) || /\s:\s*attribute\b/.test(signatureLower));
      if (isAttributeClass) {
        return "heuristic_runtime_or_convention_usage";
      }

      const isServiceLikeClass =
        row.kind === "class" &&
        fileContext.hasServiceLikeClass &&
        /(service|resolver|worker)$/i.test(name);
      if (isServiceLikeClass) {
        return "heuristic_runtime_or_convention_usage";
      }

      const isFrameworkRegisteredClass =
        row.kind === "class" &&
        (
          /(interceptor|authorizationhandler|initiali[sz]er|hostoptions|options)$/i.test(name) ||
          normalizedPath.includes("/interceptors/")
        );
      if (isFrameworkRegisteredClass) {
        return "heuristic_runtime_or_convention_usage";
      }

      const isServiceLikeMethod =
        row.kind === "method" &&
        fileContext.hasServiceLikeClass &&
        (
          signatureLower.startsWith("public ") ||
          signatureLower.startsWith("protected override ") ||
          signatureLower.startsWith("private ")
        ) &&
        /(apply|get|resolve|execute|purge|map|serialize|handle|send|publish)/i.test(name);
      if (isServiceLikeMethod) {
        return "heuristic_runtime_or_convention_usage";
      }

      const isFrameworkRegisteredMethod =
        row.kind === "method" &&
        (
          /(interceptor|authorizationhandler|initiali[sz]er|hostoptions|options)/i.test(fileName) ||
          normalizedPath.includes("/interceptors/")
        );
      if (isFrameworkRegisteredMethod) {
        return "heuristic_runtime_or_convention_usage";
      }

      // Minimal API endpoints, middleware, and OpenAPI transformers are
      // registered via convention/framework and never have direct inbound call edges.
      const isMinimalApiEndpointMethod =
        row.kind === "method" &&
        (
          normalizedPath.includes("/endpoints/") ||
          normalizedPath.includes("/middleware/")
        );
      if (isMinimalApiEndpointMethod) {
        return "heuristic_runtime_or_convention_usage";
      }

      const isMinimalApiEndpointClass =
        row.kind === "class" &&
        (
          normalizedPath.includes("/endpoints/") ||
          normalizedPath.includes("/middleware/") ||
          /(middleware|transformer|operationtransformer)$/i.test(name)
        );
      if (isMinimalApiEndpointClass) {
        return "heuristic_runtime_or_convention_usage";
      }

      const isRegistrationExtensionsClass =
        row.kind === "class" &&
        (/extensions$/i.test(name) || name === "DependencyInjection") &&
        signatureLower.startsWith("public static class ");
      if (isRegistrationExtensionsClass) {
        return "heuristic_runtime_or_convention_usage";
      }

      const isInternalStaticHelperContainerClass =
        row.kind === "class" &&
        signatureLower.includes("static class") &&
        (
          signatureLower.startsWith("public static class ") ||
          signatureLower.startsWith("internal static class ") ||
          signatureLower.startsWith("file static class ")
        ) &&
        (
          normalizedPath.includes("/extensions/") ||
          normalizedPath.includes("/helpers/") ||
          /(extractor|helper|extensions|codec|composer)$/i.test(name)
        );
      if (isInternalStaticHelperContainerClass) {
        return "heuristic_helper_container";
      }

      const isConstantContainerClass =
        row.kind === "class" &&
        (
          csharpConstantContainerNamePattern.test(name) ||
          fileContext.isConstantContainerFile
        ) &&
        signatureLower.includes("class ");

      if (isConstantContainerClass) {
        return "heuristic_runtime_or_convention_usage";
      }

      const isConstantContainerMethod =
        row.kind === "method" &&
        fileContext.isConstantContainerFile &&
        signatureLower.includes("static ");
      if (isConstantContainerMethod) {
        return "heuristic_runtime_or_convention_usage";
      }

      const isPublicStaticUtilityContainerClass =
        row.kind === "class" &&
        fileContext.hasStaticUtilityClass &&
        signatureLower.includes("static class") &&
        csharpUtilityClassNamePattern.test(name);
      if (isPublicStaticUtilityContainerClass) {
        return "heuristic_helper_container";
      }

      const isPublicStaticUtilityMethod =
        row.kind === "method" &&
        signatureLower.startsWith("public static ") &&
        csharpUtilityMethodNamePattern.test(name) &&
        (
          fileContext.hasStaticUtilityClass ||
          normalizedPath.includes("/common/") ||
          normalizedPath.includes("/models/")
        );
      if (isPublicStaticUtilityMethod) {
        return "heuristic_runtime_or_convention_usage";
      }

      const isPrivateStaticFactoryHelperMethod =
        row.kind === "method" &&
        row.outgoingCalls > 0 &&
        signatureLower.startsWith("private static ") &&
        /^(create|build|compose|resolve|map|convert|deserialize)/i.test(name) &&
        (
          /<t>/i.test(row.signature ?? "") ||
          signatureLower.includes("result<") ||
          signatureLower.includes("task<") ||
          /failure|factory|builder/i.test(name)
        );

      return isPrivateStaticFactoryHelperMethod ? "heuristic_runtime_or_convention_usage" : null;
    };

    for (const row of rows) {
      const normalizedPath = row.filePath.replace(/\\/g, "/");
      const isBootstrap = bootstrapFileNames.some((f) => normalizedPath.endsWith(`/${f}`) || normalizedPath === f);
      if (isBootstrap) {
        recordSuppressed("bootstrap_file");
        continue;
      }

      if (isLikelyEntryPoint(row)) {
        recordSuppressed("heuristic_entry_point");
        continue;
      }

      const csharpSuppressionReason = getCSharpSuppressionReason(row);
      if (csharpSuppressionReason) {
        recordSuppressed(csharpSuppressionReason);
        continue;
      }

      if ((row.incomingCalls + row.incomingTypeRefs + row.incomingImports) > 0) {
        continue;
      }

      results.push({
        ...row,
        deadReason: "no_incoming_calls_typerefs_imports"
      });

      if (results.length >= limit) {
        break;
      }
    }

    return {
      candidates: results,
      suppressed: {
        total: [...suppressedReasons.values()].reduce((sum, count) => sum + count, 0),
        reasons: Object.fromEntries([...suppressedReasons.entries()].sort((a, b) => a[0].localeCompare(b[0])))
      },
      scanPolicy: {
        mode: "skip_low_confidence",
        note: "Suppressed symbols are excluded from dead-code candidates because they match low-confidence runtime/convention heuristics; exclusion does not prove the symbol is live."
      }
    };
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
    const edgeTypes = includeCalls ? ["IMPORTS", "DEPENDS_ON", "CALLS"] : ["IMPORTS", "DEPENDS_ON"];
    const edgePlaceholders = edgeTypes.map(() => "?").join(", ");
    const params: unknown[] = [repoId, ...edgeTypes];

    let rows: { fromId: string; toId: string; edgeType: string }[];
    if (mode === "module") {
      let filterSql = "";
      if (filePathPrefix) {
        filterSql = " and (replace(sf.file_path, char(92), '/') like ? or replace(st.file_path, char(92), '/') like ?)";
        const prefix = `${filePathPrefix.replace(/\\/g, "/")}%`;
        params.push(prefix, prefix);
      }

      rows = this.db
        .prepare(
          `
          select distinct
            replace(sf.file_path, char(92), '/') as fromId,
            replace(st.file_path, char(92), '/') as toId,
            e.type as edgeType
          from edges e
          inner join symbols sf on sf.repo_id = e.repo_id and sf.symbol_id = e.from_id
          inner join symbols st on st.repo_id = e.repo_id and st.symbol_id = e.to_id
          where e.repo_id = ?
            and e.type in (${edgePlaceholders})
            and sf.file_path is not null
            and st.file_path is not null
            and sf.file_path != st.file_path
            ${filterSql}
          limit 50000
          `
        )
        .all(...params) as { fromId: string; toId: string; edgeType: string }[];
    } else {
      let filterSql = "";
      if (filePathPrefix) {
        filterSql = " and (replace(sf.file_path, char(92), '/') like ? or replace(st.file_path, char(92), '/') like ?)";
        const prefix = `${filePathPrefix.replace(/\\/g, "/")}%`;
        params.push(prefix, prefix);
      }

      rows = this.db
        .prepare(
          `
          select distinct
            e.from_id as fromId,
            e.to_id as toId,
            e.type as edgeType
          from edges e
          inner join symbols sf on sf.repo_id = e.repo_id and sf.symbol_id = e.from_id
          inner join symbols st on st.repo_id = e.repo_id and st.symbol_id = e.to_id
          where e.repo_id = ?
            and e.type in (${edgePlaceholders})
            ${filterSql}
          limit 50000
          `
        )
        .all(...params) as { fromId: string; toId: string; edgeType: string }[];
    }

    const adjacency = new Map<string, { to: string; edgeType: string }[]>();
    for (const row of rows) {
      if (row.fromId === row.toId) {
        continue;
      }
      const list = adjacency.get(row.fromId) ?? [];
      list.push({ to: row.toId, edgeType: row.edgeType });
      adjacency.set(row.fromId, list);
    }

    const nodes = [...adjacency.keys()].sort();
    const seen = new Set<string>();
    const cycles: { path: string[]; edgeTypes: string[]; length: number }[] = [];

    const canonicalCycleKey = (core: string[]): string => {
      const candidates: string[] = [];
      const n = core.length;
      for (let i = 0; i < n; i++) {
        const rotated = [...core.slice(i), ...core.slice(0, i)].join("->");
        candidates.push(rotated);
      }
      const reversed = [...core].reverse();
      for (let i = 0; i < n; i++) {
        const rotated = [...reversed.slice(i), ...reversed.slice(0, i)].join("->");
        candidates.push(rotated);
      }
      candidates.sort();
      return candidates[0] ?? core.join("->");
    };

    const stackNodes: string[] = [];
    const stackEdgeTypes: string[] = [];

    const dfs = (start: string, current: string): void => {
      if (cycles.length >= maxCycles) {
        return;
      }

      const outgoing = adjacency.get(current) ?? [];
      for (const edge of outgoing) {
        if (cycles.length >= maxCycles) {
          return;
        }

        if (edge.to === start && stackNodes.length > 1) {
          const core = [...stackNodes];
          const key = canonicalCycleKey(core);
          if (!seen.has(key)) {
            seen.add(key);
            cycles.push({
              path: [...core, start],
              edgeTypes: [...stackEdgeTypes, edge.edgeType],
              length: core.length
            });
          }
          continue;
        }

        if (stackNodes.includes(edge.to) || stackNodes.length >= maxDepth) {
          continue;
        }

        stackNodes.push(edge.to);
        stackEdgeTypes.push(edge.edgeType);
        dfs(start, edge.to);
        stackNodes.pop();
        stackEdgeTypes.pop();
      }
    };

    for (const start of nodes) {
      if (cycles.length >= maxCycles) {
        break;
      }
      stackNodes.length = 0;
      stackEdgeTypes.length = 0;
      stackNodes.push(start);
      dfs(start, start);
    }

    cycles.sort((a, b) => a.length - b.length || a.path.join("->").localeCompare(b.path.join("->")));
    return {
      mode,
      cycleCount: cycles.length,
      cycles
    };
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

  getRouteMap(
    repoId: string,
    filePathPrefix: string | null,
    httpMethod: string | null,
    limit: number
  ): {
    filePath: string;
    controllerSymbolId: string;
    controllerName: string | null;
    handlerSymbolId: string;
    handlerName: string | null;
    httpMethod: string;
    routeTemplate: string;
    line: number;
  }[] {
    const conditions = ["r.repo_id = ?"];
    const params: unknown[] = [repoId];

    if (filePathPrefix) {
      conditions.push("replace(r.file_path, char(92), '/') like ?");
      params.push(`${filePathPrefix.replace(/\\/g, "/")}%`);
    }

    if (httpMethod) {
      conditions.push("r.http_method = ?");
      params.push(httpMethod.toUpperCase());
    }

    const where = conditions.join(" and ");

    return this.db
      .prepare(
        `
        select
          r.file_path as filePath,
          r.controller_symbol_id as controllerSymbolId,
          cs.name as controllerName,
          r.handler_symbol_id as handlerSymbolId,
          hs.name as handlerName,
          r.http_method as httpMethod,
          r.route_template as routeTemplate,
          r.line as line
        from routes r
        left join symbols cs on cs.repo_id = r.repo_id and cs.symbol_id = r.controller_symbol_id
        left join symbols hs on hs.repo_id = r.repo_id and hs.symbol_id = r.handler_symbol_id
        where ${where}
        order by r.file_path, r.line
        limit ?
        `
      )
      .all(...params, limit) as {
      filePath: string;
      controllerSymbolId: string;
      controllerName: string | null;
      handlerSymbolId: string;
      handlerName: string | null;
      httpMethod: string;
      routeTemplate: string;
      line: number;
    }[];
  }

  getRepoSchemaSnapshot(repoId: string): {
    repoId: string;
    fileCount: number;
    symbolCount: number;
    edgeCount: number;
    routeCount: number;
    languages: { language: string; fileCount: number }[];
  } {
    const fileCount = (this.db.prepare(`select count(*) as cnt from files where repo_id = ?`).get(repoId) as { cnt: number } | undefined)?.cnt ?? 0;
    const symbolCount = (this.db.prepare(`select count(*) as cnt from symbols where repo_id = ?`).get(repoId) as { cnt: number } | undefined)?.cnt ?? 0;
    const edgeCount = (this.db.prepare(`select count(*) as cnt from edges where repo_id = ?`).get(repoId) as { cnt: number } | undefined)?.cnt ?? 0;
    const routeCount = (this.db.prepare(`select count(*) as cnt from routes where repo_id = ?`).get(repoId) as { cnt: number } | undefined)?.cnt ?? 0;

    const languages = this.db
      .prepare(
        `
        select coalesce(language, 'unknown') as language, count(*) as fileCount
        from files
        where repo_id = ?
        group by coalesce(language, 'unknown')
        order by fileCount desc, language asc
        `
      )
      .all(repoId) as { language: string; fileCount: number }[];

    return { repoId, fileCount, symbolCount, edgeCount, routeCount, languages };
  }

  runReadOnlyGraphQuery(
    sql: string,
    namedParams: Record<string, string | number | boolean | null>,
    limit: number,
    timeoutMs?: number
  ): {
    columns: string[];
    rows: Record<string, unknown>[];
    rowCount: number;
    truncated: boolean;
    elapsedMs: number;
    timedOut: boolean;
  } {
    // NOTE: better-sqlite3 executes synchronously on the main thread; true mid-query
    // interruption is not possible without worker_threads. The LIMIT clause wrapping
    // provides the primary row-count bound. timeoutMs acts as a post-execution guard:
    // if the query completes but took longer than the budget, timedOut=true is returned
    // and the caller should surface a timeout error rather than the result.
    const wrappedSql = `select * from (${sql}) as mcp_query limit @__limit`;
    const stmt = this.db.prepare(wrappedSql);
    const start = Date.now();
    const rows = stmt.all({ ...namedParams, __limit: limit + 1 }) as Record<string, unknown>[];
    const elapsedMs = Date.now() - start;
    const truncated = rows.length > limit;
    const safeRows = truncated ? rows.slice(0, limit) : rows;
    const columns = safeRows.length > 0 ? Object.keys(safeRows[0]) : [];
    const timedOut = timeoutMs !== undefined && timeoutMs > 0 && elapsedMs > timeoutMs;
    return { columns, rows: safeRows, rowCount: safeRows.length, truncated, elapsedMs, timedOut };
  }

  rebuildFts(): void {
    const start = Date.now();
    try {
      // FTS5 incremental rebuild — rebuilds inverted index for all symbols
      this.db.exec(`insert into symbols_fts(symbols_fts) values('rebuild')`);
      
      // FTS5 optimize pragma: compacts the index and removes deleted entries
      // This typically reduces index size by 10-30% and improves query speed
      this.db.exec(`insert into symbols_fts(symbols_fts) values('optimize')`);
      
      const elapsed = Date.now() - start;
      process.stderr.write(`[index-fts] rebuilt symbols_fts in ${elapsed}ms\n`);
    } catch (e) {
      process.stderr.write(`[index-fts-error] symbols_fts rebuild failed: ${e instanceof Error ? e.message : String(e)}\n`);
    }
  }

  searchSymbols(
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
      const ftsQuery = strategy === "intent" ? this.buildIntentFtsQuery(query) : this.buildFtsQuery(query);
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
        .all(ftsQuery, ...params, limit) as (SymbolRecord & { repoPath: string | null })[];
    }

    if (strategy === "intent") {
      const tokens = this.extractIntentTokens(query);
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

  getSearchSuggestions(query: string, repoId: string | null, limit: number): string[] {
    const cappedLimit = Math.max(1, Math.min(limit, 10));
    const tokens = this.extractIntentTokens(query).slice(0, 6);

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
    const rows = this.db
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

  getFileContext(repoId: string, filePath: string, limit: number, compact = false): { symbols: SymbolRecord[] | { name: string; kind: string; line: number }[]; edges: ResolvedEdge[]; graphHealth: GraphHealth } {
    const canonicalPath = this.resolveCanonicalFilePath(repoId, filePath);
    const symbols = this.db
      .prepare(
        `
        select repo_id as repoId, symbol_id as symbolId, file_path as filePath, name, kind, line, signature
        from symbols
        where repo_id = ? and replace(file_path, char(92), '/') = replace(?, char(92), '/')
        limit ?
        `
      )
      .all(repoId, canonicalPath, limit) as SymbolRecord[];

    if (symbols.length === 0) {
      return { symbols: [], edges: [], graphHealth: { unresolvedCalls: 0, unresolvedImports: 0, unresolvedTypeRefs: 0, note: "no symbols found" } };
    }

    if (compact) {
      const graphHealth = this.countUnresolvedEdgesForFile(repoId, canonicalPath);
      return { symbols: symbols.map((s) => ({ name: s.name, kind: s.kind, line: s.line })), edges: [], graphHealth };
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

    const graphHealth = this.countUnresolvedEdgesForFile(repoId, canonicalPath);
    return { symbols, edges, graphHealth };
  }

  getBatchContext(repoId: string, filePaths: string[], limit: number, compact = false): { symbols: SymbolRecord[] | { name: string; kind: string; filePath: string; line: number }[]; edges: ResolvedEdge[] } {
    if (filePaths.length === 0) {
      return { symbols: [], edges: [] };
    }
    const canonicalPaths = filePaths.map((fp) => this.resolveCanonicalFilePath(repoId, fp));
    const placeholders = canonicalPaths.map(() => "?").join(", ");
    const symbols = this.db
      .prepare(
        `
        select repo_id as repoId, symbol_id as symbolId, file_path as filePath, name, kind, line, signature
        from symbols
        where repo_id = ? and replace(file_path, char(92), '/') in (${placeholders.split(", ").map(() => "replace(?, char(92), '/')").join(", ")})
        limit ?
        `
      )
      .all(repoId, ...canonicalPaths, limit) as SymbolRecord[];

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

  resolveImportEdges(repoId: string, maxUnresolvedRows = 0): number {
    // Find all IMPORTS edges with unresolved plain-text toId ("import:<path>")
    const unresolvedSql = `
      select distinct e.from_id as fromId, e.to_id as toId, sf.file_path as fromFile
      from edges e
      inner join symbols sf on sf.repo_id = e.repo_id and sf.symbol_id = e.from_id
      where e.repo_id = ? and e.type = 'IMPORTS' and e.to_id like 'import:%'
      ${maxUnresolvedRows > 0 ? "limit ?" : ""}
    `;
    const unresolved = this.db
      .prepare(unresolvedSql)
      .all(...(maxUnresolvedRows > 0 ? [repoId, maxUnresolvedRows] : [repoId])) as {
      fromId: string;
      toId: string;
      fromFile: string;
    }[];

    if (unresolved.length === 0) return 0;

    const updateStmt = this.db.prepare(
      `update edges set to_id = ?, confidence = ?, reason = ? where repo_id = ? and from_id = ? and to_id = ?`
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

    const importResolveCache = new Map<string, string | null>();

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

        const cacheKey = `${fromDir}|${importPath}`;
        if (importResolveCache.has(cacheKey)) {
          const cachedModuleId = importResolveCache.get(cacheKey);
          if (cachedModuleId) {
            updateStmt.run(cachedModuleId, 0.95, "resolved relative import", repoId, row.fromId, row.toId);
            count += 1;
          }
          continue;
        }

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

        let matchedModuleId: string | undefined;
        for (const candidate of candidates) {
          const moduleId = fileToModuleId.get(candidate);
          if (moduleId) {
            matchedModuleId = moduleId;
            break;
          }
        }

        importResolveCache.set(cacheKey, matchedModuleId ?? null);

        if (matchedModuleId) {
          updateStmt.run(matchedModuleId, 0.95, "resolved relative import", repoId, row.fromId, row.toId);
          count += 1;
        }
      }
    });
    tx();

    return count;
  }

  resolveCallEdges(repoId: string, maxUnresolvedRows = 0): number {
    // Find all CALLS edges with unresolved plain-text toId ("callee:<name>")
    // Join symbols to get the caller's file for same-file resolution priority
    const unresolvedSql = `
      select distinct e.from_id as fromId, e.to_id as toId, s.file_path as fromFile
      from edges e
      inner join symbols s on s.repo_id = e.repo_id and s.symbol_id = e.from_id
      where e.repo_id = ? and e.type = 'CALLS' and e.to_id like 'callee:%'
      ${maxUnresolvedRows > 0 ? "limit ?" : ""}
    `;
    const unresolved = this.db
      .prepare(unresolvedSql)
      .all(...(maxUnresolvedRows > 0 ? [repoId, maxUnresolvedRows] : [repoId])) as {
      fromId: string;
      toId: string;
      fromFile: string;
    }[];

    if (unresolved.length === 0) return 0;

    const updateStmt = this.db.prepare(
      `update edges set to_id = ?, confidence = ?, reason = ? where repo_id = ? and from_id = ? and to_id = ?`
    );
    const insertDispatchStmt = this.db.prepare(
      `
      insert into edges (repo_id, from_id, to_id, type, confidence, reason)
      select ?, ?, ?, 'CALLS', ?, ?
      where not exists (
        select 1 from edges
        where repo_id = ? and from_id = ? and to_id = ? and type = 'CALLS'
      )
      `
    );

    // Pre-build interface lookup map: name → { symbolId, filePath }
    const interfaceRows = this.db
      .prepare(`select symbol_id as symbolId, name, file_path as filePath from symbols where repo_id = ? and kind = 'interface'`)
      .all(repoId) as { symbolId: string; name: string; filePath: string }[];
    const interfaceByName = new Map<string, { symbolId: string; filePath: string }>();
    for (const r of interfaceRows) {
      if (!interfaceByName.has(r.name)) interfaceByName.set(r.name, { symbolId: r.symbolId, filePath: r.filePath });
    }

    // Pre-build implementor files map: interfaceSymbolId → filePath[]
    const implEdgeRows = this.db
      .prepare(
        `select distinct e.to_id as ifaceId, s.file_path as filePath
         from edges e
         inner join symbols s on s.repo_id = e.repo_id and s.symbol_id = e.from_id
         where e.repo_id = ? and e.type = 'IMPLEMENTS' and s.kind in ('class', 'struct')`
      )
      .all(repoId) as { ifaceId: string; filePath: string }[];
    const implementorFilesByIfaceId = new Map<string, string[]>();
    for (const r of implEdgeRows) {
      const list = implementorFilesByIfaceId.get(r.ifaceId) ?? [];
      list.push(r.filePath);
      implementorFilesByIfaceId.set(r.ifaceId, list);
    }

    const candidateMap = this.buildNamedCandidateMap(repoId, ["function", "method", "constructor", "class"]);

    let count = 0;
    const tx = this.db.transaction(() => {
      for (const row of unresolved) {
        const calleeName = row.toId.slice(7); // strip "callee:"
        let dispatchMethodName: string | null = null;
        let dispatchInterfaceId: string | null = null;
        let match = this.pickBestNamedCandidate(
          candidateMap.get(calleeName) ?? [],
          row.fromFile,
          ["function", "method", "constructor", "class"]
        );

        // For qualified calls like "IRepository.Save", resolve primary target to the
        // interface method first, then fan out lower-confidence edges to implementing methods.
        if (calleeName.includes(".")) {
          const parts = calleeName.split(".").filter((x) => x.length > 0);
          const receiverType = parts.length > 1 ? parts.slice(0, -1).join(".") : "";
          const memberName = parts[parts.length - 1] ?? "";
          if (receiverType && memberName) {
            const iface = interfaceByName.get(receiverType);
            if (iface) {
              // Find the interface method via the candidateMap (already in memory)
              const ifaceMethod = (candidateMap.get(memberName) ?? []).find(
                (c) => c.filePath === iface.filePath && c.kind === "method"
              );
              if (ifaceMethod) {
                match = { symbolId: ifaceMethod.symbolId, filePath: iface.filePath, kind: "method" };
                dispatchMethodName = memberName;
                dispatchInterfaceId = iface.symbolId;
              }
            }
          }
        }

        // Retry qualified placeholders like "TypeName.methodName" using terminal symbol name.
        if (!match && calleeName.includes(".")) {
          const baseName = calleeName.split(".").pop() ?? calleeName;
          match = this.pickBestNamedCandidate(
            candidateMap.get(baseName) ?? [],
            row.fromFile,
            ["function", "method", "constructor", "class"]
          );
        }

        if (match) {
          const confidence = dispatchMethodName
            ? (match.filePath === row.fromFile ? 0.9 : 0.8)
            : (match.filePath === row.fromFile ? 0.9 : 0.75);
          const reason = dispatchMethodName
            ? "resolved interface method"
            : (confidence >= 0.9 ? "resolved callee same-file" : "resolved callee by name");
          updateStmt.run(match.symbolId, confidence, reason, repoId, row.fromId, row.toId);
          count += 1;

          if (dispatchMethodName && dispatchInterfaceId) {
            const implementorFiles = implementorFilesByIfaceId.get(dispatchInterfaceId) ?? [];
            for (const implFilePath of implementorFiles) {
              const implMethod = (candidateMap.get(dispatchMethodName) ?? []).find(
                (c) => c.filePath === implFilePath && c.kind === "method"
              );
              if (!implMethod || implMethod.symbolId === match.symbolId) {
                continue;
              }
              const insertResult = insertDispatchStmt.run(
                repoId,
                row.fromId,
                implMethod.symbolId,
                0.65,
                "interface-dispatch",
                repoId,
                row.fromId,
                implMethod.symbolId
              );
              if (insertResult.changes > 0) {
                count += 1;
              }
            }
          }
        }
      }
    });
    tx();

    return count;
  }

  resolveTypeRefEdges(repoId: string, maxUnresolvedRows = 0): number {
    const unresolvedSql = `
      select distinct e.from_id as fromId, e.to_id as toId, s.file_path as fromFile
      from edges e
      inner join symbols s on s.repo_id = e.repo_id and s.symbol_id = e.from_id
      where e.repo_id = ? and e.type = 'TYPE_REF' and e.to_id like 'type:%'
      ${maxUnresolvedRows > 0 ? "limit ?" : ""}
    `;
    const unresolved = this.db
      .prepare(unresolvedSql)
      .all(...(maxUnresolvedRows > 0 ? [repoId, maxUnresolvedRows] : [repoId])) as {
      fromId: string;
      toId: string;
      fromFile: string;
    }[];

    if (unresolved.length === 0) return 0;

    const updateStmt = this.db.prepare(
      `update edges set to_id = ?, confidence = ?, reason = ? where repo_id = ? and from_id = ? and to_id = ? and type = 'TYPE_REF'`
    );

    const candidateMap = this.buildNamedCandidateMap(repoId, ["class", "interface", "struct", "type"]);

    let count = 0;
    const tx = this.db.transaction(() => {
      for (const row of unresolved) {
        const rawTypeName = row.toId.slice(5);
        const typeName = rawTypeName.split(".").pop() ?? rawTypeName;
        const match = this.pickBestNamedCandidate(
          candidateMap.get(typeName) ?? [],
          row.fromFile,
          ["class", "interface", "struct", "type"]
        );

        if (match) {
          const confidence = match.filePath === row.fromFile ? 0.9 : 0.75;
          const reason = confidence >= 0.9 ? "resolved type same-file" : "resolved type by name";
          updateStmt.run(match.symbolId, confidence, reason, repoId, row.fromId, row.toId);
          count += 1;
        }
      }
    });
    tx();

    return count;
  }

  resolvePropertyEdges(repoId: string, maxUnresolvedRows = 0): number {
    const unresolvedSql = `
      select distinct e.from_id as fromId, e.to_id as toId, s.file_path as fromFile, e.type as edgeType
      from edges e
      inner join symbols s on s.repo_id = e.repo_id and s.symbol_id = e.from_id
      where e.repo_id = ? and e.type in ('PROPERTY_REF', 'PROPERTY_WRITE') and e.to_id like 'property:%'
      ${maxUnresolvedRows > 0 ? "limit ?" : ""}
    `;
    const unresolved = this.db
      .prepare(unresolvedSql)
      .all(...(maxUnresolvedRows > 0 ? [repoId, maxUnresolvedRows] : [repoId])) as {
      fromId: string;
      toId: string;
      fromFile: string;
      edgeType: "PROPERTY_REF" | "PROPERTY_WRITE";
    }[];

    if (unresolved.length === 0) return 0;

    const updateStmt = this.db.prepare(
      `update edges set to_id = ?, confidence = ?, reason = ? where repo_id = ? and from_id = ? and to_id = ? and type = ?`
    );

    const propertyCandidates = this.buildNamedCandidateMap(repoId, ["property"]);
    const typeRows = this.db
      .prepare(
        `
        select name, file_path as filePath
        from symbols
        where repo_id = ? and kind in ('class', 'interface', 'struct', 'type')
        `
      )
      .all(repoId) as { name: string; filePath: string }[];

    const typeFilesByName = new Map<string, Set<string>>();
    for (const row of typeRows) {
      const list = typeFilesByName.get(row.name) ?? new Set<string>();
      list.add(row.filePath);
      typeFilesByName.set(row.name, list);
    }

    let count = 0;
    const tx = this.db.transaction(() => {
      for (const row of unresolved) {
        const token = row.toId.slice("property:".length);
        const memberName = token.split(".").pop() ?? "";
        if (!memberName) {
          continue;
        }

        const rawTypeName = token.slice(0, Math.max(0, token.length - memberName.length - 1));
        const typeName = rawTypeName.split(".").pop() ?? rawTypeName;
        const namedCandidates = propertyCandidates.get(memberName) ?? [];
        if (namedCandidates.length === 0) {
          continue;
        }

        const constrainedCandidates = (() => {
          if (!typeName) {
            return namedCandidates;
          }
          const files = typeFilesByName.get(typeName);
          if (!files || files.size === 0) {
            return namedCandidates;
          }
          const filtered = namedCandidates.filter((candidate) => files.has(candidate.filePath));
          return filtered.length > 0 ? filtered : namedCandidates;
        })();

        const match = this.pickBestNamedCandidate(constrainedCandidates, row.fromFile, ["property"]);
        if (!match) {
          continue;
        }

        const sameFile = match.filePath === row.fromFile;
        const confidence = row.edgeType === "PROPERTY_WRITE"
          ? (sameFile ? 0.84 : 0.72)
          : (sameFile ? 0.88 : 0.75);
        const reason = sameFile ? "resolved property same-file" : "resolved property by name";
        updateStmt.run(match.symbolId, confidence, reason, repoId, row.fromId, row.toId, row.edgeType);
        count += 1;
      }
    });
    tx();

    return count;
  }

  getImpactSurface(repoId: string, filePath: string, limit: number): {
    callers: {
      callerName: string;
      callerFile: string;
      callerLine: number;
      symbolAffected: string;
      edgeType: string;
      confidence: number;
      reason: string | null;
    }[];
    graphHealth: GraphHealth;
    reliabilitySummary: ReliabilitySummary;
  } {
    const canonicalFilePath = this.resolveCanonicalFilePath(repoId, filePath);

    const callers = this.db
      .prepare(
        `
        select
          sf.name as callerName,
          sf.file_path as callerFile,
          sf.line as callerLine,
          s.name as symbolAffected,
          e.type as edgeType,
          e.confidence as confidence,
          e.reason as reason
        from symbols s
        inner join edges e
          on e.repo_id = s.repo_id
          and (
            e.to_id = s.symbol_id
            or (e.type = 'CALLS' and e.to_id = ('callee:' || s.name))
            or (e.type = 'TYPE_REF' and e.to_id = ('type:' || s.name))
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
        confidence: number;
        reason: string | null;
      }[];

    const moduleSymbolId = this.findModuleSymbolId(repoId, canonicalFilePath) ?? undefined;
    const graphHealth = this.countUnresolvedEdgesForFile(repoId, canonicalFilePath, moduleSymbolId);
    return {
      callers,
      graphHealth,
      reliabilitySummary: this.buildReliabilitySummary(callers.map((x) => x.confidence), graphHealth)
    };
  }

  getImpactFiles(repoId: string, filePath: string, limit: number): {
    impactedFiles: { filePath: string; reason: string; confidence: number; symbolsAffected: string[] }[];
    graphHealth: GraphHealth;
    reliabilitySummary: ReliabilitySummary;
  } {
    const canonicalFilePath = this.resolveCanonicalFilePath(repoId, filePath);

    // Phase 1: get DISTINCT impacted file paths (limit applies to files, not rows)
    const distinctFiles = this.db
      .prepare(
        `
        select distinct sf.file_path as callerFile
        from symbols s
        inner join edges e
          on e.repo_id = s.repo_id
          and (
            e.to_id = s.symbol_id
            or (e.type = 'CALLS' and e.to_id = ('callee:' || s.name))
            or (e.type = 'TYPE_REF' and e.to_id = ('type:' || s.name))
          )
        inner join symbols sf on sf.repo_id = e.repo_id and sf.symbol_id = e.from_id
        where s.repo_id = ? and s.file_path = ? and sf.file_path != s.file_path
        order by sf.file_path
        limit ?
        `
      )
      .all(repoId, canonicalFilePath, limit) as { callerFile: string }[];

    if (distinctFiles.length === 0) {
      const moduleSymbolId = this.findModuleSymbolId(repoId, canonicalFilePath) ?? undefined;
      const graphHealth = this.countUnresolvedEdgesForFile(repoId, canonicalFilePath, moduleSymbolId);
      return {
        impactedFiles: [],
        graphHealth,
        reliabilitySummary: this.buildReliabilitySummary([], graphHealth)
      };
    }

    // Phase 2: for each impacted file, collect symbolsAffected (uncapped)
    const ph = distinctFiles.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `
        select
          sf.file_path as callerFile,
          e.type as edgeType,
          e.confidence as confidence,
          e.reason as reason,
          s.name as symbolAffected
        from symbols s
        inner join edges e
          on e.repo_id = s.repo_id
          and (
            e.to_id = s.symbol_id
            or (e.type = 'CALLS' and e.to_id = ('callee:' || s.name))
            or (e.type = 'TYPE_REF' and e.to_id = ('type:' || s.name))
          )
        inner join symbols sf on sf.repo_id = e.repo_id and sf.symbol_id = e.from_id
        where s.repo_id = ? and s.file_path = ?
          and sf.file_path in (${ph})
          and sf.file_path != s.file_path
        order by sf.file_path
        `
      )
      .all(repoId, canonicalFilePath, ...distinctFiles.map((r) => r.callerFile)) as {
        callerFile: string;
        edgeType: string;
        confidence: number;
        reason: string | null;
        symbolAffected: string;
      }[];

    // Group by callerFile
    const byFile = new Map<string, { reason: string; confidence: number; symbolsAffected: Set<string> }>();
    for (const row of rows) {
      const existing = byFile.get(row.callerFile);
      if (existing) {
        existing.symbolsAffected.add(row.symbolAffected);
        if (row.confidence > existing.confidence) {
          existing.confidence = row.confidence;
          existing.reason = row.reason ?? row.edgeType;
        }
      } else {
        byFile.set(row.callerFile, {
          reason: row.reason ?? row.edgeType,
          confidence: row.confidence,
          symbolsAffected: new Set([row.symbolAffected])
        });
      }
    }

    const impactedFiles = Array.from(byFile.entries()).map(([fp, v]) => ({
      filePath: fp,
      reason: v.reason,
      confidence: v.confidence,
      symbolsAffected: Array.from(v.symbolsAffected)
    }));

    const moduleSymbolId = this.findModuleSymbolId(repoId, canonicalFilePath) ?? undefined;
    const graphHealth = this.countUnresolvedEdgesForFile(repoId, canonicalFilePath, moduleSymbolId);
    return {
      impactedFiles,
      graphHealth,
      reliabilitySummary: this.buildReliabilitySummary(impactedFiles.map((x) => x.confidence), graphHealth)
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
    reliabilitySummary: ReliabilitySummary;
  } {
    const symbol = this.db
      .prepare(
        `select repo_id as repoId, symbol_id as symbolId, file_path as filePath, name, kind, line, signature
         from symbols where repo_id = ? and symbol_id = ? limit 1`
      )
      .get(repoId, symbolId) as SymbolRecord | undefined;

    if (!symbol) {
      const graphHealth = { unresolvedCalls: 0, unresolvedImports: 0, unresolvedTypeRefs: 0, note: "symbol not found" };
      return {
        symbol: null,
        callers: [],
        callees: [],
        typeDeps: [],
        graphHealth,
        reliabilitySummary: this.buildReliabilitySummary([], graphHealth)
      };
    }

    // BFS callers up to callerDepth
    const callers: (ResolvedEdge & { distance: number })[] = [];
    const visitedCallers = new Set<string>([symbolId]);
    let frontier = [symbolId];
    const declaringType = symbol.kind === "property"
      ? (this.db
          .prepare(
            `
            select name
            from symbols
            where repo_id = ? and file_path = ? and kind in ('class', 'struct') and line < ?
            order by line desc
            limit 1
            `
          )
          .get(repoId, symbol.filePath, symbol.line) as { name: string } | undefined)
      : undefined;
    const propertyTokenFallback = symbol.kind === "property" && declaringType?.name
      ? `property:${declaringType.name}.${symbol.name}`
      : null;
    const initialCallerEdgeTypes = symbol.kind === "property"
      ? ["CALLS", "PROPERTY_REF", "PROPERTY_WRITE"]
      : ["CALLS"];
    for (let depth = 1; depth <= callerDepth && frontier.length > 0 && callers.length < limit; depth++) {
      const ph = frontier.map(() => "?").join(",");
      const callerEdgeTypes = depth === 1 ? initialCallerEdgeTypes : ["CALLS"];
      const edgeTypePh = callerEdgeTypes.map(() => "?").join(",");
      const includePropertyFallback = depth === 1 && propertyTokenFallback !== null;
      const fallbackClause = includePropertyFallback
        ? "or (e.type in ('PROPERTY_REF', 'PROPERTY_WRITE') and e.to_id = ?)"
        : "";
      const rows = this.db
        .prepare(
          `
          select e.from_id as fromId, sf.name as fromName, sf.file_path as fromFilePath,
               e.to_id as toId, st.name as toName, st.file_path as toFilePath, e.type,
               e.confidence as confidence, e.reason as reason
          from edges e
          left join symbols sf on sf.repo_id = e.repo_id and sf.symbol_id = e.from_id
          left join symbols st on st.repo_id = e.repo_id and st.symbol_id = e.to_id
          where e.repo_id = ?
            and ((e.type in (${edgeTypePh}) and e.to_id in (${ph})) ${fallbackClause})
          limit ?
          `
        )
        .all(
          ...[
            repoId,
            ...callerEdgeTypes,
            ...frontier,
            ...(includePropertyFallback && propertyTokenFallback ? [propertyTokenFallback] : []),
            limit - callers.length
          ]
        ) as ResolvedEdge[];

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
    const allCallees = this.db
      .prepare(
        `
        select e.from_id as fromId, sf.name as fromName, sf.file_path as fromFilePath,
           e.to_id as toId, st.name as toName, st.file_path as toFilePath, e.type,
           e.confidence as confidence, e.reason as reason
        from edges e
        left join symbols sf on sf.repo_id = e.repo_id and sf.symbol_id = e.from_id
        left join symbols st on st.repo_id = e.repo_id and st.symbol_id = e.to_id
        where e.repo_id = ? and e.from_id = ? and e.type = 'CALLS'
        limit 20
        `
      )
      .all(repoId, symbolId) as ResolvedEdge[];
    const callees = allCallees.filter((edge) => {
      if (!edge.toId.startsWith("callee:")) {
        return true;
      }
      const token = edge.toId.slice("callee:".length);
      return !TRIVIAL_CALLEE_TOKENS.has(token);
    });

    // Type deps: IMPORTS from same file
    const moduleSymbol = this.db
      .prepare(`select symbol_id as symbolId from symbols where repo_id = ? and file_path = ? and kind = 'module' limit 1`)
      .get(repoId, symbol.filePath) as { symbolId: string } | undefined;

    const typeDeps = moduleSymbol
      ? (this.db
          .prepare(
            `
            select e.from_id as fromId, sf.name as fromName, sf.file_path as fromFilePath,
                   e.to_id as toId, st.name as toName, st.file_path as toFilePath, e.type,
                   e.confidence as confidence, e.reason as reason
            from edges e
            left join symbols sf on sf.repo_id = e.repo_id and sf.symbol_id = e.from_id
            left join symbols st on st.repo_id = e.repo_id and st.symbol_id = e.to_id
            where e.repo_id = ? and e.from_id = ? and e.type = 'IMPORTS'
            limit 10
            `
          )
          .all(repoId, moduleSymbol.symbolId) as ResolvedEdge[])
          .filter((x) => x.toName !== null)
      : [];

    const graphHealth = this.countUnresolvedEdgesForFile(repoId, symbol.filePath, symbol.symbolId);
    const confidenceSeries = [
      ...callers.map((x) => x.confidence ?? 1),
      ...callees.map((x) => x.confidence ?? 1),
      ...typeDeps.map((x) => x.confidence ?? 1)
    ];

    return {
      symbol,
      callers,
      callees,
      typeDeps,
      graphHealth,
      reliabilitySummary: this.buildReliabilitySummary(confidenceSeries, graphHealth)
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
    const canonicalFilePath = this.resolveCanonicalFilePath(repoId, filePath);

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
      .get(repoId, canonicalFilePath, line) as SymbolRecord | undefined;

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
    directFiles: number;
    subfolders: string[];
    files: {
      filePath: string;
      language: string | null;
      symbolCount: number;
      exportedCount: number;
      callerCount: number;
    }[];
  } {
    const normalized = folderPath.replace(/\\/g, "/").replace(/\/$/, "");
    // Match both forward and back slash variants stored on Windows
    const prefixFwd = `${normalized}/`;
    const prefixBwd = `${normalized.replace(/\//g, "\\")}\\`;

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
        where f.repo_id = ?
          and (
            replace(f.path, char(92), '/') like ?
            or replace(f.path, char(92), '/') = ?
          )
        group by f.path, f.language
        order by f.path
        limit ?
        `
      )
      .all(repoId, `${prefixFwd}%`, normalized, maxFiles) as {
        filePath: string;
        language: string | null;
        symbolCount: number;
        exportedCount: number;
      }[];

    // Fallback for repos where files table can be sparse/out-of-sync but symbols exist.
    const fallbackFiles = files.length === 0
      ? this.db
          .prepare(
            `
            select
              s.file_path as filePath,
              null as language,
              count(distinct s.symbol_id) as symbolCount,
              sum(case when s.kind in ('function','method','class','interface','struct','property') then 1 else 0 end) as exportedCount
            from symbols s
            where s.repo_id = ?
              and (
                replace(s.file_path, char(92), '/') like ?
                or replace(s.file_path, char(92), '/') = ?
              )
              and s.kind != 'module'
            group by s.file_path
            order by s.file_path
            limit ?
            `
          )
          .all(repoId, `${prefixFwd}%`, normalized, maxFiles) as {
            filePath: string;
            language: string | null;
            symbolCount: number;
            exportedCount: number;
          }[]
      : [];

    const effectiveFiles = files.length > 0 ? files : fallbackFiles;

    // Add caller count per file
    const result = effectiveFiles.map((f) => {
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

    // Derive immediate subfolders from the matched file paths
    const subfolderSet = new Set<string>();
    for (const f of result) {
      const rel = f.filePath.replace(/\\/g, "/");
      const rest = rel.startsWith(prefixFwd) ? rel.slice(prefixFwd.length) : rel.slice(normalized.length + 1);
      const slashIdx = rest.indexOf("/");
      if (slashIdx > 0) {
        subfolderSet.add(`${normalized}/${rest.slice(0, slashIdx)}`);
      }
    }

    const directFiles = result.filter((f) => {
      const rel = f.filePath.replace(/\\/g, "/");
      const rest = rel.startsWith(prefixFwd) ? rel.slice(prefixFwd.length) : rel.slice(normalized.length + 1);
      return !rest.includes("/");
    }).length;

    return {
      folderPath: normalized,
      totalFiles: result.length,
      directFiles,
      subfolders: [...subfolderSet].sort(),
      files: result
    };
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
    // Dedicated fast-path: surface C# route handlers from the routes table
    if (kind === "route_handler") {
      const routeConditions: string[] = ["r.repo_id = ?"];
      const routeParams: unknown[] = [repoId];
      if (filePathPrefix) {
        routeConditions.push("replace(r.file_path, char(92), '/') like ?");
        routeParams.push(`${filePathPrefix.replace(/\\/g, "/")}%`);
      }
      const routeWhere = routeConditions.join(" and ");
      routeParams.push(limit);
      const routeRows = this.db
        .prepare(
          `
          select
            r.handler_symbol_id as symbolId,
            coalesce(hs.name, r.handler_symbol_id) as name,
            'route_handler' as kind,
            r.file_path as filePath,
            r.line as line,
            r.http_method || ' ' || r.route_template as signature
          from routes r
          left join symbols hs on hs.repo_id = r.repo_id and hs.symbol_id = r.handler_symbol_id
          where ${routeWhere}
          order by r.file_path, r.line
          limit ?
          `
        )
        .all(...routeParams) as { symbolId: string; name: string; kind: string; filePath: string; line: number; signature: string }[];
      return routeRows.map((r) => ({ ...r, entryReason: "route_handler" }));
    }

    // Tier 1: runtime bootstrap files — match regardless of path separator (Windows stores backslash)
    const bootstrapFileNames = [
      "Program.cs", "Startup.cs", "main.ts", "main.js", "index.ts", "index.js",
      "App.tsx", "App.ts", "server.ts", "server.js"
    ];
    const bootstrapOrClauses = bootstrapFileNames
      .map(() => "(replace(s.file_path, char(92), '/') like ? or replace(s.file_path, char(92), '/') = ?)")
      .join(" or ");
    const bootstrapParams = bootstrapFileNames.flatMap((f) => [`%/${f}`, f]);

    const bootstrapRows = this.db
      .prepare(
        `
        select distinct s.symbol_id as symbolId, s.name, s.kind, s.file_path as filePath, s.line, s.signature
        from symbols s
        where s.repo_id = ?
          and s.kind in ('module', 'function', 'method', 'class')
          and (${bootstrapOrClauses})
        order by s.file_path, s.line
        limit ?
        `
      )
      .all(repoId, ...bootstrapParams, Math.min(limit, 20)) as {
        symbolId: string; name: string; kind: string; filePath: string; line: number; signature: string | null;
      }[];

    const bootstrapResults = bootstrapRows.map((r) => ({ ...r, entryReason: "bootstrap_file" }));
    const remaining = limit - bootstrapResults.length;

    if (remaining <= 0) {
      return bootstrapResults;
    }

    // Tier 2: uncalled public symbols (no incoming CALLS edges)
    const conditions: string[] = [
      "s.repo_id = ?",
      "s.kind not in ('module', 'property', 'constructor', 'type')"
    ];
    const params: unknown[] = [repoId];

    if (filePathPrefix) {
      conditions.push("replace(s.file_path, char(92), '/') like ?");
      params.push(`${filePathPrefix.replace(/\\/g, "/")}%`);
    }
    if (kind) {
      conditions.push("s.kind = ?");
      params.push(kind);
    }

    // Exclude symbols already in bootstrap results
    const bootstrapIds = bootstrapResults.map((r) => r.symbolId);
    if (bootstrapIds.length > 0) {
      const bph = bootstrapIds.map(() => "?").join(", ");
      conditions.push(`s.symbol_id not in (${bph})`);
      params.push(...bootstrapIds);
    }

    const where = conditions.join(" and ");
    params.push(repoId, remaining);

    const uncalledRows = this.db
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

    const uncalledResults = uncalledRows.map((r) => ({ ...r, entryReason: "uncalled_symbol" }));

    // Filter out well-known bootstrap function/method names that are never called by other code
    // but are conventional entry points or lifecycle hooks — not truly dead code.
    const bootstrapFunctionNames = new Set([
      "main", "bootstrap", "setup", "configure", "init", "start", "boot",
      "run", "launch", "startup", "initialize", "teardown", "cleanup", "shutdown",
      "onLoad", "onReady", "afterAll", "beforeAll", "afterEach", "beforeEach"
    ]);
    const filteredResults = uncalledResults.filter(
      (r) => !bootstrapFunctionNames.has(r.name) && !bootstrapFunctionNames.has(r.name.toLowerCase())
    );

    return [...bootstrapResults, ...filteredResults];
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

    const interfaceNames = [...new Set(unresolved.map((row) => row.toId.slice(6)))];
    const namePlaceholders = interfaceNames.map(() => "?").join(",");
    const interfaceRows = interfaceNames.length === 0
      ? []
      : this.db
          .prepare(
            `
            select name, symbol_id as symbolId
            from symbols
            where repo_id = ? and kind = 'interface' and name in (${namePlaceholders})
            `
          )
          .all(repoId, ...interfaceNames) as { name: string; symbolId: string }[];

    const interfaceByName = new Map<string, string>();
    for (const row of interfaceRows) {
      if (!interfaceByName.has(row.name)) {
        interfaceByName.set(row.name, row.symbolId);
      }
    }

    let count = 0;
    const tx = this.db.transaction(() => {
      for (const row of unresolved) {
        const ifaceName = row.toId.slice(6); // strip "iface:"
        const matchId = interfaceByName.get(ifaceName);

        if (matchId) {
          updateStmt.run(matchId, repoId, row.fromId, row.toId);
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

    const writeRows = (rows: import("./types.js").DocRecord[]) => {
      for (const row of rows) {
        // Ensure level is present (as undefined which will bind as NULL)
        const normalized = { ...row, level: row.level ?? undefined };
        stmt.run(normalized);
      }
    };

    if (this.db.inTransaction) {
      writeRows(docs);
      return;
    }

    this.db.transaction((rows: import("./types.js").DocRecord[]) => {
      writeRows(rows);
    })(docs);
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

    const writeRows = (rows: import("./types.js").DocMentionRecord[]) => {
      for (const row of rows) {
        stmt.run(row);
      }
    };

    if (this.db.inTransaction) {
      writeRows(mentions);
      return;
    }

    this.db.transaction((rows: import("./types.js").DocMentionRecord[]) => {
      writeRows(rows);
    })(mentions);
  }

  rebuildDocsFts(): void {
    const start = Date.now();
    try {
      // Get total doc count for progress tracking
      const countStmt = this.db.prepare(`SELECT COUNT(*) as cnt FROM docs WHERE text IS NOT NULL`);
      const { cnt: totalDocs } = countStmt.get() as { cnt: number };
      
      if (totalDocs === 0) {
        process.stderr.write(`[index-docs-fts] no docs to index\n`);
        return;
      }

      // Try to clear old FTS index; if malformed, drop and recreate
      try {
        this.db.prepare(`DELETE FROM docs_fts`).run();
      } catch (e) {
        process.stderr.write(`[index-docs-fts] docs_fts malformed, recreating table...\n`);
        this.db.exec(`DROP TABLE IF EXISTS docs_fts`);
        this.db.exec(`
          CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5(
            text,
            doc_id UNINDEXED,
            repo_id UNINDEXED,
            content='docs',
            content_rowid='rowid'
          )
        `);
      }

      // Rebuild in chunks (5000 docs per chunk) to allow SQLite to commit progress
      const chunkSize = 5000;
      const chunks = Math.ceil(totalDocs / chunkSize);
      
      for (let chunk = 0; chunk < chunks; chunk += 1) {
        const offset = chunk * chunkSize;
        this.db
          .prepare(
            `INSERT INTO docs_fts(rowid, text, doc_id, repo_id)
             SELECT rowid, text, doc_id, repo_id FROM docs 
             WHERE text IS NOT NULL
             ORDER BY rowid
             LIMIT ? OFFSET ?`
          )
          .run(chunkSize, offset);
        
        if ((chunk + 1) % 2 === 0 || chunk === chunks - 1) {
          const pct = Math.round(((chunk + 1) / chunks) * 100);
          const elapsed = Date.now() - start;
          process.stderr.write(`[index-docs-fts] ${pct}% | ${Math.min((chunk + 1) * chunkSize, totalDocs)}/${totalDocs} docs | ${elapsed}ms\n`);
        }
      }

      // Optimize FTS index to compact and improve search performance
      this.db.prepare(`INSERT INTO docs_fts(docs_fts) VALUES('optimize')`).run();

      const elapsed = Date.now() - start;
      process.stderr.write(`[index-docs-fts] completed ${totalDocs} docs in ${elapsed}ms\n`);
    } catch (e) {
      // Non-fatal: FTS rebuild failure shouldn't stop indexing
      process.stderr.write(`[index-docs-fts-error] rebuild failed: ${e instanceof Error ? e.message : String(e)}\n`);
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

    // --- Pre-build lookup maps (1 bulk query each, not per-mention) ---

    // Exact name → best symbol_id (class > interface > function > method > variable > other)
    const kindRank = (kind: string): number => {
      switch (kind) {
        case "class": return 0;
        case "interface": return 1;
        case "function": return 2;
        case "method": return 3;
        case "variable": return 4;
        default: return 5;
      }
    };

    const allSymbols = this.db
      .prepare(`select symbol_id, name, kind, file_path from symbols where repo_id = ?`)
      .all(repoId) as { symbol_id: string; name: string; kind: string; file_path: string }[];

    // Exact name map: name → best symbol_id (O(1) lookup, O(n) build)
    const nameMap = new Map<string, string>();
    // Track best kind rank per name to avoid allSymbols.find() per conflict
    const nameMapRank = new Map<string, number>();
    // Lowercase exact map: lowercase name → symbol_id
    const nameLowerMap = new Map<string, string>();
    const nameLowerMapRank = new Map<string, number>();
    // Suffix map: last segment after last dot (lowercase) → symbol_id
    // handles: symLower.endsWith(`.${lower}`) i.e. mention="GetUser", sym="UserService.GetUser"
    const nameSuffixMap = new Map<string, string>();
    // Prefix map: first segment before first dot (lowercase) → symbol_id
    // handles: symLower.startsWith(`${lower}.`) i.e. mention="UserService", sym="UserService.GetUser"
    const namePrefixMap = new Map<string, string>();

    // File path map: normalized path → symbol_id (O(1) exact lookup)
    const filePathMap = new Map<string, string>();
    // Suffix segment map: each path segment → symbol_id (for suffix match fallback)
    const filePathSuffixMap = new Map<string, string>();

    // Single pass over allSymbols: build all 6 lookup maps at once
    for (const sym of allSymbols) {
      const rank = kindRank(sym.kind);

      // Exact name map (case-sensitive)
      const existingRank = nameMapRank.get(sym.name) ?? Infinity;
      if (rank < existingRank) {
        nameMap.set(sym.name, sym.symbol_id);
        nameMapRank.set(sym.name, rank);
      }

      // Lowercase exact map + suffix/prefix maps from dotted names
      const nameLower = sym.name.toLowerCase();
      const existingLowerRank = nameLowerMapRank.get(nameLower) ?? Infinity;
      if (rank < existingLowerRank) {
        nameLowerMap.set(nameLower, sym.symbol_id);
        nameLowerMapRank.set(nameLower, rank);
      }
      const dotIdx = nameLower.lastIndexOf(".");
      if (dotIdx >= 0) {
        const suffix = nameLower.slice(dotIdx + 1);
        if (!nameSuffixMap.has(suffix)) nameSuffixMap.set(suffix, sym.symbol_id);
        const prefix = nameLower.slice(0, dotIdx);
        if (!namePrefixMap.has(prefix)) namePrefixMap.set(prefix, sym.symbol_id);
      }

      // File path maps
      const normalizedPath = sym.file_path
        .replace(/\\/g, "/")
        .replace(/\.(ts|js|tsx|jsx|cs)$/, "")
        .toLowerCase();
      if (!filePathMap.has(normalizedPath) || sym.kind === "module") {
        filePathMap.set(normalizedPath, sym.symbol_id);
      }
      // Store trailing path segments: "a/b/c" → keys "c", "b/c", "a/b/c" (max 3 deep)
      const parts = normalizedPath.split("/");
      for (let i = parts.length - 1; i >= 0; i--) {
        const key = parts.slice(i).join("/");
        if (!filePathSuffixMap.has(key)) filePathSuffixMap.set(key, sym.symbol_id);
        if (parts.length - i >= 3) break;
      }
    }

    // Use REPLACE to handle conflicts (DELETE + INSERT)
    const updateStmt = this.db.prepare(
      `update or replace doc_mentions set symbol_id = ? where repo_id = ? and doc_id = ? and mention_type = ? and mention_text = ? and symbol_id is null`
    );

    let count = 0;
    const updates: Array<[string, string, string, string, string]> = [];

    for (const mention of unresolved) {
      let resolvedSymbolId: string | undefined;

      if (mention.mention_type === "backtick") {
        // O(1) lookups: exact → lowercase exact → suffix → prefix
        const lower = mention.mention_text.toLowerCase();
        resolvedSymbolId =
          nameMap.get(mention.mention_text) ??
          nameLowerMap.get(lower) ??
          nameSuffixMap.get(lower) ??
          namePrefixMap.get(lower);
      } else if (mention.mention_type === "filepath") {
        const normalizedMention = mention.mention_text
          .replace(/\\/g, "/")
          .replace(/\.(ts|js|tsx|jsx|cs)$/, "")
          .replace(/^src\//, "")
          .toLowerCase();

        // Try exact map lookup first
        resolvedSymbolId = filePathMap.get(normalizedMention);

        // Fallback: O(1) suffix map lookup
        if (!resolvedSymbolId) {
          resolvedSymbolId = filePathSuffixMap.get(normalizedMention);
        }
      }
      // Heading mentions are low priority, skip for now

      if (resolvedSymbolId) {
        updates.push([resolvedSymbolId, repoId, mention.doc_id, mention.mention_type, mention.mention_text]);
      }
    }

    // Bulk update in a single transaction
    if (updates.length > 0) {
      const tx = this.db.transaction(() => {
        for (const args of updates) {
          updateStmt.run(...args);
          count += 1;
        }
      });
      tx();
    }

    return count;
  }

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
    const result: Record<string, string[]> = {};
    for (const f of files) {
      const normalized = f.replace(/\\/g, "/");
      const parts = normalized.split("/");
      const key = parts.length > 1 ? parts[0] : "(root)";
      if (!result[key]) result[key] = [];
      result[key].push(f);
    }
    return result;
  }

  // --- Phase 7B-2: rename impact ---
  getRenameImpact(repoId: string, symbolId: string, limit: number): {
    symbol: SymbolRecord | null;
    callers: ResolvedEdge[];
    importers: ResolvedEdge[];
    affectedFileCount: number;
  } {
    const symbol = this.db
      .prepare(
        `select repo_id as repoId, symbol_id as symbolId, file_path as filePath, name, kind, line, signature
         from symbols where repo_id = ? and symbol_id = ? limit 1`
      )
      .get(repoId, symbolId) as SymbolRecord | undefined ?? null;

    if (!symbol) {
      return { symbol: null, callers: [], importers: [], affectedFileCount: 0 };
    }

    const callerRows = this.db
      .prepare(
        `select e.from_id as fromId, e.to_id as toId, e.type,
                s.name as fromName, s.file_path as fromFilePath,
                t.name as toName, t.file_path as toFilePath,
                e.confidence, e.reason
         from edges e
         inner join symbols s on s.repo_id = e.repo_id and s.symbol_id = e.from_id
         left join symbols t on t.repo_id = e.repo_id and t.symbol_id = e.to_id
         where e.repo_id = ? and e.to_id = ? and e.type = 'CALLS'
         order by s.file_path
         limit ?`
      )
      .all(repoId, symbolId, limit) as ResolvedEdge[];

    const importerRows = this.db
      .prepare(
        `select e.from_id as fromId, e.to_id as toId, e.type,
                s.name as fromName, s.file_path as fromFilePath,
                t.name as toName, t.file_path as toFilePath,
                e.confidence, e.reason
         from edges e
         inner join symbols s on s.repo_id = e.repo_id and s.symbol_id = e.from_id
         left join symbols t on t.repo_id = e.repo_id and t.symbol_id = e.to_id
         where e.repo_id = ? and e.to_id = ? and e.type = 'IMPORTS'
         order by s.file_path
         limit ?`
      )
      .all(repoId, symbolId, limit) as ResolvedEdge[];

    const affectedFilePaths = new Set<string>();
    for (const r of callerRows) if (r.fromFilePath) affectedFilePaths.add(r.fromFilePath);
    for (const r of importerRows) if (r.fromFilePath) affectedFilePaths.add(r.fromFilePath);

    return {
      symbol,
      callers: callerRows,
      importers: importerRows,
      affectedFileCount: affectedFilePaths.size
    };
  }

  // --- Phase 7C: execution flow BFS ---
  traceExecutionFlow(repoId: string, entrySymbolId: string, maxDepth: number, maxNodes: number): {
    entrySymbol: SymbolRecord | null;
    nodes: SymbolRecord[];
    edges: { fromId: string; toId: string; fromName: string; toName: string; confidence: number | null }[];
    depthReached: number;
    truncated: boolean;
  } {
    const entrySymbol = this.db
      .prepare(
        `select repo_id as repoId, symbol_id as symbolId, file_path as filePath, name, kind, line, signature
         from symbols where repo_id = ? and symbol_id = ? limit 1`
      )
      .get(repoId, entrySymbolId) as SymbolRecord | undefined ?? null;

    if (!entrySymbol) {
      return { entrySymbol: null, nodes: [], edges: [], depthReached: 0, truncated: false };
    }

    const visitedSymbols = new Set<string>([entrySymbolId]);
    const visitedEdges = new Set<string>();
    const resultNodes: SymbolRecord[] = [entrySymbol];
    const resultEdges: { fromId: string; toId: string; fromName: string; toName: string; confidence: number | null }[] = [];
    let frontier = [entrySymbolId];
    let depthReached = 0;
    let truncated = false;

    for (let depth = 0; depth < maxDepth && frontier.length > 0 && resultNodes.length < maxNodes; depth++) {
      const nextFrontier: string[] = [];
      for (const currentId of frontier) {
        if (resultNodes.length >= maxNodes) { truncated = true; break; }
        const calleeRows = this.db
          .prepare(
            `select e.from_id as fromId, e.to_id as toId, e.confidence,
                    sf.name as fromName, st.name as toName,
                    st.repo_id as repoId, st.symbol_id as symbolId, st.file_path as filePath,
                    st.kind, st.line, st.signature
             from edges e
             inner join symbols sf on sf.repo_id = e.repo_id and sf.symbol_id = e.from_id
             inner join symbols st on st.repo_id = e.repo_id and st.symbol_id = e.to_id
             where e.repo_id = ? and e.from_id = ? and e.type = 'CALLS'
             limit 50`
          )
          .all(repoId, currentId) as (SymbolRecord & { fromId: string; toId: string; fromName: string; toName: string; confidence: number | null })[];

        for (const row of calleeRows) {
          const edgeKey = `${row.fromId}:${row.toId}`;
          if (!visitedEdges.has(edgeKey)) {
            visitedEdges.add(edgeKey);
            resultEdges.push({ fromId: row.fromId, toId: row.toId, fromName: row.fromName, toName: row.toName, confidence: row.confidence ?? null });
          }
          if (!visitedSymbols.has(row.toId) && resultNodes.length < maxNodes) {
            visitedSymbols.add(row.toId);
            resultNodes.push({ repoId: row.repoId, symbolId: row.symbolId, filePath: row.filePath, name: row.toName, kind: row.kind, line: row.line, signature: row.signature });
            nextFrontier.push(row.toId);
          }
        }
      }
      frontier = nextFrontier;
      depthReached = depth + 1;
    }

    if (frontier.length > 0 && resultNodes.length >= maxNodes) truncated = true;

    return { entrySymbol, nodes: resultNodes, edges: resultEdges, depthReached, truncated };
  }

  private buildFtsQuery(query: string): string {
    const raw = query.trim();

    // Split on whitespace for multi-word queries
    const spaceTokens = raw.split(/\s+/).filter((t) => t.length >= 2);

    if (spaceTokens.length === 1) {
      // Single token: also expand PascalCase/camelCase into constituent words
      // e.g. "ConversationAssignedToAI" → ["Conversation", "Assigned", "To", "AI"]
      const pascal = raw.replace(/([A-Z][a-z]+|[A-Z]{2,}(?=[A-Z][a-z]|$)|[A-Z]{2,})/g, " $1").trim().split(/\s+/).filter((t) => t.length >= 2);
      if (pascal.length > 1) {
        // Use AND strategy for PascalCase expansion (all parts must be present)
        const andClause = pascal.map((t) => `"${t.replace(/"/g, '""')}"*`).join(" ");
        // Also add the original as OR fallback
        return `(${andClause}) OR "${raw.replace(/"/g, '""')}"*`;
      }
      const q = raw.replace(/"/g, '""');
      return `"${q}"*`;
    }

    // Multi-word: try AND first (all tokens), OR as fallback via UNION in SQL is not possible,
    // so emit the AND form — this is stricter but more precise for phrases like "ConversationAssignedAI handler"
    const andClause = spaceTokens.map((t) => `"${t.replace(/"/g, '""')}"*`).join(" ");

    // Also expand each space-token that looks like PascalCase or snake_case
    const expandedTokens = new Set<string>(spaceTokens);
    for (const tok of spaceTokens) {
      const pascal = tok.replace(/([A-Z][a-z]+|[A-Z]{2,}(?=[A-Z][a-z]|$)|[A-Z]{2,})/g, " $1").trim().split(/\s+/).filter((t) => t.length >= 2);
      for (const p of pascal) expandedTokens.add(p);
      // snake_case: user_service → [user, service]
      const snakeParts = tok.split("_").filter((t) => t.length >= 2);
      for (const p of snakeParts) expandedTokens.add(p);
    }

    if (expandedTokens.size > spaceTokens.length) {
      const orClause = [...expandedTokens].map((t) => `"${t.replace(/"/g, '""')}"*`).join(" OR ");
      return `(${andClause}) OR (${orClause})`;
    }

    return andClause;
  }

  private extractIntentTokens(query: string): string[] {
    const rawTokens = query
      .split(/[^\p{L}\p{N}_]+/u)
      .map((t) => t.trim())
      .filter((t) => t.length >= 2);

    const expanded = new Set<string>();
    for (const token of rawTokens) {
      expanded.add(token);
      const pascalParts = token
        .replace(/([A-Z][a-z]+|[A-Z]{2,}(?=[A-Z][a-z]|$)|[A-Z]{2,})/g, " $1")
        .trim()
        .split(/\s+/)
        .filter((t) => t.length >= 2);
      for (const part of pascalParts) {
        expanded.add(part);
      }
      // snake_case: payment_handler → [payment, handler]
      const snakeParts = token.split("_").filter((t) => t.length >= 2);
      for (const part of snakeParts) {
        expanded.add(part);
      }
    }

    return [...expanded].slice(0, 12);
  }

  private buildIntentFtsQuery(query: string): string {
    const tokens = this.extractIntentTokens(query);
    if (tokens.length === 0) {
      return this.buildFtsQuery(query);
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
    const desiredLimit = Math.max(1, limit);

    try {
      this.db.prepare("select * from docs_fts limit 0").all();
      const ftsRows = this.db
        .prepare(
          `
          select docs_fts.doc_id as docId
          from docs_fts
          inner join docs on docs.doc_id = docs_fts.doc_id and docs.repo_id = ?
          where docs_fts match ?
          order by rank
          limit ?
          `
        )
        .all(repoId, ftsQuery, desiredLimit) as { docId: string }[];
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
        .all(repoId, `%${query}%`, desiredLimit) as { docId: string }[];
      docIds = likeRows.map((r) => r.docId);
    }

    const docResults: {
      docId: string;
      filePath: string;
      headingPath: string;
      contentType: string;
      text: string | null;
      level: number | null;
      resolvedMentions: { symbolId: string; symbolName: string | null; mentionText: string }[];
    }[] = [];

    if (docIds.length > 0) {
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
      docResults.push(
        ...docs
          .sort((a, b) => (orderMap.get(a.docId) ?? 99) - (orderMap.get(b.docId) ?? 99))
          .map((doc) => ({ ...doc, resolvedMentions: mentionsByDoc.get(doc.docId) ?? [] }))
      );
    }

    if (docResults.length < desiredLimit) {
      const symbolSlots = desiredLimit - docResults.length;
      try {
        this.db.prepare("select * from symbols_fts limit 0").all();
        const symbolRows = this.db
          .prepare(
            `
            select
              s.symbol_id as symbolId,
              s.name as symbolName,
              s.file_path as filePath,
              s.signature as signature,
              s.line as line
            from symbols_fts sf
            inner join symbols s on s.repo_id = ? and s.symbol_id = sf.symbol_id
            where symbols_fts match ?
            order by rank
            limit ?
            `
          )
          .all(repoId, this.buildIntentFtsQuery(query), symbolSlots) as {
          symbolId: string;
          symbolName: string;
          filePath: string;
          signature: string | null;
          line: number;
        }[];

        for (const row of symbolRows) {
          docResults.push({
            docId: `symbol:${row.symbolId}`,
            filePath: row.filePath,
            headingPath: row.filePath,
            contentType: "symbol",
            text: row.signature ?? `${row.symbolName} @ line ${row.line}`,
            level: null,
            resolvedMentions: [{ symbolId: row.symbolId, symbolName: row.symbolName, mentionText: row.symbolName }]
          });
        }
      } catch {
        // symbols_fts unavailable
      }
    }

    return docResults.slice(0, desiredLimit);
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

  private countUnresolvedEdgesForFile(repoId: string, filePath: string, symbolId?: string): GraphHealth {
    const canonicalFilePath = this.resolveCanonicalFilePath(repoId, filePath);

    const symbolFilter = symbolId ? "AND e.from_id = ?" : "";
    const row = this.db
      .prepare(
        `
        select
          count(case when e.to_id like 'callee:%'
            and e.to_id not in (${TRIVIAL_CALLEE_IN_CLAUSE}) then 1 end) as unresolvedCalls,
          -- Exclude node_builtin and npm_package imports: they are external by design, not graph gaps
          count(case when e.to_id like 'import:%'
            and coalesce(e.reason, '') not in ('node_builtin', 'npm_package') then 1 end) as unresolvedImports,
          count(case when e.to_id like 'type:%' then 1 end) as unresolvedTypeRefs
        from edges e
        inner join symbols s on s.repo_id = e.repo_id and s.symbol_id = e.from_id
        where e.repo_id = ? and replace(s.file_path, char(92), '/') = replace(?, char(92), '/')
        ${symbolFilter}
        `
      )
      .get(...([repoId, canonicalFilePath, ...(symbolId ? [symbolId] : [])] as [string, string, ...string[]])) as { unresolvedCalls: number; unresolvedImports: number; unresolvedTypeRefs: number };

    const { unresolvedCalls, unresolvedImports, unresolvedTypeRefs } = row ?? { unresolvedCalls: 0, unresolvedImports: 0, unresolvedTypeRefs: 0 };
    let note: string;
    if (unresolvedCalls === 0 && unresolvedImports === 0 && unresolvedTypeRefs === 0) {
      note = "graph data complete";
    } else {
      const parts: string[] = [];
      if (unresolvedCalls > 0) parts.push(`${unresolvedCalls} call edge${unresolvedCalls > 1 ? "s" : ""} unresolved`);
      if (unresolvedImports > 0) parts.push(`${unresolvedImports} import edge${unresolvedImports > 1 ? "s" : ""} unresolved`);
      if (unresolvedTypeRefs > 0) parts.push(`${unresolvedTypeRefs} type reference${unresolvedTypeRefs > 1 ? "s" : ""} unresolved`);
      note = `${parts.join(", ")} — results may be incomplete`;
    }

    return { unresolvedCalls, unresolvedImports, unresolvedTypeRefs, note };
  }

  listIndexedFiles(repoId: string): { path: string; language: string | null }[] {
    return this.db
      .prepare(
        `
        select path, language
        from files
        where repo_id = ?
        order by path asc
        `
      )
      .all(repoId) as { path: string; language: string | null }[];
  }

  saveRefactorPreview(preview: RefactorPreviewRecord, hunks: RefactorPreviewHunkRecord[]): void {
    const tx = this.db.transaction((previewRow: RefactorPreviewRecord, hunkRows: RefactorPreviewHunkRecord[]) => {
      this.db
        .prepare(
          `
          insert into refactor_previews (
            preview_id, repo_id, find_pattern, replace_expression, mode,
            ambiguity_threshold_percent, created_at, expires_at, digest, status,
            total_matches, affected_file_count, risk_ambiguous_count, risk_cross_type_count, risk_generated_count
          ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          on conflict(preview_id) do update set
            repo_id = excluded.repo_id,
            find_pattern = excluded.find_pattern,
            replace_expression = excluded.replace_expression,
            mode = excluded.mode,
            ambiguity_threshold_percent = excluded.ambiguity_threshold_percent,
            created_at = excluded.created_at,
            expires_at = excluded.expires_at,
            digest = excluded.digest,
            status = excluded.status,
            total_matches = excluded.total_matches,
            affected_file_count = excluded.affected_file_count,
            risk_ambiguous_count = excluded.risk_ambiguous_count,
            risk_cross_type_count = excluded.risk_cross_type_count,
            risk_generated_count = excluded.risk_generated_count
          `
        )
        .run(
          previewRow.previewId,
          previewRow.repoId,
          previewRow.findPattern,
          previewRow.replaceExpression,
          previewRow.mode,
          previewRow.ambiguityThresholdPercent,
          previewRow.createdAt,
          previewRow.expiresAt,
          previewRow.digest,
          previewRow.status,
          previewRow.totalMatches,
          previewRow.affectedFileCount,
          previewRow.riskAmbiguousCount,
          previewRow.riskCrossTypeCount,
          previewRow.riskGeneratedCount
        );

      this.db.prepare(`delete from refactor_preview_hunks where preview_id = ?`).run(previewRow.previewId);

      const insertHunk = this.db.prepare(
        `
        insert into refactor_preview_hunks (
          preview_id, hunk_id, file_path, line, start_offset, end_offset,
          before_text, after_text, replacement_text, owner_type, symbol_kind,
          confidence, risk_flags, file_hash_before
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
      );

      for (const hunk of hunkRows) {
        insertHunk.run(
          hunk.previewId,
          hunk.hunkId,
          hunk.filePath,
          hunk.line,
          hunk.startOffset,
          hunk.endOffset,
          hunk.beforeText,
          hunk.afterText,
          hunk.replacementText,
          hunk.ownerType,
          hunk.symbolKind,
          hunk.confidence,
          JSON.stringify(hunk.riskFlags),
          hunk.fileHashBefore
        );
      }
    });

    tx(preview, hunks);
  }

  getRefactorPreview(previewId: string): { preview: RefactorPreviewRecord; hunks: RefactorPreviewHunkRecord[] } | null {
    const preview = this.db
      .prepare(
        `
        select
          preview_id as previewId,
          repo_id as repoId,
          find_pattern as findPattern,
          replace_expression as replaceExpression,
          mode,
          ambiguity_threshold_percent as ambiguityThresholdPercent,
          created_at as createdAt,
          expires_at as expiresAt,
          digest,
          status,
          total_matches as totalMatches,
          affected_file_count as affectedFileCount,
          risk_ambiguous_count as riskAmbiguousCount,
          risk_cross_type_count as riskCrossTypeCount,
          risk_generated_count as riskGeneratedCount
        from refactor_previews
        where preview_id = ?
        limit 1
        `
      )
      .get(previewId) as RefactorPreviewRecord | undefined;

    if (!preview) {
      return null;
    }

    const rows = this.db
      .prepare(
        `
        select
          preview_id as previewId,
          hunk_id as hunkId,
          file_path as filePath,
          line,
          start_offset as startOffset,
          end_offset as endOffset,
          before_text as beforeText,
          after_text as afterText,
          replacement_text as replacementText,
          owner_type as ownerType,
          symbol_kind as symbolKind,
          confidence,
          risk_flags as riskFlags,
          file_hash_before as fileHashBefore
        from refactor_preview_hunks
        where preview_id = ?
        order by file_path asc, start_offset asc, hunk_id asc
        `
      )
      .all(previewId) as Array<Omit<RefactorPreviewHunkRecord, "riskFlags"> & { riskFlags: string }>;

    const hunks: RefactorPreviewHunkRecord[] = rows.map((row) => ({
      ...row,
      riskFlags: parseRiskFlags(row.riskFlags)
    }));

    return { preview, hunks };
  }

  markRefactorPreviewStatus(previewId: string, status: RefactorPreviewRecord["status"]): void {
    this.db
      .prepare(
        `
        update refactor_previews
        set status = ?
        where preview_id = ?
        `
      )
      .run(status, previewId);
  }

  recordRefactorApply(
    apply: RefactorApplyRecord,
    changes: RefactorApplyChangeRecord[],
    hunks: RefactorApplyHunkRecord[]
  ): void {
    const tx = this.db.transaction((applyRow: RefactorApplyRecord, changeRows: RefactorApplyChangeRecord[], hunkRows: RefactorApplyHunkRecord[]) => {
      this.db
        .prepare(
          `
          insert into refactor_applies (
            apply_id, rollback_id, preview_id, repo_id, status,
            created_at, completed_at, total_files, total_replacements, conflict_count
          ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `
        )
        .run(
          applyRow.applyId,
          applyRow.rollbackId,
          applyRow.previewId,
          applyRow.repoId,
          applyRow.status,
          applyRow.createdAt,
          applyRow.completedAt,
          applyRow.totalFiles,
          applyRow.totalReplacements,
          applyRow.conflictCount
        );

      const insertChange = this.db.prepare(
        `
        insert into refactor_apply_changes (
          apply_id, file_path, replacement_count, status, reason,
          file_hash_before, file_hash_after, before_content, after_content
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
      );

      for (const row of changeRows) {
        // Cap stored content to APPLY_CONTENT_STORE_MAX_BYTES (256 KB) to prevent unbounded
        // DB growth for large source files. Rollback will use hunk-level records in that case.
        const APPLY_CONTENT_STORE_MAX_BYTES = 256 * 1024;
        const beforeContentStored =
          row.beforeContent != null && Buffer.byteLength(row.beforeContent, "utf8") <= APPLY_CONTENT_STORE_MAX_BYTES
            ? row.beforeContent
            : null;
        const afterContentStored =
          row.afterContent != null && Buffer.byteLength(row.afterContent, "utf8") <= APPLY_CONTENT_STORE_MAX_BYTES
            ? row.afterContent
            : null;
        insertChange.run(
          row.applyId,
          row.filePath,
          row.replacementCount,
          row.status,
          row.reason,
          row.fileHashBefore,
          row.fileHashAfter,
          beforeContentStored,
          afterContentStored
        );
      }

      const insertHunk = this.db.prepare(
        `
        insert into refactor_apply_hunks (
          apply_id, file_path, hunk_id, start_offset_applied, end_offset_applied, before_text, after_text
        ) values (?, ?, ?, ?, ?, ?, ?)
        `
      );

      for (const hunk of hunkRows) {
        insertHunk.run(
          hunk.applyId,
          hunk.filePath,
          hunk.hunkId,
          hunk.startOffsetApplied,
          hunk.endOffsetApplied,
          hunk.beforeText,
          hunk.afterText
        );
      }
    });

    tx(apply, changes, hunks);
  }

  getApplyByRollbackId(rollbackId: string): {
    apply: RefactorApplyRecord;
    changes: RefactorApplyChangeRecord[];
    hunks: RefactorApplyHunkRecord[];
  } | null {
    const apply = this.db
      .prepare(
        `
        select
          apply_id as applyId,
          rollback_id as rollbackId,
          preview_id as previewId,
          repo_id as repoId,
          status,
          created_at as createdAt,
          completed_at as completedAt,
          total_files as totalFiles,
          total_replacements as totalReplacements,
          conflict_count as conflictCount
        from refactor_applies
        where rollback_id = ?
        limit 1
        `
      )
      .get(rollbackId) as RefactorApplyRecord | undefined;

    if (!apply) {
      return null;
    }

    const changes = this.db
      .prepare(
        `
        select
          apply_id as applyId,
          file_path as filePath,
          replacement_count as replacementCount,
          status,
          reason,
          file_hash_before as fileHashBefore,
          file_hash_after as fileHashAfter,
          before_content as beforeContent,
          after_content as afterContent
        from refactor_apply_changes
        where apply_id = ?
        order by file_path asc
        `
      )
      .all(apply.applyId) as RefactorApplyChangeRecord[];

    const hunks = this.db
      .prepare(
        `
        select
          apply_id as applyId,
          file_path as filePath,
          hunk_id as hunkId,
          start_offset_applied as startOffsetApplied,
          end_offset_applied as endOffsetApplied,
          before_text as beforeText,
          after_text as afterText
        from refactor_apply_hunks
        where apply_id = ?
        order by file_path asc, start_offset_applied desc, hunk_id asc
        `
      )
      .all(apply.applyId) as RefactorApplyHunkRecord[];

    return { apply, changes, hunks };
  }

  recordRefactorRollback(rollback: RefactorRollbackRecord): void {
    this.db
      .prepare(
        `
        insert into refactor_rollbacks (
          rollback_id, apply_id, status, created_at, completed_at, restored_files, conflict_count
        ) values (?, ?, ?, ?, ?, ?, ?)
        `
      )
      .run(
        rollback.rollbackId,
        rollback.applyId,
        rollback.status,
        rollback.createdAt,
        rollback.completedAt,
        rollback.restoredFiles,
        rollback.conflictCount
      );
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
