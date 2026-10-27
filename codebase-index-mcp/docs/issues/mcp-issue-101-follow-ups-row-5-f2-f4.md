## MCP-ISSUE-101 follow-ups (row 5: F2–F4)

- **F2 — a dirty file that stays unreadable forced a run on every check. ✅ FIXED 2026-10-27.** A path keyed
  `UNREADABLE` (EBUSY, EACCES, a lock) is never vouched for, so each gate check started a dirty run that could not
  index it. The gate now counts consecutive unreadable checks per repo and path (in memory, per process); at
  `unreadableChecks` (default 3) the path is keyed `UNREADABLE_CAPPED`, which the covered key matches, so it stops
  forcing runs. The note carries `unreadable: [paths]`; `applyFreshness` adds a `coverage.knownGaps` line on a fresh
  answer too. A readable hash differs from the capped value, so recovery starts a run. Guarded: `freshness.test.ts`
  (F2). **Not covered:** the count is per process, so a restart re-pays up to N runs.
- **Run markers matched by prefix (found with F1). ✅ FIXED 2026-10-27.** `liveRunMarkers` matched `running-<id>-` as a
  prefix, so a run of `wec.aria-wt-x` made the gate of `wec.aria` answer `refreshing` (and a dead sibling marker was
  swept). The name tail must now be exactly `<pid>-<seq>.json`, and a marker also records its `repoId`, which decides
  two ids that sanitize to one name; a marker written before that (no `repoId`) is matched on its name alone.
  `remove_repository` uses the same match. Guarded: `freshness.test.ts` (repoIds `a` / `a-b`, old form, `x/y` vs `x y`,
  the gate).
