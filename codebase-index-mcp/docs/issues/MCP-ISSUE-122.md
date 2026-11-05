## MCP-ISSUE-122 — index-run timing: a +29% full-index regression that did not reproduce, and `finished_at` stamped at the end of extraction, the freshness note without its own wait

- **Status:** F-b and F-a FIXED 2026-11-05. F-c NOT REPRODUCED (no code change), 2026-11-05.
- **Scenario:** full index of one wec.aria tree (3333 files, 17889 symbols, 52770 edges) on a fresh scratch DB,
  `index_repository {mode:"full", docsMode:"on"}` over stdio; and reading run durations back from `index_runs`.
- **Tool/query:** `index_repository` → `index_status`; `index_runs.started_at` / `finished_at` / `elapsed_ms`.
- **Workaround:** none needed for F-c; for F-b read `elapsed_ms`, not finished − started.

### F-c — the +29% full-index regression (not reproduced)

- **Reported:** a morning A/B on 2026-11-05 measured ccd3a3d 40.6 / 37.3 s against 935f4dd 50.5 / 50.2 s, all of it
  in the extract phase (31.3 → 43.8 s mean). Suspect: 5d81964 (IX-1, MCP-ISSUE-111), which made a full run keep the
  FTS tables per file (`ftsForgetFile` + `ftsIndexFile` inside every write transaction) instead of one rebuild.
- **Re-measured:** same tree (wec.aria @cc678ec4), same driver, fresh DB per run, both builds compiled in one worktree
  (A = ccd3a3d `src/`, B = 2f4badb), alternating, each run inside the machine heavy lock:

  | run | build | wall s | elapsedMs | extract | resolve | FTS |
  |---|---|---|---|---|---|---|
  | base1 | 2f4badb | 35.4 | 33061 | 28853 | 4096 | 564 |
  | base2 | 2f4badb | 30.8 | 28859 | 24708 | 4035 | 520 |
  | ccd1 | ccd3a3d | 25.5 | 24393 | 19751 | 4477 | 556 |
  | base3 | 2f4badb | 36.4 | 34155 | 29153 | 4838 | 605 |
  | ccd2 | ccd3a3d | 38.7 | 36632 | 28309 | 8021 | 1036 |
  | base4 | 2f4badb | 79.1 | 61106 | 52208 | 8030 | 981 |
  | ccd3 | ccd3a3d | 67.9 | 63108 | 52395 | 10219 | 1144 |
  | base5 | 2f4badb | 58.6 | 47464 | 41477 | 5523 | 679 |
  | ccd4 | ccd3a3d | 45.8 | 42982 | 33168 | 9530 | 1190 |

  Every run wrote the same counts (17889 symbols, 52770 edges, 12026 docs, 37381 mentions). The spread (24–63 s) follows
  machine load (another repo's .NET build held the machine during base4/ccd3), and adjacent pairs show no +29% gap.
- **Bound on the suspect:** on an indexed DB, per-file FTS forget + index for all 3333 files in 50-file transactions
  took 2.6 s; one per-repo bulk index took 1.1 s (bulk forget 0.9 s). Per-file FTS costs at most ~1.5 s (~4%) of a
  full run — not 12 s. A bulk path would also need a per-repo "FTS pending" flag honoured by seed, purge and scoped
  runs to stay crash-safe, so it is not worth it.
- **Cause of the morning signal:** unproven — machine load, or build provenance (the 935f4dd side ran the main tree's
  `dist/`, taken as 935f4dd but not rebuilt).

### F-b — `finished_at` stamped at the end of extraction (fixed)

- **Expected vs actual:** expected finished − started ≈ `elapsed_ms`. Actual: the pipeline stamped `finishedAt` when
  its extract phase ended and the runner never moved it, so finished − started = `extract_phase_ms` (live run
  6ced8f71: 54.4 s against `elapsed_ms` 103 s).
- **Fix:** `indexRunner` stamps `finishedAt` when it records the run, at the same instant as `elapsedMs`. The extract
  figure stays in `extractPhaseMs`. Readers order runs by `finished_at` (`runStore`, `runPolicy`, `seedStore`) and treat
  a run that finished after a base started as overlapping it; runs are serialized per process, so the order is
  unchanged, and a run's writes last until it is recorded, so the later stamp is the honest one for the overlap test.
- **Test:** `src/services/indexing/indexRunnerFinishedAt.test.ts` (fails before the fix: finished − started = extract).

### F-a — the freshness note's `elapsedMs` read as this call's wait (fixed)

- **Expected vs actual:** a read during an index answered `freshness: {state:"refreshing", elapsedMs: 9180, reason:
  "... after the 5000 ms query budget ..."}` — `elapsedMs` is the AGE of the shared in-flight run or tree check (timed
  from its start, which every joining caller shares), so a call that waited ~0 ms looked as if it had waited 9 s.
- **Fix:** the note carries `waitedMs` — this call's own wait — beside `elapsedMs` wherever `elapsedMs` is set;
  `elapsedMs` keeps its meaning, now documented on `FreshnessNote`. No tool schema changed (the note is free-form
  response data), so the contracts snapshot is unchanged.
- **Test:** `src/middleware/freshness.test.ts` "MCP-ISSUE-122: a caller joining an overdue run …" (fails before the fix).
