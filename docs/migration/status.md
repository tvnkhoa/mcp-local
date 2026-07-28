# Migration status — all 44 steps

**Verified** 2026-07-28 against the working tree, not from memory. Baseline `9ccae95`;
Phase H's row updated after the S-28 SDK work landed. Every
row cites the artifact that proves it. Where no artifact was found, the row says so
rather than guessing.

**26 of 44 done · 2 partial · 1 skipped by decision · 15 open.** Phase H is no longer
blocked: its SDK prerequisite (`renderResult` + `wrapCall`) shipped 2026-07-28.

---

## Step-number reconciliation (read this first)

Three commits carry S-numbers that do not match this plan. The commits are immutable, so
the mapping is recorded here rather than rewritten.

| Commit | Label used | Plan step it actually is |
|---|---|---|
| `0eccb10` | S-24 | **S-25** — migrate `postgres-mcp` |
| `e5feaf3` | S-25 | **S-24** — migrate `observe-mcp` |
| `9ccae95` | S-26 | **S-28** — extract indexing orchestration |

The first two are a harmless swap: postgres was migrated before observe because that was
the requested order. The third is a genuine collision — the plan's S-26 is "delete shadow
implementations", which is a different piece of work (and is also done; see Phase G).

`docs/migration/s26-s29-plan.md` uses the commit-side numbering throughout. Its "S-26" is
this plan's S-28, and its S-27/S-28/S-29 are this plan's S-31/S-32/S-33 plus the SDK work
that the plan folded into S-31. **This document's numbering is authoritative.**

---

## Phase A — Baseline and Safety Net · 6/6 ✅

| Step | Status | Evidence |
|---|---|---|
| S-01 Capture the pre-migration baseline | ✅ | `docs/architecture/audit-report.md` (audit of `01c532e`) |
| S-02 Wire the orphaned postgres smoke test | ✅ | `npm run verify:live` drives four smoke tests |
| S-03 Normalize per-server npm scripts | ✅ | all four answer `build` / `typecheck` / `test` / `smoke` |
| S-04 Root aggregate scripts | ✅ | `verify:packages`, `verify:servers`, `verify:all`, `verify:live` |
| S-05 Continuous integration | ✅ | `.github/workflows/ci.yml` — Windows + Node 22, credential-free |
| S-06 ⭐ Golden tool-contract snapshot | ✅ | `contracts/` — 4 snapshots, 76 tools; `contracts:check` green |

## Phase B — Native Dependency Spike · 1/1 ✅

| Step | Status | Evidence |
|---|---|---|
| S-07 Native dependency spike (throwaway) | ✅ | decision implemented long ago; record written 2026-07-28 as `docs/adr/0001-workspace-native-deps.md` |

## Phase C — Monorepo Substrate · 3/3 ✅

| Step | Status | Evidence |
|---|---|---|
| S-08 Shared TypeScript base configuration | ✅ | `tsconfig.base.json` |
| S-09 Adopt npm workspaces | ✅ | `workspaces: ["packages/*"]` — servers excluded **by decision**, ADR 0001 |
| S-10 TypeScript project references | ✅ | `composite: true` in the base; root references all five packages |

> S-09 is complete as designed, not half-done. The four duplicate `zod` /
> `@modelcontextprotocol/sdk` installs are the accepted cost recorded in ADR 0001, and
> they are why `instanceof` cannot be used across the package boundary.

## Phase D — Guard Rails · 3/3 ✅ (warn mode, as planned)

| Step | Status | Evidence |
|---|---|---|
| S-11 Guard scaffolding + convention guard | ✅ | `packages/cli/src/guards` |
| S-12 Dependency-rule guard | ✅ | same |
| S-13 Contract guard + platform no-LLM guard | ✅ | same; `guard:no-llm-runtime` also runs per-server |

Current output: **0 errors, 34 warnings across 334 files.** Warn mode is correct until
S-41 — flipping now would turn 34 warnings into 34 build failures.

## Phase E — Shared Core Extraction · 7/7 ✅

