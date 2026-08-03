# Post-Migration Backlog

**Created** — 2026-07-29
**Baseline** — `32f2a82`, working tree carrying the MCP-ISSUE-031/033 dead-code fixes
**Refreshed** — 2026-08-03. **Nine of fourteen items are closed** (B-01, B-01b, B-02, B-02b, B-07,
B-08, B-09, B-12 done; B-10 won't-do with its underlying defect fixed). Every closed row cites the
commit, command or registry entry that proves it. **Five remain open — B-03, B-04, B-05, B-06 and
B-11** — and two of those cannot be closed by writing code at all: B-04 needs measurements spread
across several commits, B-05 needs real credentials provisioned as CI secrets.
**Input** — the post-migration assessment of `docs/migration/status.md` §, re-measured against the
working tree rather than restated from the migration docs

> The migration is complete (43/44, S-42 skipped by decision). This document is **not** a
> continuation of it. It collects what the migration *left*, plus what the newly-working tools
> revealed once they started returning results.

## The shape of what remains

Every item below is one of three things, and the distinction decides the priority:

1. **A tool reports something untrue.** Highest priority — an agent acts on the output.
2. **A gate exists but does not bite.** Second — the safety net is nominal, and nobody knows until
   a regression walks through it.
3. **A cost, not a defect.** Last — real, but nothing is wrong today.

The migration built the gates. What it did not do is prove each one *fails* on the thing it claims
to catch — that was only done for the guards (`scripts/prove-guards.sh`). Most of this backlog is
finishing that job on the remaining gates.

## Conventions inherited from the migration plan

Same three hard requirements, same fields, so this document reads the same way:
**reversible** (one item = one commit = one `git revert`) · **independently testable** (validation
passes on that item alone) · **low risk** (blast radius named). Reversibility classes R1–R4 per
`migration-plan.md` §1.3.

Two additions the migration learned and this backlog adopts:

- **An investigation is its own item.** B-01 and B-02 have unknown fix size. Each is split into a
  fixed-cost **diagnosis** that produces a decision record, and a fix that is only scoped after it.
  Same pattern as the S-07 throwaway spike.
- **Measure, do not reason.** Every validation below is a command or a recorded observation, not a
  review. This is the one methodology from the migration worth keeping verbatim: it caught five
  shared-package defects before any consumer existed, and four tests that passed for the wrong
  reason.

---

## P1 — A tool reports something untrue

### B-01 · Diagnose why C# `TYPE_REF` edges are almost never produced — ✅ DONE 2026-07-30

**Outcome** — the loss was at **extraction**, and the answer was sharper than the question expected:
`emitTypeRefEdge` had *exactly one call site in the whole extractor*, the base class inside a
`base_list`. Every other type position emitted nothing. Resolution was not at fault — of the 148
edges that did exist, the 110 unresolved ones were all framework base types (`DbContext`,
`Exception`, …) that legitimately have no symbol in the repo.

Filed as MCP-ISSUE-034 (`c68bda5`); the registry entry
(`codebase-index-mcp/docs/mcp-codebase-index-issue-registry.md`) now carries the confirmed root
cause and is marked **FIXED**. The original text is kept below because the method — enumerate the
surviving edges exhaustively and classify each target — is the part worth reusing.

**Purpose**
Decide whether the loss is at extraction or at resolution. Nothing else. The fix is B-01b, scoped
after this answers.

**Why first**
`dead_code_scan` only started returning results on 2026-07-29 (MCP-ISSUE-033), and its first real
output was mostly wrong: 784 of 792 C# type declarations (**99.0%**) have zero incoming `TYPE_REF`,
so every type it reports is unproven. It also silently degrades `find_impact_files` view
`"surface"` — the 0.75-confidence rows *are* `TYPE_REF` — and `get_change_context` blast radius for
types. An agent following `mcp-hard-mode` reads those as evidence.

**Files affected**
- `src/services/extractors/treeSitterExtractor.ts` — read only: does it emit `type:` placeholders for
  declarations, fields, parameters, return types?
- `src/services/graph/edgeResolverRefs.ts` (`resolveTypeRefEdges`) — read only: does it match them?
- `codebase-index-mcp/docs/mcp-codebase-index-issue-registry.md` — MCP-ISSUE-034 updated with the
  answer

**Risk** — **Low.** Read-only investigation; no source behaviour changes.

**Rollback** — R1.

**Validation**
- The 22 `TYPE_REF` target symbols on `wec.communication-hub` are enumerated exhaustively, and each
  is classified as *emitted and resolved* / *emitted, not resolved* / *never emitted*
- For at least three types known to be live (`ValidationException`, `RequestContext`,
  `NormalizedMessageContent`), the missing edge is traced to a specific line in one of the two files
- The registry entry states which phase loses the edge, with the observation that proves it

**Complexity** — **M** (1–2 d)

---

### B-01b · Fix C# `TYPE_REF` extraction/resolution — ✅ DONE 2026-07-30

**Shipped in three commits, then a fourth.** Signature positions first (`266d91b`), a memoization
pass when type resolution turned out to cost 112 s (`9574e3e`, back to 11.5 s), then body positions
(`f1c0160`) — **falsely-dead type declarations down 48%** on `wec.communication-hub`.

The fourth is the interesting one. MCP-ISSUE-038: the `very-large` performance profile discarded
every *unresolved* `TYPE_REF`, so on the biggest repo — `wec.be`, 7528 files, which auto-selects
that profile — the fix was **inert** until `9b55de4`. A fix measured on a mid-sized repo can be
switched off by a profile on the repo that motivated it.

`dead_code_scan` no longer reports `ValidationException`, `RequestContext` or
`NormalizedMessageContent`. The rule was **not** narrowed to exclude `TYPE_REF`, as this item
required.

**Purpose** Produce the missing edges.

**Depends on** B-01. Scope unknown until then — do not estimate it here.

**Validation** (the shape it must take, whatever the fix is)
- Re-index `wec.communication-hub`; the share of type declarations with zero incoming `TYPE_REF`
  drops from 99.0% to a stated, justified figure
- `dead_code_scan` no longer reports `ValidationException`, `ForbiddenAccessException`,
  `RequestContext`, `N8nChatDecisionRequest`, `NormalizedMessageContent`
- A test pins the count on a small C# fixture, **not** on a real repo — MCP-ISSUE-032 makes any
  exact edge assertion on a large C# repo latently flaky until B-02b lands
- **Do not** narrow `dead_code_scan`'s rule to exclude `TYPE_REF`. That hides the gap instead of
  closing it (registry, MCP-ISSUE-034)

---

### B-02 · Locate the extraction-time nondeterminism — ✅ DONE 2026-07-30

**It was not a lookup.** The divergence came from comparing tree-sitter nodes with `===`
(`b764b39`): the binding hands out wrapper objects around the same native node and keeps only a
*weak* cache of them, so `===` held or did not hold depending on whether the previous wrapper had
been collected — not on anything in the tree. Five such sites: four found first, then a fifth plus
nine unordered reads on 2026-07-30 (`ae1af79`). Pinned by `test:node-identity`.

This is why the item insisted on a negative control. The three hypotheses it had already ruled out
by measurement — glob order, worker concurrency, unordered `LIMIT`s — were all *plausible*, and the
`.sort()` that "fixed" glob order was still in place while the variance continued.

**Purpose**
Find the one lookup that makes two identical runs disagree, and prove it is the one.

**Why now**
Three causes are already ruled out by measurement — glob order (the `.sort()` landed and variance
survived), worker concurrency (`PARSE_WORKERS=0` still varies), and the six unordered `LIMIT`s in
`src/services/graph/` (fixed; variance survived). The remaining evidence is sharp: identical batch
composition, identical symbol count, **103 more edges** in the same batch. So the nondeterminism is
inside extracting one file's edges.

This is the item that blocks *measurement itself*. While it is open, no edge-count delta is
evidence, and the workaround — run the same build twice to establish a noise band — has to be
applied by hand every time anyone validates a graph change. It already invalidated one C# before/
after comparison that looked like a 237-edge regression.

**Files affected**
- `src/repositories/`, `src/services/search/` — ~175 candidate `LIMIT`-without-`ORDER BY` sites, read only
- Instrumentation is throwaway, not committed

**Risk** — **Low.** Investigation.

**Rollback** — R1.

**Validation**
- The divergent lookup is named, with two runs' logs showing it returning different rows for the
  same input
- A **negative control**: pinning that one call site makes two runs agree on `edgesUpserted`, and
  reverting the pin makes them disagree again
- **Do not** add `ORDER BY` to all ~175 sites. Blanket ordering broadens tool-output changes and
  puts sort cost on the hot path — the registry already rejects that approach

**Complexity** — **M** (1–2 d)

---

### B-02b · Make an index run reproducible — ✅ DONE 2026-07-30

`ae1af79`. MCP-ISSUE-032 is **CLOSED**: all nine edge types reproduce exactly across three full
runs of `wec.communication-hub`, with vectors on and off.

**This is the item that unblocked measurement.** While it was open, no edge-count delta was
evidence and every graph change had to be validated against a hand-run noise band. That workaround
is retired, not reworded — so B-01b's before/after numbers above, and any future one, mean what
they say.

**Purpose** Two runs of one build on one unchanged tree produce identical counts.

**Depends on** B-02.

**Validation**
- Three consecutive runs on `wec.communication-hub` report identical `symbolsUpserted` **and**
  `edgesUpserted`, per edge type
- A harness asserts it, so the property cannot silently regress
- The MCP-ISSUE-032 workaround note is removed rather than reworded — it is the thing being retired

---

### B-03 · One profile resolution, not two

**Purpose**
Make the profile a tool answers at be the profile the caller asked for.

**Why**
All 43 `codebase-index` tools are `rawResult: true`, so each handler resolves its own profile via
`resolveResponseProfile(profile, compact)` while dispatch resolves it from raw arguments — and the
two disagree. `list_repositories` declares `.default("compact").optional()`; `.optional()`
short-circuits before the default applies, so `profile` reaches the handler as `undefined` and it
answers at **standard**. Dispatch would have answered at `compact`: same tool, smaller response.
`get_file_context` has the same exposure through the legacy `compact: true` boolean.

Neither `tools/list` nor a response replay can see this — the resolved profile is observable only
in one telemetry line. That is exactly why it is still here after a migration that checked
everything else.

**Files affected**
- `src/tools/handlers/` — convert handler by handler to return a plain payload; `renderResult` is the seam
  already waiting for it (S-31)
- `src/tools/` — drop `rawResult: true` per converted tool
- Start with `list_repositories` and `get_file_context`, the two with measured exposure

**Risk** — **Medium.** Response *size* changes for any caller that omitted `profile`. Contract shape
does not, so `contracts:check` will stay green — which means this needs its own before/after capture
per tool, in the migration's replay style.

**Rollback** — R2, per tool.

**Validation**
- Per converted tool: a recorded call with `profile` omitted, before and after, with the resolved
  profile and the byte size stated
- The existing telemetry assertion for `list_repositories` is updated to the intended profile, not
  deleted
- `contracts:check` 4/4 · `npm run test` green
- Each conversion is a separate commit — 43 tools in one commit is the thing the SDK migration
  deliberately avoided (S-32 used five batches)

**Complexity** — **S per tool** (start with 2; decide on the rest from what they cost)

---

## P2 — A gate that does not bite

### B-04 · Raise the graph-accuracy floor to something that can fail

**Purpose** Make `benchmark:plan:check`'s accuracy gate capable of catching a regression.

**Why**
`BENCH_MIN_RESOLVED_CALL_EDGE_PCT` is **60** (`scripts/benchmark-plan-mode.mjs:43`) while the true
value is **100**. A floor 40 points below observed is inert. S-31 deliberately left it, for a good
reason — raising a CI threshold off a single measurement is how surprise failures are made. That
reason expires once there are a few runs' evidence, which is what this item collects.

**Files affected** `codebase-index-mcp/scripts/benchmark-plan-mode.mjs`

**Risk** — **Low**, but the failure mode is annoying rather than harmful: too tight and CI goes red
on unrelated work.

**Rollback** — R1.

**Validation**
- At least five recorded runs across different commits, with the observed value each time
- The new floor is set below the lowest observation with a stated margin, and the margin is
  justified from the spread — not picked
- Verified non-vacuous: temporarily break one resolution path and confirm the gate fails

**Complexity** — **XS** (0.5 d, spread over time)

---

### B-05 · Put `verify:live` somewhere it actually runs

**Purpose** Stop the four real-backend smoke tests from depending on someone remembering.

**Why**
CI is credential-free by design (S-05, `docs/migration/ci.md`) and that decision is right. The
consequence is that nothing exercises the Postgres / OpenObserve / Bitbucket paths until a release,
and `verify:live` is a command in a doc. A broken client path is invisible for as long as nobody
ships.

**Files affected**
- `.github/workflows/` — a **separate**, manually-dispatched or scheduled workflow. Not the `verify`
  job: mixing credentials into the credential-free gate destroys the property that makes it mean the
  same thing on a fresh clone
- `docs/migration/ci.md` — state what the second workflow covers and what it still does not

**Risk** — **Medium.** Introduces secrets into CI for the first time. Least privilege, read-only
credentials, and `BITBUCKET_WRITE_ENABLED` must stay unset.

**Rollback** — R1 (delete the workflow; revoke the tokens).

**Validation**
- The workflow passes with real credentials, and its log contains no secret — checked against the
  redaction rules, not assumed
- It **fails** when a credential is removed, rather than skipping quietly
- A run's result is recorded somewhere durable, so "when did live last pass" has an answer

**Complexity** — **M** (1–2 d, mostly credential plumbing)

---

### B-06 · Unit tests where the assurance currently is not

**Purpose** Move some of `codebase-index-mcp`'s assurance off the integration harnesses.

**Why**
4 `*.test.ts` files against 129 source files. The real coverage is 37 harnesses in `scripts/test/`,
each needing a build and some needing a real index — so the feedback loop is slow and partly
dependent on machine state. S-39 opened this door (20 tests over `fileFilter` and `runPolicy`) and
did not walk far through it.

Target the pure functions the eight S-41 splits exposed — `graph/`, `impact/`, `store/` query
builders. Those closures becoming exported functions is precisely what made MCP-ISSUE-031 findable.

**Files affected** `codebase-index-mcp/src/**/*.test.ts` (new)

**Risk** — **Low.** Tests only.

**Rollback** — R1.

**Validation**
- `npm run test:unit` covers at least `graph/edgeResolver*`, `impact/impactShared`, and one
  `store/` query builder
- Each new test is shown to fail against a deliberately broken version of its subject — a test that
  has never failed is a guess, the same standard S-41 applied to the guards
- `typecheck` covers them (each server's `tsconfig.test.json`, S-39)

**Complexity** — **M** (2–3 d), and it makes B-01b/B-02b cheaper to verify

---

### B-07 · Declare the two env vars a real install uses and the manifest does not — ✅ DONE 2026-08-03

`PGSSLMODE` and `NODE_TLS_REJECT_UNAUTHORIZED` declared in `packages/manifest/src/envSpecs/postgres.ts`
under a `Node / libpq runtime (external conventions)` section, both **without** `default` — the S-35
finding: a field carrying one gets written into every user's `~/.claude.json`, which would pin an
external convention. Generated `.env.example` shows both commented out, with the process-wide
warning on the TLS flag; `generate:check` clean.

**Two guards fired, which is the part worth recording.** The manifest count test
(`postgres-mcp: 21 → 23`) and the S-43 test *"every postgres-mcp env var is POSTGRES_-prefixed"*
both failed, correctly — the second is a real design tension, not a nuisance: these are libpq's and
Node's names, so they cannot take the prefix S-43 exists to enforce.

Resolved with an explicit `FOREIGN_CONVENTIONS` allowlist in `scripts/lib/envAliases.test.mjs`
rather than a relaxed predicate, so "not `POSTGRES_`-prefixed" stays a failure by default and a
third exemption is a deliberate edit. Two further assertions close the hole the exemption opens: an
exempted name may carry neither `deprecatedAliases` nor `default`, and the allowlist may not name
something the manifest no longer declares. All three proven to reject a violation by mutation
before being kept.

**Purpose** Close the last hole in "env declared once, generated outward".

**Why**
The live `postgres-mcp` config sets `PGSSLMODE` and `NODE_TLS_REJECT_UNAUTHORIZED`; neither is in
`envSpecs/postgres.ts`, so neither reaches the generated `.env.example`. `observe-mcp` **does**
declare `NODE_TLS_REJECT_UNAUTHORIZED` (`envSpecs/observe.ts:92`), so the two servers disagree about
the same variable. S-35's whole point was ending exactly this condition; `generate:check` cannot
catch it because it compares generated output against the manifest, and both are silent.

**Files affected** `packages/manifest/src/envSpecs/postgres.ts`

**Risk** — **Low.** Documentation-only if declared as `codeDefault`-style notes: they are external
conventions (libpq, Node), not this server's own names, so they must **not** get a `default` — that
would pin them into every user's `~/.claude.json` (the S-35 finding).

**Rollback** — R1.

**Validation**
- `npm run generate:all` then `generate:check` — clean
- Generated `postgres-mcp/.env.example` shows both, commented, with the note that
  `NODE_TLS_REJECT_UNAUTHORIZED` disables certificate verification **process-wide**
- Neither declares both `default` and `codeDefault` (existing test)
- `mcp:doctor` still PASSes on the live install

**Complexity** — **XS** (< 0.5 d)

---

## P3 — A cost, not a defect

### B-08 · Correct the `§9` reconciliation row about `process.env` — ✅ DONE 2026-08-03

Both rows corrected in `docs/architecture/target-architecture.md` §9, each now naming the command
its number comes from: *Config loaded once per server* → **Built** (`guard:deps`, 0 errors), *File
size caps* → **Built** (`guard:all`: 0 errors, 20 `size/soft-cap` warnings, 1 accepted exemption
across 508 files). The env-var count was stale in three more places than this item knew about —
§9 said 89, `CLAUDE.md` and `docs/architecture.md` said 94, the manifest reports **96** — all four
now agree.

**Purpose** Fix a doc that reports a defect the repo does not have.

**Why**
`target-architecture.md` §9 lists "Config loaded once per server (S3)" as **Partial**, citing
`postgres-mcp/src/services/migration/efRunner.ts`. That line is `env: { ...process.env, CH_DB_CONNECTION: … }`
— spreading the parent environment into a `dotnet ef` child process so it inherits `PATH`. The
convention doc already classifies that as *inheritance, not configuration* (`conventions.md` §3),
and `guard:deps` reports **0 errors**. So the row describes work that should not be done.

The same §9 table also still says file size caps are "Not yet — 34 warnings … eleven files exceed
the hard cap. Blocks S-41". Current state: **17 warnings, 0 hard-cap findings, 1 declared
exemption**. A reader consulting that table to find remaining work is being told two things that are
false.

**Files affected** `docs/architecture/target-architecture.md` §9

**Risk** — **Low.**

**Validation** Each row's claim re-derived from a command (`guard:all`, `guard:deps`) and the command
named in the row.

**Complexity** — **XS**

---

### B-09 · Make `WORKSPACE_ROOT` stop counting directories — ✅ DONE 2026-08-03

`packages/manifest/src/paths.ts` now walks up from its own module until it finds a directory
holding **both** `tsconfig.base.json` and `package.json`, and throws with an actionable message if
it reaches the filesystem root. Correct at any depth, so nesting `dist/` or moving the package can
no longer produce a silently wrong answer.

Two markers, not one: every package and every server has a `package.json`, so searching for that
alone stops at `packages/manifest/`.

All three of this item's validations, run rather than reasoned:

| check | result |
|---|---|
| `mcp:doctor` output byte-diffed against a baseline captured beforehand | **identical**, same exit code |
| resolves from `src/` (tsx, the tests) and `dist/` (what `scripts/` loads) | both — `test:packages` 26/26, `mcp:doctor` PASS 4/4 |
| fails loudly outside the workspace | copied `dist/` to a temp dir and imported it: threw *"Cannot locate the workspace root … walked to the filesystem root"* |

This item also predicted that the existing test would become a tautology, and it was right — it
asserted exactly the markers the new implementation searches for. Re-pointed at consequences
instead: the root package's `name` (something the search never looks at), every `serverDirPath()`
landing on a real package directory, and containment of this module rather than *"both layouts sit
exactly three levels under the root"* — the very assumption this item removed.

**Purpose** Remove a silent-failure mode from the one export the whole installer depends on.

**Why**
`packages/manifest/src/paths.ts` derives the root by counting `..` segments from its own module
location. Three is right for both `src/` and `dist/`, and it breaks **silently** if `dist` ever
nests or the package moves. Typecheck cannot see it. Today a runtime test is the only thing standing
between that and an installer writing paths into `~/.claude.json` that point nowhere.

Replace with an upward search for a marker (`tsconfig.base.json` + root `package.json` name), which
is what the test already asserts — so the test becomes a tautology and should be re-pointed at
behaviour instead.

**Files affected** `packages/manifest/src/paths.ts`, `packages/manifest/src/manifest.test.ts`

**Risk** — **Medium.** Everything the installer and doctor resolve flows through this. `mcp:doctor`
output must be byte-diffed before and after, exactly as S-34 did when the manifest was ported.

**Rollback** — R1 (nothing persists; but re-verify `~/.claude.json` was not rewritten with bad
paths).

**Validation**
- `mcp:doctor` output byte-identical to a baseline captured beforehand, same exit code
- Resolves correctly when loaded from `src/` (tests) and from `dist/` (scripts)
- Fails loudly, with an actionable message, when no marker is found — verified by running it from a
  copied directory outside the workspace

**Complexity** — **S**

---

### B-10 · Delete the `scripts/lib/manifest.mjs` shim — ⛔ WON'T DO 2026-08-03 · the defect behind it fixed instead

**The shim cannot be deleted without losing the message, and that is a fact about ESM rather than
a preference.** This item assumed the actionable `ERR_MODULE_NOT_FOUND` re-throw could be
"re-homed". It cannot:

> A static `import … from "@mcp/manifest"` is **resolved during linking**, before the body of any
> module in the graph runs. A preflight module imported first — the obvious re-homing — never
> executes, because the graph fails to link first.

Measured, not reasoned: `scripts/lib/requireBuiltPackages.mjs` was written, all eleven importers
were repointed at the package, and with `packages/manifest/dist` moved aside **every entry point
still died on a raw `ERR_MODULE_NOT_FOUND`** — `mcp:doctor`, `contract-snapshot`, `generate-env`,
`run-servers`. The whole change was reverted.

A dynamic `await import()` inside a try/catch is the only construct that can intercept it, and a
dynamic import cannot be star-re-exported. **The hand-written name list is the price of the
message, not an oversight** — which is what this item read it as.

**What was a real defect, and is now fixed.** The list had drifted: eight names re-exported against
the package's ten, so `TOOL_LISTS` and `TOTAL_TOOL_COUNT` were unreachable through the shim and
resolved to `undefined` rather than failing. Both added, and `scripts/lib/manifestShim.test.mjs`
now diffs the two export surfaces in both directions plus rejects any `undefined` re-export —
proven by mutation to name the missing symbol in its failure message.

**Also found: this item undercounted the importers, the same way the migration plan undercounted at
S-34.** It lists seven; there are **eleven** — `scripts/lib/{cli,generate,skills,envPaths.test}.mjs`
import it too.

Reopening this needs `packages/*/dist` to stop being gitignored, or the entry points to accept a
worse first-run message. Neither is worth it for 45 lines.

**Purpose** Finish S-34. The shim was always temporary; `CLAUDE.md` says so.

**Why now** Seven consumers import it. It is 38 lines and carries one thing worth keeping: the
`ERR_MODULE_NOT_FOUND` re-throw with the "run `npm run build:packages`" message. Deleting the file
without relocating that message re-introduces the fresh-clone cliff S-34 fixed.

**Files affected** `scripts/lib/manifest.mjs` (delete) · the seven importers
(`install-mcp`, `mcp-doctor`, `update-mcp`, `lib/cli.mjs`, `lib/skills`, `contract-snapshot.mjs`,
`run-servers.mjs`) · wherever the actionable message is re-homed

**Risk** — **Low**, but it touches every tooling entry point at once.

**Rollback** — R1.

**Validation**
- `grep -rn "lib/manifest" scripts/` returns nothing
- `verify:all` exit 0 · `mcp:doctor` PASS 4/4
- With `packages/*/dist` deleted, each entry point still prints the actionable build message rather
  than a raw `ERR_MODULE_NOT_FOUND`

**Complexity** — **S**

---

### B-11 · One authoritative state document

**Purpose** Stop paying for two descriptions of one thing.

**Why**
`migration-plan.md` (1,530 lines) + `status.md` (1,111) = 2,641 lines describing finished work, and
the cost is not hypothetical: a **second Phase J table** inside `status.md` said S-38 was undone and
S-39 partial long after both landed, which made the document's own header report "1 partial · N
open". Two tables for one phase is the defect that let it drift, and `status.md` says so itself.

Now that the migration is complete, the plan is a historical record and the status document is the
only live one. Collapse to: the plan frozen and marked historical, one state document, one table per
phase.

**Files affected** `docs/migration/status.md`, `docs/migration/migration-plan.md` (header only),
`CLAUDE.md` references

**Risk** — **Low.** Documentation.

**Rollback** — R1.

**Validation** No phase has two tables. Every retained claim cites the artifact that proves it — the
standard `status.md` already sets for itself.

**Complexity** — **S**

---

### B-12 · Make stale `dist/` a check instead of a warning in three documents — ✅ DONE 2026-08-03

`mcp:doctor` gained a `dist` check: any `dist/**/*.js` with no matching source file is reported as
`WARN dist stale build output: <names>` with `rm -rf dist && npm run build` in the fix list.

Took the doctor-warning option, not clean-on-every-build, for the reason this item gives: a stale
module only matters when something still imports it by path, and a full rebuild on every compile is
too much to pay for an occasional trap. `.d.ts` and `.map` orphans are ignored — nothing loads them
at runtime.

Both halves of the validation ran: a clean tree reports `PASS dist every dist/*.js has a matching
source file` on all four servers, and dropping a `ghostModule.js` into `bitbucket-mcp/dist`
produced the warning naming that file, then PASS again once removed.

The three prose copies (`codebase-index-mcp/CLAUDE.md`, `docs/onboarding.md`,
`docs/conventions.md` §9) now point at the check instead of only warning — they stay because the
rule is still worth stating, but they are no longer the *only* thing standing between a reader and
a false measurement.

**Purpose** Turn a known trap into something that detects itself.

**Why**
`tsc` does not prune, so a renamed or moved module leaves a loadable copy at the old path. This
already produced a false "identical" result during S-41 while the probe was running the *previous*
build. The current mitigation is a warning in `codebase-index-mcp/CLAUDE.md`,
`docs/onboarding.md` and `docs/conventions.md` §9 — three copies of a rule nothing enforces, which
is the same shape as the drift that started this whole engagement.

Cheapest sufficient option: have each server's `build` clean `dist/` first, or have `mcp:doctor`
warn when `dist/` holds a `.js` with no corresponding `.ts`. Prefer the doctor warning if clean
builds cost meaningful time.

**Files affected** each server's `package.json` `build` script, or `scripts/mcp-doctor.mjs`

**Risk** — **Low.**

**Rollback** — R1.

**Validation** Rename a source file, rebuild, and confirm the mechanism reports the orphan. Then
confirm a clean tree reports nothing.

**Complexity** — **S**

---

## Explicitly NOT in this backlog

Each of these is a recorded decision with a rationale. Reopening one needs a new ADR, not a backlog
item — listing them here is what stops them being "discovered" again every six months.

| Item | Why it stays | Record |
|---|---|---|
| Four copies of `zod` / protocol SDK | The price of not hoisting `better-sqlite3` / `tree-sitter`. Measured consequence: **`instanceof` fails across the boundary**, so no shared module may match against a class it imported itself | ADR 0001 |
| Three different SQL forbidden-token lists (18/13/16) | Partly correct by dialect — SQLite needs `pragma`, DataFusion has no `merge`. Mechanism shared, policy local; two tests pin the divergence | ADR 0002 |
| No per-server `.gitignore` | Root file's `**/` patterns already decide every path | ADR 0003 |
| Servers not moved into `servers/` | Cosmetic symmetry, and the only change that rewrites `~/.claude.json` | S-42, skipped |
| `store/graphStore.ts` at 831 lines | A delegation façade's length *is* its method count. The exemption is declared and reported as `info`, not silent | S-30 |
| 17 `size/soft-cap` warnings | Advisory by design; several of those files are legitimately one thing | `conventions.md` §5 |
| The postgres alias table existing twice | Required: a server may not import `@mcp/manifest` (`servers/tooling-import`). A test diffs the copies | S-43 |
| `CH_DB_CONNECTION` kept in `efRunner` | It is *written*, not read — an outbound contract with a .NET project this workspace does not own | S-43 |

### One row left this table — reopened, and resolved (2026-08-03)

**`mapError` not extracted.** Listed above until 2026-08-03 on the strength of
`duplication-extraction-report.md` §5. The measurement behind it was correct and still is: a shared
mapper that **imports `zod` itself** compares against a different class object, both `instanceof`
branches fall through, and every validation error degrades to `internal_error` carrying a raw zod
dump.

What did not follow is the conclusion. The constraint is *"a shared module must not `instanceof`
against a class it imported"* — which says nothing about where the **algorithm** lives. Passing the
classes in as parameters satisfies it directly: `createErrorMapper` (`packages/sdk/src/errorMapper.ts`,
`4390fa1`) imports neither `zod` nor `@modelcontextprotocol/sdk`, and three servers now share the
branch order while keeping every client-visible string local.

The table's own rule — *reopening one needs a new ADR, not a backlog item* — is what happened:
ADR 0001 carries the amendment. Two things worth keeping from it:

- S-09 (deduplicating `zod`) was recorded as the prerequisite. **It was not**, and waiting for it
  was the actual cost of the wrong conclusion.
- ADR 0001 originally suggested duck-typing on `.name` as the escape hatch. Injection is strictly
  safer: `errorMapper.test.ts` pins a same-named, same-shaped `RivalZodError` reaching
  `internal_error`, which `.name` matching would have misclassified as a validation error.

---

## Order, and what depends on what

```
B-01 ─> B-01b ─┐
               ├─ ✅ both closed 2026-07-30, ahead of B-06 rather than after it
B-02 ─> B-02b ─┘

B-02b is closed, so an edge count is evidence again — every remaining item that
      validates a graph change can now measure instead of running a noise band

B-07 · B-08 · B-09 · B-12   ✅ closed 2026-08-03
B-10                        ⛔ won't do — see the item; the drift it was really about is fixed

Still open, and none of them blocks another:

B-03  independent, per-tool, pausable after any tool — the only one that changes tool output
B-04  needs elapsed time, not effort: five runs across different commits before a floor can be set
B-05  needs credentials provisioned as CI secrets — a decision, not a task
B-06  the largest remaining, and the one that makes future graph fixes cheaper to verify
B-11  documentation only
```

**Suggested next slice:** **B-06** is now the one worth doing first. It was originally scheduled to
support B-01b and B-02b; those landed without it, verified against real repos, so their regressions
are pinned by integration harnesses and a registry entry rather than by fixture-level tests. That
worked once and is not a plan.

Then **B-04** as data collection — it closes whenever five runs' evidence exists, and starting late
just moves the finish line. **B-05** is a conversation about credentials before it is any code.
**B-03** stays last: it is the only remaining item that changes what a tool returns.

The original plan had B-01/B-02 waiting on B-06. They did not wait. That is the one sequencing call
this backlog got wrong, and it cost the assurance B-06 was supposed to provide.

**What this backlog deliberately does not contain:** more restructuring. The tier model, the guards,
the contracts and the generators all work and are all enforced. Every item above either makes a tool
tell the truth, or makes an existing gate capable of failing.

## Summary

| # | Item | Tier | Risk | Rev. | Complexity | Status |
|---|---|---|---|---|---|---|
| B-01 | Diagnose C# `TYPE_REF` loss | P1 | Low | R1 | M | ✅ 2026-07-30 · `c68bda5` |
| B-01b | Fix C# `TYPE_REF` | P1 | — | — | unscoped | ✅ 2026-07-30 · `266d91b` `9574e3e` `f1c0160` `9b55de4` |
| B-02 | Locate extraction nondeterminism | P1 | Low | R1 | M | ✅ 2026-07-30 · `b764b39` |
| B-02b | Make an index run reproducible | P1 | — | — | unscoped | ✅ 2026-07-30 · `ae1af79` |
| B-03 | One profile resolution | P1 | **Med** | R2 | S / tool | open |
| B-04 | Raise the graph-accuracy floor | P2 | Low | R1 | XS | open |
| B-05 | Run `verify:live` on a schedule | P2 | **Med** | R1 | M | open |
| B-06 | Unit tests in `codebase-index` | P2 | Low | R1 | M | open |
| B-07 | Declare `PGSSLMODE` + `NODE_TLS_REJECT_UNAUTHORIZED` | P2 | Low | R1 | XS | ✅ 2026-08-03 |
| B-08 | Correct the §9 reconciliation rows | P3 | Low | R1 | XS | ✅ 2026-08-03 |
| B-09 | `WORKSPACE_ROOT` by marker, not depth | P3 | **Med** | R1 | S | ✅ 2026-08-03 · doctor output byte-identical |
| B-10 | Delete the manifest shim | P3 | Low | R1 | S | ⛔ won't do — ESM links before it evaluates; drift fixed + guarded |
| B-11 | One authoritative state document | P3 | Low | R1 | S | open |
| B-12 | Detect stale `dist/` | P3 | Low | R1 | S | ✅ 2026-08-03 · `mcp:doctor` `dist` check |
