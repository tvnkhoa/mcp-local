## MCP-ISSUE-105 — a registered repo could not be dropped from the index

- **Status:** ✅ FIXED 2026-10-27 (F1; F2/F3 follow-ups of MCP-ISSUE-101 land as their own commits).
- **Scenario:** a deleted worktree's repoId (`wec.aria-wt-scratch`, `wec.aria-wt-idx`) stayed in `list_repositories`
  and in every table for good: nothing deleted a whole repo, only `pruneFiles` removed single files.
- **Fix:** tool `remove_repository(repoId, force?)`, annotated destructive and not idempotent. It deletes every row
  keyed by the repoId in one transaction (`repoPurgeStore.ts`: the repo-keyed tables, `cross_repo_deps` on both ends,
  the refactor hunk / change / rollback children through their preview or apply, the vectors), rebuilds the four FTS
  mirrors, then removes the state-dir files (refresh lock, dirty ledger, run markers — `removeRepoStateFiles`).
  It refuses: an unknown repoId; a repo a watcher runs for; a repo with a live run marker (same check as the gate,
  `liveRunMarkers`); and, without `force: true`, a repo whose `repoPath` still exists on disk. It never touches the
  repository's files.
- **Guarded:** `repoPurgeStore.test.ts` — a schema-derived check that fails when a table with a `repo_id` /
  `from_repo_id` / `to_repo_id` column is neither purged nor exempt with a reason (`PURGE_EXEMPT`); a row per
  keyed table for two repos, after the purge none of the removed one and all of the other; a cross-repo link INTO
  the removed repo goes. `removeRepository.test.ts` — each refusal, `force`, the state files (a namesake's lock and
  ledger stay).
- **Not covered:** a process that has the repo open in memory (vector cache) is cleared only in the calling process.

