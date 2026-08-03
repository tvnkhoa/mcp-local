# Documentation Cleanup — Execution Report

**Plan** — [`documentation-cleanup-plan.md`](./documentation-cleanup-plan.md)
**Audit** — [`documentation-audit.md`](./documentation-audit.md)
**Baseline** — `74d43a0` (main, clean working tree)
**Executed** — 2026-08-03
**Change set** — 47 files modified · 19 moved · 2 created · **0 deleted** · **100% Markdown**

---

## 1. Outcome

| Check | Before | After |
|---|---|---|
| Broken Markdown links | 0 | **0** |
| Invalid documented tool parameters | 11 across 15 mentions | **0** |
| Deprecated env names used as an *instruction* | 14 mentions | **0** |
| Ambiguous root-relative script paths in active docs | 4 | **0** |
| Documents with verified stale counts | 7 | **0** |
| Headings: multiple `h1` / skipped levels / setext | 0 / 0 / 0 | **0 / 0 / 0** |
| Files missing an EOF newline | 1 | **0** |
| Registries with a status index | 0 of 2 | **2 of 2** |
| `npm run generate:check` | pass | **pass** |
| `npm run guard:all` | 0 err · 20 warn · 1 exempt · 516 files | **unchanged** |
| Files deleted | — | **0** |

**Two scope adjustments were forced by the requirements**, both departures from the approved plan:

1. **Nothing was deleted.** *"Never lose historical information… archive instead of deleting"*
   supersedes the plan's delete-after-merge decision. The four merged shells went to
   `docs/archive/superseded/` with their content intact. The plan's DELETE bucket is empty.
2. **Two items could not be completed** under *"do not modify source code"* — see §7. Both are
   reported rather than quietly dropped, and one leaves F-02 **half-applied**.

---

## 2. Structure now

```
docs/
├── README.md                  the index — rewired
├── architecture.md  conventions.md  development.md  onboarding.md
├── dependency-rules.md  folder-convention.md  packages.md
├── server-development.md  tool-development.md  backlog.md
├── ci.md                      ← PROMOTED out of docs/migration/
├── adr/                       0001 · 0002 · 0003 · README (trimmed)
├── architecture/              target-architecture.md
├── reports/                   audit · cleanup-plan · this report
└── archive/                   ← NEW · 17 files · nothing maintained
    ├── README.md              the cover note
    ├── audit-report.md
    ├── migration/             10 files (the closed 44-step migration)
    ├── refactor/              2 files
    └── superseded/            4 files merged into maintained docs
```

`docs/` top level went from 11 mixed current/historical entries to **12 current-state guides**, with
all history behind one labelled door.

---

## 3. MERGE — 4 documents, content absorbed then archived

| Source → archived at | Absorbed into | What actually moved |
|---|---|---|
| `codebase-index-mcp/docs/MCP-FIRST-CHEATSHEET.md` → `archive/superseded/` | `.claude/rules/mcp-hard-mode.md` §"One-Page Quick Reference" (new) | **Verified subset first.** All six of its runbooks already existed in the rule file. Its one distinct affordance — a one-page scannable index — was added as a 9-row table mapping goal → runbook → detailed flow |
| `.claude/skills/mcp-scaffold/SKILL.md` → `archive/superseded/skill-mcp-scaffold.md` | `docs/servers/server-development.md` §1 | A "do not hand-build a server" callout naming exactly why the skill was retired: a root `sqlGuardrails.ts` the standard-structure refactor moved into `middleware/`, and a vocabulary omitting `test`/`smoke` |
| `.claude/skills/mcp-release-checklist/SKILL.md` → `archive/superseded/skill-mcp-release-checklist.md` | `docs/development/workflow.md` §4 "Release readiness" (new) | Its six genuinely-uncovered checks (least-privilege defaults, bounds documented, config hygiene, README completeness, change hygiene, built-output smoke) — reframed onto `smoke` rather than `start`, and onto the real gate |
| `codebase-index-mcp/.claude/skills/graph-schema-design/SKILL.md` → `archive/superseded/skill-graph-schema-design.md` | `codebase-index-mcp/CLAUDE.md` §"Graph model" | Its four schema guardrails (repo-boundary scoping, run provenance, no raw sensitive spans, migration path). Its *schema baseline* was discarded — it named three edge types that never existed and omitted seven that do |

