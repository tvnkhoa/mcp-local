## MCP-ISSUE-106 — an incremental run after a HEAD move read and hashed every file

- **Status:** ✅ FIXED 2026-10-27 (wec.aria request, G1).
- **Scenario:** after a pull, merge or checkout the fast skip cannot fire (HEAD ≠ the indexed commit), so the run
  read and sha256-hashed every file the scan listed to find the changed ones (`indexPipeline.ts`, the content-hash
  skip). On wec.aria (~3,000 files) a HEAD move with 0 changed files cost 13.6 s of extract live, and a 12-file
  merge 10.8 s.
- **Fix:** `planGitScopedIncremental` (`runPolicy.ts`) names the files from git, and the runner hands them to the
  pipeline as `onlyRelativePaths` — the same scoped path a dirty run takes (deletes pruned, dependents
  re-extracted, ids re-pointed). The set is
  `git diff -M --name-status <base> HEAD` (both sides of a rename; `diffNameStatusSince`, `gitHelpers.ts`) ∪ the
  porcelain-v2 dirty set (untracked included) ∪ the pending re-index set ∪ every path a run since the base indexed
  while dirty. The base is the newest ok `full`/`incremental` run; every later run must be an ok `dirty` run. The
  dirty paths come from `index_runs.tree_key` (MCP-ISSUE-101), which names each run's dirty files: a file indexed
  dirty and reverted since is in neither the diff nor the dirty set. A scoped incremental run is itself a base —
  it re-read that whole union — so the induction reaches back to the last full walk. No schema change.
  The run's `scope` says which way it went: `…; git-scoped from <sha>: N path(s) (D from the diff, K indexed dirty
  since)` or `…; tree walk: <reason>`.
- **Walks the tree, as before, when:** `respectGitignore: false` (the scan is not git's list); the annotation key
  changed; `.git/info/exclude` or `core.excludesFile` has an mtime at or after the base run's start
  (`excludeRulesChangedSince`); any run since the base
  is not `ok` (a cancelled run wrote an unknown subset) or ran over a dirty tree without a tree key; no base, or one
  without a commit or at another `INDEX_VERSION`; git cannot diff from the base commit (gc'd, shallow, unborn
  HEAD); a `.gitignore`, `.gitattributes`, `.codebase-index/*` or `SCOPE_FORCES_FULL_RUN` path is in the set; more
  than `GIT_SCOPE_MAX_PATHS` (500) paths.
- **Git vs the indexer's own rules:** the full walk keeps only files `git ls-files --cached --others
  --exclude-standard` lists, then applies its own exclusions. So the indexed set is a subset of git's visible set,
  and every way a visible file can change content or appear shows up in the diff or the dirty set. What git cannot
  report is a change to the visible set itself, which is why an ignore-rule change walks, and why the two ignore files
  outside the tree are checked by mtime. Known gap: deleting one of those files (nothing left to stat), or writing it
  and setting its mtime back; run `full` after either.
- **Measured** (scratch clone of wec.aria at 6e011462, 2,994 files; refresh-worker limits; each run on a copy of
  one full base DB; before = ee4d38a, after = this change; two runs each, alternating):

  | HEAD move | before | after | rows vs a full run |
  |---|---|---|---|
  | empty commit (0 files) | 5.7 / 6.0 s (extract 5.2 / 5.4 s) | 0.8 / 1.0 s (extract 26 / 38 ms) | equal, both |
  | 51f82d5b (11 files; 123 dependents) | 16.2 / 16.4 s (extract 12.5 / 12.9 s) | 11.0 / 9.4 s (extract 7.8 / 6.4 s) | equal, both |

  Equal = every row of files/symbols/edges/doc_mentions/string_literals/code_comments/routes, plus S1–S3, I1 = 0,
  I2 empty. What is left of the 11-file run is the dependents' re-extraction (release J), not file selection.
- **Guarded:** `gitScopedIncremental.test.ts` (the plan's set and each walk condition; `diffNameStatusSince`
  forward, backward and on an unknown commit, over a real temp repo). `scopedRunConformance.test.ts` "G1: …"
  (incremental vs full, every row): a commit that adds, modifies, deletes and renames; a merge commit; HEAD moved
  backwards; a `.gitignore` change (walks); an untracked file after a commit; a file indexed dirty and reverted
  since (re-read through the tree key — fails with the tree-key union removed); a dirty run without a tree key
  (walks).
- **Found on the way:** MCP-ISSUE-107 (a repo at a subdirectory of its git root), fixed on main ahead of this entry.
  With it, such a repo is git-scoped like any other.
- **Review fixes (leader review of the first commit, each guarded by a conformance case that fails without it):**
  1. *Case-only rename.* After `git mv src/caller.ts src/Caller.ts`, a case-insensitive filesystem still reports
     the old name as existing, so a scoped run (dirty mode too) re-read the old spelling and never pruned it.
     `existsWithExactCase` (`fileScan.ts`) checks each path segment against its parent directory's `readdir`. It is
     used both when filtering the scoped paths and when deciding which files were deleted from the tree. Both share
     a per-run directory cache, so each directory is read once per run (dirty mode has no path cap). Names compare in
     NFC: macOS HFS+ lists NFD, and without that a non-ASCII file would read as deleted (`fileScan.test.ts`).
  2. *HEAD race.* The plan diffed base..HEAD, but the run recorded HEAD as read when the pipeline started. HEAD is
     now resolved once: the diff runs to that sha and the run records it. An incremental run that ends with HEAD
     elsewhere records no commit, so neither the fast skip nor the next plan uses it as a base. The test checks out
     another commit during the run (from the progress notifier) and back again afterwards. Without the fix, the next
     run fast-skips over the stale content.
  3. *Cross-process ordering.* Runs are listed by finish time, so a dirty run from another process that finished
     inside a long base run's window sorted below the base and was not carried. Runs that finished after the base
     started are now carried too. If such a run has no key, did not end ok, or is a second complete run, the plan
     walks the tree.