- **F3 — a change inside a dirty submodule was unseen. ✅ FIXED 2026-10-27.** Checked first: the indexer DOES index a
  submodule's files (its walk ignores only `.git` directories, and a submodule's `.git` is a file), and
  `git status --porcelain=v2 --untracked-files=all` reports a dirty submodule as ONE entry (`sub`). That entry was keyed
  as the constant `dir`, and `fileScan` drops a directory from a dirty run, so an edit inside it neither moved the key
  nor reached the run. `computeTreeKey` now keys it `submodule:<HEAD>` and expands it into the files dirty inside
  (`sub/x.ts`, content-hashed, to depth 3), read with the submodule's own `git status`; the gate hands the run those
  files and keeps the entry out of the dirty ledger. A submodule that moved to another commit changes its key but not the
  list of changed files, so that case runs an `incremental`. Guarded: `freshness.test.ts` (real `git submodule add`:
  one entry, the key, an edit, a new untracked file, the gate's run list, no run when unchanged). **Not covered:** a
  submodule whose git cannot be read is keyed `unreadable` (and capped by F2); a nested submodule beyond depth 3.
- **F4 — a run killed mid-way left a "fresh" gate over a part-written index. ✅ FIXED 2026-10-27.** A full run that
  dies after its first batch (a server restart) leaves HEAD = the last ok run's commit and a clean tree, so the gate
  answered `fresh`; the dead run's marker was swept silently. Now the marker records the run's `mode`
  (`serialize(repoId, fn, mode)`; the gate's own runs, `index_repository` and the watcher all pass it). Sweeping a
  marker whose pid is gone writes `repair-<repoId>.json`; while it exists the gate skips its fresh shortcuts, answers
  `refreshing`/`refreshed` and runs a FULL index; a full run that finishes (any caller) clears it, and
  `remove_repository` deletes it. A marker of an older build (no `mode`) is swept as before.
  **Why full, not incremental:** a scoped run skips a file whose stored hash matches, and when every file was
  re-extracted before the kill (killed in the resolve phase) it finds nothing changed and skips the resolve passes
  (`unchanged` in `indexRunner.ts`), so it cannot be shown to repair that case. A killed `dirty` run is repaired the
  same way (the cost is one full run after a restart that interrupted a refresh).
  **No "stuck running" row exists:** `index_runs` is written when a run ends (`running` is a progress state, never
  stored), so the dead marker is the only signal.
  Guarded: `freshness.test.ts` — a real full index killed after its first batch; a gate of another process answers
  not-fresh, runs `full` once, then `fresh`, and the repaired index has the same symbol / edge / unresolved / file
  counts as a clean full run; dead marker with / without a mode, live marker.

### Review fixes to MCP-ISSUE-105 (F1) and MCP-ISSUE-101 F4 (2026-10-27)

- **remove_repository takes the repo's refresh lock first.** A gate takes that lock before it writes its run marker, so
  the marker check alone could pass while a gate was about to run; the purge then went ahead, the run wrote orphan
  rows, and the old `removeRepoStateFiles` unlinked that process's live lock. Now: `tryAcquireLock` first (refuse when
  held, by this or another process), then the marker check, the purge, and `releaseLock`. `removeRepoStateFiles` no
  longer touches the lock. An `index_repository` / watcher run of another process takes only a marker, so it is covered
  by the marker check except in the instant between that check and the purge.
- **A watcher of another server process is not detected.** It writes nothing until it runs; the tool description says
  so (stop it first). The in-process watcher is refused.
- **The `repositories` row is deleted last**, after the vectors and the FTS rebuilds, so a failure part-way leaves a
  repo the call can be retried on instead of orphan rows no retry can reach. The schema guard now matches any column
  ending in `repo_id` and checks the purge deletes by that very column. The description says the removal is
  irreversible (only a fresh full `index_repository` restores it).
- **F4: the repair is bounded.** The attempt is counted in `repair-<repoId>.json` BEFORE the run starts (a killed repair
  counts); after `MAX_REPAIR_ATTEMPTS` (2) the gate stops starting runs and answers `stale`: "repair failed 2 times; run
  index_repository mode full". Any successful full run, by any caller, clears the flag.
- **F4: a dead DIRTY run is not repaired by a whole-repo full run.** Its marker records its paths (up to 2000). The
  repair clears those files' stored hashes (`invalidateFileHashes`) and runs a scoped run over them: they are
  re-extracted, so the resolve passes run (the `unchanged` shortcut is never reached). The flag keeps the most thorough
  dead mode (full > incremental > dirty) and the union of dirty paths; a dirty marker without paths, or more than the
  bound, is a full repair. Dead full / incremental markers stay a full repair.
- **F4: an expired marker (older than `staleRunMs`) with a live pid is remembered too**, for its mode, so a later death
  of that holder cannot leave "fresh".
- **Guarded:** `freshness.test.ts` — attempts cap (two runs, then stale with the instruction; a full run clears it); a
  killed repair counts; expired-marker flag; mode/paths merge; a real dirty run over 400 edited files killed after its
  first batch is repaired by ONE scoped (`dirty`) run and the index has the same symbol / edge / unresolved / file
  counts as a clean full run of the edited tree. `removeRepository.test.ts` — a held lock refuses and is left alone,
  the lock is released after a refusal and after the purge. `repoPurgeStore.test.ts` — a failure after the
  transaction keeps the repo registered and a retry succeeds.

### F4 second review (2026-10-27): the scoped repair of a dead dirty run is withdrawn

- **A dead `dirty` run is repaired by a FULL run again** (the scoped repair in the review fixes above is superseded). The
  marker recorded only the dirty paths from the run's start. The run also queued DEPENDENT files later
  (`queueDependentFiles`), rewrote them with unresolved tokens under an unchanged hash, and computed the names of what
  it replaced from the half-written rows, so neither set can be reconstructed afterwards and a scoped run over the
  recorded paths never revisits them. The recording and `store.invalidateFileHashes` were removed; the marker no longer
  carries paths. The cost: a killed dirty run costs one full run after the restart.
- **The repair state is one file per dead run** (`repair-<repo>-<pid>-<ms>-<seq>.json`) and one per started repair
  (`repairtry-…`), written by temp file + rename; nothing is read-modify-written, so a concurrent death or attempt is not
  lost. A flag file that exists but cannot be parsed counts as a full repair. A finished repair, and a full run through
  `serialize`, clear only the flags that existed when they started (a run that died meanwhile stays flagged); the attempt
  count goes when no flag is left. `remove_repository` removes both kinds.
- **Guarded:** `freshness.test.ts` — a dirty run that edits one file (every importer is a dependent), killed after two
  progress ticks, is repaired by one `full` run and equals a clean full run through `createIndexRunner`, unresolved
  counts included; two dead runs leave two flags; a half-written flag is a full repair; a flag written during a repair or
  a full run survives it; `a` / `a-b` flags do not mix.

