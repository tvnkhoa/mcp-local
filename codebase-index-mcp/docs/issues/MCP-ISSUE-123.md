## MCP-ISSUE-123 — the served server crashed 0xC0000409 (worker terminated mid-parse), reported `git_error` for a git timeout, and ran at BelowNormal priority

- **Status:** FIXED 2026-11-09 (f64ef10 crash, ac86067 seed reasons, b9d45ab priority; review follow-ups #1–#4, #7 and re-review A, D the same day). Live re-soak of IX-5 / IX-9 open (wec.aria).
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

### Review follow-ups (fixed before merge, 2026-11-09)

- **#1 an `exit` no longer stopped the run in flight.** With the pool disposed every parse answered job-timeout, and the run
  went on committing batches and could be recorded `ok` at HEAD — the fast skip and the freshness gate then trusted a
  mostly-missing index. Now `RunExtras.abortSignal`: the refresh worker's `exit` aborts the run, the pipeline stops at its
  next batch boundary, and `indexRunner` records the run `cancelled` with **no commit** (before the resolve passes, and again
  before the final record); `exit` waits for that run to settle. Tests: `indexRunnerAbort.test.ts` (abort before start and
  mid-extraction; the next incremental indexes every file and records the commit), `refreshWorker.test.ts`.
- **#2 the client's fallback terminate came before the pool's retire grace** (10 s / 60 s against 5 min), tearing nested
  parse workers down mid-parse. Both graces are now `DEFAULT_RETIRE_GRACE_MS` + 30 s.
- **#3 a run reaching its shared pool after `exit` built a new one** that nothing disposed. After `exit` no pool is built and
  no request starts (`attachRefreshWorker`, now an exported seam with injectable store / runner / pool / exit).
- **#4 no cap on retired workers.** At most `size` retired workers at once; at the cap a timed-out slot keeps its worker and
  waits for the job's late answer instead of spawning another thread.
- **#7** the hand-off process logs its own `supervisor_priority` line.
- **Re-review A — an aborted run's partial batches were never recovered.** The old terminate left a run marker and so a
  repair; the aborted run (written files, no resolve, dependents not queued) left the next scoped run seeing matching
  hashes and resolving only what it re-extracted: unresolved `callee:` / `import:` edges until some full run. Now a
  non-full run whose latest run is `cancelled` with no commit runs full instead (checked before any skip or no-op record).
  Tests: after an aborted first full run, and after an aborted incremental over a new commit, the next incremental leaves
  the same symbols and edges (from|to|type) as a clean full run.
- **Re-review D — a job held at the retire cap never freed its slot** when it never answered: the slot had no timer and
  nothing rescheduled. Now each retired worker's exit retires the held slots the cap has room for, gives them a fresh
  worker and schedules the queue.

### Left open

- (review #5, pre-existing) a parse worker that exits on its own (`onWorkerFailure`) is not replaced; its slot stays dead
  for the rest of the pool's life.
- (review #6) `gitAsync` reads any kill without an exit code as `git_timeout` — a `maxBuffer` overflow or an external kill
  is reported the same way.
- (re-review B, pre-existing) a FAILED run is recorded with HEAD's commit (indexPipeline.ts catch path), and `getLatestRun`,
  `evaluateIncrementalSkip` (runPolicy.ts) and the freshness gate's indexed commit ignore the run's status — a failed run
  at HEAD can be trusted as a base. Only `cancelled` runs carry no commit (this issue).
- (re-review C) after an abort the pipeline still runs `rebuildVectorIndex` and, for an abort during the post-phase, the
  resolve passes that already started; the run is still recorded cancelled with no commit and the next run goes full.
- (re-review E) server shutdown can now wait up to `DEFAULT_DISPOSE_GRACE_MS` (retire grace 5 min + 30 s) for the refresh
  worker when a parse worker never leaves its job; normally the worker exits within one batch.

- `buildStaleWarning` still runs two synchronous git calls (`rev-list --count`, `status --porcelain=v2`, 5 s timeout each)
  on the server thread for a STALE repo (gitHelpers.ts). Not the cause here (spec098 was fresh); worth moving async.
- One 12.8 s stall at 10:34:30, after the respawn and outside the reported load window, is unexplained.

### Enhancement proposal

- Measure a parse job's timeout in CPU time, not wall time, so starvation is not mistaken for a hang.
- A test that a refresh worker's `exit` request lands while a pool parse is in flight, against the compiled worker.
