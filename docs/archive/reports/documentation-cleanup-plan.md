# Documentation Cleanup Plan

**Input** — [`documentation-audit.md`](./documentation-audit.md) (21 findings, audited at `74d43a0`)
**Date** — 2026-08-03
**Scope** — all 89 Markdown files: 85 tracked + 4 generated/gitignored
**Status** — proposal. **No documentation has been modified.** This file and the audit are the only
additions to `docs/reports/`.

> **Three decisions were taken by the repository owner before this plan was written**, and they set
> its shape:
>
> 1. **Archive posture** — the closed-migration record **moves** to `docs/archive/`.
> 2. **Skill appetite** — *middle*: fix the pre-migration authoring skills in place, remove only the
>    three that would actively misdirect.
> 3. **Delete policy** — deletion is allowed **after** content is merged; git history is the archive.

---

## 1. Disposition summary

| Category | Files | Share |
|---|---|---|
| **KEEP** — accurate, no edit | 26 | 29% |
| **UPDATE** — content defect to correct | 31 | 35% |
| **UPDATE (refs only)** — correct content, address changes | 12 | 13% |
| **MERGE** — content absorbed elsewhere | 4 | 5% |
| **ARCHIVE** — moved to `docs/archive/` | 12 | 13% |
| **DELETE** — post-merge shell removed | 4 | 5% |
| *(regenerate — gitignored, produced by installer)* | 4 | — |
| **Total** | **89** | |

MERGE and DELETE describe the same four files at two stages, so the file count reconciles as
26 + 31 + 12 + 12 + 4 + 4 = 89.

**No file is deleted without its content landing somewhere first.** The DELETE bucket contains
exactly the four shells left behind by the four MERGEs — there is no standalone deletion, because the
audit found no document describing a system that no longer exists.

### One carve-out from the archive decision

`docs/migration/ci.md` is **not** archived. It sits in `docs/migration/` for historical reasons, but
it is not a historical document:

- `.github/workflows/ci.yml:6` cites it as the explanation of the workflow's current behaviour —
  *"Everything here is credential-free. See `docs/migration/ci.md` for what that…"*
- It records a **live** decision (B-05: no credential goes into CI) that governs today's releases.
- It carries three of the audit's staleness findings (F-06, F-10, F-11) **precisely because** its
  location marks it historical while its readers treat it as current. Nothing re-derived its numbers.

**Disposition: UPDATE + promote to `docs/development/ci.md`.** Archiving it would deepen the exact confusion that
made it stale. This is the one place this plan departs from a literal reading of the archive decision,
and the reason is that the decision was about *the closed-migration record* — and this file is not
part of it.

---

## 2. ARCHIVE — 12 files

**Destination:**

```
docs/archive/
├── README.md                          (new — explains what this directory is and is not)
├── migration/
│   ├── README.md  status.md  migration-plan.md
│   ├── foundation-notes.md  normalization-report.md
│   └── s06-s23-notes.md  s24-notes.md  s25-notes.md  s26-s29-plan.md
├── refactor/
│   ├── duplication-extraction-report.md
│   └── standard-structure-report.md
└── audit-report.md                    (from docs/architecture/)
```