**Skill surface: 15 → 13** workspace, **10 → 9** codebase-index. Every removal is a deliberate
behaviour change, recorded in `CLAUDE.md`'s skill list with its replacement named.

**Duplicated content removed beyond the merges:**

- `docs/decisions/README.md` **153 → 96 lines**. It restated all three ADRs at 20–35 lines each; now one
  paragraph plus a link, so each decision's reasoning has exactly one home.
- `CLAUDE.md` archive references **15 → 6**. It had reproduced the archive's own file-by-file index;
  that is now a pointer to `docs/archive/README.md` plus the two facts worth knowing without opening it.

---

## 4. ARCHIVE — 13 moved, 0 deleted

All 19 moves were made with `git mv` and register as renames, so `git log --follow` resolves through
them. Nothing was rewritten wholesale.

| Destination | Files |
|---|---|
| `docs/archive/migration/` | `README` · `status` · `migration-plan` · `foundation-notes` · `normalization-report` · `s06-s23-notes` · `s24-notes` · `s25-notes` · `s26-s29-plan` |
| `docs/archive/refactor/` | `standard-structure-report` · `duplication-extraction-report` |
| `docs/archive/` | `audit-report.md` (from `docs/architecture/`) |
| `docs/archive/superseded/` | the 4 merged shells (§3) |

### The one carve-out

**`docs/migration/ci.md` → `docs/development/ci.md`**, not archived. It is cited by `.github/workflows/ci.yml:6`
as the explanation of current behaviour, it records the live B-05 credential decision, and its three
staleness bugs existed *because* its location marked it historical while readers treated it as
current. Its header now says so explicitly: *"this file is current-state and is maintained."*

### `docs/archive/README.md` — new cover note

States what closed and when, that nothing inside is maintained, which maintained document replaced
each piece, the step-number reconciliation, and the filename changes that post-date the frozen
move-tables. An archive without a cover note becomes a junk drawer.

### 92 references retargeted

| | Markdown links | Prose mentions | Total |
|---|---|---|---|
| Active file → archive | 9 | 54 | 63 |
| Archive → archive | 8 | 21 | 29 |

Only 17 were links a checker would catch; **75 were backtick prose mentions no gate sees**. Both
classes were rewritten, and links were recomputed per-file rather than string-substituted — which is
what caught the second-order breakage in §6.

---

## 5. UPDATE — corrections applied

### P0 — documents that would fail when executed

**F-01 · 11 invalid tool parameters → 0.** Every documented call now validates against
`contracts/codebase-index.json`. These were not cosmetic: the schemas are zod `.strict()`
(50 occurrences), so an unknown key is **rejected**.

| Document | Corrected |
|---|---|
| `codebase-index-mcp/skill/SKILL.md` | `index_repository(profile:)` dropped · `find_impact_files(changedFiles:, depth:)` → `(filePath:, view:, groupBy:)` · `scope:{filePaths:}` → `{includePaths:}` · `find`/`replaceExpression` · `rollbackId` |
| `codebase-index-mcp/.claude/commands/codebase-index.md` | same three + `refactor_replace_rollback(applyId:)` → `(rollbackId:)` |
| `codebase-index-mcp/docs/examples.md` | `get_symbol_context_pack(symbolId:)` → `(name:)` · `find_impact_files(symbolId:)` → `(filePath:)` · `detect_changes(policyPreset:)` → `(policy:)` · `searchPattern`/`replacePattern` → `find`/`replaceExpression` · `rollbackId`, with the apply response now showing where it comes from |
| `codebase-index-mcp/docs/decision-tree.md` | `get_folder_summary(profile:)` dropped · `detect_changes(policyPreset:)` → `(policy:)` · **4 further `find_impact_files(symbolId, …)`** and **2 `get_symbol_context_pack(symbolId, …)`** corrected — beyond the audit's list, found by re-checking every signature |

