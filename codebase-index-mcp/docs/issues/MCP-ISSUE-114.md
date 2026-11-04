## MCP-ISSUE-114 — no one-call way to register a worktree's index: a 120 s index_repository call plus a separate watch

- **Status:** ✅ FIXED 2026-11-04 (IX-4, wec.aria request D7). New tool `register_worktree`. Seeding the worktree from
  the parent's index is IX-9 (not this fix): the worktree's first run is one full run (MCP-ISSUE-113).
- **Scenario:** wec.aria's 3 Nov rule "index per worktree": each new worktree needed `index_repository` — a call that
  outlived the client's 120 s ceiling on a ~3300-file worktree (MCP-ISSUE-112) — then `watch_repo start`.
- **Fix:** `register_worktree({ parentRepoId, repoPath, repoId })` (`handleRegisterWorktree`,
  `src/tools/handlers/indexHandler.ts`): checks `repoPath` against `CODEBASE_INDEX_ALLOWED_ROOTS`, that `parentRepoId`
  is registered and that `repoPath` shares its git common dir (`findWorktreeOwner`), refuses a repoId equal to the
  parent's or registered at another path; registers the repoId, queues its index job (MCP-ISSUE-112) and starts its
  watcher (`activateWatchForRepo`; with `CODEBASE_INDEX_WATCH_ACTIVE_ONLY` the previously active watcher stops). It
  answers at once: `{ repoId, parentRepoId, repoPath, registered: "new" | "already", runId, state, watch, next }`.
  Calling it again for the same repoId and path queues another run.
- `register_worktree` joins `index_repository`, `health_check` and `watch_repo` in the tools whose repoId may be
  unknown — a set kept twice, in `src/tools/index.ts` and `src/middleware/inputGuards.ts` (both updated).
- **Guarded:** `scripts/test/test-register-worktree.mjs` (`test:register-worktree`) — one call answers in < 2 s with a
  runId, registered new, watcher started; `list_repositories` and `watch_repo status` show it; `index_status` reaches ok
  with one full run and the worktree's own symbol indexed; refusals for an unknown parent, a repo that is not the
  parent's worktree, the parent's own repoId, a repoId registered elsewhere; a second call queues another run.

### Seen (fallback log, 2026-11-04)

- The member building IX-1..IX-4 read code with Grep/sed instead of codebase-index tools: its worktree
  (`mcp-local-wt-index-core`) was not indexed — indexing it would have reproduced the defects being fixed, and no
  one-call registration existed (this issue). Enhancement: with `register_worktree`, a member worktree is indexed
  without blocking its session.

### Follow-up (2026-11-04, leader review)

- `register_worktree` also refuses the parent's own checkout and a path already registered under another repoId,
  comparing paths resolved, slash-normalised, without a trailing slash and (on Windows) case-insensitively
  (`sameRepoPath`). Guarded: `indexHandler.jobs.test.ts`, `test:register-worktree` (d).
- Neither `index_repository` nor `register_worktree` writes on the server thread any more: the run registers the repo
  on the worker's connection, so `list_repositories` shows it once the run starts. A watcher batch that overflowed
  prunes its deletions with a dirty run in the worker, not with a server-thread write. Guarded:
  `indexHandler.jobs.test.ts` (a store that throws on any write).
- Re-review: `register_worktree` also refuses a path or repoId held by a queued or running job (the run registers the
  repo, so two calls in a row both passed the registry check). `remove_repository` now deletes through the writer too:
  the refresh worker runs the purge (`RefreshWorkerClient.purge`, request kind `purge`) in the DB-wide queue. Guarded:
  `indexHandler.jobs.test.ts`, `refreshWorkerClient.test.ts`, `test:register-worktree` (e).
