## MCP-ISSUE-111 — "database is locked" on index runs and reads while another repo indexes (one writer per DB, bookkeeping off the read path)

- **Status:** ✅ FIXED 2026-11-04 (IX-1, wec.aria request D1/D2). Cause read from the server log (below) and reproduced
  on a scratch DB.

### Server log (`~/.claude/mcp/http/codebase-index.log`, 4 Nov, UTC, served build a5a3702)

```
1485  ↻ index wec.be-wt-ar-xmcp-6-9 · incremental run escalated to full · 3257 dependent files > 600      (02:24, a gate refresh)
1487  ↻ index wec.aria-wt-ops · incremental run escalated to full · .codebase-index/citations.json changed
1489  ✓ index wec.aria-wt-ops · 3283 files · 17411 symbols · 15502 calls · 101.4s
1490  index_repository elapsedMs 148680 (02:27:27)
1493  ✗ index wec.aria-wt-pages · failed · database is locked
1494  02:28:11.730Z tool_threw index_repository code internal_error detail "SqliteError: database is locked"
1495  index_repository elapsedMs 40108, isError, INTERNAL_ERROR
1497  02:29:12 remove_repository: a refresh of 'wec.be-wt-ar-xmcp-6-9' holds its lock
```

The error is better-sqlite3's `SqliteError` "database is locked" (SQLITE_BUSY); the server logs no stack. The failing
`index_repository` of wt-pages ran 40.1 s — past `busy_timeout` (30 s) — while a full run of another repo
(wec.be-wt-ar-xmcp-6-9, a query-triggered refresh escalated to full, still holding its lock at 02:29) was writing: two
writers in one process, which the per-repo queue allowed (cause 1), the later one failing after waiting out the busy
timeout. wt-ops's own run (148.7 s) shows the double pass of MCP-ISSUE-113. The run was on the server thread
(MCP-ISSUE-112), so the 40 s wait also blocked every other call.
- **Scenario:** wec.aria, 4 Nov. `index_repository` of a new worktree failed "database is locked" while another worktree
  was indexing; 1 of 12 read errors in two days was the same message. Every repo shares one SQLite file
  (WAL, `busy_timeout` 30 s) and one HTTP server process serves every session.

### Cause (from the code at ccd3a3d)

1. **Two writers in one process.** `freshnessGate.serialize` queued runs per `repoId` only, so `index_repository` of repo B
   ran while repo A's run (or A's query-triggered refresh in the worker) was writing. Each waited on the other's write lock.
2. **A deferred write transaction fails without waiting.** `GraphStore.runInTransaction` began DEFERRED. A transaction that
   reads before its first write holds a read snapshot; if another connection commits meanwhile, the upgrade to a write
   lock fails at once with `SQLITE_BUSY` ("database is locked") — the busy handler cannot help a stale snapshot.
   Reproduced: `indexLockContention.test.ts` "a deferred read-then-write transaction fails SQLITE_BUSY at once".
3. **The read path wrote.** Every read tool runs the freshness gate, and the gate's bookkeeping — `markRunTreeKey`,
   `markRunTrigger`, `recordPendingReindexFiles` — ran on the server thread's connection. Behind another writer's lock,
   better-sqlite3 waits out `busy_timeout` synchronously: the whole server froze up to 30 s, then the write failed.
4. **Long write holds.** A full run rebuilt `symbols_fts`, `literals_fts`, `comments_fts` and `docs_fts` for EVERY repo in
   the DB in single statements, and ended with a TRUNCATE checkpoint that waits (up to 30 s) for readers while it blocks
   every new writer.

### Fix

- `createFreshnessGate` (`src/middleware/freshness.ts`): `serialize` is one queue per DB, not per repo.
- The gate hands its bookkeeping to the run (`RunBookkeeping`, option `runBookkeeping`); `runWithBookkeeping`
  (`src/services/indexing/indexRunner.ts`) writes it on the run's connection — the refresh worker's — so a read tool makes
  no write on the server thread.
