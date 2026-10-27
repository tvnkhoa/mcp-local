## MCP-ISSUE-087 — `detect_changes` loses the old path of a rename

- **Status:** ✅ FIXED 2026-10-22 (release K2, 3a6cc43; found during release J, same mechanism as MCP-ISSUE-085 fix (b)).
- **Scenario:** `services/impact/changeAnalysis.ts` (working-tree mode and the `base..head` range) lists changed files with `git diff --name-only`, which reports a rename by its new path only; the old path's symbols are not part of the change set, so their callers are missing from the impact.
- **Expected vs actual:** expected both paths of a `git mv`; got the new one.
- **Fix:**
  - Working tree: the freshness gate's own read (`git status --porcelain=v2 -z --untracked-files=all`); range: `git diff --name-status -z -M` (git's default 50% similarity, stated in the tool description — a move rewritten past it reads as a delete plus an add).
  - Each impact row gains `change` (`added` / `modified` / `deleted`) and, for a rename git paired, `renamedFrom` / `renamedTo`. A plain `mv` is a deleted path plus an untracked one: no pairing is claimed.
  - The gate prunes the old path before the handler runs, so a removed path the index no longer holds is scored from the files whose import tokens still resolve to it (`findImportersOfRemovedPath`: the import lane's `resolveModuleSpecifier` and tsconfig aliases, the removed path added to the known files), at 0.95 like a resolved relative import, each with reason `imports '<spec>' — <old> no longer exists`. `dependentsNote` says where the answer came from, or `no remaining importer references <old>` (the IDE rename, importers updated in the same change). Callers reaching the old file without an import token (globals, C# namespaces) are not claimed.
- **Guarded:** `test:detect-changes-rename` (17 checks over MCP stdio: `git mv` with the gate on and off, plain `mv`, the IDE rename, range mode) — 11 fail with only `changeAnalysis.ts` reverted (`git mv: both paths are listed — ["b2.ts"]`); `changedPaths.test.ts` (porcelain codes incl. copy and staged / unstaged deletes; name-status R/C/A/D/M).

