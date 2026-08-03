# Migration Notes

Between 2026-07-27 and 2026-07-29 this workspace went from four independently-grown MCP servers with
hand-copied helpers to four servers on a six-package platform with enforced dependency rules,
snapshotted tool contracts and generated configuration. **43 of 44 steps done, 1 skipped by
decision, 0 open.**

This directory is the record. It is **historical**: entries describe the state at the commit they
were written against, and are deliberately not rewritten when the code moves on. For what is true
now, read [`../architecture.md`](../architecture.md) and [`../conventions.md`](../conventions.md).

---

## Read in this order

| # | Document | What it is |
|---|---|---|
| 1 | **[`status.md`](status.md)** | **Start here.** All 44 steps verified against the working tree, each row citing the artifact that proves it. Includes the step-number reconciliation for three commits whose labels drifted, and a *Post-migration* section for work that landed after the migration closed |
| 2 | [`migration-plan.md`](migration-plan.md) | The plan as written: 44 reversible steps across phases A–K, with rollback classes R1–R4. Historical — where it and `status.md` disagree, `status.md` is authoritative |
| 3 | [`foundation-notes.md`](foundation-notes.md) | What the `packages/` foundation contains and why each piece is shaped that way |
| 4 | [`normalization-report.md`](normalization-report.md) | The 48-file in-place folder normalization (S-37) |
| 5 | [`ci.md`](ci.md) | What CI covers, what it deliberately does not (no live backends, no secrets), and the script vocabulary that makes the root aggregates work |

### Per-server SDK migration notes

Read these **before** migrating another server onto the SDK — each records a class of finding the
next one would otherwise rediscover:

| Document | Server | The finding worth reusing |
|---|---|---|
| [`s06-s23-notes.md`](s06-s23-notes.md) | `bitbucket-mcp` (pilot) | contract snapshots, and the first accepted delta: an unknown tool reporting `not_found` instead of `mcp_error` |
| [`s24-notes.md`](s24-notes.md) | `postgres-mcp` | the call-replay method, and why the SDK gained `resources` and `rawResult` |
| [`s25-notes.md`](s25-notes.md) | `observe-mcp` | the first migration needing no new SDK capability — and a profile-dependent serialization finding that **no schema could reveal** |
| [`s26-s29-plan.md`](s26-s29-plan.md) | `codebase-index-mcp` | the entry-point survey and the three SDK gaps that blocked it. **Uses commit-side numbering** — its "S-26" is the plan's S-28 |

---

## The phases

| Phase | Steps | What it produced |
|---|---|---|
| **A** Baseline and safety net | S-01…S-06 | the audit, uniform per-server scripts, root aggregates, CI, and `contracts/` — the golden `tools/list` snapshots |
| **B** Native dependency spike | S-07 | the decision that servers stay outside the npm workspace ([ADR 0001](../adr/0001-workspace-native-deps.md)) |
| **C** Monorepo substrate | S-08…S-10 | `tsconfig.base.json`, `workspaces: ["packages/*"]`, project references |
| **D** Guard rails | S-11…S-13 | `packages/cli` — the dependency and convention guards, built in warn mode |
| **E** Shared core extraction | S-14…S-20 | `@mcp/core` and `@mcp/shared` (approval, SQL, HTTP, fs) |
| **F** Tool builder and SDK | S-21…S-25 | `@mcp/sdk`; `bitbucket-mcp` piloted it, then `observe-mcp` and `postgres-mcp` |
| **G** codebase-index cleanup | S-26…S-30 | shadow implementations deleted, the watch lifecycle unified, `graphStore` split |
| **H** codebase-index SDK migration | S-31…S-33 | 43 tools onto the registry in five batches; the legacy dispatch switch deleted |
| **I** Manifest generation | S-34…S-36 | `@mcp/manifest`, generated `.env.example`, generated README blocks and tool lists |
| **J** Conventions and housekeeping | S-37…S-41 | the scaffold, the test strategy, index-registry hygiene, and the guards flipped to enforcing |
| **K** Deferred decisions | S-42…S-44 | `POSTGRES_*` env unification and the `codebase-index` key rename. S-42 (moving servers into `servers/`) **skipped by decision** |

Phases A–J all landed by 2026-07-29, which the plan marks as the point the migration is finished.
Phase K was optional; S-43 and S-44 were done anyway on the plan's own recommendation.

