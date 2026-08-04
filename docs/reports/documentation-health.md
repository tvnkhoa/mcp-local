# Documentation Health

> ## ✅ Re-scored 2026-08-03 — action items 1, 2, 3, 8, 9 are done
>
> | | At assessment | Now | What changed |
> |---|---|---|---|
> | **Documentation Health** | 85 | **95** | |
> | Accuracy | 94 | **100** | `npm run mcp:update -- --all` ran; the installed `postgres-mcp` skill went from **25 legacy env names / 0 canonical** to **2 / 28** (the 2 are its deliberate deprecation note) |
> | Maintainability | 58 | **88** | `scripts/check-docs.mjs` exists and is wired into `verify:all` **and CI**; `generate:check` added to CI. Gated failure modes **3 of 10 → 8 of 10**. Each of the five doc checks was shown to reject a deliberate violation |
> | Coverage | 84 | **93** | `CODEOWNERS` added; documentation-language policy added (`conventions.md` §10); `--force`, `typecheck:packages`, `clean:packages` documented |
> | Navigation | 96 | 96 | unchanged |
> | Consistency | 88 | 88 | unchanged |
>
> **Still open:** generate the graph model (item 4 — risk reduced from 5 hand-copies to 2 by the
> simplification pass, but not eliminated), claim derivability (item 6), the 9 unwired test harnesses
> (item 10 — a test-content decision, deliberately not taken unilaterally), per-server README skeleton
> (item 11). Items 5 and 7 were completed by the
> [simplification pass](documentation-simplification.md).
>
> **The body below is the assessment as written**, and is left unedited so the scores above have
> something to be measured against.

**Assessed** — 2026-08-03, after the portal reorganization
**Scope** — 96 Markdown files (92 tracked + 4 untracked-not-ignored), 11,262 lines
**Series** — [audit](../archive/reports/documentation-audit.md) → [cleanup plan](../archive/reports/documentation-cleanup-plan.md) → [cleanup report](../archive/reports/documentation-cleanup-report.md) → [review](../archive/reports/documentation-review.md) → **this health check**
**Method** — every score below is computed from a measurement, and each rubric names its inputs. No
score is a judgement call about tone or style.

---

## Scores

| | Score | Grade | One-line reason |
|---|---|---|---|
| **Documentation Health** | **85 / 100** | **B+** | Accurate and navigable; **under-automated** |
| Navigation | **96 / 100** | A | 0 broken links, 0 orphans, max 2 hops |
| Coverage | **84 / 100** | B | Complete on the technical surface; thin on governance |
| Maintainability | **58 / 100** | **D+** | **3 of 10 documentation failure modes are gated** |
| Accuracy | 94 / 100 | A | Every count verified; one live document is wrong |
| Consistency | 88 / 100 | B+ | Structurally uniform; per-server READMEs diverge |

**Composite weighting** — Accuracy 30% · Navigation 20% · Coverage 20% · Maintainability 20% ·
Consistency 10%. Accuracy is weighted highest because a wrong document is worse than a missing one:
it is acted on.

> **The headline is the spread, not the average.** Content quality is A-grade; the *system that keeps
> it that way* is D-grade. Four consecutive review passes each found defects the previous pass
> introduced or missed — the audit missed two invalid tool parameters, the cleanup falsified a
> directory tree and preserved a recommendation to a retired document, and the review found a
> capability claim that was 17/32 correct. None of those was caught by a gate, because **no gate for
> documentation exists.**

---

## Navigation — 96 / 100

| Component | Weight | Measured | Score |
|---|---|---|---|
| Broken links | 25 | **0 of 262** | 25 |
| Orphaned documents | 20 | **0** | 20 |
| Portal reachability | 20 | **44 of 44** `docs/` files reachable from `docs/README.md` | 20 |
| Hop distance | 15 | **max 2**, mean 1.43 — the portal's "≤2 hops" claim verified | 15 |
| Section index coverage | 10 | **8 of 8** sections have a `README.md` | 10 |
| Entry-point clarity | 10 | One entry point; root README points to it without duplicating it | 6 |

**The 4-point deduction.** Four of the five always-on rule files —
`.claude/rules/{mcp-base,typescript-mcp,db-guardrails,codebase-index}.md` — are reachable from no
document. They are loaded by the harness by scope, so nothing is functionally broken, but a human
browsing the portal cannot discover them: `docs/README.md` names the *directory* without linking the
files. `mcp-hard-mode.md` is linked (10 inbound) and is the exception.