| File | Why | Risk | Dependencies |
|---|---|---|---|
| `docs/migration/status.md` | The live state doc **of a project that closed 2026-07-29** (43/44, S-42 skipped). Nothing outstanding routes through it; `docs/development/backlog.md` owns what remains | **Medium** — most-referenced archive member: 14 internal + inbound from `CLAUDE.md`, `backlog.md`, and **two source files** | 14 internal refs · `codebase-index-mcp/src/tools/refactor.ts:18` · `scripts/test/test-impact-join-parity.mjs:23` |
| `docs/migration/README.md` | Index for the archived set; belongs with what it indexes | **Medium** — holds 9 of the 17 markdown links in the whole move | 11 refs, 9 links, all to siblings |
| `docs/migration/migration-plan.md` | Already ❄️ FROZEN by its own banner. Archiving makes the location agree with the label | **Low** — frozen; nothing reads it for state | 2 internal |
| `docs/migration/foundation-notes.md` | Why `packages/` is shaped as it is, at `01c532e`. Superseded as current-state by `docs/reference/packages.md` | **Low** | `docs/reference/packages.md`, `CLAUDE.md` |
| `docs/migration/normalization-report.md` | Record of the 48-file S-37 move. Pure history | **Low** | `CLAUDE.md`, `backlog.md` |
| `docs/migration/s06-s23-notes.md` | bitbucket SDK pilot | **Low** | `CHANGELOG.md`, `CLAUDE.md` |
| `docs/migration/s24-notes.md` | postgres SDK migration | **Low** | `adr/0001` cites it by name |
| `docs/migration/s25-notes.md` | observe SDK migration | **Low** | `CHANGELOG.md`, `CLAUDE.md` |
| `docs/migration/s26-s29-plan.md` | codebase-index SDK migration; commit-side numbering | **Low** | `migration-plan.md`, `status.md` |
| `docs/refactor/duplication-extraction-report.md` | Extraction + measured behaviour deltas at `3f5b702` | **Low** | `docs/reference/packages.md`, `backlog.md` |
| `docs/refactor/standard-structure-report.md` | The nine-slot move; `docs/reference/folder-convention.md` is the current-state successor | **Low** | `folder-convention.md`, `conventions.md` |
| `docs/architecture/audit-report.md` | The pre-migration repo at `01c532e`. Explicitly retrospective | **Low** — leaves `docs/architecture/` holding only `target-architecture.md` | `docs/architecture/as-built.md`, `docs/README.md` |

### Reference churn — measured, not estimated

Counted across every tracked file (not just Markdown), excluding `docs/reports/`:

| | Markdown links | Prose / backtick mentions | Total |
|---|---|---|---|
| **External** (active file → archive) | 9 | 54 | **63** |
| **Internal** (archive → archive) | 8 | 21 | **29** |
| **Total** | **17** | **75** | **92** |

Top referrers: `CLAUDE.md` 15 · `docs/development/backlog.md` 15 · `CHANGELOG.md` 10 · `docs/README.md` 5 (all
links) · `docs/architecture/as-built.md` 4.

**The dominant risk is not broken links — it is silent ones.** Only 17 of 92 references are Markdown
links a checker would catch. **75 are backtick prose mentions**, and the audit's link check already
proves the repo has zero broken links today, so the move would leave 75 stale pointers while the
link checker still reports green. This is why Phase 0 (§7) builds a reference checker *before* the
move rather than after.

### Three non-documentation dependencies

These are the ones a docs-only review would miss:

| File | Line | Says |
|---|---|---|
| `.github/workflows/ci.yml` | 6 | `See docs/migration/ci.md for what that…` — resolved by the §1 carve-out |
| `codebase-index-mcp/src/tools/refactor.ts` | 18 | `See the S-32 notes in `docs/migration/status.md`` — a JSDoc comment in **shipped source** |
| `codebase-index-mcp/scripts/test/test-impact-join-parity.mjs` | 23 | `See docs/migration/status.md, S-30` |

None breaks the build. All three become wrong, and nothing checks them.

### The frozen-document objection, and how it is resolved

`CONTRIBUTING.md` and `docs/README.md` both say historical documents must not be rewritten. Ten of
the 92 references live in `CHANGELOG.md`, which is Historical. Editing it looks like a violation.

**The resolution is a distinction worth writing into the convention: a path is an address, not an
assertion.** Updating an address preserves the claim and keeps it checkable; leaving the address
stale destroys the reader's ability to verify the claim at all. The prohibition exists to stop a
record from asserting something that never happened — retargeting a pointer does the opposite.

So: **paths may be updated inside historical documents; claims, numbers and dates may not.** Every
archive-related edit to `CHANGELOG.md`, `migration-plan.md` and the per-step notes must be a
path-only diff, reviewable as such. Recommendation R-6 (§7) adds this sentence to
`CONTRIBUTING.md` so the next person does not have to re-derive it.

