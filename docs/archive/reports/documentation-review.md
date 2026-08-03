# Documentation Review — Post-Cleanup

**Reviewed** — 2026-08-03, after the cleanup recorded in [`documentation-cleanup-report.md`](./documentation-cleanup-report.md)
**Series** — [audit](./documentation-audit.md) → [cleanup plan](./documentation-cleanup-plan.md) → [cleanup report](./documentation-cleanup-report.md) → **this review** → [health check](../../reports/documentation-health.md)
**Scope** — all 89 Markdown files as reviewed (85 tracked + 4 untracked-not-ignored); 90 including this report
**Method** — every claim below was checked against source, contracts, or the filesystem. Nothing was
accepted by reading.
**Corrections applied** — 8, in 6 files. All were factual errors; five were introduced or missed by
the cleanup itself.

---

## 1. Verdict

The documentation set is **consistent and navigable**. Every count, tier, slot, path and API symbol
checked resolves against its source of truth.

But the review found **8 real defects**, and that is the headline, not the clean scorecard:

> **Five of the eight were caused or missed by the cleanup pass**, and the biggest one —
> `codebase-index-mcp/README.md` claiming `profile` support for 6 tools that have no such parameter —
> was invisible to every checker used so far, because those checkers validate *call syntax* and this
> was a *prose list of tool names*.

| Dimension | Result |
|---|---|
| README consistency | ⚠️ 3 defects → fixed |
| Architecture consistency | ✅ verified exact |
| Folder references | ⚠️ 1 defect → fixed |
| Package references | ⚠️ 1 navigation defect → fixed · content ✅ |
| Server references | ✅ verified exact |
| Screenshots | ✅ none exist (§4) |
| Examples | ⚠️ 1 defect → fixed · 104/104 API symbols ✅ |
| Commands | ✅ all defined · 1 undocumented flag |
| Installation | ✅ verified against scripts |
| Contribution Guide | ✅ |
| Development Guide | ✅ |
| Architecture Guide | ✅ |
| ADR references | ✅ · 1 cosmetic note |

---

## 2. What was verified, and against what

| Claim | Source of truth | Result |
|---|---|---|
| 76 tools = 43/17/8/8 | `@mcp/manifest` + `contracts/*.json` | ✅ exact (`TOTAL_TOOL_COUNT` = 76) |
| 98 env vars = 41/23/23/11 | `serverKeys().map(k => getServer(k).env.length)` | ✅ exact |
| 6 packages, tiers 0–5 | `mcp-platform rules` | ✅ exact, incl. `@mcp/shared` zero-external |
| Nine-slot table (which server has which folder) | filesystem, 4 servers × 8 slots | ✅ **32/32 cells correct** |
| `services/` sub-domains (9 folders) | filesystem | ✅ 9/9 |
| Data-flow file paths (`codebase-index-mcp/CLAUDE.md`, `CLAUDE.md`) | filesystem | ✅ 19/19 |
| Extractor naming rules (`csharp*`, `js*`, `extractor*`) | filesystem | ✅ 14/14 |
| Server keys, dirs, entry points | `@mcp/manifest` | ✅ 4/4, all `dist/index.js` |
| Documented API symbols | `packages/*/dist` exports | ✅ **104/104 exported** |
| `npm run <script>` cited in docs | all 12 `package.json` files | ✅ all defined (6 undefined confined to the frozen plan) |
| Install/doctor/update/uninstall flags | `scripts/*.mjs` + `scripts/lib/cli.mjs` | ✅ all documented flags exist |
| Documented tool-call parameters | `contracts/*.json` | ✅ 0 invalid |
| Tool names cited anywhere | `contracts/*.json` | ✅ 0 nonexistent |
| Markdown links + anchors | filesystem | ✅ 0 broken across all docs |
| Root folders and files | filesystem | ✅ 16/16 |
| Per-server outside-`src/` files | filesystem | ✅ 16/16 |
| `generate:check` · `guard:all` | the gate | ✅ pass · 0 err / 20 warn / 1 exempt / 516 files |

---

## 3. Defects found and corrected

### 🔴 D-1 · `codebase-index-mcp/README.md` — profile support was 17/32 correct

The **worst defect in this review**, and the one no prior check could see.

The "Tools with profile support" list named 23 tools. Against `contracts/codebase-index.json`:

- **6 do not accept `profile` at all** — `get_symbol_detail`, `find_symbol_at_line`,
  `get_folder_summary`, `query_docs`, `find_entry_points`, `find_implementations`. The prose called
  these out *by name* as "previously fixed-format", now compact-default — the **exact opposite** of
  the contract.
- **15 that do accept it were omitted** — `search_regex`, `query_graph`, `orient`, `change_impact`,
  `refactor_replace_preview`, and eleven more.

