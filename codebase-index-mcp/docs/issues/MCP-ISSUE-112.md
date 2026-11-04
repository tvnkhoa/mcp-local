## MCP-ISSUE-112 — index_repository ran inside the tool call on the server thread: past 120 s the call was dropped and its run reported to nobody

- **Status:** ✅ FIXED 2026-11-04 (IX-2, wec.aria request D1). Breaking change to `index_repository`'s default result;
  new tool `index_status`; new env var `CODEBASE_INDEX_MIN_FREE_RAM_MB`.
- **Scenario:** wec.aria, 4 Nov: `index_repository` of a new worktree (~3300 files) failed 3 of 3. The first met
  "database is locked" (MCP-ISSUE-111); the second and third outlived the client's 120 s call ceiling and ended
  "transport dropped mid-call; response lost". The run executed on the server thread, so every other session's calls
  waited behind its synchronous stretches too.

### Fix

- `IndexJobQueue` (`src/services/indexing/indexJobs.ts`): `index_repository` enqueues a job and answers at once with
  `{ runId, state: "queued" | "running", waitingFor?, ahead?, next }` (default `wait: false`). `wait: true` blocks until the
  run ends or 100 s (`MAX_WAIT_MS`) pass, then answers the run summary (`state: "ok"`) or the job as it stands; a waiting
  caller with a progress token still gets `notifications/progress`.
- New tool `index_status(runId)`: `queued` (with `waitingFor`) | `running` (`phase`, `progress`, `total`) | `ok` (the run
  summary) | `failed` (`error`). A run the process no longer holds as a job is answered from `index_runs`
  (`source: "index_runs"`); an unknown runId is an `InvalidParams` error.
- One job runs at a time per server; its run goes through the DB-wide queue (MCP-ISSUE-111) and executes in the refresh
  worker thread (`RefreshWorkerClient`), never on the server thread. The watcher's runs moved there too, so every index
  write of the process is the worker's. The job's `runId` is the run's id in `index_runs` (`RunExtras.runId` →
  `RunIndexInput.runId`), so `health_check` and `index_status` name the same run.
- A job belongs to the server, not to the request: a client that disconnects cancels nothing.
- A job does not START while free RAM (`os.freemem()`) is below `CODEBASE_INDEX_MIN_FREE_RAM_MB` (default 8192, 0 = no
  floor): it stays `queued` with the reason and is re-checked every 5 s. Query-triggered refreshes and the watcher are
  not held back.
- Callers that need a finished summary pass `wait: true`; the harnesses and scripts that index large repos
  (`index-self`, `benchmark-plan-mode`, `scripts/adoption/perf.mjs`) poll `index_status` past the 100 s bound.

### Guarded

- `src/services/indexing/indexJobs.test.ts` — answers at once, one at a time in order, the RAM floor with an injected
  reader (stays queued with the reason, starts when RAM frees), the bounded wait, failed/throwing runs.
- `scripts/test/test-index-jobs.mjs` (`test:index-jobs`) — HTTP server: two repos queued answer in < 2 s; the client that
  queued them disconnects mid-run; a new client's `index_status` sees both `ok`, in order; the runId is the recorded run;
  the server thread never blocked > 250 ms while the jobs ran (measured 0 blocks over 100 ms); `wait: true` answers the
  summary; an unknown runId is an error.
- `scripts/test/test-index-lock-contention.mjs` — server-thread block during another repo's run fell from 2834 ms (IX-1,
  run on the server thread) to the reads' own work (~470 ms for a search on the repo being rewritten).

### Limits

- Jobs live in the server process: a job queued or running when the server restarts is lost (`index_status` then
  answers unknown unless the run was recorded). Re-run `index_repository`.
- Free RAM is `os.freemem()` — on Windows the available physical memory.