| Step | Status | Evidence |
|---|---|---|
| S-14 Create `@mcp/core` | ✅ | `packages/core/src` — zero-dependency tier L0 |
| S-15 Migrate env + redaction helpers | ✅ | `core/env.ts`, `core/redaction.ts` |
| S-16 ⭐ Extract `@mcp/approval` | ✅ | landed as `packages/shared/src/approval`, not a separate package |
| S-17 ⭐ Extract `@mcp/sql-guardrails` | ✅ | landed as `packages/shared/src/sql` |
| S-18 Reconcile guardrail token lists | ✅ | `docs/adr/0002-sql-guardrail-token-lists.md` — **decision: no change**; pinned by two tests |
| S-19 Extract `@mcp/http-client` | ✅ | `packages/shared/src/http` |
| S-20 Migrate error taxonomy + profiles | ✅ | `core/errors.ts`, `core/profiles.ts` |

> S-16/S-17/S-19 were planned as three packages and shipped as three directories inside
> `@mcp/shared`. Same tier, same dependency rules, one fewer `file:` edge per server.

## Phase F — Tool Builder and SDK · 5/5 ✅

| Step | Status | Evidence |
|---|---|---|
| S-21 Create `@mcp/tool-builder` | ✅ | landed as `packages/sdk/src/defineTool.ts` |
| S-22 Create `@mcp/sdk` | ✅ | `packages/sdk` — the only importer of the protocol SDK |
| S-23 Pilot: `bitbucket-mcp` onto the SDK | ✅ | `docs/migration/s06-s23-notes.md` |
| S-24 Migrate `observe-mcp` | ✅ | `e5feaf3` (labelled S-25) — `s25-notes.md` |
| S-25 Migrate `postgres-mcp` | ✅ | `0eccb10` (labelled S-24) — `s24-notes.md` |

## Phase G — codebase-index Internal Cleanup · 4.5/5