**Two invalid parameters the audit had missed** surfaced during execution and are fixed:
`get_symbol_context_pack` accepts `name` but **not** `symbolId`; `write_rollback` takes `rollbackId`,
not `applyId` (`postgres-mcp/skill/SKILL.md`). Both were invisible to the audit's checker because they
appeared without a trailing colon.

**F-02 · postgres env names.** `postgres-mcp/skill/SKILL.md` (last touched 2026-07-08, three weeks
before S-43) and the hand-written prose in `postgres-mcp/README.md` now name `POSTGRES_*` throughout.
The skill keeps one deliberate note that the pre-S-43 names remain accepted as aliases.
**Edits stayed strictly outside the generated blocks** (`README.md` lines 37–59 and 122–152);
`generate:check` passes. ⚠️ **Half-applied — see §7.**

**F-12 · always-on rule naming tools that do not exist.** `.claude/rules/codebase-index.md` listed
`get_module_flow` and `find_impact_surface`; replaced with `trace_execution_flow` and
`find_impact_files(view:"surface")`, plus a line naming `contracts/` as authoritative.

**F-03 / F-04 / F-08 / F-09 · `AGENTS.md`**, the most drifted document:

- Default profile `standard` → **`compact`** (38 schemas declare it, 3 declare `standard`).
- The `MCP-ISSUE-001`…`012` list — which shared **zero IDs** with the registry it claimed to
  summarize — replaced by a two-row pointer table. *A copy of an index is the thing that drifts.*
- Graph schema: 7 edge types (two invented) → the real **10**; symbol kinds → the real **14**; with a
  note that NuGet/ProjectReference relationships are not `EdgeType` members.
- The `47 tests` refactor baseline → read the harness output (69 `assert` calls today).
- A dangling `MCP-ISSUE-003` citation → the test suites that are the durable record.

### P1 — records that did not say what is true

| Finding | Fix |
|---|---|
| **F-05** three harness counts (31 / 34 / 34) across four docs, one self-contradicting ten lines apart | Settled on **32** in `CLAUDE.md`, `docs/guides/onboarding.md`, `docs/servers/server-development.md` |
| **F-06** `verify:all` row omitted `generate:check` | Added; the local-vs-CI difference now stated in both directions |
| **F-10 / F-11** stale test counts (sdk 50→**97**, cli 13→**20**, postgres 53→**64**, observe 41→**56**, `@mcp/manifest` omitted) | Replaced with a measured table **plus the two commands that re-derive it** |
| **F-13** guard file count 508 → **516** in 4 files | Corrected (`0 errors · 20 warnings · 1 exemption` were already exact) |
| **F-14** `indexPipeline.ts` 572 → **582** in 2 files | Corrected |
| **F-15** `PG_ALLOWED_ENVIRONMENTS` example | → `POSTGRES_ALLOWED_ENVIRONMENTS` |
| **F-16 / F-21** ambiguous paths | 4 server-relative script paths → `<server>/scripts/…`; two registry paths made repo-root-relative |
| **F-17** ADR index restatement | Trimmed (§3) |
| **F-20** no registry index | Both registries got one, generated from their own `**Status:**` lines |

**PG-DOC-001 reopened and re-closed.** The postgres registry already carried a *"skill stale on write
gating"* entry marked fixed 2026-06-29. That fix predated S-43, so the skill regressed on a new axis.
Rather than leave the entry claiming closure, it now records the regression, the re-fix, and the reason
it recurred: **the skill templates are the one generated surface no gate validates.**

### P2 — pre-migration policy and skills (17 files)

