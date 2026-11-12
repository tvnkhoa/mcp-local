## MCP-ISSUE-126 — a gate-triggered refresh run hung 5 h with no runId, no progress and no deadline, and held the DB-wide queue

- **Status:** FIXED 2026-11-12 (IX-A, branch `wt/refresh-deadline`): the deadline, its abort and repair, and index_status
  visibility; with IX-B merged, the durable repair flag and per-run marker bounds. The point inside the run where it stopped is NOT known (see *Proximate cause*); the deadline bounds any of them.
- **Scenario:** wec.aria, 11 Nov 2026, served build 8e656433ab61. A read tool's freshness gate started a `dirty` refresh
  at ~04:09Z (HEAD 2aee1d39, 13 files dirty: the edit that became 52a04a81). It ran ≥ 18,058 s (5.0 h; the gate's note
  reported `elapsedMs 18058367`) while wec.aria's HEAD moved ~70 commits on. It ended only with the server restart at
  02:46Z on 12 Nov.
- **Tool/query attempted:** read tools on wec.aria (their `freshness` note); `index_status` (lists jobs only); the live DB
  (`index_runs`, read from a copy) and `~/.claude/mcp/http/codebase-index.log`.
- **Expected vs actual:** a refresh is bounded, visible and stoppable, and a hung one cannot hold every other run. In fact:
  - the gate called `refreshWorker.run()` with no runId and no `onProgress` (`src/index.ts:182-186`);
  - `CODEBASE_INDEX_RUN_TIMEOUT_MS` bounds only `index_repository` jobs;
  - a run marker counts as live for 6 h (`freshness.ts` `DEFAULT_STALE_RUN_MS`);
  - `index_status` lists only jobs;
  - while the flight was in `inflight` every read answered "refreshing" and never re-checked HEAD (`freshness.ts:881-882`), so
    no new run started;
  - the DB-wide `runChain` (`freshness.ts:781-805`) queued every other repo's refresh behind it.
- **Impact:** 0 `index_runs` rows for ANY repo from 04:08:54Z on 11 Nov to 02:53Z on 12 Nov, against ~165 tool calls in the
  log. Every read of wec.aria paid its query budget and answered from an index ~70 commits old.
- **Workaround used:** a server restart (02:46Z on 12 Nov); the next gate run was the repair: full, 89.2 s, 3617/3609 files
  (`13da25d1`).

### Evidence (read-only: a copy of `mcp-local-index-central.db`, and the live log)

| run | mode | started (Z) | elapsed | scanned/indexed | scope |
|---|---|---|---|---|---|
| 1d6f8c88 | dirty | 11-11 04:07:34 | 2.4 s | 1/1 | 1 changed, 0 dependents |
| 0097caca | dirty | 11-11 04:07:48 | 11.5 s | 152/152 | 1 changed, 151 dependents (parse-pool lane) |
| cab715da | dirty | 11-11 04:08:31 | 3.2 s | 4/4 | 4 changed (inline lane) |
| 16524b35 | dirty | 11-11 04:08:54 | 2.0 s | 1/1 | 1 changed (inline lane) — the last row of any repo until the restart |
| (hung) | dirty | ~11-11 04:09 | ≥ 18,058 s | – | **no row** (a row is written only when a run ends), no log line |
| 13da25d1 | full | 11-12 02:53:02 | 89.2 s | 3617/3609 | the repair after the restart |

The log has no `[index-*]` warning, no parse failure, no `parse_pool_slot_dead` and no worker exit in the gap. The refresh
worker did not die: a worker `error`/`exit` rejects the run, and the gate would then have recorded the refresh failed.

### Proximate cause — not determinable

So the worker stayed busy in synchronous work, or awaited a promise that never settled. Ranked candidates (no fix applied to
any — none is proven, and the deadline bounds each):

