## MCP-ISSUE-134 — every read tool call did blocking file I/O on the server thread (HEAD files, run markers, dirty ledger)

- **Status:** FIXED 2026-11-16 (row #12, branch `wt/ci-block`). This is a different mechanism from MCP-ISSUE-132: SQL work
  there, file I/O here. The leader approved the scope (session e242b81b).
- **Scenario:** CI ad5ddd0 run 43817444070 (16 Nov, after the MCP-ISSUE-132 fix): `test:index-lock-contention` (b)
  failed. Server A's main thread blocked for 2620 ms against a bound of 2127 ms. The block was mid-run, about 8.7 s into a 17.2 s
  window (the read durations plus sleeps add up to that), and it fell on the last big read (2752 ms, `refreshing`). That read's
  padding had already gone through the vector worker (`nearby:4`), so this was not the KNN and not the run landing.
  An earlier block of 168 ms came about 4.7 s before it.
- **Tool/query attempted:** `search_symbols{strategy:"name"}` on a repo while its full run rewrites it, with a second
  process indexing another repo of the same DB (the harness shape).
- **Repro attempts (local, eb7e730, CI=true; the bound is load-aware):** none reproduced a multi-second block.
  - Run 1, 2× fixture (2400 files): max late tick 139 ms.
  - Run 2, 8-thread CPU burner (half the cores): max 309 ms.
  - Run 3, 120 dense reads, so every phase of the run is sampled: max 223 ms.
  - Run 4, four fsync'd 64 MB writers: 0 late ticks.

  **The CI stall could not be reproduced on this machine under CPU or I/O load.** What follows is what the profile showed
  on the server thread of every read.
- **Cause (profiled, run 3; inspector CPU profile of server A, `LOCK_CPU_PROF`):** in the 29.6 s window the main thread
  spent 2546 ms in synchronous file-system calls, against 540 ms in all of `searchSymbolsImpl`'s SQL:
  - `getRepoStaleness` → `resolveHeadCommitSha` → `readHeadShaFromFiles`: `statSync` plus `readFileSync` of `.git`, `HEAD`
    and the ref. 1884 ms over 122 calls (16 ms average, 92 ms max).
  - Freshness gate `liveRunMarkers`: a `readdirSync` of the state dir, and each marker read twice
    (`markerNamesOtherRepo`, then again for its body). 593 ms (62 ms max).
  - `readDirtyLedger`: 19 ms.

  A sync read waits out the disk queue on the event loop. With two processes writing full-run WALs, a slower disk turns
  milliseconds into seconds. This fits the CI shape: mid-run, with read ≈ block.
- **Expected vs actual:** a read tool keeps the server thread only for its own SQL; it never blocks on the disk queue.
- **Impact:** on the HTTP server (one process for all sessions), every read of every session paid these sync reads
  on the shared thread. Under disk pressure each of them could freeze every other call.
- **Fix:**
  - `gitHelpers.ts`:
    - The HEAD rules are written once, as a generator of I/O steps (`headShaPlan`), with a sync driver
      (`readHeadShaFromFiles`, unchanged for sync callers) and an async one (`readHeadShaFromFilesAsync`, `fs.promises`
      on the libuv threadpool).
    - `resolveHeadCommitShaAsync` uses the async reader; it previously called the sync one first. This also covers
      `buildStaleWarning`.
    - New `getRepoStalenessAsync` reads HEAD off the thread and passes it as `knownHead`.
    - No cache: HEAD is read on every call, so an answer is never older than the last commit (leader ruling).
  - `searchHandler.ts`: `search_symbols` uses `getRepoStalenessAsync`.
  - `freshness.ts`:
    - The gate uses `liveRunMarkersAsync`, which does an async readdir and reads each marker once, in parallel.
    - The verdict logic is shared through `judgeRunMarker`. The sync `liveRunMarkers` for its other callers now also reads
      each marker once.
    - The gate reads the dirty ledger with `readDirtyLedgerAsync`, started concurrently with the tree read, so it adds no
      serial step to the query budget.
    - The marker readdir is the one added serial step: a threadpool hop. Under `test:unit`'s parallel load it pushed three
      freshness tests past their 20-30 ms budgets / 50 ms wait, failing twice in a row:
      - "a run that outlives the budget…"
      - "MCP-ISSUE-110: a tree check that outlives…"
      - "F4: a killed repair is counted…"

      Each now asks again until the answer settles (bounded at 2 s, `settled()` in freshness.test.ts). Each keeps its
      run-count assertion, so the answer still comes from that one run. Production budgets are ≥ 300 ms.
  - Harness: `LOCK_CPU_PROF=<dir>` profiles server A's main thread until the window closes. The late-tick line now
    names the read in flight for each block.
- **After (local, same conditions as run 3):** sync fs time in the window fell from 2546 ms to 186 ms.
  `readHeadShaFromFiles` went from 1884 ms to 0, the marker scan from 593 ms to 4 ms. The rest was `readDirtyLedger` (101 ms; that
  profile predates moving the ledger read async), `repairNames` (10 ms) and the run's own marker and ledger writes.
  Late ticks: 0 (max 0 ms). Evidence for the gates and runs:
  `~/.claude/handover/briefs/2026-11-16-mcp-local-ci-block-evidence.md`.
- **Left (not in this row's scope; a follow-up, accepted by the leader):** read tools and resources that still read
  HEAD synchronously (`resolveHeadCommitSha`, via `readHeadShaFromFiles`) on the server thread, on every call:
  - `find_impact_files`: `buildIndexMeta(…, withFreshness=true)` → `getRepoStaleness` (impactHandler.ts:880). The
    enclosing function is sync and has about 10 call sites.
  - The `codebase://…/context` resource: `readRepoResource` → `getRepoStaleness` (resourceHandler.ts:62). It is a sync
    resource reader.
  - `detect_changes` and the change-impact tool: `handleDetectChanges` / `handleChangeImpact` →
    `computeChangedFileImpacts` → `resolveHeadCommitSha` (changeAnalysis.ts:129).
  - Not per read: `runPolicy.ts` (mode decisions when a job starts) and `indexRunner` / `indexPipeline` (inside a run).
  - `readRepairNeeded` (a readdir per gate check, about 0.1 ms per read here) is still sync.
- **Follow-up FIXED 2026-11-17 (row 3, branch `wt/head-reads`; the leader widened the scope to the two handlers'
  callers, session 4ae1d27a):** every per-call read in the list above now runs off the server thread. Outputs are unchanged.
  - `find_impact_files`: `buildIndexMeta` is now the pure DB read only. The new `buildIndexMetaWithFreshness` (impactHandler.ts)
    reads `git status` (`readWorkingTreeStateAsync`) and HEAD (`getRepoStalenessAsync`) concurrently, then `git rev-list`
    (`countCommitsBehindAsync`). It used to be four sync reads: `git status`, HEAD files, `rev-parse` fallback and `rev-list`.
  - The `repo://{repoId}/context` resource: `readRepoResource` is async and uses `getRepoStalenessAsync`. The `risk`
    resource (`buildRiskSnapshot`, not in the list above, same file) runs its `git diff --name-only HEAD` through `gitAsync`.
  - `detect_changes` / `change_impact`: the new `computeChangedFileImpactsAsync` (changeAnalysis.ts) reads HEAD with
    `resolveHeadCommitShaAsync` and runs `git status` / `git diff` / `git ls-files` through `gitAsync`. The diff and
    ls-files run concurrently. Both readers share the scoring (`scoreChangeSet`). The sync `computeChangedFileImpacts`
    stays for callers off the server thread. The handlers are async, and `asInvalidParamsOnBadRef` still maps an unresolvable
    ref to InvalidParams.
  - The freshness gate reads the repair flags with `readRepairNeededAsync` (freshness.ts). That is one async readdir for both
    flag kinds, with each file read once and in parallel. The sync `readRepairNeeded` used two readdirs and read each flag twice.
    Both share `judgeRepairFlags`.
  - Tests: `src/middleware/freshnessRepair.test.ts` checks sync/async parity of the repair verdict over every state-dir shape.
    `src/tools/handlers/headReadsAsync.test.ts` checks parity for indexMeta, the context resource and the change set, and that a
    bad ref still maps to InvalidParams. Both files also carry a guard that spies on the sync fs and `child_process` builtins
    (`syncBuiltinESMExports`) and asserts that the async readers make no sync call. The spy is shown to catch the sync readers.
  - Still sync, deliberately: the gate's rare dead-marker sweep (as before), `runPolicy.ts` and the index run itself.
- **Workaround used / fallback note:** the codebase-index MCP server did not connect in this session
  (`CONNECT_TIMEOUT` after 30 s), so discovery used baseline grep/Read on exact identifiers (`searchSymbolsImpl`,
  `readHeadShaFromFiles`, `liveRunMarkers`). This was logged here as the policy requires; it was not a tool defect.
- **Enhancement proposal:** a guard harness that fails when a read tool's main-thread profile shows `*Sync` fs calls per
  call, so the next one is caught without a slow CI runner.