### `docs/archive/README.md` — the one new file

An archive with no cover note becomes a junk drawer. It must state: what closed and when
(the 44-step migration, 43 done, S-42 skipped, 2026-07-29); that these documents were accurate at
the commits they name and are **not** maintained; where current-state answers live instead
(`docs/architecture/as-built.md`, `docs/reference/conventions.md`, `docs/development/backlog.md`); and that paths inside them may
have been retargeted while claims were not.

---

## 3. MERGE — 4 files (then DELETE)

| File | → Destination | Why | Risk | Dependencies |
|---|---|---|---|---|
| `codebase-index-mcp/docs/MCP-FIRST-CHEATSHEET.md` | `.claude/rules/mcp-hard-mode.md` | Audit **F-18**: duplicates always-on policy. Proof it is the wrong copy to trust: it drifted (**F-07** — `mcp_health_check` / `mcp_run_read_query` are not real tool names) while the rule file stayed correct | **Low** — 0 inbound Markdown links. Only unique content is the compressed runbook table, which the rule file can absorb | `AGENTS.md:346` (prose) must be repointed. `status.md:660` and `normalization-report.md:112` mention it — those are archive-bound and **historical: leave the claim, retarget nothing** |
| `.claude/skills/mcp-scaffold/SKILL.md` | `docs/servers/server-development.md` §1–2 | Prescribes the **pre-migration** shape: a root guardrails file (`sqlGuardrails.ts`) that the standard-structure refactor moved into `middleware/`, and a `build/dev/start/typecheck` vocabulary that **omits `test` and `smoke`** — the two scripts every root aggregate depends on. Never mentions `new:server`, `templates/server/`, the manifest entry, or the snapshot-before-register ordering. `server-development.md` covers all of it correctly | **Medium** — removes a skill, so it is a **behaviour change**: the scaffold skill stops being auto-loadable | Listed by name in `CLAUDE.md` §"Workspace Rules & Skills". `packages/manifest/src/servers.ts` references `mcp-skill-authoring` — **not** this one |
| `.claude/skills/mcp-release-checklist/SKILL.md` | `docs/development/workflow.md` §4 + `CONTRIBUTING.md` | Its checklist omits the entire actual gate — no `verify:all`, `verify:live`, `contracts:check` or `generate:check` — and says *"`start` works from built output"* where the vocabulary is `smoke`. A release checklist that misses the release gate is worse than none | **Medium** — behaviour change (skill removed) | `CLAUDE.md` skill list. Overlaps `codebase-index-mcp/.claude/skills/index-release-checklist` (kept, and repointed) |
| `codebase-index-mcp/.claude/skills/graph-schema-design/SKILL.md` | `codebase-index-mcp/CLAUDE.md` §"Graph model" | Prescribes a schema that **does not exist**: nodes `Repository/Revision/File/Module/Symbol/IndexRun` and edges `CONTAINS/IMPORTS/EXPORTS/CALLS/DEPENDS_ON/CHANGED_IN`. Against `src/types/index.ts:188`, three of those edges are invented and **seven real ones are missing** (`IMPLEMENTS`, `EXTENDS`, `TYPE_REF`, `PROPERTY_REF`, `PROPERTY_WRITE`, `PUBLISHES`, `CONSUMES`). This is the fourth wrong graph-model list in the repo (cf. **F-08**, **F-12**) | **Low** — behaviour change, but the content is actively wrong, so loss is negative | Merge target is itself an UPDATE for F-08 — **sequence these two together** |

**Merge discipline.** Each merge lands the destination edit and the deletion in **one commit**, so
`git revert` restores both — `CONTRIBUTING.md`'s "one item = one commit = one revert" rule. Never
delete first and merge later; a half-applied merge loses content with no marker that it is missing.

## 4. DELETE — 4 files