Because the schemas are `.strict()`, passing `profile` to any of those six is **rejected**. A reader
following this README would write six failing calls.

**Fixed**: the hand-maintained list is replaced by the accurate statement (**32 of 43** accept it), the
verified list of the **11** that do not, and the one-line command that re-derives it. The over-claiming
sentence above the table was corrected too.

**Why it was missed.** The audit and cleanup validated `tool_name({ param: … })` call *syntax*. This
was a prose list of tool names with a capability claim attached — a different shape, and unchecked.
`docs:check` must cover it (§7).

### 🔴 D-2 · `AGENTS.md` still recommended a retired document

Its per-server reference list read:

```
- `docs/archive/superseded/MCP-FIRST-CHEATSHEET.md` - Quick operator guide
```

The cleanup's retarget script did its job too literally: it corrected the **path** and left the
**recommendation**, so an active entry point was pointing readers at a document retired for being
wrong. This is the failure mode of mechanical path-rewriting without reading context.

**Fixed**: replaced with the three live `codebase-index-mcp/docs/` files plus
`.claude/rules/mcp-hard-mode.md`, and a parenthetical recording what it superseded.

### 🟠 D-3 · `docs/reference/folder-convention.md` — the workspace tree was falsified by the cleanup

```
- ├── docs/    architecture/ · migration/ · refactor/ · adr/ + top-level guides
+ ├── docs/    adr/ · architecture/ · reports/ + top-level guides
+ │   └── archive/   closed records — migration/ · refactor/ · superseded/ (not maintained)
```

`docs/migration/` and `docs/refactor/` had not existed since the archive move. **This repository has
no screenshots; ASCII trees are its only visual artifact** (§4), so this was the equivalent of a stale
screenshot — and the cleanup created it.

### 🟠 D-4 · `codebase-index-mcp/README.md` graph model — a fourth incomplete copy

The cleanup corrected the graph model in `CLAUDE.md`, `codebase-index-mcp/CLAUDE.md` and `AGENTS.md`,
and absorbed the `graph-schema-design` skill's version. It missed the copy in this README:
**9 of 10 edge types** (no `EXTENDS`) and **10 of 14 symbol kinds**.

**Fixed**, and both lists now name `src/types/index.ts` as authoritative with the count stated.

That makes **five** copies of one union found across this audit → cleanup → review sequence. The union
is mechanically extractable; §7 recommends generating it.

### 🟠 D-5 · `docs/reports/` was in no index

Three substantial reports were reachable only through one incidental citation inside a registry entry.
**Fixed**: added to `docs/README.md` and root `README.md`.

### 🟠 D-6 · Root `README.md` omitted `docs/development/ci.md` and `docs/archive/`

The cleanup promoted `ci.md` into `docs/` and created `docs/archive/`, and updated `docs/README.md`
but not the root README. **Fixed**: `docs/development/ci.md` added to Reference; `docs/archive/` and
`docs/reports/` added to History and state, replacing the row that pointed only at the migration
sub-index.

### 🟡 D-7 · No package README was linked from anywhere

`docs/reference/packages.md` exists to map the six packages and says *"Each package's own `README.md` is the
detailed reference"* — then referred to them only as the glob `packages/<name>/README.md`. Three were
incidentally cited by literal path elsewhere; `@mcp/core`, `@mcp/shared` and `@mcp/testing` were
**true orphans**.

**Fixed**: each row of *The six* now links its README, and the Related glob was replaced.

### 🟡 D-8 · `codebase-index-mcp/README.md` linked none of its own docs

The server's front door — 334 lines, the full 43-tool catalogue — pointed at none of
`docs/decision-tree.md`, `docs/examples.md`, or its issue registry. `examples.md` was referenced by
**nothing** outside my own reports, an orphan created when the cleanup renamed it from `EXAMPLES.md`.

**Fixed**: a *Further reading* table linking all three plus `CLAUDE.md` and the rule file.

---

## 4. Screenshots

**There are none, and none are missing.** Verified: **0** image references (`![...]()`), **0** tracked
image files of any format, **0** mermaid blocks.

The visual artifacts are **ASCII trees** in 8 documents. Treating them as the screenshots to verify was
the right reading — one was stale (**D-3**), and it was stale because of the cleanup. The rest check
out: `docs/architecture/as-built.md` §1 and §5, `docs/architecture/target-architecture.md`,
`docs/reference/folder-convention.md` §2–3, `templates/server/README.md`.

**Recommendation:** none. Prose plus ASCII trees is the right choice for a workspace whose subject is
file layout and dependency direction — a screenshot would date faster and check for nothing.

---

## 5. Navigation

| | Before this review | After |
|---|---|---|
| Link-reachable from the 5 entry points | 71/89 | **74/89** |
| True orphans (unreachable, not harness-loaded) | 4 | **0** |
| Harness-loaded (skills / rules / commands / templates) | 15 | 15 |
| Broken links | 0 | **0** |