1. **Parse-pool lane starvation.** `indexPipeline.ts:642` awaits `Promise.all(largeExtractionJobs)` with no overall bound.
   A job's timer starts only when a slot takes it (`extractionWorkerPool.ts:384`). A slot held at the retire cap frees only
   when a retiring worker exits, and the 5 min `terminate()` fallback never settles if that thread is stuck in native code.
   This needs a dirty set of more than 8 files (with dependents, 0097caca a minute earlier had 152). Against it: no parse
   timeouts were recorded on 11 Nov.
2. **Unbounded inline extraction** (8 files or fewer, `indexPipeline.ts:605`, on the refresh-worker thread). Only
   tree-sitter's native parse is bounded (5 s); the JS walk over a half-written file is not. All 116 committed versions of the
   files changed that day re-parsed with the deployed dist: none hung, the slowest took 1.3 s. The mid-edit versions cannot be
   recovered.
3. **Synchronous SQL in the resolve passes**: unlikely. `busy_timeout` is 30 s and then throws; `resolveInBatches` stops after
   200 iterations.
4. **A hung git child**: unlikely for the run, which only runs `rev-parse` because the gate hands it the dirty paths. The
   gate's own `git status` (git-lfs filter configured) could hang the CHECK; that note would carry no `mode`.

### Fix (IX-A)

- **Deadline.** A new env var, `CODEBASE_INDEX_REFRESH_RUN_DEADLINE_MS` (default 600000 = 10 min, agreed with wec.aria;
  clamped 1 s–6 h), applies to every freshness-gate and watcher refresh run. `RefreshRuns` in `indexJobs.ts` gives each run a
  runId (its `index_runs` id) and progress.
- **Stopping a run past the deadline.** It goes through `RefreshWorkerClient.abortRun` (the MCP-ISSUE-123 plumbing):
  - the `exit` request carries the reason, and the run aborts at its next batch boundary;
  - it records itself `cancelled` with no commit, and its scope reads `aborted (refresh run … stopped at its deadline:
    CODEBASE_INDEX_REFRESH_RUN_DEADLINE_MS=… ms): no commit recorded`;
  - a worker that does not exit within the abort grace is terminated;
  - the run's promise rejects with the reason only after the worker is gone, which frees the DB-wide queue without leaving
    two writers.
