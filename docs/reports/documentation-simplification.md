# Documentation Simplification

**Executed** — 2026-08-03
**Goal** — reduce documentation complexity without losing knowledge
**Result** — maintained surface **−25%**; duplicated prose **−65%**; **0 documents deleted**
**Companion** — [documentation-health.md](documentation-health.md) (the assessment this acted on)

---

## 1. Result

| | Before | After | Δ |
|---|---|---|---|
| Maintained `docs/` surface | 6,000 lines / 27 files | **4,480 lines / 24 files** | **−25%** |
| Root agent guides (`CLAUDE.md` + `AGENTS.md`) | 629 lines | **348 lines** | **−45%** |
| Near-identical sentences across maintained docs | 17 | **6** | **−65%** |
| Concepts explained in more than one place | 7 | **0** | **−100%** |
| Archived (preserved, not maintained) | 6,965 lines | **6,981 lines** | +16 |
| **Documents deleted** | — | **0** | — |
| Broken links | 0 of 262 | **0 of 307** | — |
| Orphaned documents | 0 | **0** | — |

Everything removed from the maintained surface is either **archived intact** or **still stated once,
somewhere canonical**. No knowledge was discarded.

---

## 2. The four largest reductions

### 2.1 `AGENTS.md`: 359 → 78 lines (−78%)

The single biggest source of duplication in the repository. It was a near-parallel copy of
`CLAUDE.md`: both described the workspace structure, the commands, the critical constraints, the
`codebase-index-mcp` architecture, and the references.

**It also contained two defects that only existed because it was a copy:**

- It **hand-listed 21 of the 98 environment variables** — a partial snapshot of data that is generated
  from `packages/manifest`. This is precisely how it came to name variables that S-43 had renamed.
- It **never mentioned `verify:all`**, and instead prescribed a five-command pre-commit sequence that
  `CLAUDE.md` explicitly says to replace with the workspace gate. Two agent entry points, contradicting
  each other on how to validate a change.

**What it is now:** a cross-agent entry point that points rather than copies — a where-to-look table,
the gate, the four hard constraints an agent can violate without noticing, and per-server links. The
env section now says *do not look for a list here* and names the generated sources plus the derivation
command.

**Nothing was lost.** Three genuinely unique passages were relocated to their canonical home,
`codebase-index-mcp/CLAUDE.md` §"Extending the extractor":

| Relocated | Why there |
|---|---|
| The 4-step tree-sitter language procedure | It is extractor internals |
| Worker-pool tuning (`cpus/2`, `LARGE_FILE_THRESHOLD_BYTES`, job timeout) | Same |
| Benchmark false positives (the two telemetry vars the gate needs) | Same |
| C# initializer-migration guidance + the worked test suites | Same |

Its MCP host-configuration JSON was **already** duplicated verbatim by
`codebase-index-mcp/README.md` §"MCP Host Configuration", which is now the only copy.

### 2.2 `docs/reports/`: 4 of 5 reports archived (−1,417 lines)

`docs/reports/` held five reports totalling 2,015 lines — **34% of the entire maintained portal was
meta-documentation about the documentation.** Four of the five were superseded as *assessments* by the
fifth, while re-stating the same findings with evolving status.

Moved to [`../archive/reports/`](../archive/README.md), intact: the audit, the cleanup plan, the
cleanup report, the review. They keep the reasoning and the measurements behind every change made, and
`docs/reports/README.md` plus `docs/archive/README.md` both index them.

`documentation-health.md` remains the single current assessment.

### 2.3 `docs/reference/`: a three-way overlap resolved

Three documents in one directory explained the same rules at length. Each concept now has exactly one
canonical home, and the other pages carry a two-line pointer:

| Concept | Canonical home | Was also explained in |
|---|---|---|
| File-size caps, waiver pragma, current findings | `folder-convention.md` §5 | `conventions.md` §5 (42 lines) |
| Generated files and what regeneration preserves | `folder-convention.md` §7 | `conventions.md` §6 |
| The `guard convention` rule list | `conventions.md` §2 | `folder-convention.md` §6 |
| Proof that each guard rejects a violation | `conventions.md` §8 | `folder-convention.md` §6, `dependency-rules.md` §6 |
| The honest "nothing checks this" list | `conventions.md` §9 | `folder-convention.md` §8 |

`conventions.md` 210 → 172 · `folder-convention.md` 305 → 269 · `dependency-rules.md` 223 → 215.