15 documents are intentionally not link-reachable — `.claude/skills/*`, `.claude/rules/*`,
`.claude/commands/*`, `<server>/skill/SKILL.md`, `templates/*`. These are discovered by directory
name. **Inbound-link count is not a liveness signal for them**, an observation that prevented four
wrong deletions during the cleanup.

---

## Accuracy — 94 / 100

Every claim class re-verified against its source of truth:

| Claim | Source of truth | Result |
|---|---|---|
| 76 tools · 43/17/8/8 | `@mcp/manifest` `TOTAL_TOOL_COUNT` + `contracts/*.json` | ✅ exact |
| 98 env vars · 41/23/23/11 | `getServer(k).env.length` | ✅ exact |
| `guard:all` 0 err / 20 warn / 1 exempt / 516 files | `npm run guard:all` | ✅ exact |
| 6 packages, tiers 0–5 | `mcp-platform rules` | ✅ exact |
| Documented tool-call parameters | `contracts/*.json` | ✅ **0 invalid** |
| Tool names cited | `contracts/*.json` | ✅ **0 nonexistent** |
| Documented API symbols | `packages/*/dist` exports | ✅ **104 of 104** |
| Nine-slot table | filesystem, 4 × 8 cells | ✅ **32 of 32** |
| Markdown links | filesystem | ✅ **0 of 262 broken** |
| `npm run` names cited | 12 `package.json` files | ✅ all defined (6 exceptions confined to the frozen migration plan) |

**The 6-point deduction is one document, and it is live.**
`.claude/skills/postgres-mcp/SKILL.md` — the operational skill an agent loads to use `postgres-mcp` —
contains **25 pre-S-43 environment names and 0 canonical ones**. The committed template
`postgres-mcp/skill/SKILL.md` was corrected during the cleanup, but the rendered copy on disk was
never regenerated, and regenerating it requires running the installer:

```bash
npm run mcp:update -- --all
```

Until that runs, the most-read `postgres-mcp` document tells a reader to set variables that are only
honoured as deprecated aliases. This is **Action Item 1**.

---

## Coverage — 84 / 100

| Component | Weight | Measured | Score |
|---|---|---|---|
| Tool + env surface | 40 | **76/76 tools** and **98/98 env vars** in generated tables | 40 |
| Structural docs | 20 | 6/6 package READMEs · 4/4 server READMEs · 4/4 skills · 4/4 `.env.example` · 3 ADRs | 20 |
| Commands & flags | 10 | 29/31 root scripts documented; 7/8 CLI flags | 8 |
| Guides depth | 10 | `guides/` holds one document. Troubleshooting exists but is buried in `workflow.md` §8 | 7 |
| Per-server parity | 10 | Section structure varies 4–10 headings; **two READMEs are Vietnamese, two English** | 6 |
| Governance | 10 | **No `CODEOWNERS`, no language policy** | 3 |

**Complete where it counts.** Every tool and every environment variable is documented, and those
tables are generated — they cannot drift.

**Gaps, all minor except the last:**

- `typecheck:packages` and `clean:packages` are defined but mentioned in no document.
- `--force` on `npm run new:server` is supported by `scripts/new-server.mjs` and documented nowhere.
- No document declares an owner. 148 of 150 commits are one author, so this is latent — it becomes
  real the moment a second person maintains a server.
- No rule states which language a new document uses, while the four server READMEs are split 2–2.

---

## Maintainability — 58 / 100

**The weakest dimension, and the one that explains the other four.**

| Component | Weight | Measured | Score |
|---|---|---|---|
| Failure-mode gating | 35 | **3 of 10** documentation failure modes are gated | 11 |
| Generated vs hand-maintained surfaces | 20 | 3 of 4 generated surfaces are gated; **skills are not** | 15 |
| Duplication control | 15 | One concept explained in **7** documents | 10 |
| Claim derivability | 15 | 15 numeric claims cite a derivation command; **~20 do not** | 7 |
| Documented maintenance model | 15 | Four maintenance classes defined, observed, and enforced by review | 15 |

### What is gated, and what is not

| Failure mode | Gate |
|---|---|
| Generated file drift (`.env.example`, README blocks, tool lists) | ✅ `generate:check` |
| Tool contract change | ✅ `contracts:check` |
| Code structure / imports / size | ✅ `guard:all` |
| **Broken Markdown links** | ❌ none |
| **Invalid documented tool parameters** | ❌ none |
| **Deprecated env names in docs** | ❌ none |
| **Orphaned documents** | ❌ none |
| **Stale numeric claims** | ❌ none |
| **Skill-template drift** | ❌ none |
| **Doc heading / structure** | ❌ none |