- **Repair.** The repo's next run in this process is `full` and records why (`full (refresh run … was stopped at the … ms
  refresh deadline; dirty requested)`). It is full even when the run was terminated and left no row for the runner's own
  "last run was aborted" escalation to read. A full run that lands clears the repair.
- **Full runs and repeated stops.** A FULL refresh (a repair, a repo's first index) gets max(deadline,
  `CODEBASE_INDEX_RUN_TIMEOUT_MS`) — 30 min by default — so the scoped deadline cannot stop a big repo's full run every time.
  After 2 deadline stops in a row, no refresh of that repo starts in this process until a run lands; the refusal names
  `index_repository(mode: "full")`. Without that cap a doomed full run would restart on every watcher batch.
- **Index jobs.** An index job stopped at `CODEBASE_INDEX_RUN_TIMEOUT_MS` also marks the repo's next run full (a terminated
  worker leaves no row there either).
- **Root cause vs symptom.** The root cause is proven: nothing bounded a refresh that the gate started. The point inside the
  run where it hung is NOT proven; parse-pool lane `Promise.all` starvation is the top candidate.

- **Durable repair (with IX-B, MCP-ISSUE-120).** A deadline stop also writes the gate's cross-process repair flag
  (`markRepairNeeded`). The in-memory repair alone was lost to another process or a restart, and a terminated run leaves no
  row while `serialize` removes its marker. The gate reads the flag and runs a full repair, which clears it. The watcher's
  and the jobs' queue entries keep the REQUESTED mode: a mode predicted at enqueue could clear another process's flag
  after a run landed in between.
- **Per-run marker bounds (with IX-B).** Each run writes its own bound into its marker (`staleAfterMs` =
  `runMarkerBounds` in `indexJobs.ts`), and another process judges the marker by that bound, never by its own limits:
  - a scoped refresh: the deadline + the abort grace (5.5 min);
  - a full refresh, and the gate's default (`runStaleAfterMs`, since a gate run may be full): the full-run deadline +
    the grace;
  - an index job: `RUN_TIMEOUT_MS` + the grace, or 6 h when jobs are unbounded.

  A marker with no bound (an older build) is judged at 6 h. `staleRunMs` itself stays at its 6 h default (leader ruling).
- **Scoped freshness (with IX-B).** The server's `ensureFresh` forwards the read's `filePathPrefix` scope. It is forwarded
  only for tools whose answer reads nothing outside the prefix: search_regex, search_symbols, search_literals and
  query_docs. Whole-graph tools — dead_code_scan, detect_circular_dependencies, find_entry_points, route_map,
  impact / trace / call-chain / context-pack — always get the whole-repo verdict, because a new caller outside the prefix
  changes their answer. The scoped `fresh` is rarely reachable (any run of the repo means `changed: null`); this is
  accepted as conservative.
- **index_status.** Every answer carries `refreshRuns` with these fields: runId, repoId, mode, source
  (`freshness_gate` | `watcher`), state (`running` | `stopping`), startedAt, elapsedMs, deadlineMs, deadlineAt,
  phase/progress/total, and stopReason. A refresh run's runId is answered while it runs, then from `index_runs`. The input
  schema did not change.

**Tests:**
- `test:refresh-deadline` drives the real worker client, a real worker thread and the real runner on a scratch DB. The only
  hook is a wrapped runner that hangs while a flag file exists. It covers:
  - a normal run left untouched;
  - a hung run listed and answered by runId;
  - the hung run stopped at the deadline, recorded cancelled with the reason, with the queue free afterwards and the next
    run full;
  - a run that ignores the abort, terminated after the grace, with the next run still full;
  - dirty runs again once the repair lands.
- Unit tests: `indexJobs.test.ts` (RefreshRuns), `refreshWorker.test.ts` and `refreshWorkerClient.test.ts` (the abort reason
  and escalatedBecause).

**Found on the way, not fixed:** an abort that lands BEFORE a run has taken its parse pool makes the run throw ("the refresh
worker is exiting: no new parse pool") instead of recording `cancelled`. There is then no row; the repair above still forces
the next run full.

**Enhancement proposal:** bound the pool lane's `Promise.all` (candidate 1) and the inline walk (candidate 2) inside the run,
so a hang ends at the batch level instead of at the 10 min deadline.

### Live follow-up (IX-A(2), 12 Nov)

**Live miss:** on the deployed server (e8f36ad, HTTP-served), wec.aria saw index_status list a gate refresh run without
`phase`, `progress` or `total`, and found refreshRuns reachable only through a valid runId. An earlier report that the run
was not listed at all was withdrawn: the calls had overlapped, and at 15:19 the run was listed.
**Cause:** the gate path was wired, worker progress included. But `createIndexProgress` (indexProgress.ts) dropped every
notification while `totalFiles` was 0. That covers the whole `scanning` phase and every phase of a scoped run with
nothing to index, which is the typical gate run. A refresh entry also had no phase of its own until the first message.
Separately, index_status required `runId` and threw on an unknown one.
**Fix (5c2cbbb):** a phase change with no file total yet is sent as a bare tick: progress +1 and no total. A refresh entry
starts at phase `starting`. index_status takes an optional `runId`; without one it answers `{ jobs, refreshRuns }`.
`test:refresh-deadline` (f)/(g) hold the real worker thread, using Atomics.wait, before the run and after the runner's first
real progress message. They read `starting`, then `scanning`, and check the no-runId listing and the unknown-runId error:
6 FAIL before the fix, 0 after.
