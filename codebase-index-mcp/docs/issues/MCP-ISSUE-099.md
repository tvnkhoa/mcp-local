## MCP-ISSUE-099 — `index_runs` and the WAL file grew without bound

- **Status:** ✅ FIXED 2026-10-22 (release M, 4230e83).
- **Scenario:** `index_runs` had no prune: 805 rows on the central DB, of which api-testing-studio had 307 and
  CommHub 237. The WAL file stood at 88 MB, up from about 1 MB before release L. Two things kept it there:
  - the server thread does not auto-checkpoint (release J);
  - scoped runs checkpoint PASSIVE.

  So nothing ever truncated the file after its peak.
- **Fix:**
  - **`index_runs` cap.** `recordRun` keeps the latest 200 rows per repo, plus always the latest run that did
    work. The F guard (latest row) and the R1 skip gate (latest work row) therefore read what they read before.
  - **WAL limit.** Every store connection sets `journal_size_limit` to 64 MB, so SQLite truncates the WAL to
    that whenever a completed checkpoint lets it restart.
- **Guarded:** `runStore.test.ts` "index_runs keeps the latest 200 rows per repo, and always the latest WORK run
  behind any number of skips".
- **Not covered:** the WAL size *during* one long write transaction is inherent to WAL. The `refactor_*`
  tables have no time prune: 56 previews, under 1 MB, left as they are.