Worse: **`generate:check` is in `verify:all` but not in CI** (verified — `ci.yml` contains no
reference to it), so even the gated third is caught locally or not at all.

Every ungated row above corresponds to a defect actually found in this series. That is the argument
for Action Item 2, and it is not speculative.

### The one real duplicate

**"`tsc` does not prune `dist/`"** is explained — with the `rm -rf dist && npm run build` remedy — in
**7 documents**: `docs/development/workflow.md`, `docs/guides/onboarding.md`,
`docs/reference/conventions.md`, `docs/reference/folder-convention.md`, `CONTRIBUTING.md`,
`docs/development/backlog.md`, `codebase-index-mcp/CLAUDE.md`. The same *"reported identical while
running the previous build"* anecdote appears in three.

It is **already diverging**: not every copy mentions that `mcp:doctor` now detects it (backlog B-12).

Seven other concepts appear in 8–15 documents each — `verify:all`, the no-LLM policy, `compact` as
the default profile, `preview → apply → rollback`, the nine-slot structure, the script vocabulary,
stdout-is-the-transport. **All seven are one-line references pointing at a single explanation**, which
is correct cross-linking, not duplication. Only the `dist/` case has seven *explanations*.

### What is strong

The four-class maintenance model (**current-state / decision / historical / generated**) is defined in
`docs/README.md`, restated as process in `CONTRIBUTING.md`, and observably followed: frozen documents
carry banners, the archive carries a cover note, and *"a path is an address, not an assertion"* gives
a reviewable rule for editing historical files. The section-index pattern also makes adding a document
cheap — one file, one index row.

---

## Consistency — 88 / 100

| Dimension | Result |
|---|---|
| Heading style | **96/96 ATX**, 0 multiple-`h1`, 0 skipped levels, 0 setext |
| Whitespace | 0 tabs, 0 files missing an EOF newline, 0 quadruple blank lines |
| Trailing whitespace | 1 file — `archive/migration/migration-plan.md`, deliberately left (whitespace churn in a frozen record buys nothing) |
| Filename casing | Content docs `lowercase-kebab.md`; only tool-recognised names (`README`, `CLAUDE`, `AGENTS`, `CONTRIBUTING`, `CHANGELOG`, `SKILL`) are upper-case |
| Line endings | 13 files CRLF — **not a defect**: `.gitattributes` declares `*.md text eol=lf` and git stores LF; this is local `core.autocrlf` state, confirmed by a clean `git diff` on an untouched CRLF file |
| Terminology | "the gate", "the nine slots", "preview → apply → rollback" used uniformly |

**The 12-point deduction** is per-server README divergence: 10 sections (codebase-index), 9 numbered
(postgres), 4 (observe), 7 (bitbucket), across two natural languages. All four carry both generated
blocks correctly, so this is presentation consistency, not correctness.

---

## Scalability

Structurally sound, with one measured cost.

**What scales.** Adding a tool requires no documentation edit — the tool list is generated from
`contracts/`. Adding an env var requires no documentation edit — the table is generated from
`envSpecs/`. Adding a document requires one file plus one index row. Each of the eight sections is
independently extensible.

**What does not.** Adding **server #5** requires hand-editing documents that hard-code the list of
four:

| Hard-codes the four-server list | Hard-codes per-server tool counts |
|---|---|
| `README.md` · `AGENTS.md` · `docs/servers/README.md` · `docs/architecture/target-architecture.md` · `docs/reference/dependency-rules.md` · `docs/reference/packages.md` · `docs/reference/folder-convention.md` · `.claude/rules/mcp-base.md` · `.claude/rules/mcp-hard-mode.md` · `docs/decisions/0003-single-root-gitignore.md` | `README.md` · `AGENTS.md` · `docs/architecture/as-built.md` · `contracts/README.md` · `packages/manifest/README.md` · `CONTRIBUTING.md` and the four server READMEs |

So the workspace's own measure — *"adding server #5 is additive"* — holds for **code and generated
artifacts** but **not for prose**: roughly **10 documents** need a manual edit. The counts themselves
are all correct today; the liability is that they are hand-maintained.

