## MCP-ISSUE-119 — a new worktree re-indexes from scratch (~104 s on wec.aria) instead of seeding from its parent

- **Status:** IN PROGRESS (IX-9). U1 id namespace and U2 seed store landed 2026-11-04; U3 job wiring and U4 harness merged and wired 2026-11-05; live acceptance on a scratch copy of wec.aria passed 2026-11-05 (EQUAL).
- **Scenario:** `register_worktree` on a worktree of an already-indexed repo (wec.aria-wt-ops: 3298 files, 17668
  symbols, 55793 edges).
- **Tool/query:** `register_worktree` → index job `mode:"incremental"` on an empty repoId, i.e. a full extraction.
- **Expected vs actual:** expected the worktree's index to be derived from the parent's, which differs from it only
  by the parent→worktree diff. Actual: full run 104016 ms; an incremental of 5–206 files on the same repo takes
  15.6–19.5 s.
- **Impact:** every new worktree waits ~100 s before its index answers; wec.aria opens several a day.
- **Workaround:** none; wait for the full run.
- **Enhancement proposal (design note, GO-WITH-LIMITS):** an id namespace per repository so a worktree mints the
  same ids as its parent; copy the parent's rows (`INSERT…SELECT`, one immediate transaction) under the worktree's
  repoId; rebuild FTS per repo and vectors for the repo; write one synthetic `seed` base run; let the git-scoped
  incremental index the diff. Fall back to one full run on any failed precondition (reported as `fallbackReason`).
  Target ≤ 25–30 s against 104 s.

### U1 — id namespace (2026-11-04)

- `repositories.id_namespace` (additive migration in `runGraphMigrations`); null means the repo's own repoId, so
  every existing repo keeps byte-identical ids and no `INDEX_VERSION` bump is needed. `GraphStore.getIdNamespace` /
  `setIdNamespace` (a namespace equal to the repoId is stored as null).
- `runIndexPipeline` passes the namespace as the extractor input's `repoId` at its three extraction sites (.csproj
  lane, worker lane, inline lane). Audit: every `stableId(...)` preimage in `src/` starts with the extractor input's
  repoId (`input.repoId`, `ctx.input.repoId`, `this.input.repoId`, or a `repoId` parameter passed from it); no id is
  minted outside `services/extractors/`; the row-shift remap pairs stored ids with extracted ones and mints none.
- Rows are written under the run's repoId: `bindRunRepoId` re-binds `symbols`, `edges`, `routes`, `docs`,
  `mentions`, `literals` in `pushPendingWrite`, the funnel all three lanes pass through (`literalsStore` writes
  `lit.repoId`, `writeStore`/`docsStore` bind `@repoId` from the record). Each of those record types carries exactly
  one repo id; `cross_repo_deps` is built by the linker after the run and never passes through extraction, so
  nothing is exempt. Annotations (citations, comments) are written with the run's repoId already.
- Proof: `src/services/indexing/idNamespace.test.ts` — unset namespace gives `stableId("parent:src/a.ts:function:alpha:0")`;
  a second repoId with namespace = parent indexes to the same rows (files, symbols, edges, routes, literals, docs,
  mentions, comments; repo_id and timestamps excluded) with no row written under the parent's repoId.
- Limits (design note §0): two repos sharing a namespace hold identical ids by design; a worktree registered before
  U1 keeps its own ids until it is re-registered.

### U2 — seed store (2026-11-04)

- `src/repositories/seedStore.ts`: `seedFromParent(store, {parentRepoId, childRepoId, childRepoPath})` →
  `{parentIndexedSha, tablesCopied, durationMs}`, throwing `SeedError` `PARENT_NOT_INDEXED` (no ok
  full/incremental/dirty/seed run with a commit), `SCHEMA_UNHANDLED` or `COPY_FAILED`. One IMMEDIATE transaction:
  register the child (parent's `annotation_key` and namespace), clear any earlier seed of the child (FTS forgotten
  first), `INSERT … SELECT` per copied table with `repo_id` replaced, FTS rows inserted for the child's rowids only
  (no `'rebuild'`), one `index_runs` row `mode:"seed"` copied from the parent's newest ok run (all columns:
  commit, index version, tree key, exclude rules). Vectors are recomputed for the child after the commit
  (`rebuildVectorIndexForRepo`). cross_repo_deps, refactor tables and DB-wide tables are not copied.