The four shells above, after their content lands. Recovery is `git log --follow <path>`.

**Explicitly not deleted**, though each was considered:

| Considered | Kept because |
|---|---|
| `codebase-index-mcp/.claude/skills/codebase-index-scaffold/SKILL.md` | Describes how to build an index server that is already built — as vestigial as `graph-schema-design`. But it prescribes nothing *false*, and the middle appetite sanctioned exactly three removals. **Flagged as the first candidate if a second pass is wanted** |
| `docs/architecture/as-built.md` | The as-built / design split against `target-architecture.md` is deliberate and already explained in its own header |
| The 4 generated `SKILL.md` files | Gitignored build output. Deleting them is meaningless; they are re-rendered by `mcp:update` |
| Any historical document | The audit found nothing obsolete. Archiving relocates; it does not discard |

---

## 5. UPDATE — content defects (31 files)

Ordered by whether a reader acting on the document would do the wrong thing.

### P0 — an agent executes the document and it fails

| File | Finding | Fix | Risk | Dependencies |
|---|---|---|---|---|
| `codebase-index-mcp/skill/SKILL.md` | **F-01** — 3 invalid params (`index_repository(profile:)`, `find_impact_files(changedFiles:, depth:)`, `scope:{filePaths:}`) | Correct against `contracts/codebase-index.json` | **High impact, low risk** — this is the file the installer renders into `~/.claude/skills/`; schemas are zod `.strict()`, so these calls are **rejected**, not ignored | Re-render: `npm run mcp:update -- --server codebase-index` |
| `postgres-mcp/skill/SKILL.md` | **F-02** — 7 lines name pre-S-43 env vars (`PG_WRITE_ENABLED`, `CH_DB_CONNECTION`, `MCP_DB_DEFAULT_LIMIT`, …) | Rename to `POSTGRES_*` | **High impact** — the prose contradicts the `{{ENV_TABLE}}` rendered beside it. Last touched **2026-07-08**, three weeks before S-43 | **Must re-run `mcp:update -- --server postgres-mcp`** — the installed copy on disk is independently stale and the repo fix alone does not correct it |
| `postgres-mcp/README.md` | **F-02** — same names in hand-written prose at lines 7, 8, 21–22, 70–71, 91, 104, 112 | Rename to `POSTGRES_*` | **Low** — edits are strictly **outside** the generated block (lines 122–152) | `generate:check` must stay green; do not touch the marked block |
| `codebase-index-mcp/docs/EXAMPLES.md` | **F-01** — 5 invalid params; 3 of 5 "canonical" examples cannot execute | Correct against the contract | **Low** | Same fix vocabulary as the skill — do both in one pass |
| `codebase-index-mcp/docs/DECISION-TREE.md` | **F-01** — `detect_changes(policyPreset:)`, `get_folder_summary(profile:)` | Correct | **Low** | Cited by `mcp-hard-mode.md:125` |
| `codebase-index-mcp/.claude/commands/codebase-index.md` | **F-01** — `find_impact_files(changedFiles:, depth:)`, `refactor_replace_preview(searchPattern:, replacePattern:)` | Correct | **Low** | Slash command — user-invocable |
| `.claude/rules/codebase-index.md` | **F-12** — names 5 tools as the contract; **`get_module_flow` and `find_impact_surface` do not exist** | Replace with `find_impact_files(view:"surface")` and `trace_execution_flow` | **Low** | Always-on rule file — wrong here is wrong in every session |
| `AGENTS.md` | **F-03** default profile `standard`→`compact` (38 schemas vs 3) · **F-04** issue list `001–012` vs actual `022, 031–041` — **zero overlap** · **F-08** invents `NUGET_DEPENDENCY`, `PROJECT_REFERENCE` · **F-09** 47→69 · **F-21** ambiguous paths | Correct all five. **Replace the issue list with a pointer, not a copy** — a copy is what drifted | **Medium** — 350 lines, the most drifted doc in the repo | Overlaps `CLAUDE.md` heavily; resolve conflicts toward `CLAUDE.md` |

