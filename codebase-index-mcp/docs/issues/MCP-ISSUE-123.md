## MCP-ISSUE-123 — the served server crashed 0xC0000409 (worker terminated mid-parse), reported `git_error` for a git timeout, and ran at BelowNormal priority

- **Status:** FIXED 2026-11-09 (f64ef10 crash, ac86067 seed reasons, b9d45ab priority). Live re-soak of IX-5 / IX-9 open (wec.aria).
- **Scenario:** wec.aria's acceptance of deploy 67e6ce37f7d7 on 9 Nov 10:15–10:32 (UTC+7) — a watcher on
  `wec.aria-wt-spec098`, reads, then `register_worktree(D:/1.SourceCode/crm/wec.aria-wt-s098eval, parent wec.aria)` — while
  another member ran 16 `node -e "for(;;){}"` burners + 8 git loopers at Normal priority on 16 logical cores (10:23:25–10:32:32).
- **Tool/query attempted:** `search_regex idempotency_key` (files, limit 10) on wec.aria-wt-spec098; `register_worktree`;
  `index_status`; the live log `~/.claude/mcp/http/codebase-index.log`.
- **Impact:** a read held 295 s; 9 event-loop stalls of 10–40 s; `register_worktree` 39.9 s with fallbackReason `git_error`;
  then the process exited 0xC0000409 mid full run (supervisor respawned it, the run was lost, no log line, no WER report).
- **Workaround used:** none on the live server; each item was replayed on a scratch stdio server over a copy of the live DB.
- **Diagnosis evidence:** `~/.claude/handover/briefs/2026-11-09-mcp-local-ix-regress-evidence.md`; fix evidence
  `~/.claude/handover/briefs/2026-11-09-mcp-local-ix-fix-evidence.md`.

### A — the crash: `worker.terminate()` during a tree-sitter parse (fixed)

- **Expected vs actual:** a parse job past `CODEBASE_INDEX_PARSE_JOB_TIMEOUT_MS` (20 s) is answered `job-timeout` and the run
  goes on. Actual: `ExtractionWorkerPool` terminated the worker; tree-sitter 0.21's native parse does not survive the worker
  being torn down under it, and the WHOLE process exits 0xC0000409 (fast-fail) with nothing on stderr and no WER event.
- **Reproduced solo, no load:** a Worker looping `parser.parse()` on ~250 KB of TypeScript, terminated after 20–220 ms →
  0xC0000409, 5/5. Controls, 40 terminations × 2 runs each, all exit 0: a plain-JS busy worker; tree-sitter loaded and idle;
  one parse done, then idle. Under starvation the live full run did 90 files in 45 s, so a 20 s job timeout is the likely trigger.
- **Fix (f64ef10):** the pool RETIRES a timed-out worker — no more jobs, a `close` message, it exits by itself after the job
  returns (a parse is bounded by tree-sitter's own 5 s timeout); a fresh worker takes the slot; `terminate()` only after a
  5 min grace. `dispose` retires every worker the same way. The refresh worker (which hosts the parse pool and parses small
  refreshes inline) answers an `exit` request by disposing the pool and exiting; `RefreshWorkerClient.abortRun` / `dispose`
  send it and terminate only after 60 s / 10 s.
- **Tests:** `extractionWorkerPool.test.ts` (a child process times out a job mid-parse: red on 67e6ce3 = exit 0xC0000409,
  green after); `refreshWorkerClient.test.ts` (the exit request, never terminating a worker that honours it: red 3/15 on 67e6ce3).

### B — the seed fallback reason (fixed)

- **Expected vs actual:** a git call the server killed at `GIT_TIMEOUT_MS` (5 s) says nothing about ancestry. Actual:
  `gitAsync` mapped any error without a numeric exit code to -1, so the timeout read as `git_error`. Solo the same pair took
  75 ms and answered `parent_not_ancestor` — the worktree's HEAD c82fcb1e is 37 commits BEHIND the parent's indexed b74f768,
  which this design can never seed; `parent_not_ancestor` did not say which way the histories part.
- **Fix (ac86067):** `git_timeout` when execFile killed git; `parent_not_ancestor` is split by the merge base into
  `child_behind_parent` (the merge base is the worktree's base) and `diverged`. `checkSeedAncestry` takes a per-call timeout.
- **Tests:** `seedAncestry.test.ts` (red on 67e6ce3), `indexJobs.seed.test.ts`, `test-register-worktree` (c2).
- **Note for an IX-9 acceptance:** pick a worktree at or after the parent's indexed commit; a worktree behind it falls back
  to a full run by design (`child_behind_parent`).

### C — the served server ran at BelowNormal priority (fixed; the cause of the IX-5 stalls)

- **Expected vs actual:** the shared server keeps answering while sessions build. Actual: `\mcp-local\codebase-index-http`
  started the supervisor at Task Scheduler's default priority 7 = BELOW_NORMAL; the server, its worker threads and its git
  children inherited it (pids 38164 / 30256 / 37732, `BelowNormal`, base 6). With 16 Normal burners on 16 cores Windows ran it
  only through its anti-starvation boost. Every stall falls inside the load window. Solo (watcher on, watchdog at 1 s): the
  same search 0.8–2.7 s, no stall over 1 s; `register_worktree` 75 ms; the full run 61.5 s.
- **Fix (b9d45ab):** `serve-http.mjs` `ensureNormalPriority` raises the supervisor first (a hand-off child inherits it) and
  the server on every start and respawn to Normal, never lowers a higher priority, and logs `supervisor_priority`. The
  scheduled task is unchanged. Owner, 9 Nov: "Nâng lên Normal (Recommended)".
- **Tests:** `serveHttp.test.mjs` — fakes for raise / never-lower / error, and a scratch supervisor started at BelowNormal
  (red on 67e6ce3: supervisor priority 10).

### Left open

- `buildStaleWarning` still runs two synchronous git calls (`rev-list --count`, `status --porcelain=v2`, 5 s timeout each)
  on the server thread for a STALE repo (gitHelpers.ts). Not the cause here (spec098 was fresh); worth moving async.
- One 12.8 s stall at 10:34:30, after the respawn and outside the reported load window, is unexplained.

### Enhancement proposal

- Measure a parse job's timeout in CPU time, not wall time, so starvation is not mistaken for a hang.
- A test that a refresh worker's `exit` request lands while a pool parse is in flight, against the compiled worker.
