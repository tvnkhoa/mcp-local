## MCP-ISSUE-125 — freshness load flakes: two test bounds, and parallel reads served one after another past the budget

- **Status:** ✅ FIXED 2026-11-10 for (1) and (2) (test bounds, row 3). (3) explained, not a gate defect; the owner
  kept the 5000 ms budget (10 Nov, option A).
- **Scenario:** on 5 Nov a loaded `run-tests --changed` failed `freshness.test.ts` "MCP-ISSUE-101 F3 …" (×3) and
  `test:freshness-worker`; both passed alone. On 10 Nov (IX-1, wec.aria) four parallel reads on a stale `mcp-local`
  index reported `freshness.waitedMs` 4976 / 5088 / 5110 / 5148 against the 5000 ms budget.

### (1) F3 unit test: a real git check under a 1000 ms budget — test bound, fixed

- **Expected vs actual:** the gate's second call starts a second dirty run. Under load it did not: `1 !== 2` at the
  second-run assertion (5 Nov, 22 s test).
- **Cause:** the test's gate checks a real submodule, so `computeTreeKey` spawns git each time. Under load that check
  outran the 1000 ms budget, the gate answered "refreshing … checking the working tree" (MCP-ISSUE-110 (1), as
  designed), and the run started after the assertion.
- **Fix:** the test's budget is 120 s. It tests what the run receives, not timing; `autoFinish` keeps it fast.

### (2) test:freshness-worker: the refresh window measured the tree check, not the refresh — harness, fixed

- **Expected vs actual:** (b) no main-thread block > 250 ms and every `list_repositories` probe < 250 ms during the
  refresh. On 10 Nov under ambient load (other sessions' members), it failed with blocks of 273 and 464 ms and a
  359 ms probe. The refresh window was 117,693 ms for a run that took 5.3 s.
- **Cause:** the harness ended its window at the first answer on `big` that was not "refreshing". With `BUDGET_MS`
  300, each tree check costs two git spawns: `git status` plus the path prefix. That took 180–370 ms on a busy
  machine, so nearly every answer was "refreshing … checking the working tree". That includes 153 of 161 answers on
  the two-file `small` repo, whose index was current. The window ran on until one check happened to fit,
  stretching (b)'s exposure to any stall 15-fold. The harness also never reset `landedLine`, so the setup's own full
  run counted as "landed".
- **Fix:** the window ends when this refresh lands, at its own `✓ index <big>` line. `landedLine` is reset at the
  trigger. `FRESHNESS_WORKER_DIAG=1` prints the poll and small-repo freshness states. After the fix, two runs under
  the same ambient load gave windows of 5,898 and 6,224 ms, 0 blocks, and probes of at most 66 ms.
- **Limit (product, unchanged):** with `checkTtlMs` 0, a read whose tree check outlasts the budget answers
  "refreshing" even when the index is current (MCP-ISSUE-110 (1) *Limits*). At the live 5000 ms budget this needs a
  check over 5 s.

### (3) Parallel reads past the budget — explained, not capped

- **Mechanism:** the gate caps each read's own wait at the budget, and `freshness.test.ts` "MCP-ISSUE-125: a read's
  freshness wait ends by the budget" checks wall ≤ budget + 300 ms for a hung check and a hung run. Parallel reads
  share one deadline: joiners time from the check's start. Node runs each due timer's continuation before the next
  timer, and that continuation is the gate's answer followed by the tool handler's synchronous work. So read k waits
  the budget plus the handlers of the k−1 reads answered before it. The test "MCP-ISSUE-125: parallel reads share one
  deadline …" pins this: 4 reads with a 40 ms handler wait budget, +40, +80 and +120 ms. IX-1 fits the same shape:
  4976 is a joiner that arrived later, then +112, +22 and +38 ms of handler work (search_regex over
  `bitbucket-mcp/src` is the heavy one).
- **Why not capped:** a single server thread cannot answer n reads at one instant. Answering joiners early would only
  move the overrun into the handler.
- **Decision (owner, 10 Nov, "Giữ 5000 ms (Recommended)"):** keep `CODEBASE_INDEX_QUERY_REFRESH_BUDGET_MS` at 5000
  and accept an overrun of up to about 150 ms on parallel reads, which is the handlers' own time. The rejected option was
  4500 on the served process, which would hold wec.aria's ≤ 5 s target for 4 parallel reads on a stale index. No config
  change.
- **Workaround used:** none. No baseline fallback; the diagnosis used codebase-index tools and the harness logs.
