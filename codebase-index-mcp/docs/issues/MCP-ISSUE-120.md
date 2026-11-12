## MCP-ISSUE-120 — search_regex times out while an incremental re-index of mcp-local runs

- **Status:** FIXED 2026-11-12 (row IX-B, wt/fresh-answer) — a read with a previous index no longer waits for a refresh run, and a prefix-scoped read is judged on its own paths. The client-side "timed out" itself was not reproduced; the waits that fed it are gone.
- Scenario: member lock-fifo, 2026-11-05 ~10:0x, repoId mcp-local (index 5 commits behind, freshness state "refreshing").
- Tool/query: search_regex pattern `importClosure|deployHash|DEPLOY_RECORD|...`, filePathPrefix `scripts/` then `scripts/serve-http.mjs`, profile compact, limit 30-40.
- Expected vs actual: an answer from the previous index (as the two earlier calls did, with freshness.reason "an incremental re-index is still running after the 5000 ms query budget"); actual "The operation timed out." three times in a row. Then the server disconnected (ECONNREFUSED), likely the leader's row-1 deploy restart.
- Impact: one narrow fallback.
- Workaround: one `grep -n` over scripts/serve-http.mjs (exact terms).
- Enhancement: search_regex should keep to the query budget during a refresh, like query_docs did in the same minute.

### Cause (2026-11-12)

Every read tool goes through the R1 freshness gate (`withFreshnessGate` → `ensureFresh`, `src/middleware/freshness.ts`),
a per-repo, whole-tree gate. When HEAD or the working tree had moved, the first read of each new refresh run waited up
to `CODEBASE_INDEX_QUERY_REFRESH_BUDGET_MS` (5000) for the run, however narrow its own question: a one-file
search_regex under `scripts/` waited for a whole-repo check and run. filePathPrefix never reached the gate. On top of
that wait the tool did its own scan, on a server whose writer was busy with the run, so a call could exceed the client's
timeout. wec.aria measured the same gate on 12 Nov: a third of its answers said "refreshing" after paying the wait,
p90 8.6 s. (A refresh run that hangs for hours is MCP-ISSUE-126, row IX-A.)

### Fix (row IX-B)

1. **Answer at once from the previous index.** When the repo has a previous index (`getIndexedCommit` not null, or the
   `hasBase` option), a read never waits for a refresh run: it starts or joins it in the background and answers
   `refreshing`, `waitedMs` ~0. The tree check itself stays bounded by the budget, as before. Only a repo with no
   previous index — never indexed, or whose latest run recorded no commit — and a repair run (the index was left
   part-written, MCP-ISSUE-101 F4) keep the budget wait. A run that settles within one macrotask (`baseGraceMs`,
   default 0) still answers `refreshed`. The failed-run backoff (MCP-ISSUE-123) is unchanged.
2. **Prefix-scoped verdict.** `ensureFresh(repoId, { filePathPrefixes })` judges the paths the query reads: the dirty
   and vanished paths, and past a moved HEAD the `git diff --name-only --no-renames` from the indexed commit (asked only
   for a scoped read, once per commit pair, bounded by the budget). None under the prefixes → `{ state: "fresh",
   scope: "prefix" }`, shown in the payload's `freshness` block. Past a moved HEAD the dirty-run ledger and the covered
   key's files count too. The verdict is narrowed only while no run of the repo writes: a run rewrites more than the
   changed paths (an incremental run re-hashes everything, a dirty run re-extracts the files depending on them) and commits
   in batches before it resolves edges, so during any run — this process's, another's, a full one — and after a failed one
   (its backoff), as well as for a part-written index, a check past its budget or a failed diff, the repo's verdict stands
   (review finding, 12 Nov). A reused non-fresh note never turns into a scoped fresh.
   Wiring the tools' filePathPrefix into the gate (`src/tools/index.ts`) lands after row IX-C.

Evidence: `src/middleware/freshness.test.ts` (IX-B cases), `test:freshness-worker`; timing at the production budget,
20 reads each after a fresh dirty edit on a 1500-file fixture: before (8e65643) p50 1392 ms / p90 1650 ms, all
`refreshed` after waiting for the run — after p50 37 ms / p90 891 ms, all `refreshing`, `waitedMs` 0-1 ms whenever a
run was in flight. The slower half (700-1100 ms) is the bounded tree check (git status plus hashing the dirty files)
that starts each new run; no read waited for a run.
