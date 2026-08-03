# Archive

Closed records. **Nothing here is maintained.**

Every document in this directory was accurate at the commit it names, and is kept so the reasoning
behind a decision stays recoverable. None of it describes the present.

> **Do not read a current state out of this directory.** For what is true now:
> [`../architecture/as-built.md`](../architecture/as-built.md) (as built) · [`../reference/conventions.md`](../reference/conventions.md)
> (the rules and what enforces them) · [`../development/backlog.md`](../development/backlog.md) (what is left) ·
> [`../README.md`](../README.md) (the full index).

---

## What closed

| | |
|---|---|
| **The migration** | 44 steps across phases A–K, between 2026-07-27 and 2026-07-29. **43 done, S-42 skipped by decision, 0 open.** Took four independently-grown MCP servers to four servers on a six-package platform with enforced dependency rules, snapshotted tool contracts and generated configuration |
| **The post-migration refactors** | The nine-slot `src/` structure in all four servers (153 files moved, 1 split), and the shared-component extraction that preceded it |
| **The pre-migration audit** | The repository as it stood at `01c532e`, before any restructuring |

## Contents

### `migration/` — the 44-step migration

| File | What it is |
|---|---|
| [`migration/README.md`](migration/README.md) | Index for this set, the phase table, and the findings worth carrying forward |
| [`migration/status.md`](migration/status.md) | All 44 steps verified against the working tree, each row citing the artifact that proves it. **Was** the live state document; the migration it tracked is closed |
| [`migration/migration-plan.md`](migration/migration-plan.md) | The plan as written on 2026-07-27. Carries its own ❄️ FROZEN banner. Kept for the reversibility classes and rollback plans, which still inform work of a similar shape |
| [`migration/foundation-notes.md`](migration/foundation-notes.md) | What the `packages/` foundation contains and why each piece is shaped that way |
| [`migration/normalization-report.md`](migration/normalization-report.md) | The 48-file in-place folder normalization (S-37) |
| [`migration/s06-s23-notes.md`](migration/s06-s23-notes.md) | Contract snapshots + the `bitbucket-mcp` SDK pilot |
| [`migration/s24-notes.md`](migration/s24-notes.md) | `postgres-mcp` onto the SDK — the call-replay method |
| [`migration/s25-notes.md`](migration/s25-notes.md) | `observe-mcp` onto the SDK — a profile-dependent serialization finding no schema could reveal |
| [`migration/s26-s29-plan.md`](migration/s26-s29-plan.md) | `codebase-index-mcp` onto the SDK. **Uses commit-side step numbers**, which differ from the plan's |

### `refactor/` — what landed after the migration closed

| File | What it is |
|---|---|
| [`refactor/standard-structure-report.md`](refactor/standard-structure-report.md) | The nine-slot layout: the rule that decides which slot a file belongs in, the per-server before/after map, which slots are N/A and why, and the compatibility evidence. Current-state successor: [`../reference/folder-convention.md`](../reference/folder-convention.md) |
| [`refactor/duplication-extraction-report.md`](refactor/duplication-extraction-report.md) | The shared-component extraction, its measured behaviour deltas, and the one cluster deliberately left alone. Current-state successor: [`../reference/packages.md`](../reference/packages.md) |

### `audit-report.md`

[`audit-report.md`](audit-report.md) — the Phase 0 audit of the pre-restructuring repository at
`01c532e`: dependency map, duplication, technical-debt register, risks.

### `reports/` — superseded documentation assessments

The four reports that produced the current documentation state. Superseded as assessments by
[`../reports/documentation-health.md`](../reports/documentation-health.md); kept because they carry the
reasoning and measurements behind every change.

| # | Report | What it did |
|---|---|---|
| 1 | [`reports/documentation-audit.md`](reports/documentation-audit.md) | The original survey at `74d43a0` — 21 findings, 2 critical |
| 2 | [`reports/documentation-cleanup-plan.md`](reports/documentation-cleanup-plan.md) | All 89 documents categorized KEEP / UPDATE / MERGE / ARCHIVE / DELETE, with why, risk, dependencies, destination |
| 3 | [`reports/documentation-cleanup-report.md`](reports/documentation-cleanup-report.md) | Execution record — 47 modified, 19 moved, 0 deleted, 92 references retargeted |
| 4 | [`reports/documentation-review.md`](reports/documentation-review.md) | Post-cleanup verification across 13 dimensions; 8 defects found and fixed |

**They describe the pre-portal `docs/` layout.** Their paths were retargeted so cross-references
resolve; no claim, number or date was altered.

### `superseded/` — merged into a maintained document

Each of these was absorbed into a document that is checked and kept current. They are here because
**nothing is deleted**, not because they should be consulted — each was removed for being *wrong*, not
merely redundant.

