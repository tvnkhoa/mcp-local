## MCP-ISSUE-100 — a capped `search_regex` looked complete

- **Status:** ✅ FIXED 2026-10-27 (wec.aria request, C1).
- **Scenario:** `search_regex` stopped at the match `limit`, at the per-file cap (200) or at the 5,000-file scan
  cap, and the response read as a full answer. Only `files_cap_reached` produced a `knownGap`; `truncated` was
  not passed to `buildCoverageBlock`; the per-file cap was silent. A caller read "0 matches in the rest" for files
  that were never opened.
- **Fix:**
  - **Every cap says so.** Limit, scan cap and per-file cap each set `truncated`, and the response carries
    `complete:false` plus a top-level `warning` (files scanned, files NOT searched, the remedy: raise `limit`,
    `outputMode:"files"`, narrow scope, or resume). `complete:true` otherwise. Coverage is lowered through
    `truncated`. All four profiles, nano included, keep `complete` / `warning` / `nextAfterPath`.
  - **Resume.** New input `afterPath`: files are path-sorted, only those after it are searched. A scan that
    stopped early returns `nextAfterPath`. `filesUnscanned` is exact (files after the stop point), not
    `eligible − scanned`.
  - **Mid-file cursor (follow-up).** A file cut by `limit` after n matches resumes at it: `nextAfterPath` is the
    path before it (omitted when it is the first file) and `nextSkipMatches: n`, passed back as
    `afterPath` + `skipMatches`. The first file after `afterPath` is re-read and its first n matches skipped, so a
    loop loses nothing, repeats nothing and ends even when one file holds more matches than `limit`. The
    per-file cap counts skipped matches too.
    `skipMatches` applies to the first in-scope file with or without `afterPath` (a cut in the FIRST file has no path
    before it, and used to restart at match 0 forever); it is echoed either way.
  - **Cap detection (follow-up).** The per-file cap is reported only when a match beyond it exists (a file with
    exactly 200 is not capped), and its remedy does not say "raise limit": the cap is fixed.
  - **`afterPath` echo (follow-up).** `afterPath` / `skipMatches` are echoed; an `afterPath` that sorts past every
    in-scope file warns instead of answering `complete:true` with nothing.
  - `perFileCapFiles` (first 20) names the files where the per-file cap hid matches; no resume point for that
    reason alone, the scan itself reached the end.
- **Guarded:** `regexSearchTruncation.test.ts` (pages via `afterPath` equal the full scan; mid-file cursor loop;
  exact-cap file; afterPath past the end; per-file cap; every profile), `regexSearchFiles.test.ts`.

