## MCP-ISSUE-050 — `index_version` was never persisted, so `mode:"incremental"` could never fast-skip

- **Status:** **FIXED** 2026-08-04. Found while fixing MCP-ISSUE-048's persistence gaps; not from the sweep.
- **Scenario:** `evaluateIncrementalSkip` (`services/indexing/runPolicy.ts`) gates the incremental
  fast-skip on `latestRun.indexVersion !== INDEX_VERSION` — re-index if the engine version moved. But
  `index_runs` had **no `index_version` column**: `recordRun` accepted the field and dropped it, and
  `getLatestRun` never selected it. So the left side was always `undefined`, the comparison was always
  true, and the version gate always fired.
- **Expected vs actual:** expected `mode:"incremental"` on an unchanged, clean, already-indexed repo to
  fast-skip. Actual: it re-scanned every time, silently — the run reported `ok` and did real work, so
  nothing looked wrong. This is a pure cost defect, which is why it survived: no output was ever untrue.
- **Impact:** the documented "incremental may fast-skip when indexed commit equals HEAD and the tree is
  clean" (`.claude/rules/mcp-hard-mode.md`) could not happen. Every incremental run paid a full scan.
- **Fix:** `index_version` added via the existing `ensureRunColumnText` migration, written by `recordRun`,
  selected by `getLatestRun`. Round-trip pinned in `src/repositories/runStore.test.ts` — the assertion
  is on the stored value specifically, because the failure mode is invisible in run status.
- **Note:** the skip also requires a clean tree and a matching commit sha, so the effect is only visible
  on a repo in that state; a dirty working tree still re-indexes, correctly.

---

