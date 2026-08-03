/**
 * SQLite schema for the code graph: table/index creation and the forward migrations that
 * bring an existing database up to the current shape (S-30).
 *
 * Lifted verbatim out of `GraphStore`, where the two methods were 460 of the class's 1,928
 * lines while touching nothing but `db`. They run once, from the constructor, in the
 * order below — `initGraphSchema` first to create anything missing, then
 * `runGraphMigrations` to reshape what an older build left behind.
 *
 * Both are idempotent: every statement is `if not exists`, or guarded by a `pragma
 * table_info` check. That is load-bearing — they run on every process start, against
 * databases written by any prior version.
 */

import type Database from "better-sqlite3";

import { indexLog } from "../services/indexing/indexProgress.js";
import { ensureVectorSchema } from "./vectorStore.js";

/** Create every table, index and FTS view the graph needs, if absent. */
export function initGraphSchema(db: Database.Database): void {
    db.exec(`
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
        end_line integer,
        signature text,
        parent_symbol_id text,
        primary key (repo_id, symbol_id)
      );

      create table if not exists edges (
        repo_id text not null,
        from_id text not null,
        to_id text not null,
        type text not null,
        confidence real not null default 1.0,
        reason text,
        assigned_expression text
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
        unresolved_low_confidence integer not null default 0,
        branch text
      );

      create index if not exists idx_edges_repo_from on edges(repo_id, from_id);
      create index if not exists idx_edges_repo_to on edges(repo_id, to_id);
      create index if not exists idx_edges_repo_type_to on edges(repo_id, type, to_id);
      create index if not exists idx_edges_repo_from_to on edges(repo_id, from_id, to_id);
      create index if not exists idx_edges_repo_type_to_from on edges(repo_id, type, to_id, from_id);
      create index if not exists idx_symbols_repo_file on symbols(repo_id, file_path);
      create index if not exists idx_symbols_repo_kind on symbols(repo_id, kind);
      create index if not exists idx_symbols_repo_kind_name on symbols(repo_id, kind, name);
      create index if not exists idx_runs_repo_started on index_runs(repo_id, started_at desc);
      create index if not exists idx_runs_repo_finished on index_runs(repo_id, finished_at desc);
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

      create table if not exists string_literals (
        repo_id text not null,
        literal_id text not null,
        file_path text not null,
        line integer not null,
        value text not null,
        enclosing_symbol_id text,
        language text,
        kind text not null,
        primary key (repo_id, literal_id)
      );

      create index if not exists idx_literals_repo_file on string_literals(repo_id, file_path);

      create virtual table if not exists literals_fts using fts5(
        value,
        literal_id unindexed,
        repo_id unindexed,
        content='string_literals',
        content_rowid='rowid'
      );

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

/**
 * Bring an existing database up to the current schema.
 *
 * @param vectorEnabled whether sqlite-vec loaded, which decides if the real vector table is
 *   created alongside the always-present `vec_symbol_map`.
 */
export function runGraphMigrations(db: Database.Database, vectorEnabled: boolean): void {
    // Add signature column to symbols if missing (backward-compatible with existing DBs)
    const symbolsCols = db.prepare("pragma table_info(symbols)").all() as { name: string }[];
    if (!symbolsCols.some((c) => c.name === "signature")) {
      db.exec("alter table symbols add column signature text");
    }
    // Add parent_symbol_id column to symbols if missing (ISSUE-004: qualified property edge resolution)
    if (!symbolsCols.some((c) => c.name === "parent_symbol_id")) {
      db.exec("alter table symbols add column parent_symbol_id text");
    }
    // Add end_line column to symbols if missing (MCP-ISSUE-012: source-span retrieval via get_symbol_source)
    if (!symbolsCols.some((c) => c.name === "end_line")) {
      db.exec("alter table symbols add column end_line integer");
    }

    // Refresh symbols_fts if it doesn't have the signature column yet
    try {
      db.prepare("select signature from symbols_fts limit 0").all();
    } catch {
      db.exec(`
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
    // `runCols` is a mutable snapshot: each helper pushes the column it adds so a
    // duplicate ensureRunColumn(name) call (e.g. build_context_ms below) is a no-op
    // instead of re-issuing ALTER and failing with "duplicate column name" on a fresh DB.
    const runCols = db.prepare("pragma table_info(index_runs)").all() as { name: string }[];
    const ensureRunColumn = (name: string) => {
      if (!runCols.some((c) => c.name === name)) {
        db.exec(`alter table index_runs add column ${name} integer not null default 0`);
        runCols.push({ name });
      }
    };
    const ensureRunColumnReal = (name: string) => {
      if (!runCols.some((c) => c.name === name)) {
        db.exec(`alter table index_runs add column ${name} real not null default 0`);
        runCols.push({ name });
      }
    };
    const ensureRunColumnText = (name: string) => {
      if (!runCols.some((c) => c.name === name)) {
        db.exec(`alter table index_runs add column ${name} text`);
        runCols.push({ name });
      }
    };

    ensureRunColumn("cross_repo_attempts");
    ensureRunColumn("cross_repo_resolved");
    ensureRunColumn("unresolved_no_candidate");
    ensureRunColumn("unresolved_ambiguous");
    ensureRunColumn("unresolved_boundary_blocked");
    ensureRunColumn("unresolved_low_confidence");
    ensureRunColumn("vector_symbols_indexed");
    ensureRunColumn("resolve_phase_ms");
    ensureRunColumn("build_context_ms");
    ensureRunColumn("call_resolve_ms");
    ensureRunColumn("import_resolve_ms");
    ensureRunColumn("type_resolve_ms");
    ensureRunColumn("property_resolve_ms");
    ensureRunColumn("implements_resolve_ms");
    ensureRunColumn("fts_rebuild_ms");
    ensureRunColumn("unresolved_calls_total");
    ensureRunColumn("unresolved_rows_capped_by_policy"); // kept for backward compat with old DBs
    ensureRunColumn("unresolved_imports_capped_by_policy");

    // Dedup guard: remove duplicate (repo_id, from_id, to_id, type) rows.
    // NOTE: We intentionally do NOT add a UNIQUE INDEX on edges because the resolve phase
    // uses UPDATE SET to_id = ? in-place, which would conflict with a UNIQUE constraint
    // when the target to_id already exists in another row (e.g. same-file resolved edge).
    // Deduplication is handled at application level via dedupeEdges() before DB write.
    // Drop the UNIQUE INDEX if it was previously created (migration rollback).
    const hasUniqueEdgeIdx = (
      db
        .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name='idx_edges_unique'`)
        .get() as { name: string } | undefined
    )?.name;
    if (hasUniqueEdgeIdx) {
      db.exec(`DROP INDEX IF EXISTS idx_edges_unique`);
    }
    ensureRunColumnReal("resolve_calls_coverage");
    ensureRunColumnText("performance_profile");

    // Add commit_sha for staleness detection.
    if (!runCols.some((c) => c.name === "commit_sha")) {
      db.exec(`alter table index_runs add column commit_sha text`);
    }

    // Add branch for branch-aware staleness display.
    ensureRunColumnText("branch");

    // Add index for getLatestRun ORDER BY finished_at on existing DBs.
    const existingIndexes = db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name='idx_runs_repo_finished'`).get();
    if (!existingIndexes) {
      db.exec(`create index if not exists idx_runs_repo_finished on index_runs(repo_id, finished_at desc)`);
    }

    // Migrate vec_symbol_map to new schema if needed (old schema had rowid PK, new has vec_rowid column)
    try {
      const vecMapCols = db.prepare("pragma table_info(vec_symbol_map)").all() as { name: string }[];
      if (vecMapCols.length > 0 && !vecMapCols.some((c) => c.name === "vec_rowid")) {
        // Old schema — drop and recreate with new schema
        indexLog("[vector] migrating vec_symbol_map to new schema...");
        db.exec(`DROP TABLE IF EXISTS vec_symbol_map`);
        try { db.exec(`DROP TABLE IF EXISTS vec_symbols`); } catch { /* ignore */ }
        indexLog("[vector] vec_symbol_map migrated — vector index will be rebuilt on next index run");
      }
    } catch {
      // Ignore if table doesn't exist yet
    }

    const edgeCols = db.prepare("pragma table_info(edges)").all() as { name: string }[];
    const ensureEdgeColumn = (name: string, sqlType: string, defaultExpr?: string) => {
      if (!edgeCols.some((c) => c.name === name)) {
        const suffix = defaultExpr ? ` default ${defaultExpr}` : "";
        db.exec(`alter table edges add column ${name} ${sqlType}${suffix}`);
      }
    };

    ensureEdgeColumn("confidence", "real", "1.0");
    ensureEdgeColumn("reason", "text");
    // ENH-029-B: RHS captured at PROPERTY_WRITE sites (assigned literal/expression). Survives edge
    // resolution because resolvePropertyEdges only rewrites to_id/confidence/reason, never this column.
    ensureEdgeColumn("assigned_expression", "text");

    db.exec(`
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

    db.exec(`
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

    // Vector schema — vec_symbol_map always, vec_symbols only if sqlite-vec loaded
    ensureVectorSchema(db, vectorEnabled);

    // Performance indexes — idempotent, safe to run on existing DBs
    db.exec(`
      create index if not exists idx_edges_repo_type_to on edges(repo_id, type, to_id);
      create index if not exists idx_symbols_repo_kind on symbols(repo_id, kind);
      create index if not exists idx_symbols_repo_kind_name on symbols(repo_id, kind, name);
      create index if not exists idx_edges_repo_from_to on edges(repo_id, from_id, to_id);
      create index if not exists idx_edges_repo_type_to_from on edges(repo_id, type, to_id, from_id);
    `);
}
