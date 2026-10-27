## MCP-ISSUE-095 — an incremental run fast-skipped over a deleted file that an earlier run indexed from a dirty tree

- **Status:** ✅ FIXED 2026-10-22 (release L).
- **Scenario:** wec.aria conformance `sql-supersede`, step 2, the incremental leg.
  1. An untracked migration `0099-l1-probe.sql` was indexed by an incremental run.
  2. The file was deleted, which left a clean tree at the indexed commit.
  3. The next incremental run fast-skipped.
  4. The file, its 4 symbols and 38 doc mentions bound to it stayed in the graph. The run was DIFFERENT from the full run.
- **Cause:** release B.1 refused the fast skip only when the last run that did work was `dirty`. A full or incremental run over a dirty tree also holds working-tree content, and nothing recorded that it did.
- **Fix:**
  - `index_runs.tree_dirty` is a new integer column. A full or incremental run that starts on a dirty working tree sets it after it is recorded, through `markRunTreeDirty`, in the same way `triggered_by` is set.
  - `evaluateIncrementalSkip` refuses the skip when the latest work run is `dirty` OR has `tree_dirty`.
  - Cost: one `git status` per full or incremental run.
- **The dirty leg of the same step was a harness gap, not a defect.**
  - In production the R1 gate notices that a dirty-ledger path has vanished. It records the path as pending re-index (`markPendingReindex`), and the next dirty run prunes it.
  - The conformance harness calls the runner directly, so it now records the pending path itself, as the gate does.
- **Guarded:**
  - `runPolicy.test.ts`: "never skips after a full or incremental run that indexed a dirty tree".
  - Conformance `sql-supersede`, step 2, in both modes.

