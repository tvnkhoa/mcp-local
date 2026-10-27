## MCP-ISSUE-086 — `health_check` ran `git status` twice, synchronously, on the server thread

- **Status:** ✅ FIXED 2026-10-22 (release K1, a4eb561; found during release J, pre-existing — present on 25e09d3).
- **Scenario:** `health_check(repoId)` reads the working tree twice with a synchronous `git status`, blocking the server thread: ~650 ms on wec.be, ~270 ms on wec.aria. Every other tool call queued behind it waits that long.
- **Tool/query attempted:** server-thread lag sampler and CPU profile around `health_check` (work-file harness).
- **Expected vs actual:** expected a non-blocking read; got two synchronous `git status` runs (porcelain v1 for the `workingTree` block, v2 for the dirty ledger) plus, measured during the fix, a repo-wide unresolved-edge aggregate on the same thread (~91 000 token edges, 130-220 ms on wec.be).
- **Impact:** a `health_check` while an agent works in another repo stalls that agent's calls for up to ~0.65 s.
- **Fix:**
  - ONE async `git status --porcelain=v2 --branch -z` (`readStatusEntriesAsync`). No `-u` flag, so the untracked mode is v1's: an untracked directory stays one entry and `changedEntries` keeps its value (`summarizeWorkingTree`). HEAD comes from `# branch.oid` (`getRepoStaleness(…, knownHead)`). The ledger check counts a path under a collapsed untracked directory as still dirty (`stillDirty`).
  - `getUnresolvedStats(repoId, runKey)` kept per latest run id — edges change only through a run, and a run from any process changes the id; cleared when the refresh worker lands a run.
- **Measured** (spawned server with the lag sampler, same central-DB copy, 5 rounds per repo, J build vs K1): wec.be 570-644 → 300-435 ms per call (the wall time is now async git); wec.aria 296-344 → 157-191 ms; server-thread samples > 250 ms 10 of 10 calls → 0 (11-12 heartbeats, one 192 ms sample: the first wec.be call, cache empty). Output with timing fields stripped hashed identical old vs new on both repos.
- **Guarded:** `statusPorcelain.test.ts` — on a real repo (modified file, staged `git mv`, untracked directory, loose untracked file) the new summary `deepEqual`s the old v1 `getRepoWorkingTreeState`; the non-git case; the ledger check.

