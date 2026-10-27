## MCP-ISSUE-068 — a 1.41 MB decision log was invisible to every docs mode, and `filesSkipped` could not say why

- **Status:** ✅ FIXED 2026-10-20 (P1; release A item 2 of the wec.aria adoption plan).
- **Scenario:** wec.aria's `docs/15-decision-log.md` (1.41 MB) is its most-linked document and the target of about 380 agent greps. A `query_docs` search for any of its rows returned nothing.
- **Cause:** one size cap (`CODEBASE_INDEX_MAX_FILE_SIZE_BYTES`, 500 KB) applied to code and markdown alike. The docs lane splits a document by section, so a large one costs nothing per query; rejecting it whole is what hurt.
  - Separately, a run's `filesSkipped: 1554` was a bare number. 187 `.vue`, 117 `.sql`, 61 assets and that one decision log were all inside it.
- **Fix:**
  - Markdown gets its own cap, `CODEBASE_INDEX_MAX_MARKDOWN_BYTES` (default 4 MB), in both `shouldIndexFile` and `search_regex`.
  - `.map` / `.tsbuildinfo` are reported as `excluded_generated`.
  - Each run persists `skippedByReason` in `index_runs.skipped_by_reason` as (reason, extension, count), largest first, including files the walk dropped by path segment (`excluded_path`). `health_check.latestRun` carries it.
- **Live after the fix:** full re-index of wec.aria: status `ok`, 1 958 indexed, 1 546 skipped, 51 s.
  - Every bucket outside `excluded_path` sums exactly to `filesSkipped`.
  - docs/15 is in the docs lane as 712 sections.
- **Guarded:** `fileFilter.test.ts` (markdown cap, generated extensions), `skipReport.test.ts`, and the `runStore.test.ts` round-trip.