### P1 — a gate or a record does not say what is true

| File | Finding | Fix | Risk | Dependencies |
|---|---|---|---|---|
| `docs/migration/ci.md` → **`docs/development/ci.md`** | **F-06** `verify:all` row omits `generate:check` · **F-10** sdk 50→**97**, cli 13→**20**, `@mcp/manifest` (26) missing · **F-11** postgres 53→**64**, observe 41→**56** | Correct, then **promote out of `migration/`** per §1 | **Medium** — a move plus a rewrite | `.github/workflows/ci.yml:6`; `docs/development/workflow.md` §4 duplicates the CI table — make one cite the other |
| `CLAUDE.md` | **F-05** 34→**32** harnesses (×2) · **F-08** 7 of 10 edge types, 10 of 14 symbol kinds | Correct; prefer *"the `test:*` scripts `run-tests.mjs` discovers"* over any number | **Medium** — 23 inbound refs, the agent entry point | Also carries 15 archive refs (§6) |
| `codebase-index-mcp/CLAUDE.md` | **F-08** graph model · **F-16** ambiguous registry path | Correct; absorb `graph-schema-design` (§3) | **Low** | Sequence with the MERGE |
| `docs/servers/server-development.md` | **F-05** — says **31** at line 253 and **34** at line 263 | Settle on **32** | **Low** | Absorbs `mcp-scaffold` (§3) |
| `docs/guides/onboarding.md` | **F-05** — "behind 31 of them" | → 32 | **Low** | — |
| `docs/development/workflow.md` | Absorbs `mcp-release-checklist` (§3); **F-13** 508→516 | Add the checklist's unique items | **Low** | Cross-refs the promoted `docs/development/ci.md` |
| `CONTRIBUTING.md` | **F-13** 508→516 (its own worked example of a well-attributed number) · **R-6** the address-vs-assertion rule · **R-11** a *"changed a tool's parameters"* row | Three edits | **Low** | — |
| `docs/reference/conventions.md` | **F-13** 508→516 · **F-14** indexPipeline 572→**582** | Correct | **Low** | 17 inbound refs |
| `docs/reference/folder-convention.md` | **F-13**, **F-14** | Correct | **Low** | 12 inbound refs |
| `docs/architecture/target-architecture.md` | **F-13** in the §9 reconciliation row | Correct | **Low** | Sole remaining occupant of `docs/architecture/` after the move |
| `contracts/README.md` | **F-15** `PG_ALLOWED_ENVIRONMENTS` → `POSTGRES_*` | One token | **Low** | Absorbs `mcp-contract-conformance` cross-ref |
| `codebase-index-mcp/docs/mcp-codebase-index-issue-registry.md` | **F-20** no status index (910 lines, 12 issues) | Add an ID → title → status table at the top | **Low** — additive | This absence is what let **F-04** go unnoticed |
| `postgres-mcp/docs/mcp-postgres-issue-registry.md` | **F-20** (607 lines, 16 issues) | Same | **Low** | PG-DOC-001 shows this class of defect recurring |
| `docs/decisions/README.md` | **F-17** restates all three ADRs at 20–35 lines each | Trim to one-paragraph summaries + links | **Low** | The ADRs themselves are KEEP |
| `docs/README.md` | Index must gain `docs/archive/`, `docs/development/ci.md`; and should state that the four **operational** skills are generated per server and gitignored (only `server-development.md` §3 says so today) | Rewire | **Low** | The hub — do this **last** in each phase |

### P2 — pre-migration policy and skills (17 files, *middle* appetite)

All 17 keep their place on the skill surface; each gets an anchor to the authoritative doc, and the
false prescriptions are corrected. Grouped because the edit is the same shape.

