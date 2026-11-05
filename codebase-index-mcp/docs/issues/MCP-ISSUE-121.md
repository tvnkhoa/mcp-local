## MCP-ISSUE-121 — the HTTP server's thread stalls: watcher activation, search_regex and a main-thread write block it

- **Status:** OPEN 2026-11-05. Diagnosis by member hang-diag (the 5-minute stall was not reproduced). The fixes land in this row's commits.
- Scenario: the live server at 935f4dd (pid 12768) stopped answering HTTP from ~03:02Z for 5+ minutes. The process
  was alive, listening, and using ~0.2 s CPU per 5 s. The last log line was a watcher run on wec.aria-wt-evalfix
  (49 files, 13.3 s). Earlier the same day, reads took 9–42 s during index runs.
- Tool/query: reads (search_symbols, search_regex, query_docs, index_status, health_check) right after
  watch_repo start / register_worktree, and during index runs.
- Expected vs actual: reads answer within the query budget; actual: 7–24 s right after each watcher activation.
  Several calls returned in the same millisecond (one blocked loop releasing them), then a 5-minute silence.
- Measured blockers on the server thread (scratch server, CPU profile + loop-lag probe):
  1. Watcher activation: chokidar opens one synchronous `fs.watch` per file and per directory
     (chokidar/esm/handler.js:115 via `_handleFile`). A 3.9k-entry tree took 6.7–7.0 s to get ready, with stalls up
     to 1 s. A single recursive `fs.watch` takes 1–2 ms.
  2. search_regex: `statSync` + `readFileSync` of every candidate file (regexSearch.ts `readScannable`), plus
     `glob.sync` under scanAll. On 3.4k files during a full run this was 23 s of 65 s main-thread busy time and
     ~1.15 s per call.
  3. watch_repo start wrote the repositories row on the server thread (`ensureRepository`), so it could wait up to
     busy_timeout (30 s) behind the worker's write lock.
- Impact: every client of the shared HTTP server waits behind a single blocked thread.
- Workaround: restart the served process (leader only).
- Fix (this row, in order):
  (4) a loop watchdog worker that logs `event_loop_stall` with the calls in flight when the server thread has not
      run for `CODEBASE_INDEX_LOOP_WATCHDOG_THRESHOLD_MS` (default 10 s), and `event_loop_stall_ended` when it runs
      again. It is on by default; turn it off with `CODEBASE_INDEX_LOOP_WATCHDOG_ENABLED=false`.
  (2) search_regex reads asynchronously, with bounded concurrency.
  (3) watch_repo start makes no main-thread write.
  (1) win32 watchers use one recursive `fs.watch`; a watcher whose root is deleted stops itself.
- Evidence: `~/.claude/handover/briefs/2026-11-05-mcp-local-hang-diag-evidence.md`,
  `~/.claude/handover/briefs/2026-11-05-mcp-local-hang-fix-evidence.md`.
