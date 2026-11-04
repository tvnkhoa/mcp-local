## MCP-ISSUE-118 — `test:field-access-exact` red when solo: the cold type-program build outlives the harness budget

- **Status:** OPEN (filed 2026-11-04 by the IX-6/IX-7 member; id reserved by the mcp-local leader). Whether it predates
  IX-6 is being settled by a 5× solo baseline run at ccd3a3d.
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