---

## What landed after the migration closed

Neither is a migration step, and neither had a state record until `status.md` was extended
2026-08-03:

| Work | Commits | Record |
|---|---|---|
| The standard nine-slot `src/` structure in all four servers — 153 files moved, 1 split | `d692094` · `7676dbd` | [`../refactor/standard-structure-report.md`](../refactor/standard-structure-report.md) |
| One `create*` / `register*` vocabulary across all three MCP surfaces, plus `runServer` and `createErrorMapper` | `4390fa1` | `packages/sdk/README.md` §"The builder family" |
| The scaffold rebuilt on that vocabulary | 2026-08-03 | `templates/server/**` |

---

## Findings worth carrying forward

The migration's value is partly in what it disproved. Six that changed how work is done here:

**The env contract was wrong in every direction.** The manifest declared 41 of 89 vars actually read
by the code; not one of the three sources (manifest, `.env.example`, README) agreed with another. The
real list was **not** found by grepping `process.env` — a regex missed 27 of `codebase-index`'s 39,
because the servers read env through `createEnvReader` and the keys appear only as string literals.
What worked: boot each server with `process.env` replaced by a recording `Proxy`.

**A `default` in the manifest pins a value into every user's `~/.claude.json`.** Declaring 48 tuning
knobs with defaults would have frozen them at that day's values. Hence `codeDefault` — documentation
only, never written anywhere.

**The hand-maintained tool list had drifted to 12 of 43.** The installed skill therefore advertised
under a third of the largest server, so a model reading it could not know most tools existed. Now
generated from `contracts/`.

**Shared code is not automatically better than the copies it replaces.** Three extractions changed
behaviour before anyone adopted them — a `maxDepth` default that truncated real data, a
`shouldDropNullish` rule that changed the `standard` profile's shape, and dollar-quote scanning that
*weakened* a SQL guard on the wrong dialect. Mechanism-not-policy is necessary but not sufficient;
the mechanism has to be proven equivalent first.

**A test written after a refactor only proves the refactor agrees with itself.** `test:server-envelopes`
(31 assertions) was written against the *pre*-migration server and made to pass there first.

**`tsc` does not prune `dist/`.** A probe reported *"identical"* while running the previous build.
Now detected by `npm run mcp:doctor` (backlog B-12) — but the habit still matters.

---

## Reconciliation you will trip over

Three commits carry S-numbers that do not match the plan. The commits are immutable, so the mapping
is recorded rather than rewritten:

| Commit | Label used | Plan step it actually is |
|---|---|---|
| `0eccb10` | S-24 | **S-25** — migrate `postgres-mcp` |
| `e5feaf3` | S-25 | **S-24** — migrate `observe-mcp` |
| `9ccae95` | S-26 | **S-28** — extract indexing orchestration |

`status.md`'s numbering is authoritative. `s26-s29-plan.md` uses the commit-side numbering
throughout.

---

## What is left

[`../backlog.md`](../backlog.md) — the post-migration backlog. Thirteen of fourteen items closed or
resolved; **B-04 alone remains**, and it needs elapsed time rather than effort (five accuracy
observations across different commits, now collected automatically by CI). It also lists the
accepted debt that is **not** in it, so decided questions stay decided.

**B-11 was about this directory, and is closed (2026-08-03).** `migration-plan.md` is now marked
**frozen and historical** in its own header — it was still claiming *"In progress — 24 of 44 steps
done"*, sixteen steps stale — and `status.md` is the single live state document with **one table per
phase**. The duplicate Phase J table is deleted, its two unique facts folded into the authoritative
one. That duplicate is what made this document's own header report a step count that was wrong for
weeks; two tables for one phase was the defect, not the drift between them.

The two files still total ~2,750 lines, and that is fine: one is a frozen record of *why* each step
was shaped as it was, the other is the verified state. The cost B-11 named was two documents both
claiming to describe the present, which is no longer the case.

---

## Related

- [`../architecture.md`](../architecture.md) — what this is *now*
- [`../architecture/target-architecture.md`](../architecture/target-architecture.md) — the design, with §9 reconciling it against what was built
- [`../architecture/audit-report.md`](../architecture/audit-report.md) — the pre-migration repository at `01c532e`
- [`../adr/README.md`](../adr/README.md) — the decisions the migration made
