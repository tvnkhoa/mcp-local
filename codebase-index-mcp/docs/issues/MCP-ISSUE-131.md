## MCP-ISSUE-131 — `query_docs` mode `term` blocked the server thread for seconds, and waited out the 5 s budget for usages it could not have; `index_status` paid for both

- **Status:** FIXED 2026-11-13 (row #13, branch `wt/perf-docs`). Owner, 13 Nov: "tìm nguyên nhân và sửa luôn". Leader
  approved fixes (a) and (b); (c) is an enhancement, not done.
- **Scenario:** wec.aria measured on the live server (12 Nov): `index_status` took 0.9-3.0 s per call, and `query_docs`
  mode `term` took 5-9 s on a fresh index. Target: index_status < 200 ms, term < 1 s.
- **Tool/query attempted:** `index_status` (with and without `runId`); `query_docs{mode:"term"}` with and without `query`.
- **Measured** on a scratch stdio server over an online backup of the live DB (1.3 GB, 14 repos), with
  `CODEBASE_INDEX_QUERY_REFRESH_ENABLED=false`. The live server was not touched.
  - `index_status` itself: 1-4 ms. Live telemetry agrees: p50 1 / p90 2 ms (n=61).
  - Telemetry starts the clock only after the event loop picks the call up, so queueing never shows in it.
- **Expected vs actual:**
  - **Cause 1, a synchronous scan on the server thread.**
    - `scanSchemaKeys` (impactHandler.ts) runs `statSync` + `readFileSync` on every non-test TS/JS file of the repo.
      On wec.aria that is 1 656 files, of which 130 import zod.
    - On this machine an open costs ~3 ms whatever the file size (on-access scanning). `open + read 8 KB` of all 1 656
      files took 4.8-5.3 s; a stat alone took 45 ms.
    - A cold term call therefore took 3.1-3.3 s on a settled server, and 6.1-10.3 s right after start-up. It ran on
      the event loop, so every other call of every session waited behind it. `index_status` sent during it answered in
      3 043-10 307 ms; idle it answered in 2 ms.
    - The per-file cache was in memory, keyed by absolute path and cleared in one go at 10 000 entries. Every server
      restart and every worktree started cold.
  - **Cause 2, waiting for usages that cannot arrive.** A term call with `query` asks the TS LanguageService lane
    (`termUsages` → `exactFieldAnswer`) and waits up to the R1 query budget (5 s).
    - The cold program build for wec.aria takes ~60 s.
    - Its first answer was a `cap_breach` on the 60 s cold budget, the next call ~25 s later, and only then did a warm
      answer come back (0.7-0.8 s).
    - Throughout the build every term call waited the full 5 s only to return `usages.status: "building"`: 5 004-5 046
      ms, 20 calls in a row.
- **Impact:**
  - On the live server (HTTP, every session on one event loop), a term call stalled every tool call for 3-10 s.
  - Each term call during a type-program build cost 5 s and returned no usages.
  - `index_status`, the call agents poll in a loop, inherited both delays.
- **Fix:**
  - (a) `services/docs/termScan.ts` `SchemaKeyScanner`:
    - Async `stat`/`readFile`, at most 16 files at a time. The event loop stays free, and the opens overlap: measured
      1 → 7.4 s, 8 → 1.9 s, 32 → 1.7 s.
    - Per-file keys are cached by mtime+size in an LRU of 50 000 files, shared by every repo. The cache key is the
      absolute path plus the repo-relative one, because the keys carry the relative path and nested registered repos
      (`mcp-local` holds `codebase-index-mcp`) spell one file two ways. Review finding; the old cache had the same bug.
    - Concurrent scans of one repo with the same file list (hashed) share one pass.
    - The handler keeps the path guard (`assertSafeRepoFilePath`) and the test-path filter.
  - (b) `fieldWorkerClient.ts` `isWarm(repoId, repoPath)`:
    - A program counts as warm once the worker has answered a request for it with anything other than a breach, and no
      request posted after that one dropped it. The worker takes requests in posting order.
    - It mirrors the worker's 2-host LRU (`WORKER_CACHED_HOSTS` = `MAX_CACHED_HOSTS`, asserted by a test), keyed by
      repoId as the worker's is. A request at another repoPath drops the program; posting a third repo evicts the
      oldest. The mirror is forgotten when the worker is lost.
    - A false "warm" costs only the old 5 s wait; a false "cold" costs only a `building` answer.
    - `exactFieldAnswer(…, { coldWaitMs })` caps the wait when the program is not warm. Term passes
      `TERM_USAGES_COLD_WAIT_MS` = 500 ms, so a small repo still answers in time.
    - `find_field_accesses` is unchanged: it still waits up to the full budget.
    - A withheld `building` block now carries `next`: re-query the same term later for the full usages, or call
      `find_field_accesses`, which waits up to the budget (`withheldTermUsages`).
- **Before → after**, same DB copy, same probes. Raw outputs:
  `~/.claude/handover/briefs/2026-11-13-mcp-local-perf-docs-{before,after}-*.txt`.
  - `index_status` sent during a cold term call, settled server: 3 043 / 3 262 ms → 14 / 29 ms.
  - The same right after start-up: 10 307 / 6 096 ms → 10 / 20 ms.
  - `index_status` idle: 1-6 ms → 1-2 ms. p50 / p90 over n=6: 3 / 13 → 4 / 22 ms (noise).
  - Term reverse report, cold, settled: 3 084 / 3 295 ms → 1 806 / 1 605 ms. Warm: p50 144 → 82 ms.
  - Term with `query` while the program builds: 5 004-5 046 ms → 561-622 ms (p50 607, p90 3 065 incl. the cold first).
- **Not met:** the first term call after a restart, or for a new worktree, is still 1.6-1.8 s on a settled server and
  ~3 s while the server is still starting. Every TS/JS file must still be opened once per process (see enhancement (c)).
- **Enhancement proposal (c), not approved today:**
  - Persist the per-file key cache per repo in the freshness state directory (a JSON next to the run markers, no DB
    schema change). A restart would then cost the stats alone (~50 ms for 1 656 files).
  - Alternatives: schema keys stored at index time (a migration and a full re-index), or reading only the files whose
    indexed content hash changed.
- **Evidence:** unit tests `src/services/docs/termScan.test.ts` (9) and `fieldWorkerClient.test.ts` (+5); probes in
  `~/.claude/handover/briefs/2026-11-13-mcp-local-perf-docs-probes/`; evidence file
  `~/.claude/handover/briefs/2026-11-13-mcp-local-perf-docs-evidence.md`.