| File | Absorbed into | Why it was retired |
|---|---|---|
| [`superseded/MCP-FIRST-CHEATSHEET.md`](superseded/MCP-FIRST-CHEATSHEET.md) | [`../../.claude/rules/mcp-hard-mode.md`](../../.claude/rules/mcp-hard-mode.md) §"One-Page Quick Reference" | Duplicated always-on policy, and had drifted: it named `mcp_health_check` / `mcp_run_read_query`, which are not real tool names |
| [`superseded/skill-mcp-scaffold.md`](superseded/skill-mcp-scaffold.md) | [`../servers/server-development.md`](../servers/server-development.md) §1–2 | Prescribed a root guardrails file the standard-structure refactor moved into `middleware/`, and a script vocabulary omitting `test` and `smoke` |
| [`superseded/skill-mcp-release-checklist.md`](superseded/skill-mcp-release-checklist.md) | [`../development/workflow.md`](../development/workflow.md) §4 | Omitted `verify:all`, `verify:live`, `contracts:check` and `generate:check` — the entire release gate |
| [`superseded/skill-graph-schema-design.md`](superseded/skill-graph-schema-design.md) | [`../../codebase-index-mcp/CLAUDE.md`](../../codebase-index-mcp/CLAUDE.md) §"Graph model" | Prescribed three edge types that never existed and omitted seven that do |

---

## Two conventions that apply to everything here

**A path is an address, not an assertion.** Paths inside these documents were retargeted when the
files moved on 2026-08-03, so their cross-references still resolve. **No claim, number, date or
commit hash was altered.** Updating an address preserves a claim and keeps it checkable; leaving it
stale destroys the reader's ability to verify it at all.

**Step numbers do not always match commit messages.** Three commits carry S-numbers that differ from
the plan's — `0eccb10` labelled S-24 is the plan's S-25, `e5feaf3` labelled S-25 is S-24, `9ccae95`
labelled S-26 is S-28. The commits are immutable, so the mapping is recorded in
[`migration/status.md`](migration/status.md) rather than rewritten.

### Filenames that moved *after* these records were written

The move-tables in [`migration/normalization-report.md`](migration/normalization-report.md) record
where S-37 put each file **on 2026-07-27**, and are left exactly as written — that column is a claim
about what S-37 did, not a pointer to maintain. Three of those destinations have since changed:

| S-37 destination (as recorded) | Where it is now |
|---|---|
| `codebase-index-mcp/docs/DECISION-TREE.md` | `codebase-index-mcp/docs/decision-tree.md` |
| `codebase-index-mcp/docs/EXAMPLES.md` | `codebase-index-mcp/docs/examples.md` |
| `codebase-index-mcp/docs/MCP-FIRST-CHEATSHEET.md` | [`superseded/MCP-FIRST-CHEATSHEET.md`](superseded/MCP-FIRST-CHEATSHEET.md) |

The two renames standardized content-doc filenames on lowercase-kebab; `README.md`, `CLAUDE.md`,
`AGENTS.md`, `CONTRIBUTING.md`, `CHANGELOG.md` and `SKILL.md` keep their conventional upper-case names
because tooling recognises them. **Files already inside this archive keep the names they were archived
under**, so `git log --follow` and any external reference still resolve.

`docs/migration/baseline.md` and `docs/migration/rollback-drill.md`, named in
[`migration/migration-plan.md`](migration/migration-plan.md), were **planned and never created** —
those paths are deliberately left unretargeted, because pointing them into this archive would imply
files that do not exist.

---

## References from outside the documentation

Five non-documentation files carry comments citing documents that moved here or into the portal. All
five were **corrected on 2026-08-03** when `docs/` was reorganized, so no stale pointer remains:

| File | Now cites |
|---|---|
| `.github/workflows/ci.yml` | [`../development/ci.md`](../development/ci.md), [`../reference/conventions.md`](../reference/conventions.md), [`../development/backlog.md`](../development/backlog.md) |
| `codebase-index-mcp/src/tools/refactor.ts` | [`migration/status.md`](migration/status.md) |
| `codebase-index-mcp/scripts/test/test-impact-join-parity.mjs` | [`migration/status.md`](migration/status.md) |
| `observe-mcp/src/middleware/sqlGuardrails.test.ts` | [`../decisions/0002-sql-guardrail-token-lists.md`](../decisions/0002-sql-guardrail-token-lists.md) |
| `packages/core/src/result.ts` | [`../reference/conventions.md`](../reference/conventions.md) |

All five are comments; none affects behaviour. `packages/core/dist/result.d.ts` carries the old path
until the next `npm run build:packages` — it is generated output, not a source of truth.
