/**
 * The indexing write path: everything that mutates the graph for one file, plus the WAL
 * session and bulk-index maintenance around a run (S-30).
 *
 * Lifted out of `GraphStore`. Unlike the schema and run-history extractions, these functions
 * need more than a connection — the hot per-file writes run through prepared statements cached
 * once at construction, because re-preparing them per file measurably dominated indexing. That
 * cache is the `WriteStatements` bundle; `WriteContext` pairs it with the connection.
 *
 * Two conventions here are load-bearing and easy to break:
 *
 * - `db.inTransaction` is checked before opening one. `indexPipeline` batches many files into a
 *   single outer transaction, and better-sqlite3 does not nest — wrapping unconditionally would
 *   throw mid-run. Every multi-row write below therefore has the same two-branch shape.
 * - Deletes come before inserts, per file, and `replaceSymbolsForFile` clears that file's edges
 *   as well as its symbols. Edges are keyed by their *source* symbol, so symbols must not be
 *   dropped before the edges that hang off them.
 */

import type Database from "better-sqlite3";

import type { EdgeRecord, FileRecord, RouteRecord, SymbolRecord } from "../types/index.js";
import { getEdgeDefaults } from "../services/impact/impactAnalyzer.js";

/** Prepared statements for the hot per-file write path, prepared once per connection. */
export interface WriteStatements {
  readonly upsertFile: Database.Statement;
  readonly deleteEdgesForFile: Database.Statement;
  readonly deleteSymbolsForFile: Database.Statement;
  readonly insertSymbol: Database.Statement;
  readonly deleteRoutesForFile: Database.Statement;
  readonly insertEdge: Database.Statement;
  readonly insertRoute: Database.Statement;
}

export interface WriteContext {
  readonly db: Database.Database;
  readonly stmts: WriteStatements;
}

export function prepareWriteStatements(db: Database.Database): WriteStatements {
  return {
    upsertFile: db.prepare(
      `
      insert into files (repo_id, path, content_hash, language, updated_at)
      values (@repoId, @path, @contentHash, @language, @updatedAt)
      on conflict(repo_id, path) do update set
        content_hash = excluded.content_hash,
        language = excluded.language,
        updated_at = excluded.updated_at
      `
    ),
    deleteEdgesForFile: db.prepare(
      `
      delete from edges
      where repo_id = ?
        and from_id in (
          select symbol_id
          from symbols
          where repo_id = ? and file_path = ?
        )
      `
    ),
    deleteSymbolsForFile: db.prepare(`delete from symbols where repo_id = ? and file_path = ?`),
    insertSymbol: db.prepare(
      `
      insert into symbols (repo_id, symbol_id, file_path, name, kind, line, end_line, signature, parent_symbol_id)
      values (@repoId, @symbolId, @filePath, @name, @kind, @line, @endLine, @signature, @parentSymbolId)
      `
    ),
    deleteRoutesForFile: db.prepare(`delete from routes where repo_id = ? and file_path = ?`),
    insertEdge: db.prepare(
      `
      insert into edges (repo_id, from_id, to_id, type, confidence, reason, assigned_expression)
      values (@repoId, @fromId, @toId, @type, @confidence, @reason, @assignedExpression)
      `
    ),
    insertRoute: db.prepare(
      `
      insert into routes (repo_id, file_path, controller_symbol_id, handler_symbol_id, http_method, route_template, line)
      values (@repoId, @filePath, @controllerSymbolId, @handlerSymbolId, @httpMethod, @routeTemplate, @line)
      `
    )
  };
}

// ── WAL session ────────────────────────────────────────────────────────────────

/** Flush WAL contents into main database file (GitNexus pattern for batch indexing). */
export function checkpoint(db: Database.Database): void {
  try {
    db.pragma("wal_checkpoint(PASSIVE)");
  } catch {
    // Ignore checkpoint errors to avoid interrupting indexing flow.
  }
}

/**
 * Disable auto-checkpoint before a large index run to prevent WAL checkpoint
 * contention with concurrent readers. Call endIndexSession() when done.
 */
export function beginIndexSession(db: Database.Database): void {
  try {
    db.pragma("wal_autocheckpoint = 0"); // Disable auto-checkpoint during indexing
  } catch {
    // Non-fatal — indexing continues without this optimization
  }
}