> **Correction.** An earlier revision of this file marked S-26 done on the strength of
> checking approval and the SQL guardrails. That check missed a third shadow: the watch
> lifecycle existed **twice** — `activateWatchForRepo`, `armWatchInactivityTimer` and
> `clearWatchInactivityTimer` in both `index.ts` and `handlers/indexHandler.ts` — with
> which copy ran depending on how the watcher was triggered (`watch_repo` used the
> handler's; boot auto-start, per-call auto-activation and the idle callback used the
> entry point's). The two had not drifted, but they shared mutable state while being
> separately editable. S-27 merged them, so the row is now accurate for a different
> reason than it originally claimed.


| Step | Status | Evidence |
|---|---|---|
| S-26 Delete shadow implementations | ✅ | approval and SQL guards delegate to `@mcp/shared` everywhere; the last shadow — a duplicated watch lifecycle — was removed by S-27 |
| S-27 Extract the watch lifecycle | ✅ | `src/watch/watchLifecycle.ts`; the duplicate copies in `index.ts` and `handlers/indexHandler.ts` are gone |
| S-28 Extract indexing orchestration | ✅ | `9ccae95` (labelled S-26) — `src/indexing/{indexRunner,runPolicy}.ts` |
| S-29 Break the `graphStore`→`regexSearch` cycle | ✅ | `RegexSearchStore` interface in `src/regexSearch.ts`; static scan reports **0 cycles** across 66 modules |
| S-30 Split `graphStore.ts` | 🟡 | `find_impact_files` fix **done**; split done, 1,928 → 810 across 4 modules, but 810 > the 600 cap and cannot go lower as a façade — see below |

## Phase H — codebase-index SDK Migration · 0/3

| Step | Status | Notes |
|---|---|---|
| S-31 Install the coexistence adapter | ❌ | **unblocked** — the SDK prerequisite is built |
| S-32 Migrate 43 tools in 5 batches | ❌ | |
| S-33 Delete the legacy dispatch switch | ❌ | |

**Prerequisite done.** The three capabilities `@mcp/sdk` was missing shipped as two hooks
— `renderResult` and `wrapCall` — with 15 tests (sdk 50 → 65). See `s26-s29-plan.md` §S-28.

The dangerous one was serialization: telemetry is emitted inside `asTextCore`, so a naive
migration would silently stop all success-path telemetry while producing byte-identical
responses. Neither the contract snapshot nor a response replay would have revealed it.
`renderResult` is the seam that prevents it, and S-32's verification must still assert
that telemetry is actually emitted — the tests prove the hook works, not that the server
wires it up.

## Phase I — Manifest Generation · 0/3

| Step | Status | Evidence |
|---|---|---|
| S-34 Convert manifest to `@mcp/manifest` | ❌ | still `scripts/lib/manifest.mjs`; no `packages/manifest` |
| S-35 Generate `.env.example` | ❌ | four `.env.example` files exist but are hand-written — no generator |
| S-36 Generate README/skill tables + tool lists | ❌ | no generator found |

## Phase J — Conventions and Housekeeping · 2/5

| Step | Status | Evidence |
|---|---|---|
| S-37 Normalize folders + `.gitignore` | ✅ | `3f5b702`, `docs/migration/normalization-report.md` (48 files) |
| S-38 Server scaffold generator | ❌ | no scaffold script |
| S-39 Consolidate the test strategy | 🟡 partial | script vocabulary is uniform and `run-tests.mjs` discovers `test:*` so the list cannot fall behind — but no strategy document exists |
| S-40 Index registry + workspace hygiene | ✅ | `*.db`, `*.db-shm`, `*.db-wal` gitignored; central DB at the root is untracked |
| S-41 Flip guards to enforce; finalize docs | ❌ | would fail on the 36 current warnings; needs the graphStore cap decision above, plus 11 other files over 600 lines |

## Phase K — Deferred Decisions · 0/3 (1 skipped)

| Step | Status | Evidence |
|---|---|---|
| S-42 Move servers into `servers/` | ⏭ skipped by decision | recorded in the plan |
| S-43 Unify env prefixes | ❌ | still mixed: `CODEBASE_INDEX_*`, `PG_*`, `OBSERVE_*`, `BITBUCKET_*`, and `CH_*` shared by two servers |
| S-44 Rename the `codebase-index-local` key | ❌ | key still in `scripts/lib/manifest.mjs` |

---

## What actually blocks progress

Everything left splits into three groups, and only one is hard.

**Hard — Phase H.** Needs the three SDK capabilities built first (S-31's real prerequisite),
and Phase G's remaining structural work is what makes the 43-tool migration reviewable.
Order: S-27 → S-29 → SDK capabilities → S-31…S-33. S-30 (splitting `graphStore.ts`, 8 PRs)
can run in parallel and is what unblocks S-41.

**Mechanical — Phase I and S-38.** Generators over `scripts/lib/manifest.mjs`, which is
already the single source of truth. Low risk, no behaviour change, independently
verifiable by diffing generated output against the committed files.

**Deferred by decision — Phase K.** S-43 and S-44 both break existing user configuration
in `~/.claude.json`. They were placed last on purpose and should stay there.

## Resolved — `find_impact_files(view:"files")` did not scale (was: open defect)

**Fixed in S-30.** Commit `896a968`. Recorded here because the original diagnosis in this
document was partly wrong, and the corrected mechanism is worth keeping.

Measured before the fix, on one file, same index, same profile:

| Call | Time |
|---|---|
| `find_impact_files` `view:"files"` | **216,216 ms** |
| the same call again | 216,039 ms — deterministic, nothing is cached |
| `find_impact_files` `view:"surface"` | 1,462 ms |
| `get_file_summary` | 2,520 ms |

### What this document previously claimed, and what was actually true

It said `e.repo_id = s.repo_id` "does not filter before the scan, so repos that have
nothing to do with the query still cost time". That is **not** what happens. `EXPLAIN QUERY
PLAN` shows SQLite did constrain `edges` by `repo_id` through
`idx_edges_repo_type_to_from` — cross-repo rows were excluded.

The real cause was the join *order*. With the six-way `OR` predicate unindexable beyond the
`repo_id` prefix, SQLite chose the **caller** symbol table as the outermost loop, making the
query approximately

```
|symbols in repo| × |symbols in target file| × |edges in repo|
```

For `src/graphStore.ts` — 107 symbols, in a repo with 1,752 symbols and 5,089 edges — that
is ~950 M predicate evaluations, each doing string concatenation and in one branch a `LIKE`.
Measured 15.5 s on that index; the 216 s figure came from a larger one. The 148× gap against
`view:"surface"` was the same predicate under a `limit` that let it stop early.

So the multi-repo framing was a red herring: a **single** large repo was always enough to
trigger this. That is worse than what was originally written, not better.

### The fix

`buildEdgeToSymbolJoinClause()` became `buildEdgeToSymbolPairsCte(symbolFilter)`: the same
six alternatives as a `union` of one branch each, so the planner picks an index per branch,
plus `cross join` to pin the driver to the small `symbols` side (without `ANALYZE` stats it
cannot tell that the symbol filter selects few rows).

Verified by diffing old against new over all 229 files of a workspace index, through the
full `getImpactFilesImpl` path including its aggregation:

```
files compared: 229    mismatches: 0    aggregate speedup: 650x
src/graphStore.ts      15,487 ms → 3.5 ms
```

Pinned by `test:impact-join-parity`, which checks results against the frozen old predicate
**and** asserts the plan shape — six index seeks into `edges`, no full scan, no branch
constrained by `repo_id` alone. The plan is what regressed, and a results-only test cannot
see it.

Two things this also removed: the 180 s timeout override in `test-profile-responses.mjs`
(added during S-25, masking rather than fixing), and a silent skip in that script's
`get_call_chain` block, which asked `search_symbols` for a `symbolId` under a profile that
projects it away.

## S-30 second half — the `graphStore.ts` split

`graphStore.ts` 1,928 → **810** lines across four new modules, each extraction verified by
typecheck + `--noUnusedLocals` + build + smoke + the full 27-script suite:

| Module | Lines | What |
|---|---|---|
| `src/store/schema.ts` | 486 | `initGraphSchema`, `runGraphMigrations` |
| `src/store/writeStore.ts` | 409 | per-file writes, WAL session, bulk index maintenance |
| `src/store/graphQueries.ts` | 300 | the seven reads that were still inline SQL |
| `src/store/runStore.ts` | 154 | `index_runs` write + latest-run read |

**Still 810, not under the 600-line hard cap — and it cannot get there as a façade.** What
remains is 155 lines of imports plus 100 delegating methods averaging 6.4 lines. Even
compressed to a bare 3-line body plus a blank each, the floor is ~590 before comments or the
constructor. The plan's Phase G exit gate asks for two things that cannot both hold:

- "the façade keeps every existing call site unchanged" — 158 call sites across ~100 methods
- "no class exceeds 25 methods" — prose only; nothing measures method count, the guard
  measures file lines

A façade over N stores *is* N groups of delegating methods. Three ways out, none of them
free:

1. **Exempt the file, explicitly.** The guard has no exemption facility today. Adding a
   pragma it honours and reports (`// @convention-exempt size/hard-cap: <reason>`) makes
   "we decided this file may be long, here is why" reviewable instead of invisible — and
   S-41 needs an answer for the other 11 oversized files regardless.
2. **Split the façade into sub-facades** — `store.docs.searchDocs(...)`, `store.write.…`.
   Gets every file well under the cap, changes ~158 call sites.
3. **Mixins** — `class GraphStore extends DocsMixin(WriteMixin(Base))`. Keeps call sites,
   splits files, and makes the class harder to read than either alternative.

Unresolved; needs a decision before S-41 can flip guards to enforce.

## Gate status at time of writing

```
verify:all            exit 0 — 4/4 servers, test phase 60.9s (was 398s and failing)
guards                0 errors, 36 warnings, 342 files
                      (+2 vs S-29: the split traded one hard-cap file for two
                       soft-cap ones, and graphStore.ts is still over the hard cap)
4/4 servers           build · typecheck · test
contracts:check       4/4 — 43 / 17 / 8 / 8 tools
```
