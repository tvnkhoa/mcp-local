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

import type { IndexRunSummary } from "../types.js";

export function recordRun(db: Database.Database, summary: IndexRunSummary & { crossRepoLinked?: number; callEdgesResolved?: number; importEdgesResolved?: number; mentionsResolved?: number }): void {
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
        performance_profile
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
      summary.performanceProfile ?? null
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
        unresolved_calls_total as callEdgesAttempted,
        unresolved_calls_total as unresolvedCallsTotal,
        unresolved_imports_capped_by_policy as unresolvedImportsCappedByPolicy,
        resolve_calls_coverage as resolveCallsCoverage,
        performance_profile as performanceProfile
      from index_runs
      where repo_id = ?
      order by finished_at desc, started_at desc, rowid desc
      limit 1
      `
    )
    .get(repoId) as IndexRunSummary | undefined;

  if (row && typeof row.callEdgesAttempted === "number") {
    // ISSUE-025: derive unresolved từ partition attempted − resolved (không có cột riêng).
    const resolved = (row as IndexRunSummary & { callEdgesResolved?: number }).callEdgesResolved ?? 0;
    row.callEdgesUnresolved = Math.max(0, row.callEdgesAttempted - resolved);
  }
  return row ?? null;
}
