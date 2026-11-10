## MCP-ISSUE-123 — the served server crashed 0xC0000409 (worker terminated mid-parse), reported `git_error` for a git timeout, and ran at BelowNormal priority

- **Status:** FIXED 2026-11-09 (f64ef10 crash, ac86067 seed reasons, b9d45ab priority; review follow-ups #1–#4, #7 and re-review A, D the same day; review #5, re-review E, #6, the async stale warning, re-review B and C, the failure backoff, the failed-run stale warning 2026-11-10: 5b1eb4d, 0242d50, cf78e3b, 206ed15, af1e7eb, fbe8151, ce61e93, e060e07, 63ccbef; #6 on Windows: platform limit). Live re-soak of IX-5 / IX-9 open (wec.aria).
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

### Fixed 2026-11-10

- **#5 a parse worker that exits on its own was never replaced (fixed 2026-11-10, 5b1eb4d).** Any exit of a slot's own worker
  (code 0 too) answers its job `error`, then the slot is respawned — at most `MAX_RESPAWNS_PER_WINDOW` (3) times in any
  `RESPAWN_WINDOW_MS` (60 s) per slot. One more exit inside the window marks the slot dead and reports it once (stderr
  `parse_pool_slot_dead`, or `onSlotDead`); the pool runs on its other slots, and with every slot dead it is `degraded` and
  answers each job `error` ("parse pool degraded") at once instead of spawning a thread per job. A worker that emitted
  `error` gets no job before its `exit`. Tests: `extractionWorkerPool.test.ts` (respawn; dies-at-start storm) — red on a755851.
  Review nits 0242d50, cf78e3b: the window expiry (`respawnWindowMs` seam), a degraded pool answering queued jobs, and a
  worker exiting 0 mid-job are tested; the re-review D test's probes back off (0.5–8 s, 40 s cap) because each timed-out
  100 ms probe swapped in another cold worker, which made the test load-sensitive.
- **Re-review E — shutdown could wait 5.5 min (fixed 2026-11-10, 5b1eb4d).** `RefreshWorkerClient.dispose` sends `exit` with
  `shutdown: true`; the refresh worker disposes its parse pool with `SHUTDOWN_RETIRE_GRACE_MS` (20 s, 4× tree-sitter's 5 s
  parse timeout; graces already running are shortened) and exits by `SHUTDOWN_WORKER_EXIT_MS` (25 s) from a timer even if the
  aborted run has not settled (a timer fires between JS turns, so never inside an inline parse); the client terminates only
  after `DEFAULT_DISPOSE_GRACE_MS` (35 s). Shutdown is bounded at 35 s. A parse worker still in its job at 20 s may be
  terminated mid-parse at shutdown only — the process is ending. `abortRun` and every non-shutdown dispose keep the 5 min
  retire grace (A's guarantee). A shutdown that arrives while `abortRun` is still stopping the worker sends it the shutdown
  `exit` too; the worker upgrades its pending exit (shortens the pool's running graces, starts the 25 s timer), so that case
  is bounded at 35 s as well (0242d50). **Accepted at shutdown, by design:** (a) the 25 s `process.exit` can come before the
  aborted run reaches `recordAborted`, so its `index_runs` row stays `running` until the next server start cleans it up;
  (b) the 20 s terminate of a parse worker still in its job can hit the 0xC0000409 path (A) — the process is ending anyway,
  and this happens only at shutdown, never on a normal run. Tests: `extractionWorkerPool.test.ts` (dispose graceMs vs plain
  dispose; red on a755851), `refreshWorker.test.ts`, `refreshWorkerClient.test.ts`.
- **#6 `gitAsync` read any kill as `git_timeout` (fixed 2026-11-10, 206ed15, af1e7eb).** `gitAsync` (gitHelpers.ts) names how
  git ended with no exit code — `classifyGitKill`: execFile's `ERR_CHILD_PROCESS_STDIO_MAXBUFFER` → `max_buffer`; `killed`
  true (execFile killed it at `timeout`) → `timeout`; a signal with `killed` false → `killed` (from outside the server).
  `checkSeedAncestry` reports `git_timeout`, `git_max_buffer` or `git_killed` (new `SeedFallbackReason` members); the reason
  reaches `index_status.fallbackReason` unchanged. Its 4th parameter is an optional git runner. Tests: `seedAncestry.test.ts`
  — a stub git runner ends each call as timeout / max_buffer / killed (no timing); a real overflow at maxBuffer 4 and a real
  timeout (`hash-object --stdin`, 300 ms); node error shapes. Red on a755851 (no `classifyGitKill` export).
- **`buildStaleWarning` is async (fixed 2026-11-10, 206ed15).** HEAD from the git dir's files (`readHeadShaFromFiles`) else
  async `rev-parse`; `rev-list --count` and `status --porcelain=v2` run concurrently through execFile
  (`countCommitsBehindAsync`, `readWorkingTreeStateAsync`). A stale-repo read no longer holds the server thread up to
  2 × 5 s. Output unchanged. The 7 tools that build it await it: find_impact_files, get_change_context, find_field_accesses
  (builds it once; its no-property answer stays synchronous), search_literals, search_regex, get_symbol_source. Test:
  `staleWarning.test.ts` (event-loop turns during the build; exact output for stale / up to date / unknown repo / no run /
  non-git / missing indexed commit); red on a755851 (the build returned a value, not a Promise).

- **Re-review B — a failed run was trusted as a base (fixed 2026-11-10, fbe8151).** A failed run used to record the HEAD it
  started at; `getLatestRun` then made that commit the indexed commit, so a failed run at HEAD could feed the fast skip and
  make the freshness gate read "fresh" — although the pipeline commits each batch before it throws, so a failed run leaves a
  partial graph. Now `buildRunSummary` (runFinalize.ts) records `commitSha = null` for `failed` and `cancelled`, and the
  runner's re-review A rule also covers a failed latest run: the next `incremental` or `dirty` run is escalated to `full`
  (also for a failed row from an older build that did record a commit). Readers still read the LATEST run, not the latest
  successful one, deliberately: after a failed or cancelled run the graph holds that run's partial writes, so an earlier ok
  run's commit does not describe it. With a null commit on the latest run `evaluateIncrementalSkip` answers "no previous
  indexed commit", the freshness gate treats it as HEAD moved and refreshes, and `planGitScopedIncremental` already walks on
  any non-ok run. Tests: `runFinalize.test.ts` (a failed or cancelled run summary carries no commit);
  `indexRunnerAbort.test.ts` (a failed run records no commit and the next incremental at the same HEAD runs full) — red on
  a755851.
- **Re-review C — work after an abort (fixed 2026-11-10, fbe8151).** After an abort the pipeline no longer calls
  `rebuildVectorIndex` (the full run that follows rebuilds the vectors). The runner checks the abort signal before each
  post-phase pass — calls, imports, CSS/SQL/workspace, types, properties, routes, implements, EF, cross-repo, dedup,
  mentions — and at each batch boundary of the batched call and import passes (ce61e93, e060e07 test it); on abort it records
  the run `cancelled` with no commit (`recordAborted`). Tests: `indexRunnerAbort.test.ts` (an abort after the files were
  written skips the vector rebuild; an abort during the resolve passes runs no further pass; an abort at a batch boundary
  inside the call pass ends the pass there; the last is red against a loop without the check).
- **Re-review B follow-up — a post-phase throw recorded no run (fixed 2026-11-10, ce61e93).** `getIndexMeta`, `recordRun`,
  `markRunTreeDirty`, `markRunExcludeRules` and `clearPendingReindexFiles` in `indexRunner.ts` sit outside the per-pass
  try/catch; a throw before the run was recorded left no run, so the previous ok run at HEAD stayed the base over a
  part-resolved graph. runCore's post-phase is now guarded: a run not yet on record is recorded `failed` with no commit
  (scope "failed in the post-phase: <message>"), the session is ended and the error rethrown; the next `incremental` or
  `dirty` run escalates to `full`. A throw after the run is recorded leaves the record as it is (the graph was complete
  when written). Test: `indexRunnerAbort.test.ts` (a throw in the post-phase records the run failed with no commit, and the
  next incremental runs full) — red against fbe8151.
- **Review of fbe8151 / ce61e93 (fixed 2026-11-10, e060e07).**
  - *Failure backoff.* A failed run records no commit, so the freshness gate saw "HEAD moved" on the next query and started
    another full run; a repeating failure would have re-indexed on every query more than 1 s apart. After a gate-started run
    fails (status `failed`, or the run threw) `freshness.ts` starts no further run for that repo until a backoff passes: it
    answers `stale`, says how long it waits and points to `index_repository`. The backoff is `FAILED_REFRESH_BACKOFF_MS`
    (30 s), doubled per consecutive failure, capped at `FAILED_REFRESH_BACKOFF_MAX_MS` (15 min). A finished run from any
    caller clears it; a cancelled run neither counts nor clears; a repair keeps its own `MAX_REPAIR_ATTEMPTS` cap and is not
    subject to it; a throw from the gate's own bookkeeping after a finished run is not a failure. The backoff is per process,
    like the gate's other memory. Test: `freshness.test.ts` (a refresh that fails every time: 20 queries 2 s apart start ≤ 2
    runs; an hour of queries a minute apart starts 2–6; after a manual ok run the next query runs at once) — red against
    ce61e93.
  - *Session end.* `indexRunner.ts` ends the index session exactly once on every path through `endSession` (finished,
    aborted, failed, a throw from `recordRun`, a throw from the pipeline). The pipeline case was a pre-existing leak:
    `beginIndexSession` was never matched. Test: the index session ends on every failing path — red against ce61e93.
  - *MCP-ISSUE-125 test.* "parallel reads share one deadline" asserts the shape, not tight milliseconds (the first answer
    waited the budget; answers come at least one handler apart; a read joining 450 ms late waits less than its own 600 ms
    budget); it stays red against a per-read-deadline mutant.

- **The stale warning after a failed run (fixed 2026-11-10, 63ccbef; found by row 6).** With re-review B a failed or
  cancelled latest run has no commit, so `buildStaleWarning` read "indexed commit unavailable" (`isStale` null) and returned
  NO warning: a read over a partial graph looked clean. It now returns the warning for such a run (in a git repo) with
  `lastIndexedCommit` and `commitsBehind` null and three optional fields: `latestRun` {`runId`, `status`, `mode`,
  `triggeredBy`?, `finishedAt`, `summary` — the run's scope and error, cut to 300 chars}, `graphMayBePartial: true` and
  `action` (run `index_repository`; after a failed automatic refresh the gate backs off). The backoff's wait is not repeated
  here: it is per process, inside the freshness gate, and the same response's `freshness.reason` already says how long.
  Every other case keeps its shape; the tool contracts are unchanged (descriptions only name `staleWarning`). Test:
  `staleWarning.test.ts` (failed, cancelled, a 2 000-char error cut) — red on 69ae7e7 (no warning).
- **#6 Windows residual: an outside kill cannot be told from git's own exit 1 (platform limit, measured 2026-11-10).** Probe
  (git 2.50.1.windows.1, node 22, Windows 11): `execFile("git", ["cat-file", "--batch"])` killed from outside after 1.5 s,
  against git's own exits. `taskkill /F`, `taskkill /F /T` and `process.kill(pid)` from another node process all end as
  `code 1, signal null, killed false`, empty stderr — and `exit` and `close` both report `(1, null)` — exactly what
  `merge-base --is-ancestor` answers for "not an ancestor". No field differs, so `classifyGitKill` cannot name them:
  each reads as that call's own exit 1 — `child_head_unresolved` (rev-parse), `parent_sha_missing` (cat-file -e),
  "not an ancestor" then the merge-base split (is-ancestor), `unrelated_history` (merge-base). `Stop-Process -Force` (.NET
  `Process.Kill`) ends as `code 4294967295` (TerminateProcess with -1) and only reaches `git_error`; it is the one
  distinguishable killer, and classifying it would rest on git never exiting 0xFFFFFFFF itself — not done. A kill by the
  server (timeout, maxBuffer) is still named on Windows, as before. Probe and output:
  `~/.claude/handover/briefs/2026-11-10-mcp-local-stale-failed-probe.mjs`, `…-winkill-probe.log`.
- **An awaited `dispose` held no handle (fixed 2026-11-10, a7a7e98; harness 1f820f1; found by CI 69ae7e7).** Row 7's unref of
  the `stopWorker` fallback timer (0242d50) left `await dispose()` holding nothing, since the worker itself is unref'd. A
  caller without its own ref'd handle exited 13 (test:freshness-worker (c) on CI). The timer is now ref'd for `dispose`
  (bounded by `DEFAULT_DISPOSE_GRACE_MS`) and stays unref'd for `abortRun`. Test: `refreshWorkerClient.test.ts` "row 15"
  (a child process), red on 1f820f1.

### Left open

- One 12.8 s stall at 10:34:30, after the respawn and outside the reported load window, is unexplained — watch only (owner,
  10 Nov: "tạm thời theo dõi thôi").

### Enhancement proposal

- Measure a parse job's timeout in CPU time, not wall time, so starvation is not mistaken for a hang.
- A test that a refresh worker's `exit` request lands while a pool parse is in flight, against the compiled worker.