export function endIndexSession(db: Database.Database): void {
  try {
    db.pragma("wal_autocheckpoint = 8000"); // Restore threshold
    db.pragma("wal_checkpoint(TRUNCATE)"); // Force full checkpoint to shrink WAL file
  } catch {
    // Non-fatal
  }
}

// ── Bulk-run index maintenance ─────────────────────────────────────────────────

/**
 * Remove duplicate resolved edges after the full resolve phase.
 * Keeps the row with the highest rowid (last written = typically highest confidence after resolve).
 * Only targets resolved edges (non-placeholder to_id) to avoid touching unresolved placeholders.
 * Returns the number of duplicate rows deleted.
 */
export function deduplicateResolvedEdges(db: Database.Database, repoId: string): number {
  const PLACEHOLDERS = `(
      to_id LIKE 'callee:%' OR to_id LIKE 'import:%' OR
      to_id LIKE 'property:%' OR to_id LIKE 'iface:%' OR to_id LIKE 'type:%'
    )`;
  const result = db
    .prepare(
      `DELETE FROM edges
       WHERE repo_id = ?
         AND NOT ${PLACEHOLDERS}
         AND rowid NOT IN (
           SELECT MAX(rowid) FROM edges
           WHERE repo_id = ?
             AND NOT ${PLACEHOLDERS}
           GROUP BY repo_id, from_id, to_id, type, assigned_expression
         )`
    )
    .run(repoId, repoId);
  return result.changes;
}

/**
 * Drop secondary edge indexes before bulk resolve to speed up writes.
 * Call rebuildEdgeIndexes() after bulk write is done.
 */
export function dropEdgeIndexesForBulkWrite(db: Database.Database): void {
  try {
    db.exec(`
      drop index if exists idx_edges_repo_to;
      drop index if exists idx_edges_repo_type_to;
      drop index if exists idx_edges_repo_from_to;
      drop index if exists idx_edges_repo_type_to_from;
    `);
  } catch {
    // Non-fatal
  }
}

/**
 * Rebuild edge indexes after bulk resolve completes.
 *
 * These four indexes are what makes the edge→symbol join in `buildEdgeToSymbolPairsCte`
 * indexable. Dropping them and failing to rebuild does not break correctness, so no test
 * catches it — it silently returns `find_impact_files` to its pre-S-30 cost.
 */
export function rebuildEdgeIndexes(db: Database.Database): void {
  try {
    db.exec(`
      create index if not exists idx_edges_repo_to on edges(repo_id, to_id);
      create index if not exists idx_edges_repo_type_to on edges(repo_id, type, to_id);
      create index if not exists idx_edges_repo_from_to on edges(repo_id, from_id, to_id);
      create index if not exists idx_edges_repo_type_to_from on edges(repo_id, type, to_id, from_id);
    `);
  } catch {
    // Non-fatal
  }
}

// ── Per-file writes ────────────────────────────────────────────────────────────

export function upsertFile(ctx: WriteContext, record: FileRecord): void {
  ctx.stmts.upsertFile.run(record);
}

export function ensureRepository(db: Database.Database, repoId: string, repoPath: string): void {
  db.prepare(
    `
    insert into repositories (repo_id, repo_path, updated_at)
    values (?, ?, ?)
    on conflict(repo_id) do update set
      repo_path = excluded.repo_path,
      updated_at = excluded.updated_at
    `
  ).run(repoId, repoPath, new Date().toISOString());
}