| Files | Defect | Fix |
|---|---|---|
| `.claude/rules/mcp-base.md`, `.claude/rules/typescript-mcp.md` | Script vocabulary `build/dev/start/typecheck` **omits `test` and `smoke`**; "a dedicated guardrails file" is the pre-standard-structure convention (now `middleware/`) | Correct both; cite `docs/reference/conventions.md` §4 and `docs/reference/folder-convention.md` §2 |
| `.claude/rules/db-guardrails.md` | Accurate but unanchored | Cite **ADR 0002** — the per-dialect token-list decision is exactly what this rule is about |
| `.claude/rules/mcp-hard-mode.md` | **Merge destination** for the cheatsheet (§3) | Absorb the runbook table; verify every tool name against the contract while editing |
| `.claude/skills/`: `db-parameterization-audit`, `db-query-budgeting`, `mcp-contract-conformance`, `mcp-error-taxonomy`, `mcp-host-integration-security`, `mcp-observability-runbook`, `mcp-security-review`, `mcp-tool-annotations` (8) | Checklists still valid, but **zero references to the platform** — no `@mcp/core` error codes, no `contracts:check`, no `verify:all`, no guards | Add a *"Authoritative reference"* line per skill pointing at `contracts/README.md`, `docs/reference/conventions.md`, `docs/reference/dependency-rules.md` or ADR 0002 as appropriate |
| `codebase-index-mcp/.claude/skills/`: `codebase-index-scaffold`, `incremental-indexing`, `index-conformance-full-vs-incremental`, `index-metadata-governance`, `index-release-checklist`, `index-security-review`, `index-unresolved-symbol-policy`, `mcp-first-codebase-operations`, `tree-sitter-extraction` (9) | Same — design-time guidance for a server that shipped | Same anchoring. `index-release-checklist` → `docs/development/workflow.md` §4. `mcp-first-codebase-operations` → point at `mcp-hard-mode.md` as policy home rather than restating it |

**Risk for all 17: Low.** Each is additive or corrective, none is removed, so no skill-surface
behaviour changes. **Dependency:** `CLAUDE.md` lists these by name; its list shrinks by 3 (§3).

### The gitignored four

`.claude/skills/{codebase-index,postgres-mcp,observe-mcp,bitbucket-mcp}/SKILL.md` — **regenerate, do
not edit.** They are rendered from the `<server>/skill/SKILL.md` templates. The postgres copy is
verified stale on disk (env table shows `CH_DB_CONNECTION` as canonical, i.e. pre-S-43). Fixed by
`npm run mcp:update -- --all` after the P0 template edits, not by touching them.

## 6. UPDATE (refs only) — 12 files

Correct content; the addresses they cite change. **Path-only diffs**, reviewable as such.

| File | Refs | Note |
|---|---|---|
| `docs/development/backlog.md` | 15 | Highest churn. Active doc — freely editable |
| `CHANGELOG.md` | 10 | **Historical** — paths only, per the §2 rule. Claims, numbers, dates untouched |
| `docs/architecture/as-built.md` | 4 (1 link) | — |
| `docs/decisions/0001-workspace-native-deps.md` | 2 | Cites `s24-notes.md` by name |
| `docs/reference/packages.md` | 2 | — |
| `README.md` | 1 (link) | — |
| `docs/decisions/README.md` | 1 (link) | Combine with its **F-17** trim |
| `docs/reference/conventions.md`, `docs/development/workflow.md`, `docs/reference/folder-convention.md` | 1 each | Combine with their P1 content edits |
| `.github/workflows/ci.yml` | 1 | Comment → `docs/development/ci.md` (§1 carve-out) |
| `codebase-index-mcp/src/tools/refactor.ts` | 1 | **Source JSDoc** → `docs/archive/migration/status.md` |
| `codebase-index-mcp/scripts/test/test-impact-join-parity.mjs` | 1 | Harness comment → same |

`CLAUDE.md` and `docs/README.md` also carry 15 and 5 archive refs, but they have substantive edits in
§5, so they are counted there — do both in one commit each.

## 7. KEEP — 26 files

No edit. Every checkable claim in these verified exact during the audit.

