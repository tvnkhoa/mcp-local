## MCP-ISSUE-117 — `search_regex` gave no match total and no `truncated` flag on a complete response

- **Status:** ✅ FIXED 2026-11-04 (IX-7, wec.aria request D6).
- **Scenario:** a wide pattern returned a page and `complete:false`, but never how many matches there were in all, so a
  caller could not size the sweep; and `truncated` appeared only when true, so `r.truncated === false` was `undefined`.
- **Tool/query:** `search_regex{ pattern:"<wide>", limit:50 }`, then resume with `afterPath` + `skipMatches`.
- **Expected vs actual:** `total` (exact) when the scan finished; an explicit boolean `truncated` always. Paging stays
  `nextAfterPath` + `skipMatches` — **no numeric `offset`** (frozen with wec.aria, 2026-11-04).
- **Fix:** `searchRegexImpl` returns `total` when nothing was capped, else `totalLowerBound` (matches counted so far in this
  call) and no `total`. A complete RESUMED call also counts the files before the resume point (bare count, no context
  built, per-file cap applied the same way), so the last page of a paged scan reports the same `total` as one uncapped
  call. `outputMode:"files"` counts files. A per-file cap hides matches, so it yields a lower bound, never a total. The
  handler puts `truncated`, `total`, `totalLowerBound` in every profile and mode. File reading was extracted to
  `readScannable` (same checks, used by the scan and the prefix count).
- **Cost:** an uncapped, unresumed scan adds one integer increment per match. Only a complete resumed call re-reads
  the earlier files.
- **Guarded:** `regexSearchTruncation.test.ts` — "paging to completion: every match once, and the FINAL page's total is
  the uncapped count" (limits 1,2,4,5,9,10: first-match and last-match cut points), the files-mode, past-the-end and
  first-file-cut cases, and the every-profile handler test.