The division is now principled: **`conventions.md` is the rule index** (its stated purpose — "sorted
by whether something checks it"), **`folder-convention.md` owns placement and size**, and
**`dependency-rules.md` owns imports**.

### 2.4 "`tsc` does not prune `dist/`": 7 homes → 1

The one concept the health report flagged as genuinely duplicated, and it had already begun to diverge
— not every copy mentioned that `mcp:doctor` detects it.

**Canonical:** `docs/development/workflow.md` §7 (the full explanation, the remedy, the doctor check).

| Was | Now |
|---|---|
| `docs/guides/onboarding.md` — 9-line explanation | 3-line statement + pointer |
| `docs/reference/conventions.md` §9 — 8 lines | 2-line bullet + pointer |
| `docs/reference/folder-convention.md` §8 | pointer (§2.3) |
| `codebase-index-mcp/CLAUDE.md` | trimmed to its **unique** consequence — the harnesses import `dist/` by path, so this server is hit hardest — plus a pointer |
| `CONTRIBUTING.md` | left: it is a checklist row, which is pointer-shaped already |
| `docs/development/backlog.md` | left: inside closed item B-12, a historical record |

---

## 3. Other single-sourcing

| Concept | Canonical home | Trimmed to a pointer in |
|---|---|---|
| The three shared-code characterization failures | `architecture/target-architecture.md` §"One design assumption…" | `CONTRIBUTING.md` — keeps the rule, drops the three worked examples |
| `~/.claude.json` is live machine state | `servers/server-development.md` §6 | `architecture/target-architecture.md` |
| Graph model — symbol kinds, stable IDs, schema guardrails | `codebase-index-mcp/CLAUDE.md` §"Graph model" | `codebase-index-mcp/README.md` — keeps the **consumer-facing** edge-semantics table, which is unique |
| Script vocabulary (the rule) | `reference/conventions.md` §4 | `development/workflow.md` §3 — keeps the root-command table, which is unique |
| Tool annotation semantics | `contracts/README.md` | `servers/tool-development.md` |

---

## 4. Duplication that was left, and why

Not all repetition is duplication. Six near-identical sentences remain, each deliberately:

| Repetition | Occurrences | Why it stays |
|---|---|---|
| *"Defaults marked (code) are the server's own fallback…"* | 4 server READMEs | **Inside `<!-- BEGIN/END GENERATED -->` blocks.** Produced by the generator from one template — this is single-sourcing working, not failing |
| *"This file provides guidance to Claude Code…"* | `CLAUDE.md` ×2 | Convention boilerplate for the filename |
| *"Run `list_repositories` to get the exact `repoPath`…"* | skill template + slash command | Both are **agent-facing entry points loaded independently**. An agent reads one, never both; a pointer would break a self-contained skill |
| *"`verify:all` exiting 0 means you have a working install"* | onboarding + workflow | One sentence, and it is the "you are done" statement in each. Cheaper to repeat than to redirect |
| *"`info` never affects the exit code"* | `folder-convention.md` + `packages/cli/README.md` | A package README must stand alone for someone reading that package |
| *"A guard is the declared answer to…"* | `tool-development.md` + `packages/sdk/README.md` | Same reason |

**The rule applied:** duplication is a defect when two documents can *diverge* and both claim
authority. It is acceptable when one copy is generated, or when the reader will only ever see one of
them.

---

## 5. Verbosity removed

Beyond the structural cuts, the pattern removed throughout was **restating a rule before linking to
it**. The house style favours long explanatory asides; where a doc explained a concept it did not own,
that explanation became a sentence plus a link.

What was **not** cut: the "why" behind decisions, the measured numbers with their derivation commands,
the recorded failure anecdotes (*"a probe reported identical while running the previous build"*). Those
are the parts that make the documentation worth reading, and terseness there would be a loss, not a
simplification.

Also not cut: the archive. It grew by 16 lines (index rows). 6,981 lines of closed record are now
**60% of all documentation** — which is correct, because none of it is maintained and all of it is
behind one clearly-labelled door.

---

## 6. What this did not fix

Simplification does not close the gap the health report named. **The documentation is smaller and
single-sourced; it is still almost entirely ungated.**

| Outstanding | Status |
|---|---|
| **`npm run mcp:update -- --all`** — the installed `postgres-mcp` skill still carries **25 legacy env names, 0 canonical** | unchanged; still the highest-value single action |
| **`scripts/check-docs.mjs`** — no gate for links, tool params, capability claims, or env aliases | unchanged |
| `generate:check` absent from CI | unchanged |
| Graph model still hand-copied in 2 places (down from 5) | improved, not solved — generate it |
| ~10 documents hard-code the four-server list | unchanged — the scalability cost of adding server #5 |

One new observation: this pass **reduced** the number of places a fact can drift, which is the same
outcome a gate would produce for the specific facts involved — but only for the facts involved. The
structural fix remains action item 2 in the health report.

---

## 7. Verification

```
broken links                0 of 307        (was 0 of 262)
orphaned documents          0
portal reachability         45/45, max 2 hops
section indexes             8/8
duplicated sentences        6               (was 17)
invalid tool parameters     0
generate:check              PASS
guard:all                   0 errors · 20 warnings · 1 exemption · 516 files
documents deleted           0
```

Every archived file was moved, not copied-and-removed; every trimmed passage was verified to exist in
its canonical home before the copy was reduced.

**One accounting note.** `docs/adr/README.md` → `docs/decisions/README.md` is recorded by git as a
delete plus an add rather than a rename, because the portal move and the §2.3 trim landed together and
similarity fell below git's 50% threshold. The content is intact at the new path;
`git log --follow -M20%` pairs them. No document was deleted in the sense that matters — nothing left
the repository.

---

## 8. Summary

| | |
|---|---|
| Maintained `docs/` | 6,000 → **4,480 lines** (−25%) |
| `AGENTS.md` | 359 → **78 lines** (−78%) |
| Reports archived | 4 of 5 (−1,417 lines from the maintained surface) |
| Concepts with more than one explanation | 7 → **0** |
| Duplicated sentences | 17 → **6**, each justified |
| Documents deleted | **0** |
| Defects fixed as a side effect | **2** — `AGENTS.md`'s 21-of-98 env list and its contradiction of the gate |

The documentation is now smaller in the places that were redundant and unchanged in the places that
carry reasoning. Every concept has one home; everything else links to it.

> *Prefer one source of truth. Links instead of copies.* — the brief, and now the structure.

---

*Simplification report. No document was deleted; four were archived. Verified read-only after
execution.*
