/**
 * The `index_runs` table: one row per index run, and the "what did the last run look like"
 * read that every freshness check depends on (S-30).
 *
 * Lifted out of `GraphStore`, where `recordRun` + `getLatestRun` were 140 lines touching
 * nothing but the connection. `recordRun` writes the wide column set that
 * `runGraphMigrations` keeps adding to; `getLatestRun` is what `health_check`,
 * `detect_changes` and the incremental-skip decision all read to decide whether the graph
 * still matches the working tree.
 */

import type Database from "better-sqlite3";

import type { IndexRunSummary } from "../types/index.js";

export function recordRun(db: Database.Database, summary: IndexRunSummary & { crossRepoLinked?: number; callEdgesResolved?: number; importEdgesResolved?: number; mentionsResolved?: number; skipReason?: string }): void {
  db
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
        commit_sha, branch,
        resolve_phase_ms, build_context_ms, call_resolve_ms, import_resolve_ms,
        type_resolve_ms, property_resolve_ms, implements_resolve_ms, fts_rebuild_ms,
        unresolved_calls_total, unresolved_rows_capped_by_policy, unresolved_imports_capped_by_policy, resolve_calls_coverage,
        performance_profile,
        index_version, parse_timeouts,
        edges_dropped_by_confidence, edges_dropped_by_call_cap, edges_dropped_by_type_ref_cap,
        files_pruned, edges_pruned, edges_deduplicated,
        symbols_in_graph, edges_in_graph, extract_phase_ms,
        call_edges_attempted, call_edges_unresolved,
        vector_symbols_indexed, health_reasons, skip_reason
      ) values (
        ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?,
        ?, ?,
        ?, ?,
        ?, ?,
        ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?,
        ?, ?,
        ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?,
        ?, ?,
        ?, ?, ?
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
      summary.commitSha ?? null,
      summary.branch ?? null,
      summary.resolvePhaseMs ?? 0,
      summary.buildContextMs ?? 0,
      summary.callResolveMs ?? 0,
      summary.importResolveMs ?? 0,
      summary.typeResolveMs ?? 0,
      summary.propertyResolveMs ?? 0,
      summary.implementsResolveMs ?? 0,
      summary.ftsRebuildMs ?? 0,
      summary.callEdgesAttempted ?? summary.unresolvedCallsTotal ?? 0, // ISSUE-025: cột giữ tên cũ, nghĩa là "attempted"
      0, // unresolved_rows_capped_by_policy — kept for backward compat, always 0 (use unresolvedImportsCappedByPolicy)
      summary.unresolvedImportsCappedByPolicy ? 1 : 0,
      summary.resolveCallsCoverage ?? 0,
      summary.performanceProfile ?? null,
      // MCP-ISSUE-048: previously reported on the wire and then dropped on the floor.
      // `index_version` in particular gates the incremental fast-skip, which could never fire while
      // the stored value was always undefined.
      summary.indexVersion ?? null,
      summary.parseTimeouts ?? 0,
      summary.edgesDroppedByConfidence ?? 0,
      summary.edgesDroppedByCallCap ?? 0,
      summary.edgesDroppedByTypeRefCap ?? 0,
      summary.filesPruned ?? 0,
      summary.edgesPruned ?? 0,
      summary.edgesDeduplicated ?? 0,
      summary.symbolsInGraph ?? 0,
      summary.edgesInGraph ?? 0,
      summary.extractPhaseMs ?? 0,
      summary.callEdgesAttempted ?? 0,
      summary.callEdgesUnresolved ?? 0,
      summary.vectorSymbolsIndexed ?? 0,
      summary.healthReasons && summary.healthReasons.length > 0 ? JSON.stringify(summary.healthReasons) : null,
      summary.skipReason ?? null
    );
}

export function getLatestRun(db: Database.Database, repoId: string): IndexRunSummary | null {
  const row = db
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
        commit_sha as commitSha,
        branch,
        resolve_phase_ms as resolvePhaseMs,
        build_context_ms as buildContextMs,
        call_resolve_ms as callResolveMs,
        import_resolve_ms as importResolveMs,
        type_resolve_ms as typeResolveMs,
        property_resolve_ms as propertyResolveMs,
        implements_resolve_ms as implementsResolveMs,
        fts_rebuild_ms as ftsRebuildMs,
        unresolved_calls_total as unresolvedCallsTotal,
        unresolved_imports_capped_by_policy as unresolvedImportsCappedByPolicy,
        resolve_calls_coverage as resolveCallsCoverage,
        performance_profile as performanceProfile,
        -- MCP-ISSUE-048: read back what is now stored, instead of aliasing one column to two names
        -- and re-deriving the unresolved count with the same broken subtraction the writer used.
        index_version as indexVersion,
        parse_timeouts as parseTimeouts,
        edges_dropped_by_confidence as edgesDroppedByConfidence,
        edges_dropped_by_call_cap as edgesDroppedByCallCap,
        edges_dropped_by_type_ref_cap as edgesDroppedByTypeRefCap,
        files_pruned as filesPruned,
        edges_pruned as edgesPruned,
        edges_deduplicated as edgesDeduplicated,
        symbols_in_graph as symbolsInGraph,
        edges_in_graph as edgesInGraph,
        extract_phase_ms as extractPhaseMs,
        call_edges_attempted as callEdgesAttempted,
        call_edges_unresolved as callEdgesUnresolved,
        vector_symbols_indexed as vectorSymbolsIndexed,
        health_reasons as healthReasonsJson,
        skip_reason as skipReason
      from index_runs
      where repo_id = ?
      order by finished_at desc, started_at desc, rowid desc
      limit 1
      `
    )
    .get(repoId) as IndexRunSummary | undefined;

  if (!row) return null;

  // Rows written before the MCP-ISSUE-048 columns existed default to 0. Fall back to the legacy
  // alias so an old run still reports an attempted count rather than a bare zero.
  if (!row.callEdgesAttempted && typeof row.unresolvedCallsTotal === "number") {
    row.callEdgesAttempted = row.unresolvedCallsTotal;
  }

  const withJson = row as IndexRunSummary & { healthReasonsJson?: string | null };
  if (withJson.healthReasonsJson) {
    try {
      row.healthReasons = JSON.parse(withJson.healthReasonsJson) as string[];
    } catch {
      row.healthReasons = [];
    }
  }
  delete withJson.healthReasonsJson;

  return row;
}