The audit under-weighted this: **20 of 21 authoring skills contained no reference to the six-package
platform, the guards, or the gate.** Three actively misprescribed and were merged away (§3). The
remaining 17 each gained an **Authoritative reference** section naming the maintained document that
governs it — so a stale checklist now points at something checked.

Three always-on rule files also carried pre-refactor conventions, now corrected:

- `mcp-base.md` — "a dedicated guardrails file" → the nine-slot structure with `middleware/`;
  script vocabulary `build/dev/start/typecheck` → **`build/typecheck/test/smoke`**.
- `typescript-mcp.md` — same vocabulary fix, plus guardrails placement.
- `db-guardrails.md` — now cites **ADR 0002** (the per-dialect token-list decision) and the canonical
  `POSTGRES_*` bound names.

---

## 6. Normalization

**Measured before changing anything**, which is what kept this section honest.

| Dimension | Finding | Action |
|---|---|---|
| Heading style | 85/85 ATX · 0 multiple-`h1` · 0 skipped levels · 0 setext | **None needed** — already uniform |
| Tabs in prose | 0 | none |
| Multiple blank lines | 0 | none |
| EOF newline | 1 missing | fixed |
| Trailing whitespace | 1 file (`archive/migration/migration-plan.md`) | **left** — whitespace churn in a frozen record buys nothing |
| Table of contents | Registries had none; `docs/` index mixed current and historical | Indexes added to both registries; `docs/README.md` split into *Current state* / *History*; `docs/archive/README.md` created |
| **Line endings** | 14 files CRLF, 71 LF | **No action — not a defect.** `.gitattributes` already declares `*.md text eol=lf` and git stores LF; the CRLF is local `core.autocrlf` state. Confirmed with `git diff` on an untouched CRLF file: no diff |
| **Filename casing** | 2 outliers | `DECISION-TREE.md` → `decision-tree.md`, `EXAMPLES.md` → `examples.md` |

**Naming rule now consistent**: content docs are `lowercase-kebab.md`; only the tool-recognised
convention names stay upper-case (`README`, `CLAUDE`, `AGENTS`, `CONTRIBUTING`, `CHANGELOG`, `SKILL`).
Files already inside `docs/archive/` keep the names they were archived under, so external references
and `git log --follow` still resolve.

### Two false positives caught before acting

Worth recording, because both would have produced wrong work:

- **`noH1: 14`** — my checker reported 14 files with no `h1`. The list was byte-identical to the CRLF
  list: in JavaScript `.` does not match before `\r`, so the heading regex failed on CRLF lines. A
  checker artifact, not a documentation defect.
- **The 508 in `docs/development/backlog.md`** was left alone. It sits inside B-08's dated closure note describing
  what was measured *then*. The live figure was corrected in the four current-state docs; changing a
  dated record would misrepresent it.

---

## 7. Not done — and what it costs

### ⚠️ F-02 is half-applied

`postgres-mcp/skill/SKILL.md` is fixed in the repository. **The installed copy at
`.claude/skills/postgres-mcp/SKILL.md` is still the stale pre-S-43 render** — its env table lists
`CH_DB_CONNECTION`, `PG_ENV_*`, `PG_ALLOWED_ENVIRONMENTS` as canonical, and its prose still says
`PG_WRITE_ENABLED`. That file is generated build output; refreshing it means running the installer,
which rebuilds servers and writes to `~/.claude/skills/` — an environment change beyond
*"only modify documentation"*.

```bash
npm run mcp:update -- --all      # required to finish F-02
```

**Until that runs, an agent loading the postgres skill still reads deprecated env names.** This is the
single highest-value follow-up in this report.

### Deferred by the source-code constraint

