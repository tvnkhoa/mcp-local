## MCP-ISSUE-136 — a padded search_symbols waited the whole 2 s budget behind another repo's KNN rescan

- **Status:** FIXED 2026-11-17 (row 1, branch `wt/fresh-wait`, session 5d857b10). Found by CI run 43835093453
  (e109539, attempt 1; the rerun was green).
- **Scenario:** `test:freshness-worker` (a). A dirty refresh of `big` (1 500 files) runs while `small` is searched every
  150 ms with `search_symbols { query: "smallBeta", strategy: "name" }` and `big` is polled with `fn_7_1`. Both queries
  have fewer than three name hits, so both are padded with vector neighbours through the MCP-ISSUE-132 KNN worker.
- **Tool/query attempted (MCP):** `search_symbols` on `fw-small-*`, `strategy: "name"`, `limit: 5`.
- **Expected vs actual:**
  - **Expected:** every `small` search answers in < 1 s (they took 61-102 ms on that runner).
  - **Actual:** the last one took **2073 ms**: `FAIL (a) every search on the other repo answered, each in < 1 s`.
- **Cause (reproduced):** the run of `big` landed and `onRunLanded` cleared the worker's KNN memo. The next `big` poll
  went to the worker as a full brute-force scan of `big`'s partition, about 2.9 s on the CI runner. The worker is
  serial, so the `small` search posted right after it queued behind the scan and resolved `{ skipped: "budget" }` at
  `DEFAULT_PADDING_WAIT_MS` (2 000 ms). The window in that log ends about 2 s after the run landed, which is the `big`
  poll waiting out its own budget. The brief's first hypothesis was "respawn + wait"; the measurements show the worker
  is not respawned. The wait was **head-of-line blocking**, and it hit a repo whose index did not change.
- **Repro:** the harness's negative control `FRESHNESS_WORKER_KNN_DELAY_MS=2900`, a test-only preload. The vector
  worker's first `big` search after each memo invalidation busy-waits for that long, matching CI's scan. With the
  pre-fix client this fails (a) with a 2116-2154 ms `small` search, the same shape as CI. Locally the real rescan is
  220-235 ms, under the 1 s bound, which is why it only showed on the slower runner.
- **Impact:** on the shared served server, a padded search on any repo could wait up to 2 s behind another session's
  slow KNN. It then came back without its `nearby` rows (`paddingSkipped: budget`), even though its own repo was
  memoized and cheap.

### Fix

`VectorSearchWorkerClient` runs up to `MAX_WORKERS` = 2 worker lanes. An idle worker takes each request, the first
idle one first, so ordinary one-at-a-time traffic keeps a single warm memo. When every worker is busy, a second one is
spawned. Past two workers, the least busy lane queues the request. `MAX_PENDING` (4) still bounds the outstanding
scans in total, `invalidate()` reaches every lane, and a lane that dies fails only its own waiters. Idle exit and
`dispose` stop every lane.

Not chosen:
- **Per-repo invalidation.** `onProcessCachesInvalidated` carries no repoId, and changing that is outside this row's
  scope (`graphStore.ts`, `index.ts`). It would also not help on its own: a memo hit still queues behind a running
  scan in a serial worker.
- **A lower budget.** It turns the wait into a skipped `nearby` for every slow scan; it does not remove the wait.

The `big` search that pays for its own rescan after a run lands still waits up to the budget. That cost belongs to the
repo that changed, and the budget exists for it.

### Evidence

- Unit (`src/repositories/vectorSearchWorkerClient.test.ts`): three lane tests.
  - A search posted while the other lane is held answers at once.
  - Never more than `MAX_WORKERS` lanes, and requests are balanced across them.
  - A dying lane fails only its own waiters.
- Harness: `FRESHNESS_WORKER_KNN_DELAY_MS=2900 node scripts/test/test-freshness-worker.mjs`.
  - Pre-fix client: exit 1, `small` 2116 ms.
  - Fixed client: exit 0, `small` ≤ 373 ms, with the delayed `big` scan asserted to have run inside the window.
  - Without the delay: green.
- **Enhancement proposal:** pass the landed repoId through `onProcessCachesInvalidated` so the memo is cleared per repo.