The `docs/` tree diagram in `docs/reference/folder-convention.md` is the sharpest instance: it is the
only diagram describing the documentation layout, and it has now been falsified **twice** in one day
by reorganizations — once by the archive move, once by the portal move. It is correct now.

---

## Action Items

Ordered by whether a document currently tells a reader something false, then by whether a gate exists.

### P1 — a live document is wrong

| # | Action | Effort | Why now |
|---|---|---|---|
| **1** | **`npm run mcp:update -- --all`** | 1 command | `.claude/skills/postgres-mcp/SKILL.md` carries **25 legacy env names, 0 canonical**. The repository template is already fixed; only the rendered copy is stale. This is the single highest-value action in this report |

### P2 — no gate exists for defects that have already occurred

| # | Action | Effort | Why now |
|---|---|---|---|
| **2** | **Add `scripts/check-docs.mjs`, wire into `verify:all` as `docs:check`.** Five checks: (a) Markdown links + anchors, (b) documented tool-call parameters vs `contracts/`, (c) tool-name existence, (d) **prose capability claims** about tools, (e) deprecated env names used as instructions. Enumerate files with `git ls-files` **plus** `git ls-files --others --exclude-standard` | ~150 lines | Every one of the 10 ungated failure modes produced a real defect in this series. Check (d) is what would have caught the 17/32 profile list; the untracked-file note is what would have caught the unchecked archive index |
| **3** | **Add `generate:check` to `.github/workflows/ci.yml`** | 1 line | It is in `verify:all` but not in CI, so generated-file drift survives a push |
| **4** | **Generate the graph model.** `EdgeType` and `SymbolKind` are unions in `codebase-index-mcp/src/types/index.ts`; render them into a `<!-- BEGIN/END GENERATED -->` block | ~40 lines | **Five incomplete copies of one union** were found across four passes — each pass found a copy the previous one missed |

### P3 — cost, not defect

| # | Action | Effort |
|---|---|---|
| **5** | Give *"`tsc` does not prune `dist/`"* **one** home (`docs/development/workflow.md` §7) and reduce the other six to a pointer. It is already diverging on whether `mcp:doctor` detects it | small |
| **6** | Replace hand-maintained counts with their derivation command, or generate them. ~20 current-state claims carry a number without a nearby command; 15 already do it correctly — follow that pattern | medium |
| **7** | Link the four unreferenced `.claude/rules/*.md` files from `docs/README.md` so they are discoverable by a human, not only by the harness | small |
| **8** | Document `--force` (`new:server`), `typecheck:packages`, `clean:packages` | small |
| **9** | Add `CODEOWNERS` and a documentation language policy in `docs/reference/conventions.md` §7 | small |
| **10** | Wire or delete the **9 test harnesses** in `codebase-index-mcp/scripts/test/` that no `test:*` script references and that therefore never run | medium |
| **11** | Consider a per-server README skeleton so the four are structurally comparable | medium |

### Expected effect

Items 1–4 are the load-bearing ones. Completing them moves **Maintainability 58 → ~85** (gating 7 of
10 failure modes instead of 3, and closing the last ungated generated surface) and **Accuracy 94 →
100**, taking the composite **Documentation Health from 85 to roughly 93**. Items 5–11 are worth
about 4 further points and can be done incrementally.

---

## Summary

| | |
|---|---|
| Documents | 96 (11,262 lines — 6,000 maintained portal, 5,262 archive) |
| Broken links | **0 of 262** |
| Orphaned documents | **0** |
| Max hops from the entry point | **2** |
| Invalid tool parameters / nonexistent tools | **0 / 0** |
| Documented API symbols verified | **104 of 104** |
| Tool + env coverage | **76/76 · 98/98** |
| Documentation failure modes gated | **3 of 10** |
| Concepts explained in more than one place | **1** |
| Live documents known to be wrong | **1** (installed `postgres-mcp` skill) |

The documentation is in good shape and is in the top decile of what a workspace this size usually
carries: accurate counts that cite their commands, a real maintenance-class model, zero broken links
across 262, and an entry point that reaches everything in two hops.

Its weakness is singular and specific: **almost nothing about the documentation is checked by a
machine.** Four passes of careful human review produced four sets of defects, each pass catching the
last one's misses — which is the expected outcome of review without automation, not a failure of
diligence. The workspace already knows this about itself:

> *A convention nobody checks is a preference.* — `docs/reference/conventions.md`, ADR 0002

Documentation is currently a preference. Action item 2 is what makes it a convention.

---

*Health assessment. Read-only — no document was modified in producing this report.*
