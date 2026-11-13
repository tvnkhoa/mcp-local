## MCP-ISSUE-130 — an INDEX_VERSION change ran scoped (incremental/dirty) runs that kept the older extraction; the gate said `refreshing` with no run

- **Status:** FIXED 2026-11-13 (row #9, branch `wt/index-version`). Owner, 13 Nov: "Mở member sửa ngay (Recommended)".
- **Scenario:** wec.aria, server upgraded v15-tiebreak-path → v16-python-tree-sitter. `reads` reported that a FULL run
  was needed, yet run 339b6b3a ran INCREMENTAL (~35 s). Found by row #1 (MCP-ISSUE-127 evidence). The live
  codebase-index-mcp index showed the same on 13 Nov: `freshness.state: "refreshing"`, mode `incremental`, with the
  reason "last fully built by v15-tiebreak-path; this server runs v16-python-tree-sitter".
- **Tool/query attempted:** any read through the freshness gate; `index_repository` mode `incremental`.
- **Expected vs actual:**
  - Expected: the first run after a version change rebuilds the index under the new build's rules.
  - Actual, part 1: the run mode ignored INDEX_VERSION. `runPolicy.ts` only turned off the fast skip
    (`evaluateIncrementalSkip`) and the git-scoped plan (`planGitScopedIncremental` walks the tree). The walk then
    skipped every file whose content hash was unchanged (`indexPipeline.ts`, "unchanged"), so those files kept the
    older build's symbols and edges. The run recorded the new version, so the latest run no longer showed the mismatch.
  - Actual, part 2: `freshness.ts` `ensureFresh` turned a `fresh`/`refreshed` verdict into `refreshing` because of the
    version warning alone. No run existed, and none was started.
- **Impact:** after every INDEX_VERSION bump, files not edited since keep the old extraction until someone runs
  `index_repository` mode `full` by hand. Every read meanwhile says `refreshing`, which promises a run that never comes.
- **Fix:**
  - `runPolicy.ts` `versionEscalation` / `versionEscalationFor`: compares this build's INDEX_VERSION with the run that
    says which rules built the index. That is the newest ok `full` or `seed` run among the recent work runs, else
    `getLatestFullRunVersion`. It never uses the latest run, which a scoped run already stamped with the new version.
    - A repo with runs but no full run on record escalates once.
    - A newer build's index is not escalated over; `newerBuildRefusal` refuses it.
  - `indexRunner.ts`: a non-full run (incremental, dirty, gate-started, watcher) with a mismatch runs FULL once. The run
    row's `scope` says why: `full (the index was last fully built by <old>; this server runs <new>, …; incremental requested)`.
    That full run then becomes the base, so the next run is scoped again.
  - `freshness.ts`:
    - The gate asks for mode `full` when the version differs, so a running refresh is labelled truthfully.
    - With no run, a version-only verdict is `stale`, not `refreshing`. The reason ends "No index run is in progress:
      the index predates this server's version, and the next refresh this gate starts (on any change) runs full."
    - An index fully built by a NEWER build (its generation number is higher): the gate neither asks for full nor
      promises a full run. The reason says to restart the server instead. Review finding 3.
  - Review follow-up (leader, 13 Nov), in `indexJobs.ts` and `src/index.ts`:
    - Finding 1, watcher deadline: `RefreshRuns` takes a `mustRunFull` hook, wired to `versionEscalationFor`.
      `modeFor` plans the run full, with the reason, before the deadline is chosen. A watcher or gate run that the
      version forces full therefore gets the full-run deadline, not the 10-minute scoped one. Index jobs get the
      same plan and keep their own timeout.
    - Finding 3, gate wiring: the gate takes `versionEscalation`, wired to `versionEscalationFor`. It decides the
      older-index case by the runner's own rule: a seed row counts as a full build, and runs with no full run on
      record escalate once. `getFullRunVersion` now only detects a newer build's index.
- **Open (review finding 2, outside the file scope):** seeded worktrees (`seedStore.ts`). The seed row copies
  `index_version` from the parent's base run. That base can be an incremental run stamped with the new version over
  an old full build (the 339b6b3a case), and then the child never escalates. Fix: give the seed row the parent's
  full-base version, or refuse the seed when `versionEscalationFor(parent)` is non-null.
- **Not done (by brief):** no INDEX_VERSION bump. The verdict reuse of MCP-ISSUE-127 is unchanged. The gate does not
  start a full run for the version alone: a query never pays for a whole-repo rebuild it did not cause.
- **Evidence:**
  - `src/services/indexing/indexRunnerVersion.test.ts` (5 cases). Without the runner change, 4 of 5 fail.
  - `runPolicy.test.ts` (2 cases), `freshness.test.ts` (the MCP-ISSUE-101 part 5 case, rewritten).
  - Gate log: `~/.claude/handover/briefs/2026-11-13-mcp-local-version-escalation-evidence.md`.
- **Enhancement proposal:** none open.