- `SEED_TABLES` classifies every table (copy / recompute / special / skip, with a reason); `unhandledSeedTables`
  lists any table it does not name (FTS5 and vec0 shadow tables excluded), and the seed refuses with
  `SCHEMA_UNHANDLED` before writing. `seedStore.test.ts` fails on a fresh schema with an unnamed table.
- Proof (`seedStore.test.ts`): a seeded child equals both the parent and a full index of the same tree under the same
  namespace, row set by row set for files, symbols, edges, routes, literals, docs, mentions, citations, comments,
  pending paths; FTS integrity check passes and MATCH answers per FTS table are equal; vector rows equal; a re-seed
  is idempotent; the parent is untouched.
- Open for U3 (runPolicy, owned by member C): the planner must accept mode `seed` as a base, and the carried-dirty
  semantics of a parent whose newest ok run is `dirty` are inherited through the copied tree key. Not measured yet:
  copy time on a wec.aria-sized DB.

### U3 — job wiring (2026-11-04 / 2026-11-05)

- `checkSeedAncestry` (gitHelpers): the parent's seed base commit must be an ancestor of the worktree's HEAD (strict,
  per acceptance), else `fallbackReason` `parent_not_indexed` / `parent_sha_missing` / `child_head_unresolved` /
  `unrelated_history` / `parent_not_ancestor` / `git_error`.
- `runWithSeed(request, deps)` (indexJobs.ts) is the job executor's step (src/index.ts): no `seedFrom`, or a child that
  already has an ok run → the plain run. Otherwise ancestry → phase `seed` → scoped incremental. Every refusal or
  failure runs full in the same job and reports `fallbackReason` in index_status: ancestry refusal, `seed_<code>`
  (child cleared first — the vector step runs after the copy commits), `incremental_after_seed_failed` (child cleared).
- Seed and clear run in the refresh worker, the single writer (MCP-ISSUE-112): request kinds `seed` and `clear`.
  `clear` (`clearRepositoryIndexImpl`) drops the repo's index rows, keeps its `repositories` row (namespace,
  annotation key) and forgets FTS rows per repo — never the all-repo FTS rebuild. The ancestry check reads
  `GraphStore.seedBaseSha`, the same row the seed copies. `planGitScopedIncremental` accepts a `seed` row as a base.
- `register_worktree` enqueues `seedFrom: <parent repoId>`; `index_repository` has no seed path.

### U4 — conformance harness (2026-11-04)

- `scripts/test/test-seed-conformance.mjs` (+ `_seedCompare.mjs`): self-test full-vs-full EQUAL; compare mode
  `--db --roots --a --b --probes` compares every repo_id table as a multiset (symbol ids normalised) and the answers of
  search_symbols / query_docs / search_regex per probe; exit 1 on any difference.

### Acceptance (2026-11-05, scratch clone of wec.aria @32d3cf87, scratch DB, own stdio server)

- Parent `aria-parent` full at C~20 (3341 files, 42 s). Worktree at C (35-file diff, 15 code files): seeded via
  register_worktree 18.8 s / 23.1 s wall (phases seed → incremental after seed → scoped 35 files) vs a full index of
  the same tree 51–61 s. A 1 s `list_repositories` ping during the seeded job: max 532 / 859 ms, none failed.
- Conformance (`test-seed-conformance.mjs` compare mode): seeded vs full **under the same namespace** → EQUAL, 15
  tables (17896 symbols, 56577 edges, 12026 docs, 32605 mentions …) and 5 probes (search_symbols ×2, query_docs
  search + section, search_regex). Against a full run under its own namespace the ids differ by design (U1 limits):
  doc_mentions.candidate_ids, ambiguous-callee picks and repositories.id_namespace.
- Defect found and fixed: the copy's `INSERT … SELECT` read rows in repo_id-index order, so the child's rowids (the
  tie-break of equal-ranked answers) differed from a full run; a search_symbols probe's 5th hit changed. The copy now
  runs `order by rowid`; `seedStore.test.ts` asserts the parent's rowid order and fails without it.
- Fallback: parent indexed at C~20, worktree at C~25 (not a descendant) → one full run, `fallbackReason:
  "parent_not_ancestor"` in index_status (62.7 s).
- Limit found: `register_worktree` refuses a parent that is itself a linked worktree (common-dir check, MCP-ISSUE-114).
