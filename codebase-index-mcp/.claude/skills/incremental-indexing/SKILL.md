---
name: incremental-indexing
description: "Change how codebase-index-mcp decides what to re-index, and prove the change kept full and incremental results equal: index_repository modes (full | incremental | dirty), the fast-skip gate, per-file content hashing, per-file symbol/edge replacement, pruning, and the full-vs-incremental conformance procedure (same symbols, same edges by type, no dangling or orphaned edges, ready/blocked verdict). Use when editing runPolicy.ts, indexPipeline.ts, runFinalize.ts, indexRunner.ts, writeStore.ts, symbol-id minting, a resolver or the watcher, when bumping INDEX_VERSION, and before merging any such change."
---

# Incremental Indexing

## The three modes, as built

| `mode` | Files considered | Pruning | Notes |
|---|---|---|---|
| `full` | every file the scan sees | yes, if the scan was not capped by `maxFiles` | also clears and rebuilds this repo's outbound `cross_repo_deps` |
| `incremental` | every file; unchanged hashes are skipped | yes, if the scan was not capped | fast-skips the whole run when the gate below passes |
| `dirty` | only working-tree-changed files, plus files the refactor engine wrote (`pendingReindex`) | **no** (subset scan) | cheapest refresh. Use `full` after a branch switch |

## The decision path

1. **Run-level fast skip**, `evaluateIncrementalSkip` (`services/indexing/runPolicy.ts`). Skips only
   when the last run's `commit_sha` equals HEAD, its `index_version` equals `INDEX_VERSION`
   (`indexPipeline.ts`), **and** `git` reports a clean tree. A skipped run still writes a zero-work
   summary with `skip_reason`.
   - **Bump `INDEX_VERSION`** whenever extraction output changes for files that did not change
     (a new lane, a new edge type, a new symbol kind). If you skip the bump, existing indexes
     fast-skip forever and never get the new data (see the ISSUE-023 comment in
     `evaluateIncrementalSkip`). The gate also depends on
     `index_version` being persisted: until MCP-ISSUE-050 fixed that, the skip could never fire.
2. **Per-file skip** (`indexPipeline.ts`, `mode === "incremental"`). The content is passed through
   `redactSensitive`, hashed with sha256 (`hashOf`) and compared with `files.content_hash`. An equal
   hash counts the file as `filesSkipped`. A size-mtime "quick check" runs before the read.
   **Read it before relying on it:** it does a `startsWith` against a sha256 hex digest.
3. **Per-file replace** (`repositories/writeStore.ts`). `replaceSymbolsForFile` deletes the edges
   **emitted from** the file and its symbols, then inserts the new ones. Edges in *other* files that
   point *into* this file are not touched.
4. **Prune** (`pruneAndResolve`, `runFinalize.ts`). This runs `pruneStaleFiles` + `pruneOrphanedEdges`
   only when the scan was complete (not `dirty`, not capped). `pruneOrphanedEdges` checks `from_id`
   only.
5. **Post-phase resolve** (`indexRunner.ts`): route handlers, then IMPLEMENTS / EXTENDS /
   base-class dispatch / PUBLISHES-CONSUMES (depending on profile, via `resolvePostPhasePolicy`),
   then cross-repo, then `deduplicateResolvedEdges`, then mentions. Every resolver is non-fatal.

## Where incremental can drift from full

Check these first when the two disagree:

- **Inbound edges into a re-indexed file.** A symbol id includes its `row` (`makeSymbolId`), so an
  edit that shifts declarations re-mints their ids. A resolved edge from an *unchanged* file still
  holds the old `to_id`. Neither step 3 nor step 4 removes it. Measure it with query I2 in
  *Verification: full vs incremental* below.
- **Capped scans.** If the repo has more files than `maxFiles`, pruning and full-mode IMPLEMENTS
  resolution are skipped, and an `[index-prune-skipped]` line is logged.
- **Cross-repo links** are rebuilt on `full` runs only.

## Verify a change

```bash
cd codebase-index-mcp && npm run build
npm run test:unit                     # runPolicy.test.ts, runFinalize.test.ts, runStore.test.ts
npm run verify:enhancements           # live stdio run over this repo, includes mode:"dirty"
npm run smoke
```

There is no wired harness that compares full with incremental. Run the procedure below before you
merge.

## Verification: full vs incremental

Prove that an incremental or dirty run leaves the graph equal to a full run on the same revision.
This is a measurement with a ready/blocked verdict; the whole release gate is
`index-release-checklist`.

