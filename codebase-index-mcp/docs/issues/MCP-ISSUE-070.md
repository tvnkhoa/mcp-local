## MCP-ISSUE-070 — gitignored build output was indexed, so symbols appeared twice

- **Status:** ✅ FIXED 2026-10-20 (P2; found by wec.aria's acceptance of release B).
- **Scenario:** wec.aria's `.gitignore` excludes `dist-runtime/`, yet `packages/core/dist-runtime/**` was in the graph.
  - Every core symbol showed twice (`gate.ts:260` and `dist-runtime/tools/gate.js:250`), so results and `change_impact` were doubled.
  - The walk honoured only the server's own ignore globs and path segments, never the repo's `.gitignore`. The dirty set already did (`--exclude-standard`), so the two scopes disagreed.
- **Fix:**
  - In a git repo the scan keeps only what `git ls-files --cached --others --exclude-standard` shows.
  - The rest is tallied as `gitignored` in `skippedByReason`.
  - Outside git, the plain walk is unchanged.
  - Opt-out: `CODEBASE_INDEX_RESPECT_GITIGNORE=false`.
  - Previously indexed gitignored files are pruned by the next complete (full or incremental) run.
- **Guarded:** `fileScan.test.ts`: a gitignored `dist-runtime/` is dropped and tallied; untracked-not-ignored is kept; the opt-out restores the walk.

