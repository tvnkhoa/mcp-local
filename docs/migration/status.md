# Migration status — all 44 steps

**Verified** 2026-07-28 against the working tree, not from memory. Baseline `9ccae95`;
Phase H's row updated after the S-28 SDK work landed. Every
row cites the artifact that proves it. Where no artifact was found, the row says so
rather than guessing.

**33 of 44 done · 1 partial · 1 skipped by decision · 9 open.** **Phase H is complete** —
S-31, S-32 and S-33 all landed 2026-07-28. All 43 codebase-index tools are on the SDK registry,
the legacy bridge is gone, and **all four servers now run on `@mcp/sdk`**. S-33 carried one
intended contract change (unknown tool → `not_found`); see [the S-33 section](#s-33--the-decision-and-the-one-contract-change).

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
| S-10 TypeScript project references | ✅ | `composite: true` in the base; root references all six packages (`manifest` added in S-34) |

> S-09 is complete as designed, not half-done. The four duplicate `zod` /
> `@modelcontextprotocol/sdk` installs are the accepted cost recorded in ADR 0001, and
> they are why `instanceof` cannot be used across the package boundary.

## Phase D — Guard Rails · 3/3 ✅ (warn mode, as planned)

| Step | Status | Evidence |
|---|---|---|
| S-11 Guard scaffolding + convention guard | ✅ | `packages/cli/src/guards` |
| S-12 Dependency-rule guard | ✅ | same |
| S-13 Contract guard + platform no-LLM guard | ✅ | same; `guard:no-llm-runtime` also runs per-server |

Current output: **0 errors, 34 warnings, 1 accepted exemption across 384 files.** Warn mode is
correct until S-41 — flipping now would turn 34 warnings into 34 build failures.

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

## Phase H — codebase-index SDK Migration · 3/3 ✅

| Step | Status | Notes |
|---|---|---|
| S-31 Install the coexistence adapter | ✅ | `a441500` (descriptor table) + `a281358` (`createMcpServer` + bridge). Contract byte-identical; **one behaviour change found later, see the S-32 note** |
| S-32 Migrate 43 tools in 5 batches | ✅ | `5b8faeb` · `37c2c3e` · `ed145f1` · `ef20f67` · `b3454e1`. All 43 on the registry; `switch` reduced to the unknown-tool branch |
| S-33 Delete the legacy dispatch switch | ✅ | bridge and `legacyDispatch.ts` both gone; unknown tool now answers `not_found`. **One intended contract change** — see below |

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

> S-33 made that call: **adopt `not_found`.** The bridge and the file are gone. Kept here
> because it is the reason the bridge looked over-engineered for three commits.

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

## Phase I — Manifest Generation · 3/3 ✅

| Step | Status | Evidence |
|---|---|---|
| S-34 Convert manifest to `@mcp/manifest` | ✅ | `packages/manifest` (tier 5); `scripts/lib/manifest.mjs` is now a shim. Equivalence proved before the switch — see below |
| S-35 Generate `.env.example` | ✅ | `scripts/generate-env.mjs`; all four files generated. The manifest gained **48** vars it had never declared — see below |
| S-36 Generate README/skill tables + tool lists | ✅ | `scripts/generate-{tools,docs}.mjs`; `tools` derived from `contracts/` — 76, and the installed skills now advertise all of them |

### S-35 / S-36 · the env contract was wrong in every direction

**The numbers the plan predicted were optimistic.** It expected key counts of 7 / 19 / 12 / 9
(manifest / `.env.example` / README / skill) for one server and a reconciliation job. The actual
spread across all four:

| | manifest, before | `.env.example`, before | **read by the code** |
|---|---|---|---|
| `codebase-index-local` | 7 | 16 | **39** |
| `postgres-mcp` | 14 | 22 | **21** |
| `observe-mcp` | 12 | 21 | **23** |
| `bitbucket-mcp` | 8 | 9 | **11** |

The manifest declared **41 of 89**. Not one of the three sources agreed with another, and nothing
checked — which is exactly the condition S-35 exists to end, just larger than estimated.

#### How the real list was found

Not by grepping `process.env`. The migrated servers read env through
`createEnvReader(defaultEnvSource())` and local wrappers, so the keys appear only as string
literals inside calls like `env.string("OBSERVE_BASE_URL", …)`. A regex over `process.env` missed
27 of codebase-index's 39 vars, and a first attempt "found" `OBSERVE_BASE_URL` as *declared but
unread* — obviously false, which is what exposed the method as unsound.

What worked: boot each server with `process.env` replaced by a recording `Proxy` and capture every
key actually read, then read each call site for its true fallback. That found vars no static scan
would have — including `CODEBASE_INDEX_WATCH_ACTIVE_ONLY`, whose default is **`true`**, the only
boolean in that server that does not default to false.

#### `default` would have been the wrong field

`install-mcp` writes any field with a `default` (or `prompt`) into `~/.claude.json`, which *pins*
it. Declaring 48 tuning knobs with defaults would have written 48 lines into every user's agent
config and frozen them at today's values — so a later change to a code default would silently stop
applying.

Hence `codeDefault`: documentation only, never written anywhere. Those vars appear in
`.env.example` **commented out** and in the README marked *(code)*, and the installer stays silent.
A test asserts no field declares both.

#### Reviewing the diff caught three things worth keeping and one bug

The plan is explicit that the first generation is *"a diff to review, not to trust"*. Comparing
generated output against the committed originals found four keys that would have been dropped:

- **`NODE_TLS_REJECT_UNAUTHORIZED`** — real operational guidance for a self-signed query host.
  Not an observe-mcp variable, but preserved with a note that it disables certificate
  verification **process-wide**, not just for OpenObserve.
- **`PG_ENV_DEV` / `PG_ENV_STAGING` / `PG_ENV_PROD`** — the family's concrete members. The first
  renderer emitted only `PG_ENV_*`, which is worse than what it replaced: a reader still has to
  guess the suffix. `familyExamples` restores them.
- **`LARGE_FILE_THRESHOLD_BYTES`** — correctly dropped. The code reads only
  `CODEBASE_INDEX_LARGE_FILE_THRESHOLD_BYTES`; the un-prefixed name in the hand-written file
  **did nothing at all**. A documentation bug that had been sitting there being copied.

`PG_ALLOWED_ENVIRONMENTS` also tightened from `dev,staging,prod` to `dev` — the committed example
carried one developer's local convenience as though it were the default.

#### S-36 · the drift was worse than the plan's example

`tools` was hand-maintained and named 12 of `codebase-index-local`'s 43 and 16 of
`postgres-mcp`'s 17. The **installed skill** therefore advertised under a third of the largest
server, so a model reading it could not know most tools existed.

It is now generated into `src/generated/toolLists.ts` from `contracts/` — the committed
`tools/list` snapshots, which `contracts:check` already verifies against the running servers in
CI. Reading the snapshot rather than booting again keeps the generator free of a build dependency
on the manifest it writes into. After `mcp:update -- --all`, the installed skills list
**43 / 17 / 8 / 8 = 76**, matching `contracts/`.

READMEs get generated blocks between `<!-- BEGIN/END GENERATED: … -->` markers, and **only** the
contiguous env table and tool list are replaced. Two of these READMEs are in Vietnamese and
`codebase-index-mcp`'s carries a 60-line annotated tool catalogue that is more useful than any
generated list — replacing those wholesale would have been a downgrade dressed up as automation.

#### The gate, and proof it gates

`generate:check` runs inside `verify:all`, and `mcp:doctor` reports staleness per server as a
**warning** — stale docs do not stop a server from working, and the doctor reports state rather
than gating on it.

Verified by hand-editing a generated `.env.example`: `generate:check` exited **1**, `verify:all`
exited **1**, and the doctor showed `WARN generated stale: .env.example` against `observe-mcp`
alone. Reverted, both returned to 0.

---

### S-34 · the port, and the two things the plan did not account for

`packages/manifest` (tier 5, depends on `@mcp/core`) now holds `SERVERS`, `getServer`,
`serverKeys`, `evaluateEnv`, `WORKSPACE_ROOT`, `serverEntryPath`, `serverDirPath` and the four
types that were a single JSDoc `@type` comment. `scripts/lib/manifest.mjs` is a re-export shim,
as the plan specified.

**Equivalence was proved, not reviewed.** This data is what `~/.claude.json` gets written from,
so a silent change rewrites working agent configuration on the next install. A throwaway script
compared old and new side by side before the shim went in: identical export surface, identical
`WORKSPACE_ROOT`, `SERVERS` deep-equal, identical derived paths for all four servers, and
`evaluateEnv` identical across **73 observations** (nothing set, everything set, each var alone,
and four prefix-family variations per server). Then `mcp:doctor` output was diffed against a
baseline captured beforehand — **byte-identical**, same exit code.

#### The plan undercounted the consumers

It lists five (`install-mcp`, `mcp-doctor`, `uninstall-mcp`, `update-mcp`, `lib/skills`). There
are **seven**: `contract-snapshot.mjs`, `lib/cli.mjs` and `run-servers.mjs` also import it, and
`uninstall-mcp` reaches it through `lib/cli.mjs` rather than directly. The shim is why that
undercount cost nothing.

It also omits `WORKSPACE_ROOT` from the export list, which is the one export with a real hazard
attached — see below.

#### `guard:deps` did not enforce the rule the plan validates against

The plan's validation reads "`guard:deps` confirms **no server imports `@mcp/manifest`**
(dependency rule 5)". Nothing enforced that: the tier matrix governs imports *between packages*,
and a server is not a row in it. The server-scoped rules only covered `process.env` access and
cross-server imports.

So the rule was added — `servers/tooling-import`, an **error**, covering `@mcp/manifest` and
`@mcp/cli`. Unlike the env rule there is no migration legitimately violating it, so the first
occurrence is a defect rather than a countdown. Verified by injecting an import into
`observe-mcp` and confirming the guard reported it, then removing it and confirming the count
returned — a guard rule that has never failed is a guess.

#### `WORKSPACE_ROOT` is the fragile export

It counts `..` segments from its own module, so it depends on where that module sits at runtime.
Three levels is right for both layouts — `dist/` when `scripts/` loads it, `src/` when the tests
do — and it breaks *silently* if `dist` ever nests or the package moves. Type-checking cannot
see it, so the suite asserts the resolved directory really is the workspace root by looking for
`tsconfig.base.json` and the root `package.json` name.

#### A pre-existing fresh-clone break, fixed in passing

`npm run setup` was `node scripts/install-mcp.mjs` with no build step, while the per-server
builds it runs need `packages/*/dist` — which is gitignored. So `setup` could never have worked
on a fresh clone. It now runs `build:packages` first (`tsc -b`, ~1.3s incremental), as does
`mcp:install`.

The other entry points were left alone deliberately, `mcp:doctor` above all: a doctor that
refuses to run because something does not compile is the wrong tool. Instead the shim catches
`ERR_MODULE_NOT_FOUND` and re-throws with the actionable message, keeping the original as
`cause`:

```
@mcp/manifest is not built yet. Run `npm run build:packages` from the workspace root
(about 1s), then retry. Packages compile to gitignored dist/, so a fresh clone always
needs this once.
```

#### Found while porting, left for S-36

`tools` is a hand-maintained subset for the generated skill, not a real `tools/list`:
`codebase-index-local` names **12 of 43**, `postgres-mcp` **16 of 17**. Deriving it is exactly
what S-36 does, so the data was ported unchanged and the drift recorded in the package's README
instead of being quietly patched here.

Two guards and one test caught omissions during the work, each doing its job: the convention
guard required the package README, `tier/unknown-package` required the TIER_RULES row, and
`cli.test.ts` pins the package list exactly — so adding a package is a deliberate edit in three
places rather than an accident in one.

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
| S-44 Rename the `codebase-index-local` key | ❌ | key still in `packages/manifest/src/servers.ts` |

---

## What actually blocks progress

**Phase H is done, so the hard group is empty.** What remains is mechanical work plus two
deliberately deferred decisions.

**S-34 is unblocked, and by S-32 rather than S-33.** The plan blocks S-34 on S-33 "since
deriving tool lists requires every server to expose a registry" — but the registry held all 43
from the moment S-32's last batch landed, and `legacy.listTools()` was already returning `[]`.
The remaining blocker for S-41 is unchanged: eleven files in `codebase-index-mcp/src` are still
over 600 lines.

**Mechanical — S-35, S-36 and S-38.** Generators over `@mcp/manifest`, which is already the
single source of truth and, since S-34, typed. Low risk, no behaviour change, independently
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
verify:all            exit 0 — 4/4 servers, test phase 68.3s
guards                0 errors, 34 warnings, 1 accepted exemption, 362 files
                      (warning count unchanged by S-33; index.ts 556 → 211
                       lines, no size warning; its env/direct-access warning
                       is pre-existing)
4/4 servers           build · typecheck · test
codebase-index tests  28/28 — test:server-envelopes grew 31 → 44 → 46 assertions
contracts:check       4/4 — 43 / 17 / 8 / 8 tools, no drift. codebase-index
                      carries annotations on all 43; descriptions + schemas
                      unchanged
smoke                 exit 0
benchmark:plan:check  exit 0 — savings 66.89% (floor 40), snapshot clean,
                      graph accuracy 100% (floor 60). Was exit 4 at a441500.
guard:no-llm-runtime  passed — no model provider imports in runtime source
```

## S-33 · the decision, and the one contract change

S-32 left the `switch` empty, so S-33 was never a deletion — it was a choice between keeping
`tools/legacyDispatch.ts` as this server's unknown-tool envelope keeper, or adopting the
platform's `not_found`. **Decision: adopt `not_found`.** The bridge, the
`dispatchLegacyTool` option and the 34-line file are all gone; the registry is now the only
source of tools and an unregistered name reaches dispatch's own not-found path.

### The recorded delta

Captured from a real stdio call against the built server, before and after:

| | before | after |
|---|---|---|
| `code` | `MCP_ERROR` | `not_found` |
| `message` | `no_such_tool_at_all: MCP error -32601: Unknown tool: no_such_tool_at_all` | `no_such_tool_at_all: Unknown tool: no_such_tool_at_all.` |
| `requestId` | uuid | uuid (unchanged) |
| `isError` | `true` | `true` (unchanged) |

Still an `isError` **result**, not a JSON-RPC error — that was the part worth protecting, and it
did not move. Rationale for the change itself: `not_found` names the condition, whereas the old
message leaked a JSON-RPC error number into a tool *payload*. All four servers now agree, and
each pins it with the same `DELTA:` test.

`contracts:check` stays green at 43 tools: `tools/list` does not describe error payloads, which
is exactly why this delta needed a test and a doc entry rather than a snapshot diff.

### The trap that made this more than a deletion

Deleting the file alone does **not** produce `not_found`. Dispatch raises a `PlatformError`, but
this server supplies `formatError`, so the error is handed to `mapError` *before* the platform
can render it — and `mapError` knew only `ZodError`, `PolicyViolationError` and `McpError`. A
`PlatformError` fell through to the final branch, giving:

```
{ "code": "INTERNAL_ERROR", "message": "<tool>: Unknown tool: <tool>.", ... }
```

The worst of the three outcomes: it drops the old code, never produces the intended one, and
relabels a caller's mistake as a defect in this server. The fix is the `isPlatformError` branch
`mapError` now has — the same unwrap postgres-mcp's `toWireError` already did. Pinned by an
assertion that the code is *not* `INTERNAL_ERROR`, because that failure mode is silent: it is a
plausible-looking envelope with a plausible-looking message.

### What did not change

`MCP_ERROR` is **not** retired. It is the code for any `McpError` a handler throws, and those
paths are untouched — verified on the same probe run:

```
refactor_replace_apply, bad previewId
  { "code": "MCP_ERROR", "message": "refactor_replace_apply: MCP error -32602: ... not found." }
```

The delta is narrowly the unknown-tool case, not a vocabulary change.

Before committing, the workspace was searched for anything else depending on the old envelope.
Only the test and this document did; the remaining `-32601` hits are the other three servers'
own `DELTA:` comments and migration notes — historical record, not dependants. No skill, client
config or manifest referenced it.

### One cosmetic consequence, left alone

The message now names the tool twice — `no_such_tool_at_all: Unknown tool: no_such_tool_at_all.`
— because `mapError` prefixes every message with the tool name and the platform's own text
already includes it. Removing the prefix for just this code path would make the unknown-tool
envelope the only one shaped differently, which is a worse trade than the repetition.

### Where the plan and reality diverge

The plan lists two more validation items for S-33 that it cannot deliver:

- **`index.ts` < 60 LOC.** It is 211. The 2,051 → 214 reduction already happened in S-31; the
  remaining 211 lines are env constants, `buildHandlerContext`, and the shutdown hooks. Getting
  under 60 means relocating config to another module — motion with real risk (env read timing,
  and two callbacks that are lazy *on purpose*) for no benefit beyond hitting a number no guard
  enforces. The convention guard's cap is 600 and reports no finding.
- **`guard:convention` reports zero oversized files in `codebase-index-mcp`.** Not achievable
  here and never was: `impactAnalyzer` (~1,457), `edgeResolver` (~1,423), `staticAnalyzer`
  (~1,228) and eight others predate this phase. That is S-41's blocker, not S-33's work.
