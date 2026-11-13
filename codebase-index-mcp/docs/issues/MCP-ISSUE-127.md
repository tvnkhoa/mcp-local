## MCP-ISSUE-127 — a tree check slower than the query budget dropped its verdict, so every later read said `refreshing` for good

- **Status:** FIXED 2026-11-13 (row #1, branch `wt/ci-lock`): a check that outlived its caller's budget leaves its verdict
  for the callers of the next `LATE_CHECK_REUSE_MS` (1 s) after it finished (`src/middleware/freshness.ts`). Option A,
  owner's choice, 13 Nov: "A: dùng lại kết quả 1 giây (Recommended)".
- **Scenario:** GitHub CI run 43190005628 (main 5d30ac1, windows-latest, Node 22): `test:index-lock-contention` FAIL
  `(c) the dirty edit on the read repo is indexed once the queue drains`, 98.9 s. All runs ended ok, no lock error, server
  A idle (lag-sampler heartbeats ≤ 15 ms). Last green CI at e8f36ad: 48.6 s.
- **Tool/query attempted:** `search_symbols` on the dirty repo `small`, polled 120 × (call + 250 ms) until the edit is in
  the answer and `freshness.state` is not `refreshing`.
- **Expected vs actual:** the first answer past the budget says "checking the working tree … continues in the background
  … and a later query will use it". The later query did not use it. `checkTtlMs` defaults to 0, so the finished check's
  `fresh` verdict (`lastCheck`, keyed to the check's START) was never served. Each new read started a new check
  (`git status` + hashing). On a runner where that takes longer than the 300 ms budget, the new check timed out the same
  way. Result: `refreshing` on every read while the index was current.
- **Regression?** No. `freshness.ts`, `gitHelpers.ts` and `src/index.ts` are unchanged e8f36ad..5d30ac1. The path dates
  from MCP-ISSUE-110 (`waitCheck`). The CI runner was ~1.3× slower than in the green run (harness durations compared
  test by test), and that was enough to put the check past the budget.
- **Impact:** any client on a slow or loaded machine sees every read of a dirty repo flagged `refreshing` with coverage
  lowered, although nothing is refreshing (`index_status` lists no run) and the index is current. CI goes red on (c).
- **Reproduction:** `LOCK_SLOW_GIT_MS=600 npm run test:index-lock-contention` (an inline preload delays each server's
  `git status` callback). At 5d30ac1: 2 of 5 runs FAIL (c) at 50.4 s / 51.6 s, the rest fresh only after 3–40 s. With the
  fix: 2/2 PASS, fresh ~0.85 s after the first late answer. Unit test: `freshness.test.ts` "MCP-ISSUE-127: …"; it fails
  on 5d30ac1's `freshness.ts` and passes with the fix.
- **Guarantees of the fix (tested):** (i) more than 1 s after the late check finished, a new check runs; (ii) an edit made
  before a check started is never answered fresh by it; (iii) an edit made after a late check finished is seen by the
  first check started after the window. **Blind spot (accepted):** an edit made after a check STARTED can be answered
  `fresh` for at most that check's duration + 1 s. Every check already had this blind spot, as does the existing 1 s
  reuse of a non-fresh verdict.
- **Workaround used:** none needed; diagnosis through the harness's new (c) trail (state + reason per change, and
  `index_status` on failure).
- **Enhancement proposal:** a check that is regularly slower than the budget is a cost signal. Report the tree check's
  duration in `health_check` so a slow machine shows up before its reads start saying `refreshing`.