- `GraphStore.runInTransaction` begins IMMEDIATE (`src/repositories/graphStore.ts`).
- FTS kept per file in every mode: a full run forgets/re-indexes each written file's FTS rows (`indexPipeline.ts`), its
  prune forgets before deleting (`runFinalize.ts`), and the watcher's prune does too (`src/index.ts`). The all-repo
  rebuild runs once per DB, on the first full run of this build, then `index_meta.fts_per_file` records it.
- `endIndexSession(truncate)` runs the TRUNCATE checkpoint with no busy handler (`truncateCheckpointNoWait`,
  `writeStore.ts`): it never holds writers while waiting for a reader; `journal_size_limit` bounds the WAL meanwhile.

### Guarded

- `src/middleware/freshness.test.ts` — "serialize never lets runs of two DIFFERENT repos overlap", "with runBookkeeping
  the gate hands its writes to the run and makes none itself".
- `src/services/indexing/indexLockContention.test.ts` — bookkeeping order, the deferred-vs-immediate repro, the no-wait
  checkpoint, and a full run with a deleted file: the repo's FTS rows equal its content rows, another repo's are untouched,
  no all-repo rebuild after the first.
- `scripts/test/test-index-lock-contention.mjs` (`test:index-lock-contention`) — server A runs a full index of a second
  repo while a second server process on the same DB runs another; 24 reads (gate refreshes on a dirty repo) during both:
  0 lock errors, both runs ok, each read within budget + 2 s.

### Limits

- Cross-PROCESS writers (stdio sessions beside the HTTP server) still share the DB; IMMEDIATE + `busy_timeout` make the
  later one wait instead of failing. The in-process queue cannot see another process.
- `index_repository` and the watcher still run on the server thread (max block 2.8 s on the harness fixture); IX-2
  (MCP-ISSUE-112) moves them to the worker.
- An older build sharing the DB still writes full runs without per-file FTS upkeep, and rebuilds every table at its end;
  a crash of such a run between its writes and that rebuild leaves FTS stale until `index_meta.fts_per_file` is deleted.

### Follow-up (2026-11-04, leader review)

- IMMEDIATE now covers every index write transaction, not only `GraphStore.runInTransaction`: the edge resolvers
  (`services/graph/edgeResolver*.ts`) and the write stores (`repositories/{writeStore,scopedRunStore,docsStore,
  literalsStore,annotationsStore,vectorStore,repoPurgeStore,refactorStore,pathSeparatorMigration}.ts`) begin through
  `immediateTransaction` (`repositories/sqliteTx.ts`). The read-path temp-table transaction in
  `services/impact/impactShared.ts` stays deferred: IMMEDIATE would make a read take the write lock. Guarded:
  `indexLockContention.test.ts` "immediateTransaction takes the write lock at BEGIN".
- Open (follow-up 7, not fixed): the `index_meta.fts_per_file` marker assumes every writer keeps FTS per file. A process
  still running an older build writes full runs without that upkeep and rebuilds every FTS table at its end; if such a
  run dies between its writes and that rebuild, FTS stays stale until the marker is deleted (a newer build's next full
  run then rebuilds once).
- `remove_repository` no longer rebuilds every FTS table: on a per-file DB (`index_meta.fts_per_file`) it forgets only the
  removed repo's FTS rows, inside the delete's transaction (`ftsForgetRepo`, `repoPurgeStore.ts`); the all-repo rebuild
  stays only for a DB without the marker. Guarded: `indexLockContention.test.ts` (purging repo b leaves repo a's FTS
  rows exact and none of b's).
- 2026-11-09 (row 12): CI run 42577407542 (windows-latest, Node 22, ae22bf0), the first to include
  `test:index-lock-contention`, failed it with all three runs ok and no lock error; the failing assertion was not in the
  log (fixed: `scripts/lib/failureExcerpt.mjs` now keeps harness `FAIL`/`✗`/`info` lines ahead of the tail). Local solo
  ×3 under the heavy lock: big run 11.0–12.8 s, slowest read ≤ 440 ms (bound 2300), longest server-thread block
  ≤ 435 ms (bound 1000); CI's big run took 22.8 s (~1.9× slower), putting the block at ~830 ms. Read as runner timing,
  not a lock defect: on CI (`CI` set) both timing bounds × 2.5 (`CI_FACTOR` in the harness); local bounds unchanged.
  Unproven until the next CI run names the assertion.
