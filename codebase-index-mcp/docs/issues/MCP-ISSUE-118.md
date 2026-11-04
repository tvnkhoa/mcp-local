## MCP-ISSUE-118 — `test:field-access-exact` red when solo: the cold type-program build outlives the harness budget

- **Status:** DIAGNOSED 2026-11-04 (F-1) — pre-existing, not a regression; the fix is in the harness (index-core's file),
  proposed below and verified 5/5; no src change.
- **Scenario:** `npm run test:field-access-exact` exits 1; `run-tests.mjs --changed ccd3a3d` showed it as the only red
  harness (61/62).
- **Tool/query:** `find_field_accesses` on a fresh 13-file repo, first (cold) call.
- **Expected vs actual:** the cold call answers exact. Actual: `confidence:"gap"`, knownGaps "type program still building
  for 'field-exact-…' (2.9–3.8 s so far); the build continues in the background. No accesses are returned", so the 13
  checks that need accesses fail. Solo at b2a4cc5: red 3 of 5 runs; green twice immediately after `npm run build`.
- **Impact:** a red harness in the changed-set gate; nothing in IX-6/IX-7 touches field-access code.
- **Workaround:** none yet; a re-run right after a build was green.
- **Enhancement proposal:** the harness should retry the cold call until `typeResolution` stops reporting a build in
  progress (the server's own message says to), or the cold budget should be raised under load. Needs the baseline
  result before choosing.
- **Cause (F-1, 2026-11-04).** The server behaves as designed (release I1, MCP-ISSUE-073): one field call waits at
  most what the R1 freshness gate left of `CODEBASE_INDEX_QUERY_REFRESH_BUDGET_MS` (5 s, floor 250 ms; `src/index.ts`
  `TS_LS.remainingWaitMs`), then answers `gap` "type program still building" with no list and keeps building. The
  harness asserts `exact` on the first, cold call with no retry. On this fixture the uncancellable cold program build
  alone took 2.4–3.6 s under 38–91 % CPU load (other sessions), after worker spawn + TypeScript load and the freshness
  gate had used the rest of the 5 s. The `CODEBASE_INDEX_TS_LS_COLD_START_MS: "1"` case fails the same way: the time
  cap is checked only after the program is built, so its breach answer also arrives after the wait budget.
  `test-field-access-vue.mjs` already polls for this reason (`askSettled`); the exact harness never got it.
- **Evidence (solo runs, `node scripts/test/test-field-access-exact.mjs`).** Baseline ccd3a3d: red 5/5 (11/9/11/11/12
  of 24 passed). 7694ddf: red 2/5. 7694ddf with the polling patch: green 5/5 (24/24, CPU load 38–87 %). No dotnet build
  running in any run. Not a regression of b2a4cc5 or any later commit: the red rate tracks machine load.
- **Fix (proposed, `scripts/test/test-field-access-exact.mjs`, owned by index-core today).** Add a `settled(call)`
  helper that re-asks every 1 s (max 60) while the answer is `gap` with knownGaps matching
  `/type program still building/`, and use it for the two cold calls (the "exact" server and the "cap" server). The
  late answer the client keeps (`FieldWorkerClient.late`) is served to the identical retry, so the cold flag, the
  timings and the cap breach are still asserted as before. Patch: `~/.claude/handover/briefs/2026-11-04-mcp-local-fae-budget-harness.patch`.
- **Not chosen:** raising the 5 s wait in src would only move the threshold and lengthen every cold call the I1
  contract keeps bounded (`test:field-access-worker` checks that bound).