| Files | Why |
|---|---|
| `docs/reference/dependency-rules.md`, `docs/servers/tool-development.md` | **The reference standard.** Every count in `dependency-rules.md` verified exact — including the subtle one needing type-only vs value imports distinguished (41 total / 26 type / 12 files) |
| `docs/decisions/0002`, `docs/decisions/0003` | Verified. 0001 is refs-only (§6) |
| `packages/{core,sdk,shared,testing,cli,manifest}/README.md` (6) | All six consistent with `packages/cli/src/guards/rules.ts`; each states its tier in the header |
| `observe-mcp/README.md`, `observe-mcp/skill/SKILL.md` | **Zero** param or env drift found — the control group proving the drift is not universal |
| `bitbucket-mcp/README.md`, `bitbucket-mcp/skill/SKILL.md` | Same |
| `codebase-index-mcp/README.md` | Best-maintained server doc (25 commits); the annotated 43-tool catalogue |
| `templates/server/README.md`, `templates/server/skill/SKILL.md` | Rebuilt 2026-08-03 on the current `create*`/`register*` vocabulary |
| `.claude/skills/mcp-skill-authoring/SKILL.md` | The **only** platform-aware authoring skill; referenced from `packages/manifest/src/servers.ts` |
| `.claude/commands/mcp-effectiveness-eval.md` | No findings |
| `docs/archive/reports/documentation-audit.md`, this file | The audit trail |
| `docs/migration/migration-plan.md` … | *(archived, not kept — see §2)* |

**A caveat that prevented four wrong calls.** 28 documents have **zero inbound Markdown references**,
including every `SKILL.md` and three package READMEs. Zero inbound refs does **not** mean orphaned:
skills are discovered by directory name by the harness, and `.claude/rules/*` are always-on by scope.
Inbound-link count is not a liveness signal for these, and treating it as one would have deleted the
`observe-mcp` and `bitbucket-mcp` skills — the two cleanest documents in the repository.

---

## 8. Execution order

Six phases. Ordering rationale: **build the checker before the churn**, fix correctness before
cosmetics, and do the 92-reference move **last** so nothing else rebases on top of it.

### Phase 0 — the gate (do this first)

Recommendation **R-1** from the audit, and the precondition for Phase 4.

```
scripts/check-docs.mjs        # new
  1. tool-param check   every tool_name({…}) in *.md vs contracts/*.json inputSchema
  2. env-alias check    deprecatedAliases used as the operative name
  3. reference check    every backtick path + markdown link resolves   <-- catches the 75
```

Wire into `verify:all` as `docs:check`. Without check #3 the archive move leaves 75 stale prose
pointers while the link checker reports green. All three checkers exist as ~40-line prototypes from
the audit and only need promoting to `scripts/`.

**Deliberate consequence:** `docs:check` will fail immediately, on the F-01/F-02 defects. That is the
gate working — land it in warn mode, or land it in the same commit as Phase 1.

### Phase 1 — P0 correctness (7 files)

F-01 and F-02. **Then `npm run mcp:update -- --all`**, without which the installed skills stay
stale — the repo fix alone does not reach `~/.claude/skills/`. Independent of the archive move;
ship it first regardless of what follows.

### Phase 2 — P1 content (14 files)

Counts, graph-model lists, `AGENTS.md`, the `ci.md` promotion. One commit per document.

### Phase 3 — MERGE → DELETE (4 files)

Each merge and its deletion in **one** commit. Sequence `graph-schema-design` with the
`codebase-index-mcp/CLAUDE.md` graph-model fix from Phase 2.

### Phase 4 — ARCHIVE (12 moves + 92 references)

Land as **three** commits so a bisect can isolate a bad retarget:

1. `git mv` the 12 files + add `docs/archive/README.md`
2. Retarget the 29 internal (archive → archive) references
3. Retarget the 63 external references — **`CHANGELOG.md` path-only**

Then `npm run docs:check && npm run verify:all`.

### Phase 5 — structural additions

