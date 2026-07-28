# Migration status — all 44 steps

**Verified** 2026-07-28 against the working tree, not from memory. Baseline `9ccae95`;
Phase H's row updated after the S-28 SDK work landed. Every
row cites the artifact that proves it. Where no artifact was found, the row says so
rather than guessing.

**29 of 44 done · 1 partial · 1 skipped by decision · 13 open.** Phase H is nearly done:
S-31 and S-32 both landed 2026-07-28. All 43 codebase-index tools are on the SDK registry and
the `switch` is down to its unknown-tool branch; only S-33 is left.

S-31 also found `benchmark:plan:check` — a hard CI step — **already failing on `main`**, for
two reasons that had nothing to do with the migration. Both fixed; see
[the benchmark gate](#the-benchmark-gate-was-red-before-s-31) below.

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

## Phase G — codebase-index Internal Cleanup · 5/5

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
| S-30 Split `graphStore.ts` | ✅ | `find_impact_files` fix + split (1,928 → 831 across 4 modules) + a declared, reported guard exemption for the façade — see below |

## Phase H — codebase-index SDK Migration · 2/3

| Step | Status | Notes |
|---|---|---|
| S-31 Install the coexistence adapter | ✅ | `a441500` (descriptor table) + `a281358` (`createMcpServer` + bridge). Contract byte-identical; **one behaviour change found later, see the S-32 note** |
| S-32 Migrate 43 tools in 5 batches | ✅ | `5b8faeb` · `37c2c3e` · `ed145f1` · `ef20f67` + this commit. All 43 on the registry; `switch` reduced to the unknown-tool branch |
| S-33 Delete the legacy dispatch switch | ❌ | the switch is already empty — what is left is a **decision**, see below |

**Prerequisite done.** The three capabilities `@mcp/sdk` was missing shipped as two hooks
— `renderResult` and `wrapCall` — with 15 tests (sdk 50 → 65). See `s26-s29-plan.md` §S-28.

The dangerous one was serialization: telemetry is emitted inside `asTextCore`, so a naive
migration would silently stop all success-path telemetry while producing byte-identical
responses. Neither the contract snapshot nor a response replay would have revealed it.
`renderResult` is the seam that prevents it, and S-32's verification must still assert
that telemetry is actually emitted — the tests prove the hook works, not that the server
wires it up.

### S-31 · what the server actually keeps

`src/index.ts` is now configuration and construction only (556 → 211 lines). `src/server.ts`
holds the `createMcpServer` call; `src/tools/legacyDispatch.ts` holds the 43-branch `switch`
verbatim, so S-32 deletes branches from one file and S-33 deletes that file.

The registry is empty and `LegacyBridge.has()` answers `true` unconditionally. That is
deliberate: during coexistence the switch is the **terminal** handler, and its `default:`
branch is this server's unknown-tool rejection — an `isError` result carrying `MCP_ERROR` and
`-32601`, not a JSON-RPC error. Left to the platform default it would have become `not_found`
with a different payload. **bitbucket-mcp accepted exactly that delta in its own migration**
(`sdk.test`: "DELTA: an unknown tool now reports not_found instead of mcp_error"), so the
precedent for changing it exists — but 43 tools in daily use is a different risk, and S-33
has to make that call deliberately rather than inherit it from a deleted `switch`.

Four behaviours carried by the hooks, none of them visible in a `tools/list` snapshot:
`formatError` (the `{code, message, requestId}` envelope, pretty-printed at *every* profile,
including `nano`), `renderResult` (wired now though unreachable while the registry is empty —
the first migrated tool would otherwise silently lose telemetry), `wrapCall` (the
`AsyncLocalStorage` scope, plus `maybeAutoActivateWatchFromArgs` guarded so a failure there
still renders the normal envelope), and `resources` (the four `repo://` URIs and the
capability declaration).

`progressNotifier` is set **only** when the host supplied a progress token. `CallContext`
always offers `reportProgress`, but passing it unconditionally would make the indexer believe
someone is listening and compute a progress snapshot per batch that goes nowhere.

Proven by `test:server-envelopes` (31 assertions), **written against the pre-migration server
and passing there first** — a test authored after a refactor only proves the refactor agrees
with itself. The plan's own last check was run too: with `list_repositories` alone registered,
it was served by the registry (`{"servedBy":"registry"}`, annotations present, still 43 tools)
while the other 42 went to the switch and the unknown-tool envelope was unchanged. That probe
was reverted — registering it for real is S-32 batch 1.

One SDK gap this found: `ResourceProvider.list()` took no cursor, so migrating would have
silently dropped this server's "any cursor → empty page" behaviour. The parameter is now
optional, which keeps postgres-mcp's zero-argument provider valid.

### S-32 · all 43 tools, in five batches

Five commits, in the plan's risk order: read/metadata (8) `5b8faeb`, search (9) `37c2c3e`,
graph/impact (12) `ed145f1`, indexing/watch (4) `ef20f67`, refactor (10) last.

Nothing was rewritten. Each tool pairs the zod schema it always had — **imported** from
`schemas/toolSchemas.ts`, so validation, `.strict()` rejection, defaults and the `.refine()`
cross-field rules are the same objects — with the JSON Schema moved out of the descriptor table
unedited. Every batch's contract diff was checked tool by tool, not just by count: 43 → 43,
names identical, only the migrated tools changed, and their only change was gaining
`annotations`.

**Every tool is `rawResult: true`, and that is a finding rather than a shortcut.** The handlers
resolve their own profile through `resolveResponseProfile(profile, compact)`; dispatch resolves
it from the raw arguments. Those disagree. `list_repositories` declares
`profile: …default("compact").optional()`, and `.optional()` short-circuits an absent value
*before* the default applies — so `profile` reaches the handler as `undefined` and it answers at
**standard**. Letting dispatch serialize would have answered at `compact`: same tool, smaller
response, and neither `tools/list` nor a response replay could show which was intended.
`get_file_context` has the same exposure via the legacy `compact: true` boolean. There is now a
test asserting `list_repositories` reports `profile=standard` in its telemetry line — the only
place the resolved profile is observable at all. Converting a handler to return a plain payload
is a separate, per-handler change; `renderResult` is the seam waiting for it.

**Annotations are a real contract addition.** Legacy descriptors carried none and `defineTool`
requires them, so all 43 tools gained an `annotations` object across S-32. Deliberate, and the
same outcome postgres-mcp's migration had. Most are `readOnly + idempotent + local`;
`openWorld: false` throughout, because this server touches only the local filesystem and a local
SQLite file — the one field where copying postgres-mcp's presets would have been wrong. The
judgement calls are documented on the presets in `tools/common.ts` and asserted field-by-field:

| tool | readOnly | idempotent | destructive | why |
|---|---|---|---|---|
| `index_repository` | no | yes | **yes** | replaces symbols/edges, prunes on `mode:"full"` — but only derived state, rebuildable from source |
| `watch_repo` | no | yes | no | starts/stops a watcher; removes nothing. A running watcher later triggers re-indexes, but the hint describes the *call* |
| `refactor_replace_apply` | no | no | **yes** | the only tool that edits the user's source files |
| `refactor_replace_rollback` | no | yes | **yes** | overwrites working-tree files too; being the undo does not make it safe unprompted |
| `refactor_replace_preview`, `rename_assist`, `refactor_symbol_migration`, `change_value_representation` | yes | **no** | no | write no source, but mint a previewId + approval token per call |

#### Correction: S-31 did change one behaviour

The S-31 commit claimed the migration was provably behaviour-preserving. That held for the
contract and for everything the 31 assertions covered, but it missed one path, found while
migrating the refactor batch.

The pre-SDK `switch` used `return await` for `refactor_symbol_migration` and
`change_value_representation` — with a comment explaining why — but a plain `return` for
`refactor_replace_apply`. Inside a `try`, a plain `return` of a promise does **not** route its
rejection to the `catch`. `handleRefactorReplaceApply` rejects on four reachable paths (unknown
previewId, `PREVIEW_EXPIRED`, `AMBIGUITY_THRESHOLD_EXCEEDED`, unknown repo).

Measured, not reasoned — the same call against a build of `a441500` and against current:

| build | `refactor_replace_apply`, bad previewId | `refactor_symbol_migration` (used `return await`) |
|---|---|---|
| `a441500` (pre-S-31) | raw **JSON-RPC error** | `isError` envelope |
| current | `isError` envelope | `isError` envelope |

S-31 moved the try/catch into the SDK's dispatch, which awaits the bridge — so all three now
report the envelope. **Kept, as a fix.** The old behaviour lost the `PolicyViolationError` code
into an opaque protocol error and was inconsistent with the other 42 tools *and* with its own two
siblings; the missing `await` reads as an oversight, not a decision. Pinned by a test now.

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
| S-41 Flip guards to enforce; finalize docs | ❌ | would fail on the 35 current warnings; the graphStore cap is settled, but 11 other files are still over 600 lines |

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

**831 lines, over the 600-line hard cap — deliberately, and now declared.** What remains is
155 lines of imports plus ~100 delegating methods averaging 6.4 lines. Even compressed to a
bare body plus a blank each, the floor is ~590 before comments or the constructor.

This surfaced a conflict in the plan's own Phase G exit gate, which asks for two things that
cannot both hold:

- "the façade keeps every existing call site unchanged" — 158 call sites across ~100 methods
- "no class exceeds 25 methods" — prose only; nothing measures method count, the guard
  measures file lines

A façade over N stores *is* N groups of delegating methods. **Resolved by giving the guard an
exemption facility** rather than by pretending the cap fits:

```ts
// @convention-exempt size/hard-cap: <reason>
```

The exemption is reported, not silent — it comes back as an `info` finding with the reason
attached, and `info` never affects the exit code, including under `--strict`. Three things are
refused by design: only the two size caps are exemptable (`logging/console-log` catches a write
to the MCP transport, and no reason makes that acceptable); a reason-less pragma is an error;
and an exemption that suppresses nothing is a warning, so the pragma is deleted when the file
is finally split.

Two alternatives were rejected: sub-facades (`store.docs.x`) change 158 call sites for no
behavioural gain, and mixins split the files while making the class shape harder to read.

Cohesion in `graphStore.ts` is now policed by a different rule than length — every method is a
one-line forward, and a body that grows past that belongs in a `store/` module.

Building the facility found two bugs in itself, both the same shape: a quoted example of the
pragma registering as a live exemption. The guard's own hint string exempted
`conventionGuard.ts` from its hard cap, and the test fixture exempted `cli.test.ts`. Fixed by
anchoring the pattern to the start of a line; both are now regression tests.

**The other 11 files over 600 lines in `codebase-index-mcp/src` are not exempted** — they are
genuine debt and still block S-41:

```
impactAnalyzer 1457 · edgeResolver 1423 · index 1351 · staticAnalyzer 1228
extractorUtils 1006 · csharpExtractor 970 · symbolSearch 797 · refactorEngine 701
indexPipeline 682 · refactorHandler 632 · toolSchemas 615
```


## The benchmark gate was red before S-31

`benchmark:plan:check` is a hard CI step (`.github/workflows/ci.yml`, no `continue-on-error`).
Measured at `a441500` it exited **4**. Neither cause was the migration; S-31 found them because
adding one test file moved a second one over its threshold.

**1 · The savings snapshot was comparing two different files.** The file-scoped scenarios took
their target from `search_symbols("runIndexAndResolve")[0].filePath`. The committed baseline
(`file-context: 0.0511`) was recorded when that resolved to `src/index.ts`; by `a441500` the
top hit had become `src/indexing/indexRunner.ts`, so the gate compared one file's ratio against
another's and reported a savings regression. On the *same* file savings had in fact **improved**
(0.0511 → 0.0439). The target is now pinned (`BENCH_CONTEXT_FILE`, default `src/graphStore.ts`).
Re-baselining was done by diffing every entry, not by blanket overwrite: only `file-context`
and `file-summary` moved beyond tolerance, both being the retargeted scenarios; everything else
was unchanged or better (`link-tests-to-source` 0.9435 → 0.7051).

**2 · The graph-accuracy gate could not tell a missed link from a dependency call.** It scored
every `CALLS` edge in the repo, so the metric was a function of how much library-calling code
the repo contained. The top "unresolved" tokens were `exit`, `fileURLToPath`, `callTool`,
`resume` — every one a call into a dependency with no symbol to resolve to. At 61.61% against a
floor of 60, adding one test script dropped it to 55.35% and failed a gate about the extractor
on a commit that touched no extractor code. Narrowing to `src/` does **not** fix it: `src/` is
full of zod builder chains (`string`, `optional`, `strict`, `refine`), which are the same thing.

The denominator is now **in-repo-resolvable** calls only — an edge counts if it is resolved, or
its unresolved token names a symbol that actually exists in the repo. That measures what the
gate claims: of the calls the extractor could have linked, how many did it link?

Result: **119 resolvable calls, 0 missed, 100%.** Verified non-vacuous rather than assumed —
the `exists` clause was confirmed to fire for a token that *is* a repo symbol
(`callee:asText` → match), and all 102 excluded edges were confirmed to name no repo symbol.
So the old 61.61% was reporting dependency calls as extractor failures.

**Follow-up, deliberately not done here:** `minResolvedCallEdgePct` is still 60 while the true
value is 100. A floor 40 points below observed is nearly inert, but raising a CI threshold off
a single measurement is how surprise failures get created. Tighten it once there are a few
runs' worth of evidence.

## Gate status at time of writing

```
verify:all            exit 0 — 4/4 servers, test phase 65.9s
guards                0 errors, 34 warnings, 1 accepted exemption, 364 files
                      (index.ts 556 → 214 lines, no size warning; its
                       env/direct-access warning is pre-existing and unchanged)
4/4 servers           build · typecheck · test
codebase-index tests  28/28 — test:server-envelopes grew 31 → 44 assertions
contracts:check       4/4 — 43 / 17 / 8 / 8 tools. codebase-index now carries
                      annotations on all 43; descriptions + schemas unchanged
smoke                 exit 0
benchmark:plan:check  exit 0 — savings 66.89% (floor 40), snapshot clean,
                      graph accuracy 100% (floor 60). Was exit 4 at a441500.
```

### What S-33 actually has to do

The switch is already empty — S-32 removed every `case`. `tools/legacyDispatch.ts` is 34 lines
holding one `throw`, and it exists for one reason: it is this server's unknown-tool answer, an
`isError` result carrying `MCP_ERROR` and `-32601`. The SDK's own path returns a `not_found`
`PlatformError` instead — different payload, different code. bitbucket-mcp accepted exactly that
delta in its migration (`sdk.test`: *"DELTA: an unknown tool now reports not_found instead of
mcp_error"*), so the precedent exists.

So S-33 is a decision, not a deletion: keep the file as the envelope keeper, or adopt
`not_found` and record the contract change. Deleting it without choosing is the one wrong
option — and the reason `LegacyBridge.has()` still answers `true` unconditionally.
