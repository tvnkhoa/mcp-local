## MCP-ISSUE-132 — `search_symbols` blocked the server thread 0.2-2.9 s: its vector near-neighbour KNN ran on the event loop

- **Status:** FIXED 2026-11-16 (row #1, branch `wt/busy-block`). Leader approved the fix scope (session e242b81b).
- **Scenario:** CI 6208ca9 run 43440259585 (row #19, 13 Nov): `test:index-lock-contention` (b) failed at 2855 ms with
  every run ok. Each late tick of server A's lag sampler was the `search_symbols` on `big` in flight at that moment
  (big reads 833 / 2864 ms, blocks 828 / 2855 ms). Row #19 answered with a load-aware bound; the block itself stayed.
- **Tool/query attempted:** `search_symbols{strategy:"name"}` on a repo whose full run is rewriting it, with a second
  process indexing another repo of the same DB (the harness shape).
- **Suspect named in the brief:** the SQLite busy handler (`busy_timeout = 30000`) on the server-thread connection,
  waiting on the worker's write transaction. **Ruled out:**
  - With the server connection's `busy_timeout` forced to 0 (a preload rewriting the pragma) there was no
    `SQLITE_BUSY` in 24 reads and the same block (1061 ms). A WAL reader does not wait on the writer's lock.
- **Cause (proven on 44e1e9a, scratch harness runs, local):**
  - `searchSymbolsImpl` padded a name query with fewer than three FTS hits with vector near-neighbours —
    `vectorSearchSymbols` → `knnDeterministic`, a sqlite-vec brute-force KNN over the repo's 512-dim partition, up to
    four scans per lookup when it widens on ties — synchronously, on the server thread.
  - While a full run rewrites `big`, FTS finds nothing for `fb_<i>_1`, so every name lookup padded.
  - A main-thread CPU profile of server A (8 s chunks, inspector preload) over one harness run: 2097 ms in
    `searchSymbols`, of which 2058 ms in the vec0 `all`. Timing every better-sqlite3 call on that thread: the KNN
    statement took 49-689 ms per call, 22 calls 3382 ms; no other statement reached 40 ms.
  - Not only under contention: on the live central DB (read-only), the same KNN for a near-miss name on
    wec.communication-hub takes 200-231 ms per scan. Every near-miss lookup on the HTTP server held every session.
- **Expected vs actual:** a read keeps the server thread for its own milliseconds of SQL, not for a vector scan.
  Before: harness server A ticks late > 100 ms: 7-11 per run, max 433-1107 ms (6 runs, local).
- **Impact:** the HTTP server (one process for every session) froze 0.2-0.7 s per near-miss name lookup locally,
  2.9 s on the CI runner; every other call waited.
- **Fix:**
  - The KNN runs in a lazily spawned worker (`repositories/vectorSearchWorker.ts`) on its own read-only connection.
    `search_symbols` waits for it at most 2 s (`DEFAULT_PADDING_WAIT_MS`) and never blocks on it
    (`vectorSearchWorkerClient.ts`).
  - One path: `searchSymbolsImpl` no longer pads at all. The handler asks `needsVectorPadding` and appends the
    worker's rows (`appendVectorNeighbours`). Sync callers (`get_symbol_blame` / cross-repo name lookups) get name
    matches only; a near-neighbour was never their answer.
  - A neighbour list that did not arrive is reported, never silent: `paddingSkipped: "budget" | "queue" | "worker-error" |
    "unavailable"` plus a coverage gap. A late answer is still computed and memoized in the worker.
  - At most 4 outstanding searches (`queue` beyond). The worker exits after 5 min idle and on shutdown. Its KNN memo
    is cleared with the server thread's caches (`GraphStore.onProcessCachesInvalidated`: run landed, purge, seed).
  - Bundled: `scripts/bundle.mjs` ENTRIES has `vectorSearchWorker`, beside `index.js` in `dist/bundle/`.
- **After:** harness ticks late > 100 ms: 0-1 per run, max 0-115 ms. The bound is a fixed 250 ms locally; on CI row
  #19's load-aware bound stays, max(625, 0.15 × baseline big run) (leader ruling, 16 Nov). Negative controls: locally
  `LOCK_SERVER_ENTRY` pointing at a 44e1e9a build fails (b) (max 472 ms); under `CI=true` the pre-fix blocks of this
  machine sit below the CI bound, so the CI control is `LOCK_INJECT_BLOCK_MS` (>= 3x the bound). The `nearby` answers are unchanged: 8/8 big reads `nearby:4` before and after; on the live DB the
  worker's rows equal the in-thread rows for three near-miss names.
- **Cost of the worker** (live DB, wec.communication-hub): first padded call including spawn 389 ms; RSS +20 MB after
  spawn, +2 MB after three KNNs.
- **Workaround used (baseline path):** none — the evidence came from instrumented harness runs, not from a fallback.
- **Enhancement proposal:** an int8/bit-quantized vec0 column would cut the scan itself (a schema change; not needed for
  the server thread any more).
- **CI bound tightening — not done (row 16, 17 Nov):** the plan was to tighten the CI bound to max(300 ms, 2 × the
  observed max block) from the last green CI runs. The observed max is not in those logs: `scripts/run-tests.mjs` runs
  each harness with `capture: true` and prints only `ok [31/70] test:index-lock-contention (<s>)` on a pass, so the
  harness's `server A main-thread ticks late > 100 ms: …, max N ms` line appears only on a failure. Runs read:
  44031150499 (main f345c46) 65.3 s, 44025347429 (wt/knn-cancel) 79.4 s, 44009694184 (wt/fresh-wait) 63.2 s,
  43856178248 (main e1c9109) 72.4 s — duration only, no block value. With no measured value the "< 300 ms" test cannot
  be passed, so the bound is unchanged: CI is still max(625 ms, 0.15 × baseline big run), a load-aware bound rather than a
  constant. Next step: have the harness write its max block and bound to a file the CI job uploads (or print it past the
  runner's capture), collect three green runs, then tighten.
