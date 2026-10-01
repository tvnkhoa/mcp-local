---
name: index-metadata-governance
description: "Add, rename or stop writing a field on codebase-index-mcp's index_runs record (run counters, commit_sha, branch, index_version, performance_profile, health_reasons, skip_reason), or change what health_check reports as latestRun. Use when editing repositories/schema.ts (runGraphMigrations), runStore.ts recordRun/getLatestRun, runFinalize.ts buildRunSummary/assessRunHealth, or the IndexRunSummary type. Not for which files get re-indexed (incremental-indexing)."
---

# Index Metadata Governance

A run record that drops a field still reports `status: "ok"`, so missing provenance never fails a
test on its own. MCP-ISSUE-048 found counters the response reported but `index_runs` never stored.
MCP-ISSUE-050 found that `index_version` was never persisted, which meant the incremental fast-skip
could never fire.

## What `index_runs` holds today

Schema: `repositories/schema.ts`. The `create table` covers only the original columns. **Every later
column is added in `runGraphMigrations`** through `ensureRunColumn` (integer), `ensureRunColumnReal`
or `ensureRunColumnText`.

| Group | Columns |
|---|---|
| Identity | `run_id`, `repo_id`, `mode` (`full`/`incremental`/`dirty`), `status` (`ok`/`degraded`/`failed`/`cancelled`), `started_at`, `finished_at`, `elapsed_ms` |
| Provenance | `commit_sha`, `branch`, `index_version` (= `INDEX_VERSION` in `indexPipeline.ts`), `performance_profile` |
| Volume | `files_scanned/indexed/skipped/pruned`, `symbols_upserted`, `edges_upserted`, `docs_upserted`, `mentions_upserted`, `symbols_in_graph`, `edges_in_graph`, `edges_pruned`, `edges_deduplicated`, `vector_symbols_indexed` |
| Failures | `parse_failures`, `parse_timeouts`, `edges_dropped_by_confidence/_call_cap/_type_ref_cap` |
| Resolution | `call_edges_attempted/resolved/unresolved`, `resolve_calls_coverage`, `import_edges_resolved`, `unresolved_calls_total`, cross-repo `cross_repo_*` and `unresolved_no_candidate/ambiguous/boundary_blocked/low_confidence` |
| Timing | `extract_phase_ms`, `resolve_phase_ms`, `build_context_ms`, `call_resolve_ms`, `import_resolve_ms`, `type_resolve_ms`, `property_resolve_ms`, `implements_resolve_ms`, `fts_rebuild_ms` |
| Verdict | `health_reasons` (from `assessRunHealth`), `skip_reason` |

**Gaps, stated plainly:** there is no parser- or grammar-version column and no rule-version column.
`index_version` is the only provenance for extraction output. There is also no "who triggered it"
column (MCP tool, watcher or `setup`). Do not claim those exist in a report.

## Adding or changing a field: checklist

1. Add the field to `IndexRunSummary` / `IndexRunResult` (`src/types/index.ts`).
2. Add `ensureRunColumn*("<snake_name>")` in `runGraphMigrations`. Never only in `create table`:
   existing databases would not get the column.
3. Write it in `recordRun` and alias it back in `getLatestRun` (`repositories/runStore.ts`). Use one
   column per name. An alias that maps one column to two names was part of 048.
4. Shape it once in `buildRunSummary` (`runFinalize.ts`). That function serves both the success
   path and the failure path. If the field has no meaningful value on failure, *omit* it rather than
   writing `0`.
5. Zero-work runs come from `buildSkippedRunSummary` (`runPolicy.ts`). Add the field there too.
6. Add a round-trip assertion to `src/repositories/runStore.test.ts`.
7. If the field changes extraction output, bump `INDEX_VERSION` (see `incremental-indexing`).

## Verify

```bash
cd codebase-index-mcp
npm run test:unit                 # runStore.test.ts, runFinalize.test.ts, runPolicy.test.ts
npm run build && npm run smoke
```

Then check the field on a live run. Call `health_check(repoId: "codebase-index-mcp")` and read
`latestRun`. Then run
`query_graph(repoId: "codebase-index-mcp", sql: "select * from index_runs where repo_id = :repoId order by finished_at desc", limit: 1)`
and confirm the response value and the stored value agree.

## Authoritative reference

`repositories/schema.ts`, `repositories/runStore.ts`, and MCP-ISSUE-048 / MCP-ISSUE-050 in
`codebase-index-mcp/docs/mcp-codebase-index-issue-registry.md`.
