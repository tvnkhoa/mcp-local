## MCP-ISSUE-119 — a new worktree re-indexes from scratch (~104 s on wec.aria) instead of seeding from its parent

- **Status:** IN PROGRESS (IX-9). U1 id namespace landed 2026-11-04; U2 seed store, U3 job wiring, U4 conformance open.
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
