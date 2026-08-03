# Post-Migration Backlog

**Created** — 2026-07-29
**Baseline** — `32f2a82`, working tree carrying the MCP-ISSUE-031/033 dead-code fixes
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

### B-01 · Diagnose why C# `TYPE_REF` edges are almost never produced

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

### B-01b · Fix C# `TYPE_REF` extraction/resolution

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

### B-02 · Locate the extraction-time nondeterminism

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

### B-02b · Make an index run reproducible

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

### B-07 · Declare the two env vars a real install uses and the manifest does not

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

### B-08 · Correct the `§9` reconciliation row about `process.env`

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

### B-09 · Make `WORKSPACE_ROOT` stop counting directories

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

### B-10 · Delete the `scripts/lib/manifest.mjs` shim

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

### B-12 · Make stale `dist/` a check instead of a warning in three documents

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
| Four copies of `zod` / protocol SDK | The price of not hoisting `better-sqlite3` / `tree-sitter`. Measured consequence: `mapError` cannot be shared, `instanceof` fails across the boundary | ADR 0001 |
| `mapError` not extracted | Same cause, measured not assumed | `duplication-extraction-report.md` §5 |
| Three different SQL forbidden-token lists (18/13/16) | Partly correct by dialect — SQLite needs `pragma`, DataFusion has no `merge`. Mechanism shared, policy local; two tests pin the divergence | ADR 0002 |
| No per-server `.gitignore` | Root file's `**/` patterns already decide every path | ADR 0003 |
| Servers not moved into `servers/` | Cosmetic symmetry, and the only change that rewrites `~/.claude.json` | S-42, skipped |
| `store/graphStore.ts` at 831 lines | A delegation façade's length *is* its method count. The exemption is declared and reported as `info`, not silent | S-30 |
| 17 `size/soft-cap` warnings | Advisory by design; several of those files are legitimately one thing | `conventions.md` §5 |
| The postgres alias table existing twice | Required: a server may not import `@mcp/manifest` (`servers/tooling-import`). A test diffs the copies | S-43 |
| `CH_DB_CONNECTION` kept in `efRunner` | It is *written*, not read — an outbound contract with a .NET project this workspace does not own | S-43 |

---

## Order, and what depends on what

```
B-01 ─> B-01b ─┐
               ├─> both need B-06's fixture-level tests to be verifiable
B-02 ─> B-02b ─┘   without tripping over each other

B-02b unblocks: any future validation that reads an edge count as evidence
                (including B-01b's own before/after)

B-03  independent, per-tool, pausable after any tool
B-04  needs elapsed time more than effort — start collecting now, decide later
B-05 · B-07 · B-08 · B-09 · B-10 · B-11 · B-12   all independent
```

**Suggested first slice:** B-07 and B-08 (both < 0.5 d, both close a stated-vs-actual gap), then
B-01 and B-02 in parallel as the two investigations, with B-06 started alongside because both fixes
will need somewhere to assert. B-04 begins immediately as data collection and closes whenever the
evidence is there.

**What this backlog deliberately does not contain:** more restructuring. The tier model, the guards,
the contracts and the generators all work and are all enforced. Every item above either makes a tool
tell the truth, or makes an existing gate capable of failing.

## Summary

| # | Item | Tier | Risk | Rev. | Complexity |
|---|---|---|---|---|---|
| B-01 | Diagnose C# `TYPE_REF` loss | P1 | Low | R1 | M |
| B-01b | Fix C# `TYPE_REF` | P1 | — | — | unscoped |
| B-02 | Locate extraction nondeterminism | P1 | Low | R1 | M |
| B-02b | Make an index run reproducible | P1 | — | — | unscoped |
| B-03 | One profile resolution | P1 | **Med** | R2 | S / tool |
| B-04 | Raise the graph-accuracy floor | P2 | Low | R1 | XS |
| B-05 | Run `verify:live` on a schedule | P2 | **Med** | R1 | M |
| B-06 | Unit tests in `codebase-index` | P2 | Low | R1 | M |
| B-07 | Declare `PGSSLMODE` + `NODE_TLS_REJECT_UNAUTHORIZED` | P2 | Low | R1 | XS |
| B-08 | Correct the §9 reconciliation rows | P3 | Low | R1 | XS |
| B-09 | `WORKSPACE_ROOT` by marker, not depth | P3 | **Med** | R1 | S |
| B-10 | Delete the manifest shim | P3 | Low | R1 | S |
| B-11 | One authoritative state document | P3 | Low | R1 | S |
| B-12 | Detect stale `dist/` | P3 | Low | R1 | S |