`CODEOWNERS` (**F-19**) · the two registry status indexes (**F-20**) · a language policy in
`docs/reference/conventions.md` §7 (two of four server READMEs are Vietnamese, and no rule says which language
a new doc uses) · the *"changed a tool's parameters"* row in `CONTRIBUTING.md`.

### Phase 6 — decide the deferred item

**R-9:** the 9 harnesses in `codebase-index-mcp/scripts/test/` wired to no `test:*` script and
therefore never run. `docs/servers/server-development.md:265` documents them honestly and has for long
enough to decide: wire them or delete them. Note `CLAUDE.md:38` claims the discovered list *"cannot
fall behind"* — true of **scripts**, false of **harnesses**.

---

## 9. Verification

After each phase:

```bash
npm run docs:check          # new — tool params, env aliases, every reference
npm run verify:all          # packages + servers + contracts + generated docs
npm run mcp:doctor          # per-server build/config/env/skill/start
```

Phase-specific:

| Phase | Additional check |
|---|---|
| 1 | Call each corrected example against the live server via MCP. Schemas are `.strict()`, so a wrong param **errors** — this is a real test, not a read-through |
| 1 | `npm run mcp:update -- --all`, then confirm `~/.claude/skills/postgres-mcp/SKILL.md` shows `POSTGRES_*` |
| 3 | `git show --stat` on each merge commit: destination edit **and** deletion present |
| 4 | Reference count for `docs/migration/` and `docs/refactor/` outside `docs/archive/` reaches **0**, excluding `docs/reports/` |
| 4 | `git log --follow docs/archive/migration/status.md` returns full pre-move history |
| 5 | `mcp:doctor` still PASS 5/5 per server — Phase 3 removed three skills; confirm none was a *server operational* skill |

**Rollback.** One item = one commit = one `git revert`. Phase 4's three-commit split means a bad
retarget reverts without undoing the moves.

---

## 10. What this plan does not do

| Not doing | Why |
|---|---|
| Rewrite claims, numbers or dates in any historical document | `CONTRIBUTING.md`. Paths are addresses; claims are assertions (§2) |
| Reconcile `migration-plan.md`'s 6 dead script names and 8 never-shipped paths | Its ❄️ FROZEN banner is the correct mechanism |
| Merge `docs/architecture/as-built.md` into `target-architecture.md` | The as-built / design split is deliberate and self-documenting |
| Delete any historical document | The audit found nothing obsolete. Archiving relocates; it does not discard |
| Remove more than three skills | The *middle* appetite was chosen. `codebase-index-scaffold` is flagged as the next candidate (§4) |
| Touch generated blocks or `.env.example` | `generate:check` owns them |
| Convert the two Vietnamese READMEs | Out of scope; Phase 5 adds the policy that would decide it |

---

## 11. Summary

| | |
|---|---|
| Files categorized | **89** — 26 KEEP · 31 UPDATE · 12 UPDATE (refs) · 4 MERGE→DELETE · 12 ARCHIVE · 4 regenerate |
| Files moved | 12 (+1 promoted: `docs/migration/ci.md` → `docs/development/ci.md`) |
| Files deleted | 4, each after its content landed |
| New files | 2 — `docs/archive/README.md`, `scripts/check-docs.mjs` |
| References to retarget | **92** (17 links + 75 prose), incl. 3 in non-doc files |
| Commits | ~55, one per item; Phase 4 split into 3 |

**Phase 0 is the phase that matters.** Two of this repository's four generated documentation surfaces
are gated and two are not, and both critical findings live in the ungated pair. Every other phase
fixes documents; Phase 0 fixes the reason they drifted. The workspace's own sharpest rule is the
diagnosis, and it was written in this repo about this exact failure mode:

> *A convention nobody checks is a preference.* — `docs/reference/conventions.md`, ADR 0002

Env names and tool schemas are checked everywhere they are **declared**, and nowhere they are
**explained**.

---

*Planning artifact. No documentation was modified in producing this file.*