Entry points: `README.md`, `CLAUDE.md`, `AGENTS.md`, `docs/README.md`, `CONTRIBUTING.md`.

The 15 non-reachable files are correct: `.claude/skills/*`, `.claude/rules/*`, `.claude/commands/*`,
`<server>/skill/SKILL.md` and `templates/*` are discovered by the harness by directory name, not by
link. **Inbound-link count is not a liveness signal for those** — the observation that prevented four
wrong deletions during the cleanup, and it still holds.

### A methodology defect in my own tooling

Every checker in the audit and cleanup enumerated files with `git ls-files`. That **excludes untracked
files** — so `docs/archive/README.md`, the archive's own cover note, and all three reports were
**never link-checked at all**. Re-running over tracked + untracked (89 files, not 85) is what surfaced
D-5 and the package-README orphans. Any `docs:check` implementation must use
`git ls-files` **plus** `git ls-files --others --exclude-standard`.

---

## 6. Duplicate concepts

Measured across the 68 maintained documents (archive, reports and `CHANGELOG.md` excluded — restating
is their job). A *mention* is healthy cross-referencing; a re-*explanation* is a divergence risk. Only
the second is reported.

| Concept | Docs that **explain** it | Assessment |
|---|---|---|
| **`tsc` does not prune `dist/`** | **7** — `docs/development/workflow.md` §7, `docs/guides/onboarding.md`, `docs/reference/folder-convention.md` §8, `docs/reference/conventions.md` §9, `CONTRIBUTING.md`, `docs/development/backlog.md`, `codebase-index-mcp/CLAUDE.md` | ⚠️ **The one real duplicate.** All seven give the `rm -rf dist && npm run build` remedy; three retell the same *"reported identical while running the previous build"* anecdote. **Already diverging**: not all mention that `mcp:doctor` now detects it (B-12) |
| `preview → apply → rollback` + HMAC | 12 docs | ✅ Acceptable — each states it for *its own* server or layer; only `docs/architecture/as-built.md` §4 explains the mechanism |
| `compact` is the default profile | 12 docs | ✅ Acceptable — `codebase-index-mcp/README.md` is the detailed home; the rest are one-liners |
| nine-slot standard structure | 10 docs | ✅ `docs/reference/folder-convention.md` §2 is the home; others reference it |
| script vocabulary `build/typecheck/test/smoke` | 9 docs | ✅ One line each; `docs/reference/conventions.md` §4 is the home |
| `verify:all` gate | 15 docs | ✅ A command, not a concept — repetition is correct |
| no-LLM policy | 13 docs | ✅ A hard constraint that *should* appear everywhere it applies |
| stdout is the MCP transport | 8 docs | ✅ Safety-critical; repetition is deliberate |

**Not rewritten.** The instruction was to avoid unnecessary rewriting, and the `dist/` duplication is
not *wrong* anywhere — it is a maintenance risk. §7 carries it as a recommendation.

---

## 7. Missing documentation

| Gap | Severity | Note |
|---|---|---|
| **`scripts/check-docs.mjs` does not exist** | **High** | The gate for everything this review found. It must now also cover: prose *capability claims* about tools (D-1), untracked files (§5), and tool-name existence. Blocked earlier by *"do not modify source code"* |
| **`postgres-mcp` installed skill still stale** | **High** | Carried forward from the cleanup: the repo template is fixed, the rendered copy at `.claude/skills/postgres-mcp/SKILL.md` is not. Needs `npm run mcp:update -- --all` |
| `--force` on `npm run new:server` | Low | Supported by `scripts/new-server.mjs`; documented nowhere. The other five flags (`--key`, `--dir`, `--display`, `--no-verify`, plus `--server`/`--all`/`--yes`) are all documented |
| Language policy | Low | 2 of 4 server READMEs are Vietnamese (`postgres-mcp`, `bitbucket-mcp`), 2 English. No rule says which a new doc uses |
| `CODEOWNERS` | Low | No document declares an owner; 148 of 150 commits are one author |
| Per-server README skeleton | Low | Section structure varies widely: codebase-index 10 sections, postgres 9 (numbered), observe 4, bitbucket 7. All four carry both generated blocks correctly, so this is consistency, not correctness |
| 9 unwired test harnesses | Low | Still never run; honestly documented in `docs/servers/server-development.md` |

### Recommendations, in priority order

1. **Build `docs:check`** — now with four checks, not three: tool-call params · tool-name existence ·
   **prose capability claims** · env aliases; over tracked **and** untracked files.
2. **Run `npm run mcp:update -- --all`** to finish the postgres skill fix.
3. **Generate the graph model.** Five incomplete copies of one TypeScript union were found across
   three passes. `EdgeType` and `SymbolKind` are mechanically extractable from
   `src/types/index.ts`; a `<!-- BEGIN/END GENERATED -->` block would end the class of defect.
