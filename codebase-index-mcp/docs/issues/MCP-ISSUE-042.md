## MCP-ISSUE-042 — `refactor_replace_rollback` restores the files and leaves the graph holding the reverted names, while `health_check` reports "ready"

- **Status:** **FIXED** 2026-08-04 — see *What shipped* below. First observed 2026-08-03; re-verified on `411afe5` from a fresh process before the fix.
- **Scenario (exact repro, `wec.communication-hub` at `8fe717b`, clean tree):**
  1. `refactor_replace_preview{ find:"NormalizeToConversationCode", replaceExpression:"NormalizeToConversationCodeX", scope:{includePaths:["backend/CommunicationHub/src"]} }` → 3 matches / 3 files.
  2. `refactor_replace_apply` → `driftPercent 0`, `appliedReplacementsCount 3`. `git diff --stat` = 3 files, 3 insertions.
  3. `index_repository{ mode:"dirty" }` → graph now holds the new name (`query_graph`: `SELECT name FROM symbols WHERE name LIKE 'NormalizeToConversationCode%'` → `NormalizeToConversationCodeX`).
  4. `refactor_replace_rollback` → `restoredFilesCount 3`, `conflicts 0`; `git status` clean.
  5. **`query_graph` still returns `NormalizeToConversationCodeX`** — a symbol that exists in no file on disk.
- **Expected vs actual:** expected rollback to either re-index the restored files or mark the repo stale. Actual: `health_check` reports `codebaseState.status:"ready"`, `shouldReindex:false`, `reasons:[]`, `actionHints[0].reason:"Index appears up-to-date"`, and `staleness.isStale:false`.
- **Why staleness can't see it:** the check diffs `indexedCommitSha` against HEAD and inspects the working tree. Rollback restores the tree to HEAD, so both signals read healthy — the graph's divergence is invisible to both.
- **Impact:** every graph tool answers from a phantom name after a rollback, with no warning. This is the same failure *class* as MCP-ISSUE-040 (a graph that does not match reality while `status` says otherwise), reached by a supported operation rather than by a stale process.
- **Workaround (verified):** `index_repository{ mode:"incremental" }` immediately after any rollback — restores the correct symbol. `mode:"dirty"` does **not** work: the tree is clean again, so the changed-file set is empty.
- **Enhancement proposal:** have `refactor_replace_rollback` record the restored file list into the same pending-reindex set `dirty` mode consumes (so `mode:"dirty"` becomes sufficient), or have it mark those files' stored content hash invalid so `codebaseState` reports `stale` with `reasons:["files restored by rollback are not re-indexed"]`. Failing either, `refactor_replace_rollback` should return an `actionHints` entry recommending the incremental re-index — the response currently returns only `restoredFilesCount`/`conflicts`.

### What shipped 2026-08-04 — all three, because they are complementary rather than alternatives

A new `pending_reindex_files` table (`repositories/schema.ts`) is the **third staleness signal**. The
other two are both git-derived, and that is precisely why neither can see this: `getRepoStaleness`
compares the indexed commit sha against HEAD, the working-tree check shells out to `git status`, and a
rollback restores the *exact* pre-apply bytes — so HEAD matches and the tree is clean while the graph
still holds the applied names.

1. **Both halves of the refactor lifecycle record their writes.** Rollback writes `touchedFiles`
   (`tools/handlers/refactorApplyHandlers.ts`), apply writes its applied files
   (`tools/handlers/refactorApplyGate.ts`). Apply was survivable before — the tree goes dirty — but
   recording it keeps the two symmetric and survives a later commit/stash that cleans the tree.
2. **`health_check` reports `stale`**, ranked *above* `dirty` on purpose: a clean tree with a non-empty
   pending set is exactly the rollback case, and the one where nothing else in the response would
   report a problem. `reasons` names it, `codebaseState.pendingReindex` lists the files, and the
   `index_repository` action hint switches to `mode:"dirty"` — now the cheaper sufficient fix.
3. **`mode:"dirty"` unions the pending set** into the git changed-file set (`indexRunner.ts`), so the
   documented `mode:"incremental"` workaround is no longer required. The set is cleared once the run
   records, since the graph has now seen those files.
4. **Rollback returns `actionHints`**, so a caller who never runs `health_check` still learns of it.

Note the rollback handler is synchronous, so it structurally cannot await an index run — the
pending-set shape is required, not merely preferred. Round-trip pinned in
`src/repositories/crossRepoStore.test.ts`.

---