export function getFileHash(db: Database.Database, repoId: string, filePath: string): string | null {
  const row = db
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

function isSqliteUniqueConstraintError(error: unknown): boolean {
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

/**
 * Turn a bare UNIQUE-constraint failure into one that names both colliding symbols.
 * A symbol_id is SHA-256(repoId:filePath:symbolName) truncated to 24 hex chars, so a collision
 * means either a genuine hash collision or — far more likely — the same logical symbol extracted
 * twice. Neither is diagnosable from "UNIQUE constraint failed: symbols.symbol_id".
 */
function buildSymbolCollisionError(db: Database.Database, row: SymbolRecord, error: unknown): Error {
  const existing = db
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

export function replaceSymbolsForFile(
  ctx: WriteContext,
  repoId: string,
  filePath: string,
  symbols: SymbolRecord[]
): void {
  // Remove previous edges emitted by symbols in this file before replacing symbols.
  ctx.stmts.deleteEdgesForFile.run(repoId, repoId, filePath);
  ctx.stmts.deleteSymbolsForFile.run(repoId, filePath);

  const writeRows = (rows: SymbolRecord[]): void => {
    for (const row of rows) {
      try {
        ctx.stmts.insertSymbol.run({
          ...row,
          endLine: row.endLine ?? null,
          signature: row.signature ?? null,
          parentSymbolId: row.parentSymbolId ?? null
        });
      } catch (error) {
        if (isSqliteUniqueConstraintError(error)) {
          throw buildSymbolCollisionError(ctx.db, row, error);
        }
        throw error;
      }
    }
  };

  if (ctx.db.inTransaction) {
    writeRows(symbols);
    return;
  }

  ctx.db.transaction((rows: SymbolRecord[]) => {
    writeRows(rows);
  })(symbols);
}

/**
 * Remove files (and their symbols/edges) for a repo that are no longer in the current file set.
 * Used after a full-mode index to clean up deleted files.
 * Returns the number of stale files removed.
 */
export function pruneStaleFiles(db: Database.Database, repoId: string, currentRelativePaths: string[]): number {
  const existing = db.prepare(`select path from files where repo_id = ?`).all(repoId) as { path: string }[];

  const currentSet = new Set(currentRelativePaths);
  const stale = existing.filter((r) => !currentSet.has(r.path)).map((r) => r.path);
  return pruneFiles(db, repoId, stale);
}

export function pruneFiles(db: Database.Database, repoId: string, relativePaths: string[]): number {
  if (relativePaths.length === 0) {
    return 0;
  }

  const uniquePaths = [...new Set(relativePaths)];
  const deleteTx = db.transaction((paths: string[]) => {
    for (const filePath of paths) {
      db.prepare(
        `
        delete from edges
        where repo_id = ?
          and from_id in (
            select symbol_id
            from symbols
            where repo_id = ? and file_path = ?
          )
        `
      ).run(repoId, repoId, filePath);
      db.prepare(`delete from symbols where repo_id = ? and file_path = ?`).run(repoId, filePath);
      db.prepare(`delete from docs where repo_id = ? and file_path = ?`).run(repoId, filePath);
      db.prepare(`delete from routes where repo_id = ? and file_path = ?`).run(repoId, filePath);
      db.prepare(`delete from string_literals where repo_id = ? and file_path = ?`).run(repoId, filePath);
      db.prepare(`delete from files where repo_id = ? and path = ?`).run(repoId, filePath);
    }
  });
  deleteTx(uniquePaths);

  return uniquePaths.length;
}

export function pruneOrphanedEdges(db: Database.Database, repoId: string): number {
  const result = db
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

export function replaceEdgesForFile(ctx: WriteContext, repoId: string, filePath: string, edges: EdgeRecord[]): void {
  // replaceSymbolsForFile already cleared edges for this file, but we delete again here as a
  // safety net for callers that invoke replaceEdgesForFile independently.
  ctx.stmts.deleteEdgesForFile.run(repoId, repoId, filePath);

  const writeRows = (rows: EdgeRecord[]): void => {
    for (const row of rows) {
      const defaults = getEdgeDefaults(row);
      ctx.stmts.insertEdge.run({
        ...row,
        confidence: row.confidence ?? defaults.confidence,
        reason: row.reason ?? defaults.reason,
        assignedExpression: row.assignedExpression ?? null
      });
    }
  };

  if (ctx.db.inTransaction) {
    writeRows(edges);
    return;
  }

  ctx.db.transaction((rows: EdgeRecord[]) => {
    writeRows(rows);
  })(edges);
}

export function replaceRoutesForFile(ctx: WriteContext, repoId: string, filePath: string, routes: RouteRecord[]): void {
  ctx.stmts.deleteRoutesForFile.run(repoId, filePath);

  if (routes.length === 0) {
    return;
  }

  const writeRows = (rows: RouteRecord[]): void => {
    for (const row of rows) {
      ctx.stmts.insertRoute.run(row);
    }
  };

  if (ctx.db.inTransaction) {
    writeRows(routes);
    return;
  }

  ctx.db.transaction((rows: RouteRecord[]) => {
    writeRows(rows);
  })(routes);
}
