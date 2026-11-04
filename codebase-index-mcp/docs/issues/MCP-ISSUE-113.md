## MCP-ISSUE-113 — a repoId with no index was indexed twice: the default incremental run escalated to full

- **Status:** ✅ FIXED 2026-11-04 (IX-3(a), wec.aria request D4). Seeding a worktree from its parent's index is
  IX-9, not this fix.
- **Scenario:** every new worktree of wec.aria. `index_repository` (default `mode: "incremental"`) of wt-ops ran 98 s
  and recorded "scope: full (escalated from incremental: .codebase-index/citations.json changed)".
- **Cause:** with no rows for the repoId, the incremental run's plan walks the tree and extracts every file as new. The
  pipeline's dependent search (`queueDependentFiles`, `indexPipeline.ts`) then finds a file matching
  `SCOPE_FORCES_FULL_RUN` (tsconfig, package.json, citations.json) among the "changed" ones and escalates
  (`scopeEscalation` → `escalateToFull`, `indexRunner.ts`): the whole repo is extracted again as a full run, and the
  first pass is thrown away. A `dirty` run of an unindexed repo would have indexed only the dirty files.
- **Fix:** `createIndexRunner` checks `isUnindexed` (no run recorded and no file indexed for the repoId) before
  planning; a non-full run of such a repo runs full at once, scope `full (no index yet for this repoId; <mode>
  requested)`, with the caller's runId — one pass, no escalation line.
- **Measured (scratch clone of mcp-local, 923 files, same machine, consecutive runs):** build 5d81964 (before) 33.5 s
  wall, one recorded full run of 16.6 s after a discarded incremental pass, 1 escalation line; this build 20.3 s wall,
  one full run of 17.3 s, 0 escalation lines. Raw: `briefs/2026-11-04-mcp-local-index-core-ix3-{old,new}.json`.
- **Guarded:** `src/services/indexing/indexRunnerUnindexed.test.ts` — an `incremental` and a `dirty` run of an
  unindexed repoId with tsconfig.json, package.json and citations.json: mode `full`, the scope says why, no
  `escalated`, exactly one `index_runs` row under the given runId; the next incremental run keeps its mode.
