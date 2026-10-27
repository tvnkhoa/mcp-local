## MCP-ISSUE-066 — IDE state under `.vs/` consumed the whole 20 000-file scan budget: `filesIndexed: 1`

- **Status:** ✅ FIXED 2026-10-01 (P1; found while re-indexing for MCP-ISSUE-065).
- **Scenario:** `index_repository(repoId: "wec.social-ads", mode: "full")`. The repo has 1 054 tracked files, plus 25 194 untracked files in Visual Studio's `.vs/CopilotSnapshots`.
- **Expected vs actual:** expected about 1 000 files indexed. Got `filesScanned: 20000, filesIndexed: 1, filesSkipped: 19999`.
  - `.vs` and `.idea` were excluded only by `EXCLUDED_PATH_SEGMENTS`. That filter runs **after** the glob and after `maxFiles` truncates it.
  - Since MCP-ISSUE-060 turned `dot: true` on (2026-09-17), the glob walks `.vs/`. The sorted list puts `.vs/…` ahead of `src/…`, so the snapshots filled every slot.
  - This is the same failure the `.venv` follow-up to MCP-ISSUE-060 fixed; the IDE-state directories were missed then.
- **Impact:** the repo's graph silently stopped updating. A truncated scan correctly refuses to prune, so the old 9 413 symbols survived and still looked healthy, with status `ok`. Any repo opened in Visual Studio or a JetBrains IDE was exposed.
- **Fix:** `.vs` and `.idea` moved into `VENDOR_DIR_SEGMENTS`, which feeds both `INDEX_IGNORE_GLOBS` (walk level) and the segment filter. `.vscode` stays segment-only, because it is small and `search_regex(scanAll)` may want it.
- **Guarded:** `fileFilter.test.ts` "a vendor tree is excluded at the GLOB" now lists `.vs` and `.idea`. It fails on the pre-fix code (`'.vs must be in INDEX_IGNORE_GLOBS…'`).
- **Structural fix (same day):** the segment-only names (`wwwroot`, `public`, `static`, `assets`, `logs`, `.vscode`) can no longer starve the budget either.
  - `scanRepoFiles` drops any path with an excluded segment **before** the caller applies `maxFiles`, testing the repo-relative path.
  - The pipeline now hands `shouldIndexFile` the repo-relative path (rooted `/…`) instead of the absolute one. Before, a repo checked out under a directory with an excluded name, such as `D:/assets/repo`, lost every file as `excluded_path` and reported `ok` on an empty graph.
  - Guarded by `fileScan.test.ts` (3 tests; 2 fail pre-fix) and `repoUnderExcludedName.test.ts` (fails pre-fix with an empty graph).

