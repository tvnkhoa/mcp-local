## MCP-ISSUE-122 — index-run timing: a +29% full-index regression that did not reproduce, and `finished_at` stamped at the end of extraction, the freshness note without its own wait

- **Status:** F-b and F-a FIXED 2026-11-05. F-c NOT REPRODUCED (no code change), 2026-11-05. F-d FIXED 2026-11-09.
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

### F-d — the resolve phase is 3× slower on the shared live DB than on a fresh one (fixed)

- **Expected vs actual:** the same wec.aria tree resolved in 6–7 s on a fresh DB but 14–47 s on the live DB. SQL
  profile (2026-11-05): almost the whole gap was `rebuildEdgeIndexes` — 4× `CREATE INDEX` on `edges`, 14.3 s against
  0.5 s on the fresh DB. A full run (or a bulk resolve) drops the four secondary `edges` indexes before the call
  resolve and rebuilds them after it, and those indexes are DB-wide: the rebuild re-reads every repo's edges (889k
  rows, 14 repos then) to save UPDATE costs on one repo's 6%. While they are dropped, every other repo's reads
  full-scan `edges` too, in every server process (the slow-read story of MCP-ISSUE-121). No missing `repo_id` index
  was found.
- **Fix:** `shouldDropEdgeIndexesForResolve(mode, unresolvedRows, repoEdgeShare)` keeps the indexes when this repo
  holds less than `BULK_RESOLVE_INDEX_DROP_MIN_EDGE_SHARE` (0.5) of the DB's edges. `repoEdgeShare` (indexRunner)
  sums `getRepoSchemaSnapshot().edgeCount` over the listed repos; it is read only when the drop is otherwise due, and
  answers 1 alone in the DB, on a fresh DB, or on a failed read, so a single-repo DB keeps the bulk-write
  optimisation. The share never turns on a drop that the mode and row count did not call for.
- **Measured** (2026-11-09; wec.aria @cc678ec4 full run, `docsMode:"on"`, scratch process over stdio, each run in the
  heavy lock; base = 2f4badb compiled in the same worktree; live = a `backup()` copy of the live DB, 834172 edges in
  13 repos, so wec.aria is 5.9%; fresh copy per run). Resolve / call-resolve ms:

  | DB | base 2f4badb | fix |
  |---|---|---|
  | fresh (single repo) | 6146 / 996 · 7066 / 1304 · 6536 / 1009 — mean 6583 | 6239 / 1115 · 7401 / 1133 · 6304 / 804 — mean 6648 |
  | live copy | 20792 / 13352 · 20695 / 14541 · 14012 / 9204 — mean 18500 | 5883 / 1577 · 7055 / 1368 · 7458 / 1386 — mean 6799 |

  The live copy now resolves within ~0.2 s of the fresh DB (it was 2.8× slower); the single-repo DB is unchanged (+1%,
  inside run-to-run noise; whole runs 37.9–46.1 s fix vs 43.8–60.9 s base). With `CODEBASE_INDEX_LOG_MODE=verbose` the
  fresh run logs `dropping edge indexes for bulk resolve...` and the live copy `keeping edge indexes: this repo holds
  5.9% of the DB's edges`. All 14 runs wrote identical graphs: 17889 symbols; edges by type CALLS 20968, IMPORTS 8068,
  TYPE_REF 7795, USES_CSS_VAR 5579, USES_CSS_CLASS 2878, SQL_QUERY 2703, PROPERTY_REF 2381, PROPERTY_WRITE 2355,
  SQL_USES 1653, SQL_GRANT 966, USES_COMPONENT 751, SQL_MIGRATION_ORDER 144, DEPENDS_ON 121, SQL_REFERENCES 107,
  EXTENDS 44, IMPLEMENTS 21; 15979 call + 5167 import edges resolved.
- **Test:** `src/services/indexing/runPolicy.test.ts` "MCP-ISSUE-122 (F-d): …" — the threshold on both sides (0.5 drops,
  0.499 and 0.064 keep, share 1 drops, a dirty run below the row floor stays undropped) and `repoEdgeShare` (shares,
  a repo not yet listed, alone, fresh DB, failed read → 1).
