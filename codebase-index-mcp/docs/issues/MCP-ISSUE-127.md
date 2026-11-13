## MCP-ISSUE-127 — a tree check slower than the query budget makes every read say `refreshing`; test:index-lock-contention (c) waited for an answer a slow runner never gives

- **Status:** FIXED 2026-11-13 (row #1, branch `wt/ci-lock`), owner's option B' (13 Nov): "B': bỏ A, sửa test và câu
  thông báo (Recommended)".
  - The harness (c) now accepts the edit's symbol with no run left.
  - The gate's reason no longer promises that a later query reuses a check's verdict.
  - The gate's behaviour is unchanged.
  - Option A (7a3eaf9, reuse the verdict for 1 s) was tried and rejected; see *Rejected fix*.
- **Scenario:** GitHub CI run 43190005628 (main 5d30ac1, windows-latest, Node 22). `test:index-lock-contention` FAIL
  `(c) the dirty edit on the read repo is indexed once the queue drains`, 98.9 s. All runs ended ok with no lock error,
  and server A was idle (lag-sampler heartbeats ≤ 15 ms). Last green CI was e8f36ad, at 48.6 s.
- **Tool/query attempted:** `search_symbols` on the dirty repo `small`, polled 120 × (call + 250 ms). The poll stops when
  the edit is in the answer and `freshness.state` is not `refreshing`.
- **Expected vs actual:**
  - Expected: once the queue drains, a read shows the edit and says the index is current.
  - Actual: every read showed the edit with `refreshing` "checking the working tree against the index is still running
    after the 300 ms query budget".
  - Why: the gate's tree check (`git status` + hashing) took longer than the budget on that runner. `checkTtlMs` defaults
    to 0, so a finished check's "nothing changed" verdict is not kept. Each read therefore starts a new check, which
    times out the same way.
  - The old reason text added "a later query will use it". That is true of a refresh the check starts, not of the
    verdict itself.
- **Regression?** No. `freshness.ts`, `gitHelpers.ts` and `src/index.ts` are unchanged e8f36ad..5d30ac1; the path dates
  from MCP-ISSUE-110 (`waitCheck`). That CI runner was ~1.3× slower than the green run's (harness durations compared one
  by one), which was enough to put the check past the budget.
- **Impact:**
  - On a slow or loaded machine, every read of a dirty repo is flagged `refreshing` with coverage lowered, although
    `index_status` lists no run.
  - This is honest about what the gate knows: it has not verified the tree within the budget. It is accepted, not a
    defect, as long as the reason says so.
  - CI went red because (c) demanded "not refreshing".
- **Reproduction:** `LOCK_SLOW_GIT_MS=600 npm run test:index-lock-contention`. An inline preload delays each server's
  `git status` callback by 600 ms. At 5d30ac1 the old (c) failed in 2 of 5 runs, at 50.4 s and 51.6 s; the other runs
  turned fresh only after 3–40 s.
- **Fix:**
  - `test-index-lock-contention.mjs` (c) passes when a read answers with the edit and either:
    - it is not `refreshing`; or
    - its only caveat is the tree check past the budget, and `index_status` lists no job and no refresh run.
  - (c) prints its trail of freshness states (on failure, or with `LOCK_DIAG=1`).
  - `freshness.ts` `waitCheck` reason now ends: "… starts a refresh if one is needed, which a later query will use; if
    nothing changed, the next query checks again."
  - `freshness.test.ts` (MCP-ISSUE-110 case) pins the new wording.
- **Rejected fix (A, 7a3eaf9):** keep a late check's verdict for 1 s after it finished.
  - It made (c) pass under slow git (2/2).
  - It broke `test:query-refresh` §6 ("a pending cleanup is reported, or already done"), deterministically. With a slow
    check, a file deleted right after a query was answered `fresh` with the deleted symbol.
  - Edit-then-query is the common agent pattern, so a verdict from a check that started before the edit must not be
    served as fresh.
- **Workaround used:** none; the diagnosis came from the harness's new (c) trail.
- **Enhancement proposal:** report the tree check's duration in `health_check`, so a slow machine shows up before every
  read says `refreshing`. A cheaper check (e.g. git's fsmonitor) would also remove the cause.