| Item | Why | Cost |
|---|---|---|
| **`scripts/check-docs.mjs`** (plan Phase 0, audit R-1) | New source file | **The gate that makes all of this un-repeatable does not exist.** Both critical findings were second occurrences; nothing yet stops a third |
| 3 non-doc references to moved docs | Source/config edits | `.github/workflows/ci.yml:6` → `docs/development/ci.md`; `codebase-index-mcp/src/tools/refactor.ts:18` and `scripts/test/test-impact-join-parity.mjs:23` → `docs/archive/migration/status.md`. All three are comments; none affects behaviour. **Recorded in `docs/archive/README.md` so they are not lost** |
| `CODEOWNERS` (audit F-19) | Repo metadata, not documentation | Ownership stays implicit (148 of 150 commits are one author) |
| **9 unwired test harnesses** (audit R-9) | `package.json` change | Still never run. `docs/servers/server-development.md` documents them honestly; `CLAUDE.md`'s "cannot fall behind" claim remains true of *scripts* and false of *harnesses* |

### Deliberately not done

- **No claim, number, date or commit hash was altered in any historical document.** Only paths, per
  the rule now written into `docs/README.md`: *a path is an address, not an assertion.*
- `migration-plan.md`'s 6 dead script names and 8 never-shipped paths stay — its ❄️ FROZEN banner is
  the correct mechanism.
- `codebase-index-scaffold` kept (the *middle* skill appetite sanctioned three removals); flagged in
  the plan as the next candidate.
- The two Vietnamese READMEs were not translated. A language policy remains unwritten.

---

## 8. Verification

```
markdown links                      0 broken   (85 files, all links + anchors)
documented tool params vs contracts 0 invalid  (was 11 across 15 mentions)
deprecated env names as instruction 0          (was 14 mentions)
ambiguous paths in active docs       0          (was 4)
npm run generate:check              PASS       — generated blocks untouched
npm run guard:all                   0 errors · 20 warnings · 1 exemption · 516 files
git status                          47 M · 19 R · 2 new · 0 D · all Markdown
```

### The check that mattered most

After the first retarget pass, links reported **0 broken** — and that was wrong. Nine links *inside*
the moved files pointed at non-moved targets with `../`, now one level too shallow. The link checker
caught them only because it resolves per-file rather than pattern-matching; all nine were fixed.

### And the check that caught me

Reviewing the historical diffs, **two of my own retargets had crossed the line I wrote**:

1. `migration-plan.md` — `docs/migration/baseline.md` and `rollback-drill.md` were retargeted into the
   archive. **Those files were planned and never created.** Pointing them at the archive implies files
   that do not exist. **Reverted.**
2. `normalization-report.md` — its move-table records where S-37 put each file *on 2026-07-27*. I had
   rewritten the `MCP-FIRST-CHEATSHEET.md` destination to the archive, making the record claim a move
   S-37 did not make. **That is a claim, not an address. Reverted** — the file now has zero diff.

Both are noted because the address/assertion distinction is easy to state and easy to violate; the
surviving evidence is that every remaining historical diff is a path to a file that exists.

---

## 9. Summary

| | |
|---|---|
| Documents modified in place | 47 |
| Documents moved (all `git mv`, history preserved) | 19 |
| Documents created | 2 (`docs/archive/README.md`, this report) |
| **Documents deleted** | **0** |
| References retargeted | 92 (17 links + 75 prose) |
| Duplicated lines removed | ~57 from `docs/decisions/README.md`; 9 archive-index rows from `CLAUDE.md` |
| Skill surface | 25 → 22 (3 merged away, 17 anchored to authoritative docs) |
| Findings closed | 20 of 21 · **F-02 half-applied**, pending `mcp:update` |
| Non-Markdown files touched | **0** |

The cleanup fixed what the audit found. It did not fix **why** the drift happened: `.env.example`,
the README blocks and the tool lists are gated by `generate:check`; the skill templates are not, and
that is where both critical findings lived. Until `scripts/check-docs.mjs` exists, this report
describes a repaired state, not a protected one.

> *A convention nobody checks is a preference.* — `docs/reference/conventions.md`, ADR 0002

---

*Execution report. Every change in this pass was to a Markdown file; no source, config, or generated
artifact was modified.*
