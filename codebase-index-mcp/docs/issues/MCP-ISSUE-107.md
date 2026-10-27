## MCP-ISSUE-107 — a repo registered at a subdirectory of its git root answered "fresh" on stale content

- **Status:** ✅ FIXED 2026-10-27 (G2, found while doing MCP-ISSUE-106; landed on main ahead of 106).
- **Scenario:** `git status --porcelain` prints paths from the git root, but the index stores them relative to
  repoPath. For a repo registered at a subdirectory (`codebase-index-mcp` inside `mcp-local`), every dirty path came
  back as `codebase-index-mcp/src/…`. The dirty run (from the gate's `knownDirtyPaths` or from `collectDirtyFiles`)
  found no such file under repoPath and re-read nothing. The tree key (MCP-ISSUE-101) hashed the same missing paths
  as `deleted` and was recorded, so the gate answered `fresh` on the old content. Dirty files elsewhere in the git
  root also counted as this repo's changes.
- **Fix:** `gitPathPrefix` (`gitHelpers.ts`, `rev-parse --show-prefix`, cached per repoPath) and `underPrefix`, both
  exported for the 106 diff to reuse. `readWorkingTreeState` / `readWorkingTreeStateAsync` (the gate, the tree key,
  the dirty ledger, `collectDirtyFiles`) and `readStatusEntriesAsync` (`health_check`, `stillDirty` against the
  ledger) return repoPath-relative paths and drop paths outside it. A rename across the boundary keeps only the side
  inside repoPath. `hasWorkingTreeChanges` (the fast skip) passes `-- .`. `link_tests_to_source` used to strip the
  prefix itself; it no longer does, or the prefix would be stripped twice.
- **Effect on stored keys:** a tree key recorded before the fix names root-relative paths. The first gate check after
  the upgrade sees a different key and runs once. A dirty run that read nothing before the fix left the commit's
  content indexed, and any file still dirty is in the dirty set again.
- **Guarded:** `scopedRunConformance.test.ts` "G2: …", a repo at `<root>/sub` with a change outside it too: the gate's
  dirty run (paths from `readWorkingTreeStateAsync`) and `mode:"dirty"` each equal a full run; the tree key names
  `src/util.ts` with a hash. With the prefix strip removed, all three fail. `statusPorcelain.test.ts` "MCP-ISSUE-107":
  status entries and the dirty set in a subdirectory, a rename inside it keeping a repoPath-relative origin, and
  renames into and out of it.
- **With MCP-ISSUE-106:** `diffNameStatusSince` passes `--relative`, and the 106 plan no longer walks the tree for such
  a repo. `scopedRunConformance.test.ts` "G2: an incremental run on a subdirectory repo after a commit is git-scoped
  to repoPath's paths" guards it.