4. **Give `tsc` does not prune `dist/` one home** (`docs/development/workflow.md` §7) and reduce the other six
   to a pointer.
5. Document `--force`; add a language policy and `CODEOWNERS`.

---

## 8. Per-dimension detail

**README consistency** — Root README, `docs/README.md` and the four server READMEs agree on every
shared number (76 tools, 98 env, 43/17/8/8, six packages, server keys). Three defects fixed: D-1, D-6,
D-8. All four server READMEs carry both `<!-- BEGIN/END GENERATED -->` blocks and `generate:check`
passes, so their env tables and tool lists cannot drift.

**Architecture consistency** — `docs/architecture/as-built.md` (as-built) and
`docs/architecture/target-architecture.md` (design + §9 reconciliation) agree with each other and with
`mcp-platform rules`. The deliberate as-built/design split is intact and self-documenting. §9's
`0 errors, 20 warnings, 1 exemption across 516 files` matches `guard:all` exactly.

**Folder / package / server references** — 16/16 root paths, 32/32 nine-slot cells, 9/9 sub-domains,
19/19 data-flow paths, 14/14 extractor files, 16/16 per-server files, 4/4 server descriptors, 6/6
package tiers. One tree stale (D-3), one navigation gap (D-7).

**Examples** — 0 invalid tool parameters; 0 nonexistent tool names; **104/104** documented API symbols
actually exported from `packages/*/dist`, including all four `@mcp/shared` subpaths. One capability
claim wrong (D-1).

**Commands / Installation** — Every `npm run` cited in a maintained doc is defined. The six undefined
names are confined to the frozen `migration-plan.md`, which its ❄️ banner covers. All documented flags
verified against `scripts/*.mjs` and the shared `scripts/lib/cli.mjs` parser; `--force` is the only
supported flag that is undocumented.

**Contribution / Development / Architecture Guides** — All three verified accurate, including the
`verify:all`-vs-CI difference table in both directions, the seven-layer test table, and the
address-vs-assertion rule the cleanup added to `CONTRIBUTING.md` and `docs/README.md`.

**ADR references** — 3 files, 3 `Accepted` statuses, all three cited (0001 × 41, 0002 × 25, 0003 × 16),
no dangling ADR numbers, index links resolve. One cosmetic point: the index describes 0001 as
*"Accepted, implemented **+ amended**"* while the file's own Status line reads *"Accepted,
implemented"* — the amendment is in the body. Not corrected; the index is the more informative of the
two, and `docs/decisions/README.md`'s own guidance is to amend rather than restate.

---

## 9. Changes made

Eight corrections in six files. **Documentation only** — `git status` shows no non-Markdown file
touched.

| File | Change |
|---|---|
| `codebase-index-mcp/README.md` | D-1 profile support (list → accurate statement + derivation command) · D-4 graph model (10 edges, 14 kinds) · D-8 *Further reading* table |
| `AGENTS.md` | D-2 stop recommending the archived cheatsheet |
| `docs/reference/folder-convention.md` | D-3 workspace tree |
| `docs/README.md` | D-5 `reports/` row |
| `README.md` | D-6 `docs/development/ci.md`, `docs/archive/`, `docs/reports/` |
| `docs/reference/packages.md` | D-7 link all six package READMEs |

**Verification after changes:** links 0 broken (89 docs) · orphans 0 · tool params 0 invalid ·
`generate:check` pass · `guard:all` 0 errors / 20 warnings / 1 exemption / 516 files. Re-verified after
adding this report: **0 orphans, 75/90 link-reachable.**

---

## 10. Summary

| | |
|---|---|
| Documents reviewed | 89 (90 including this report) |
| Dimensions verified | 13 |
| Defects found | **8** — 2 high, 4 medium, 2 low |
| Defects corrected | **8** |
| Of those, caused or missed by the cleanup | **5** |
| Broken links / orphans / invalid params | 0 / 0 / 0 |
| Duplicate concepts needing a decision | 1 (`dist/` pruning, 7 homes) |
| Missing documentation items | 7, two of them high |
| Non-Markdown files touched | **0** |

The cleanup left the documentation **consistent**; this review found it was not yet **correct**. The
two highest-severity defects were a capability claim no checker validated and a recommendation a
path-rewriter preserved while retargeting. Both are the same underlying gap: *the checks cover the
shapes we already thought to check.*

Three passes have now each found a fresh copy of the same graph-model union, and each pass found the
previous pass's misses. That is the argument for **generating** what is derivable and **gating** what
is not — recommendations 1 and 3.

> *A convention nobody checks is a preference.* — `docs/reference/conventions.md`, ADR 0002

---

*Review report. Every correction in this pass was to a Markdown file; no source, config, or generated
artifact was modified.*
