## MCP-ISSUE-071 — `search_symbols` padded an exact name match with 49 vector near-neighbours

- **Status:** ✅ FIXED 2026-10-20 (P2; found by wec.aria's acceptance of release B).
- **Scenario:** `search_symbols(strategy:"name", limit:50)` for one exact, unique name returned 50 rows, 49 of them `matchType:"fuzzy"`. Agents read rows 2-50 as matches.
- **Cause:** fewer than 3 full-text hits triggers vector padding up to `limit`. MCP-ISSUE-058(b) labelled the rows, but they still shared the result list.
- **Fix:**
  - `symbols` holds only rows that match by name, and `count` counts only those.
  - Near-neighbours go to a separate `nearby` field, at most 5.
  - With no name match, `symbols` is empty, `nearby` holds the neighbours, and coverage stays `low` with "not found, here is what is nearby".
- **Guarded:** `searchSymbolsNearby.test.ts` (3 tests).