**No wired harness does this.** `scripts/test/` has none, and `test-orphan-edges.mjs` is unwired and
points at a hard-coded external path. So the procedure runs through MCP tools against a live index.
Use `repoId: "codebase-index-mcp"` and the exact `repoPath` from `list_repositories`.

Index runs have been reproducible since MCP-ISSUE-032 closed, so two full runs on the same build
must match exactly. A delta is therefore signal, not noise. If two full runs disagree with each
other, stop: that is a regression of 032, not a conformance finding.

### Snapshot queries (`query_graph`, `profile: "compact"`)

Every query must contain `:repoId`.

| # | What | SQL |
|---|---|---|
| S1 | symbols by kind | `select kind, count(*) n from symbols where repo_id = :repoId group by kind order by kind` |
| S2 | edges by type | `select type, count(*) n from edges where repo_id = :repoId group by type order by type` |
| S3 | unresolved by type | `select type, count(*) n from edges where repo_id = :repoId and (to_id like 'callee:%' or to_id like 'import:%' or to_id like 'type:%' or to_id like 'property:%' or to_id like 'iface:%') group by type` |
| I1 | orphaned `from_id` | `select count(*) n from edges where repo_id = :repoId and from_id not like 'callee:%' and from_id not in (select symbol_id from symbols where repo_id = :repoId)` |
| I2 | dangling `to_id` | `select type, count(*) n from edges where repo_id = :repoId and to_id not like '%:%' and to_id not in (select symbol_id from symbols where repo_id = :repoId) group by type` |
| R | run record | `select mode, status, index_version, commit_sha, files_indexed, files_skipped, files_pruned, edges_pruned, symbols_in_graph, edges_in_graph, skip_reason from index_runs where repo_id = :repoId order by finished_at desc` (`limit: 3`) |

I1 and I2 must both be 0 after **every** run. I2 matters most: `pruneOrphanedEdges` checks `from_id`
only, and a symbol id includes its row. A line shift in a re-indexed file can therefore leave
inbound edges from unchanged files pointing at an id that no longer exists.

### Procedure

1. `health_check(repoId: "codebase-index-mcp")` → `list_repositories`.
2. **Baseline A.** Run `index_repository(repoId: "codebase-index-mcp", repoPath: "<exact>", mode: "full", docsMode: "on")`,
   then S1 to I2 and R.
3. **No-op incremental.** Run `index_repository(mode: "incremental", ...)` on a clean tree. R must
   show a skip with a `skip_reason`. If it re-indexes, the fast-skip gate is broken.
4. **Controlled edit.** Insert three blank lines above the first declaration of a file that other
   files call, so the edit shifts rows without changing semantics. Pick the file with
   `find_impact_files(repoId: "codebase-index-mcp", filePath: "<file>", view: "files")`. Run
   `index_repository(mode: "incremental", ...)`, then take **B** = S1 to I2.
   Repeat with `mode: "dirty"` → **B′**.
5. **Reference C.** Run `index_repository(mode: "full", ...)` on the same edited tree, then S1 to I2.
6. **Compare** B and B′ against C, query by query, and against A for the edges the edit should not
   have touched. Then compare one behaviour query on the edited file's main symbol:
   `get_call_chain(repoId: "codebase-index-mcp", symbolId: "<id from C>", direction: "callers", depth: 2)`
   should return the same callers after B and after C.
7. **Restore.** Revert the edit, run `index_repository(mode: "full", ...)`, and confirm S2 equals A.

Expected asymmetries. These are not defects, but name them in the report:

- `dirty` never prunes.
- `cross_repo_deps` is rebuilt on full runs only.
- A capped scan (more files than `maxFiles`) skips pruning and logs `[index-prune-skipped]`.

### Verdict

- **`ready`**: I1 = I2 = 0 after every run, B = C on S1 to S3, and step 6 callers are identical.
- **`blocked`**: list each mismatching query with its counts (B / B′ / C). Name the likely mechanism
  from *Where incremental can drift from full* above.

If the run uses baseline fallback, log it in `docs/mcp-codebase-index-issue-registry.md`, as
`.claude/rules/mcp-hard-mode.md` requires.

## Authoritative reference

`services/indexing/` source (`runFinalize.ts`, `writeStore.ts` for the conformance mechanics), and
in `codebase-index-mcp/docs/mcp-codebase-index-issue-registry.md`: MCP-ISSUE-032 (reproducibility),
MCP-ISSUE-042 (`pendingReindex` after a rollback), MCP-ISSUE-048 (run counters vs the database) and
MCP-ISSUE-050 (`index_version`).
