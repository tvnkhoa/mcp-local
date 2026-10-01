---
name: index-run-bookkeeping
description: "Bookkeeping for each codebase-index-mcp index run. Run provenance: add, rename or stop writing an index_runs field (run counters, commit_sha, branch, index_version, performance_profile, health_reasons, skip_reason) or what health_check reports as latestRun; use when editing repositories/schema.ts runGraphMigrations, runStore.ts recordRun/getLatestRun, runFinalize.ts buildRunSummary/assessRunHealth or the IndexRunSummary type. Unresolved edges: references it cannot bind (callee:/import:/type:/property:/iface: tokens, the edgeResolver* passes that rewrite them, confidence/reason values, external boundary tagging, the unresolved and edges_dropped_by_* counters, unresolvedRatio in health_check and impact tools); use when editing services/graph/edgeResolver*.ts, an edge cap or MIN_EDGE_CONFIDENCE, getUnresolvedStats or impactShared.ts warnings, or a tool shows nameless rows or synthetic ids. Not for which files get re-indexed (incremental-indexing) or emitting edges (tree-sitter-extraction)."
---

# Index Run Bookkeeping

Two failure modes share one property: **they never fail a test on their own.**

- A run record that drops a field still reports `status: "ok"`, so missing provenance goes
  unnoticed (Part 1).
- An unresolved reference that is dropped, or dressed up as resolved, still produces a plausible
  graph (Part 2).

Both are counted in `index_runs`, so the two parts meet at the run counters.

---

## Part 1 — Run provenance (`index_runs`)

MCP-ISSUE-048 found counters the response reported but `index_runs` never stored.
MCP-ISSUE-050 found that `index_version` was never persisted, which meant the incremental fast-skip
could never fire.

### What `index_runs` holds today

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

### Adding or changing a field: checklist

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

### Verify

```bash
cd codebase-index-mcp
npm run test:unit                 # runStore.test.ts, runFinalize.test.ts, runPolicy.test.ts
npm run build && npm run smoke
```

Then check the field on a live run. Call `health_check(repoId: "codebase-index-mcp")` and read
`latestRun`. Then run
`query_graph(repoId: "codebase-index-mcp", sql: "select * from index_runs where repo_id = :repoId order by finished_at desc", limit: 1)`
and confirm the response value and the stored value agree.

---

## Part 2 — Unresolved-edge policy and counters

**Rule: an unresolved reference is kept and labelled. It is never dropped silently and never
dressed up as resolved.** Each way this broke is on file:

- MCP-ISSUE-038: the `very-large` profile discarded every unresolved TYPE_REF.
- MCP-ISSUE-053: unresolved rows surfaced as nameless rows and synthetic ids that ate the `limit`.
- MCP-ISSUE-052: a wrong same-named edge was reported at `confidence: "high"`.

### The lifecycle, as built

1. **Extraction** emits the target as a token in `to_id`: `callee:<name>`, `import:<spec>`,
   `type:<name>`, `property:<name>`, or `iface:<name>`. `nuget:<pkg>` is used for `DEPENDS_ON`.
2. **Default labels** are set in `runGraphMigrations` (`repositories/schema.ts`):

   | Token | Confidence | Reason |
   |---|---|---|
   | `callee:` | 0.4 | `unresolved callee token` |
   | `import:` | 0.5 | `unresolved import token` |
   | `type:` | 0.45 | `unresolved type token` |
   | `property:` | 0.5 | `unresolved property token` |
3. **Resolution** (`services/graph/`) runs `edgeResolverCalls.ts`, `edgeResolverImports.ts`,
   `edgeResolverRefs.ts` and `edgeResolverContracts.ts` (IMPLEMENTS / EXTENDS / bus). Each rewrites
   `to_id`, `confidence` and `reason` in place. A token that provably points outside the repo is
   kept and tagged `reason = 'external boundary'` with confidence 0.1. It is not deleted. The resolve
   window is bounded by `CODEBASE_INDEX_MAX_UNRESOLVED_RESOLVE_ROWS`. The post-resolve passes can be
   switched off with `CODEBASE_INDEX_POST_RESOLVE_TYPE_REFS_ENABLED` / `_PROPERTY_REFS`.
4. **Cross-repo** resolution runs **last** (`safeCrossRepoResolve`, after MCP-ISSUE-048). Its
   failures are counted in `index_runs.unresolved_no_candidate / _ambiguous / _boundary_blocked /
   _low_confidence`. Those four columns count **cross-repo** reasons only. They are not a per-file or
   per-language breakdown.
5. **Reporting.** `getUnresolvedStats` (`repositories/graphQueries.ts`) feeds
   `health_check.codebaseState`. `impactShared.ts` computes
   `unresolvedRatio = unresolved / (resolved + unresolved)` and warns above 0.05, 0.15 and 0.3.
   Above 0.3, `.claude/rules/mcp-hard-mode.md` allows baseline fallback.

### Checklist for a resolver or cap change

- [ ] Any token you cannot bind keeps its prefix and gets a `reason`. Count it with
      `query_graph(repoId: "codebase-index-mcp", sql: "select type, reason, count(*) n from edges where repo_id = :repoId and confidence < 0.5 group by type, reason")`.
- [ ] Every new cap or drop path increments an `edges_dropped_by_*` (or new) run counter, added
      through the Part 1 checklist above.
- [ ] Read tools filter placeholder rows out of names and counts instead of returning them
      (MCP-ISSUE-053), and a result is never labelled `high` confidence on a token edge.
- [ ] Unknown input returns an honest empty result, not a confident one:
      `npm run test:unknown-input-honesty`.
- [ ] Before/after: S3 (unresolved by type) and I2 (dangling `to_id`) from
      `incremental-indexing` → *Verification: full vs incremental*, on a live index.

### Harnesses

`npm run test:unit` covers `edgeResolverCalls.test.ts`, `edgeResolverShared.test.ts` and
`moduleResolution.test.ts`. The relevant integration harnesses are `test:interface-dispatch`,
`test:base-class-dispatch`, `test:call-chain-interface`, `test:issue-052-qualified-call`,
`test:csharp-type-refs`, `test:csharp-using-bridge`, `test:nuget-bridge`, `test:bus-edges`,
`test:impact-join-parity` and `test:unknown-input-honesty`. Build first.

---

## Authoritative reference

Run provenance: `repositories/schema.ts`, `repositories/runStore.ts`, and MCP-ISSUE-048 /
MCP-ISSUE-050 in `codebase-index-mcp/docs/mcp-codebase-index-issue-registry.md`.

Unresolved edges: `services/graph/edgeResolver*.ts`, and MCP-ISSUE-034/038/045/052/053 in the same
registry.
