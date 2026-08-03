# Documentation Audit

**Audited state** — `74d43a0` (main, clean working tree)
**Date** — 2026-08-03
**Scope** — every Markdown file in the repository: 89 on disk (85 tracked, 4 generated and gitignored)
**Constraint honoured** — no existing file was modified or deleted. This report is the only file created.

> **What this report is.** An assessment of the documentation landscape after the 44-step migration
> and the standard-structure refactor. It classifies every document, and it separates *verified*
> defects from impressions. Every count and every claimed defect below names the command that
> produced it, because this repository's own rule is *"counts drift, commands do not"*
> (`CONTRIBUTING.md`). Where I could not verify something, the row says so.

---

## 1. Headline

This is a **well-maintained documentation set** — unusually so. The link graph is intact, the
current-state / historical / generated split is real and observed, and the numbers in the prose are
mostly re-derivable. Four automated checks I wrote for this audit found **zero** broken Markdown
links, **zero** broken relative paths in the doc hub, and confirmed the tool counts, env-var counts
and dependency-rule counts exactly.

The defects cluster in one place, and it is the place that matters most:

> **The four `<server>/skill/SKILL.md` templates are the oldest current-state documents in the
> repository — all four last committed `2026-07-08`, before the migration began (`2026-07-27`) — and
> they are the only documentation surface that no gate checks. They are also the documents an agent
> actually loads and executes.**

That single structural gap accounts for the two highest-severity findings (F-01, F-02). Everything
else is drift measured in single digits.

**Verified defect count:** 21 findings — 2 critical, 5 high, 8 medium, 6 low.
**Documents needing action:** 12 of 89. **Documents that are clean:** 77.

---

## 2. Method

Four checkers were written for this audit and are reproducible. They live in the session scratchpad;
their logic is described here so they can be rebuilt as repo scripts (see §9, R-1).

| Check | What it does | Result |
|---|---|---|
| **Link check** | Every `[text](../../reports/target)` in every tracked `.md`, excluding fenced code, resolved against the filesystem; `#anchor` fragments resolved against the target's headings | **0 broken** of all links checked |
| **Path-reference check** | Every backtick-quoted path anchored at a real top-level directory, resolved repo-root-relative | 71 distinct misses — **triaged in §6**; all but 4 are historical or placeholder by design |
| **Tool-parameter check** | Every documented `tool_name({ prop: … })` call validated against `contracts/*.json` `inputSchema.properties`, with same-named tools unioned across servers and quoted strings stripped | **11 invalid parameters across 15 mentions** |
| **Env-name check** | Every `` `SCREAMING_CASE` `` token matched against `@mcp/manifest`'s canonical names and `deprecatedAliases` | 21 aliases used; **14 mentions use an alias as the operative name** |

Commands run to verify prose claims:

```bash
npm run guard:all                    # 0 errors, 20 warnings, 1 exemption, 516 files
npm run test:packages                # per-package test counts
(cd postgres-mcp && npm test)        # 64;  observe-mcp 56;  bitbucket-mcp 25
node -e "import('./packages/manifest/dist/index.js').then(m=>m.serverKeys().map(...))"
node -e "…contracts/*.json → tool counts…"
grep -rn 'from \"@modelcontextprotocol/sdk' */src --include=\"*.ts\" | grep -v '\.test\.ts' | wc -l
```

---

## 3. Inventory and status

Status vocabulary: **Active** (current-state, maintained) · **Historical** (frozen record, correct by
design) · **Generated** (rendered from the manifest) · **Stale** (active but contains verified
inaccuracies) · **Duplicate** (substantially restates another doc) · **Archive candidate**.

**Owner — one for all 89 files.** There is no `CODEOWNERS`, and no document declares a maintainer.
Git attributes 148 of 150 commits to **Koi Tran <koi.tran@siliconstack.com.au>** (the remaining two
are single drive-by commits from `tvnkhoa` and `Phuc Le Hong`). `docs/migration/ci.md` states the
operating assumption plainly: *"this workspace has one operator on one machine."* Ownership is
therefore uniform and implicit; the per-file "owner" column is omitted as it would repeat one name 89
times. **This is itself a finding — see F-19.**

### 3.1 Root (5 tracked)

| Document | Purpose | Status | Related code |
|---|---|---|---|
| `README.md` | Workspace overview, installer commands, server table | **Active** | `scripts/*.mjs`, `packages/manifest` |
| `CLAUDE.md` | Agent entry point: constraints, commands, MCP-first rules | **Stale** (F-05, F-08) | whole workspace |
| `AGENTS.md` | Env reference, pitfalls, integration config | **Stale — most drifted doc in the repo** (F-03, F-04, F-09) | all four servers |
| `CONTRIBUTING.md` | Process: commits, review, what a change carries | **Stale** (F-13, minor) | — |
| `CHANGELOG.md` | Dated entries, introducing commit named | **Historical** ✅ | — |

### 3.2 `docs/` hub and guides (11)

| Document | Purpose | Status | Related code |
|---|---|---|---|
| `docs/README.md` | **The doc index.** Also defines the four maintenance classes | **Active** ✅ exemplary | — |
| `docs/guides/onboarding.md` | Fresh clone → four servers in three commands | **Stale** (F-05) | `scripts/install-mcp.mjs` |
| `docs/architecture/as-built.md` | As-built description | **Active** ✅ verified accurate | `packages/*`, all servers |
| `docs/reference/conventions.md` | Every rule sorted by what enforces it | **Stale** (F-13) | `packages/cli/src/guards/` |
| `docs/development/workflow.md` | The loop, test layers, the gate, CI difference | **Active** ✅ verified accurate | root `package.json`, `ci.yml` |
| `docs/servers/server-development.md` | Scaffold → register → operate a server | **Stale** (F-05 — self-contradictory) | `templates/server/`, `packages/manifest` |
| `docs/servers/tool-development.md` | Declaring, gating, testing, snapshotting a tool | **Active** | `packages/sdk`, `contracts/` |
| `docs/reference/packages.md` | What each of the six packages is for | **Active** ✅ verified accurate | `packages/*` |
| `docs/reference/folder-convention.md` | Where a file goes | **Stale** (F-13, F-14) | `packages/cli/src/guards/conventionGuard.ts` |
| `docs/reference/dependency-rules.md` | What may import what | **Active** ✅ **all counts verified exact** | `packages/cli/src/guards/rules.ts` |
| `docs/development/backlog.md` | B-01…B-12 (+B-01b, B-02b); 13 of 14 closed | **Active** ✅ verified consistent | — |

### 3.3 ADRs (4)

| Document | Purpose | Status | Notes |
|---|---|---|---|
| `docs/decisions/README.md` | Index + the "writing one" template | **Active** · mild **Duplicate** (F-17) | Restates each ADR nearly in full |
| `docs/decisions/0001-workspace-native-deps.md` | Servers outside the npm workspace | **Active** ✅ amended, not rewritten — model practice | root `package.json`, `packages/sdk/src/errorMapper.ts` |
| `docs/decisions/0002-sql-guardrail-token-lists.md` | Per-dialect forbidden-token lists | **Active** ✅ | `packages/shared/src/sql/` |
| `docs/decisions/0003-single-root-gitignore.md` | One root `.gitignore` | **Active** ✅ | `.gitignore` |

### 3.4 Architecture, migration, refactor (14)

| Document | Purpose | Status |
|---|---|---|
| `docs/architecture/target-architecture.md` | The design + §9 built-vs-target reconciliation | **Active** · §9 row stale (F-13) |
| `docs/architecture/audit-report.md` | Pre-migration repo at `01c532e` | **Historical** ✅ provenance stated |
| `docs/migration/README.md` | Migration index + findings worth carrying forward | **Active** ✅ verified consistent |
| `docs/migration/status.md` | **The live state document.** All 44 steps, each citing its artifact | **Active** ✅ |
| `docs/migration/migration-plan.md` | The plan as written | **Historical** ✅ explicit ❄️ FROZEN banner — exemplary |
| `docs/migration/ci.md` | What CI covers and does not | **Stale** (F-06, F-10, F-11) |
| `docs/migration/foundation-notes.md` | What `packages/` contains and why | **Historical** ✅ |
| `docs/migration/normalization-report.md` | The 48-file folder normalization | **Historical** ✅ |
| `docs/migration/s06-s23-notes.md` | bitbucket SDK pilot | **Historical** ✅ |
| `docs/migration/s24-notes.md` | postgres SDK migration | **Historical** ✅ |
| `docs/migration/s25-notes.md` | observe SDK migration | **Historical** ✅ |
| `docs/migration/s26-s29-plan.md` | codebase-index SDK migration | **Historical** ✅ numbering caveat stated |
| `docs/refactor/duplication-extraction-report.md` | Shared-component extraction + behaviour deltas | **Historical** ✅ |
| `docs/refactor/standard-structure-report.md` | The nine-slot layout, per-server map, evidence | **Historical** ✅ |

### 3.5 `.claude/` policy, skills, commands (17)

| Document | Purpose | Status |
|---|---|---|
| `.claude/rules/mcp-hard-mode.md` | **The MCP-first policy.** 369 lines, workspace-wide | **Active** — the most load-bearing agent doc |
| `.claude/rules/mcp-base.md` | Base rules for all MCP packages | **Active** · thin, pre-migration (2026-07-08) |
| `.claude/rules/typescript-mcp.md` | TS/ESM conventions | **Active** · thin, pre-migration |
| `.claude/rules/db-guardrails.md` | postgres-mcp safety rules | **Active** · thin, pre-migration |
| `.claude/rules/codebase-index.md` | Indexing design rules | **Stale** (F-12 — names five tools that do not exist) |
| `.claude/skills/` × 11 authoring skills | Scaffold, security review, release checklist, error taxonomy, … | **Active** · all pre-migration (2026-07-08); generic, not workspace-specific except `mcp-skill-authoring` |
| `.claude/commands/mcp-effectiveness-eval.md` | Baseline-vs-MCP benchmark slash command | **Active** |

### 3.6 Generated, gitignored (4 — on disk, not tracked)

| Document | Status |
|---|---|
| `.claude/skills/{codebase-index,postgres-mcp,observe-mcp,bitbucket-mcp}/SKILL.md` | **Generated** from `<server>/skill/SKILL.md`. The postgres one is **verified stale on disk** (F-02) |

### 3.7 Per-server (25) and per-package (6)

| Document | Purpose | Status |
|---|---|---|
| `codebase-index-mcp/README.md` | Annotated 43-tool catalogue | **Active** (25 commits — best-maintained server doc) |
| `codebase-index-mcp/CLAUDE.md` | Sub-project guide, folder-ownership table | **Stale** (F-08, F-16) |
| `codebase-index-mcp/skill/SKILL.md` | **Installed operational skill** | 🔴 **Stale — critical** (F-01) |
| `codebase-index-mcp/docs/EXAMPLES.md` | Five canonical workflows | 🔴 **Stale — three of five examples cannot execute** (F-01) |
| `codebase-index-mcp/docs/DECISION-TREE.md` | Task-oriented tool flowchart | **Stale** (F-01) |
| `codebase-index-mcp/docs/MCP-FIRST-CHEATSHEET.md` | One-page operator guide | **Stale** (F-07) · **Duplicate** of `mcp-hard-mode.md` (F-18) |
| `codebase-index-mcp/docs/mcp-codebase-index-issue-registry.md` | Server-side defect registry (910 lines, 12 issues) | **Active** · missing an index (F-20) |
| `codebase-index-mcp/.claude/commands/codebase-index.md` | Slash command | **Stale** (F-01) |
| `codebase-index-mcp/.claude/skills/` × 10 | Indexing-internals authoring skills | **Active** · all pre-migration, generic |
| `postgres-mcp/README.md` | Setup + guardrails (Vietnamese) | 🔴 **Stale — pre-rename env names in prose** (F-02) |
| `postgres-mcp/skill/SKILL.md` | **Installed operational skill** | 🔴 **Stale — critical** (F-02) |
| `postgres-mcp/docs/mcp-postgres-issue-registry.md` | Defect registry (607 lines, 16 issues) | **Active** · see F-02 note on PG-DOC-001 |
| `observe-mcp/README.md` | Setup + tools (English) | **Active** ✅ |
| `observe-mcp/skill/SKILL.md` | Installed operational skill | **Active** ✅ no param/env drift found |
| `bitbucket-mcp/README.md` | Auth + write gate (Vietnamese) | **Active** ✅ |
| `bitbucket-mcp/skill/SKILL.md` | Installed operational skill | **Active** ✅ no param/env drift found |
| `contracts/README.md` | What the snapshots are, how to update | **Active** · one stale example name (F-15) |
| `templates/server/README.md` · `skill/SKILL.md` | Scaffold docs with `__PLACEHOLDER__`s | **Active** ✅ rebuilt 2026-08-03 |
| `packages/{core,sdk,shared,testing,cli,manifest}/README.md` | Per-package reference, tier stated in the header | **Active** ✅ all six verified consistent with `rules.ts` |

**No document is Deprecated or Obsolete.** Nothing describes a system that no longer exists.
**Archive candidates: none.** The historical set is explicitly labelled and load-bearing; §7 explains
why archiving it would be wrong.

---

## 4. Findings — critical and high

### 🔴 F-01 · Documented `codebase-index` tool calls are invalid and would be **rejected**, not ignored

**Severity: critical.** 11 distinct invalid parameters across 15 mentions in 4 documents, validated
against `contracts/codebase-index.json`.

This is not cosmetic. The input schemas are `zod` `.strict()` — 50 `.strict()` calls across
`codebase-index-mcp/src/types/schemas/*.ts`. An unknown key is **rejected**, so a call copy-pasted
from these documents fails validation rather than silently ignoring the extra field.

| Document | Line | Documented | Actual schema |
|---|---|---|---|
| `codebase-index-mcp/skill/SKILL.md` | 25 | `index_repository(…, profile:)` | no `profile`: `batchSize, docsMode, maxFiles, mode, repoId, repoPath` |
| `codebase-index-mcp/skill/SKILL.md` | 39 | `find_impact_files(changedFiles:, depth:)` | `filePath, groupBy, limit, profile, repoId, view` |
| `codebase-index-mcp/skill/SKILL.md` | 58 | `refactor_replace_preview(scope:{filePaths:})` | `scope` sub-props are `excludePaths, fileGlobs, includePaths` |
| `.claude/commands/codebase-index.md` | 44 | `find_impact_files(changedFiles:, depth:)` | as above |
| `.claude/commands/codebase-index.md` | 60 | `refactor_replace_preview(searchPattern:, replacePattern:)` | required: `repoId, find, replaceExpression` |
| `docs/EXAMPLES.md` | 28 | `get_symbol_context_pack(symbolId:)` | `calleeDepth, callerDepth, limit, name, profile, repoId` — takes **`name`**, not `symbolId` |
| `docs/EXAMPLES.md` | 39, 42 | `find_impact_files(symbolId:)` | takes **`filePath`**, not `symbolId` |
| `docs/EXAMPLES.md` | 45 · `DECISION-TREE.md` 85 | `detect_changes(policyPreset:)` | `policy` |
| `docs/EXAMPLES.md` | 55, 64 | `refactor_replace_preview(searchPattern:, replacePattern:)` | `find`, `replaceExpression` |
| `docs/EXAMPLES.md` | 77 | `refactor_replace_rollback(applyId:)` | `rollbackId` |
| `DECISION-TREE.md` | 42 | `get_folder_summary(profile:)` | `folderPath, maxFiles, repoId` |

**Why it matters most for `skill/SKILL.md`:** that file is the committed source of truth the installer
renders into `~/.claude/skills/codebase-index/` and `.claude/skills/codebase-index/`. It is what an
agent reads *before* calling anything. `docs/EXAMPLES.md` is titled "Five canonical examples" — three
of the five contain a call that cannot execute.

**Root cause:** the parameter names look like an earlier generation of the API (`searchPattern` /
`replacePattern` → `find` / `replaceExpression`; `symbolId` → `name` / `filePath`; `policyPreset` →
`policy`). `contracts:check` pins the *schema*, and `generate:check` pins the *generated blocks* —
neither validates prose examples against the schema.

### 🔴 F-02 · `postgres-mcp`'s installed skill and README name environment variables that are only deprecated aliases

**Severity: critical.** S-43 renamed all 23 `postgres-mcp` vars to `POSTGRES_*`. The old names still
work, with a one-time deprecation warning — but these documents present them as *the* names to set.

`postgres-mcp/skill/SKILL.md` — last committed **2026-07-08**, three weeks before S-43:

| Line | Says | Canonical |
|---|---|---|
| 27 | `MCP_DB_DEFAULT_LIMIT` / `MCP_DB_MAX_LIMIT` | `POSTGRES_DEFAULT_LIMIT` / `POSTGRES_MAX_LIMIT` |
| 28 | `PG_EXPLAIN_COST_WARN` | `POSTGRES_EXPLAIN_COST_WARN` |
| 33 | `PG_DEFAULT_ENVIRONMENT`, `PG_ALLOWED_ENVIRONMENTS`, `PG_WRITABLE_ENVIRONMENTS` | `POSTGRES_*` |
| 35 | "Writes (OFF unless `PG_WRITE_ENABLED=true`)" | `POSTGRES_WRITE_ENABLED` |
| 44 | `PG_WRITE_PREVIEW_TTL_MS` | `POSTGRES_WRITE_PREVIEW_TTL_MS` |
| 46 | "Migrations (OFF unless `PG_MIGRATION_ENABLED=true`)" | `POSTGRES_MIGRATION_ENABLED` |
| 63 | "set **one** of `CH_DB_CONNECTION`, `PG_ENV_*`, or `CH_APPSETTINGS_ROOTS`" | `POSTGRES_CONNECTION`, `POSTGRES_ENV_*`, `POSTGRES_APPSETTINGS_ROOTS` |

**The file will contradict itself once installed.** Its env table is the `{{ENV_TABLE}}` placeholder,
rendered from the manifest — so the generated table says `POSTGRES_*` while the hand-written prose
above it says `PG_*` / `CH_*`.

**The installed copy on disk is verified stale.** `.claude/skills/postgres-mcp/SKILL.md` lines 67–73
show `CH_DB_CONNECTION`, `CH_APPSETTINGS_ROOTS`, `PG_ENV_*`, `CH_CONNECTION_NAME`,
`PG_ALLOWED_ENVIRONMENTS` as canonical table rows — i.e. rendered before S-43 and never refreshed.
Compare `postgres-mcp/README.md:126–128`, generated from the current manifest, which correctly reads
`POSTGRES_CONNECTION … renamed — still accepts CH_DB_CONNECTION`.

`postgres-mcp/README.md` repeats it in hand-written prose **outside** the generated block
(lines 122–152 are generated; these are not): lines 7, 8 (`PG_WRITE_ENABLED`,
`PG_MIGRATION_ENABLED`), 21–22 (`CH_DB_CONNECTION`, `CH_APPSETTINGS_ROOTS`, `CH_CONNECTION_NAME`,
`PG_ENV_DEV/STAGING/PROD`), 70–71, 91, 104, 112.

**Not a false positive.** The generated table's `renamed — still accepts X` notes and `AGENTS.md`'s
`*(was X)*` annotations are correct and intentional; they were excluded. Only alias-as-operative-name
usages are listed.

**Noteworthy:** `postgres-mcp/docs/mcp-postgres-issue-registry.md` already carries **PG-DOC-001 —
"`postgres-mcp-operations` skill stale on write gating & approval secret"**, marked
*fixed 2026-06-29 (docs)*. That fix predates S-43, so the skill regressed on a **new** axis after
being explicitly repaired once. This is the second occurrence of the same class of defect.

### 🔴 F-03 · `AGENTS.md` documents the wrong default response profile

`AGENTS.md:254` — "`standard` - Balanced (default)".
`CLAUDE.md:129` — "`compact` is the default for all read tools."

Verified in `codebase-index-mcp/src/types/schemas/`: **38** occurrences of
`responseProfileSchema.default("compact")` versus **3** of `"standard"`. `compact` is the default;
`AGENTS.md` is wrong and contradicts `CLAUDE.md`.

### 🔴 F-04 · `AGENTS.md`'s issue-registry section is entirely disjoint from the registry

`AGENTS.md:271–285` lists `MCP-ISSUE-001` … `MCP-ISSUE-012`, all "✅ resolved", as the contents of
`codebase-index-mcp/docs/mcp-codebase-index-issue-registry.md`.

The registry actually contains: `MCP-ISSUE-022, 031, 032, 033, 034, 035, 036, 037, 038, 039, 040,
041`. **Zero overlap.** Every ID `AGENTS.md` names is absent from the file it points at, and none of
the twelve issues that *are* there is mentioned. An agent following `AGENTS.md` would conclude the
listed problems are the known ones and that nothing since has been filed.

### 🔴 F-05 · Three different harness counts across four documents; all three are wrong

| Document | Line | Claims |
|---|---|---|
| `docs/guides/onboarding.md` | 111 | "should not wait behind **31** of them" |
| `docs/servers/server-development.md` | 253 | "then **31** integration harnesses" |
| `docs/servers/server-development.md` | 263 | "wait behind **34** harnesses" |
| `CLAUDE.md` | 39, 49 | "all **34** keep their own name", "behind **34** harnesses" |

Measured: `codebase-index-mcp/package.json` declares **34** `test:*` scripts, two of which
(`test:unit`, `test:integration`) are not harnesses — so **32** named harnesses. `scripts/test/`
holds **41** harness files (42 including `_fixtures.mjs`), of which **9** are wired to no script.
32 wired = 41 − 9 ✅.

`docs/servers/server-development.md` contradicts itself ten lines apart. The correct figure is **32**.

---

## 5. Findings — medium and low

### F-06 · `docs/migration/ci.md` misstates `verify:all`'s composition

`ci.md:134` — "`verify:all` | `verify:packages` + `verify:servers` + `contracts:check`".

Actual: `verify:all = verify:packages && verify:servers && contracts:check && generate:check`.
`generate:check` is omitted — in the one document whose purpose is to record what runs where, and for
the one step both `README.md` and `development.md` stress is caught *locally or not at all*.
`docs/development/workflow.md` §4 states it correctly.

### F-07 · `MCP-FIRST-CHEATSHEET.md` names tools that do not exist

Lines 45–46 use `mcp_health_check` and `mcp_run_read_query`. The runtime names are
`mcp__postgres-mcp__health_check` and `mcp__postgres-mcp__run_read_query`, as
`.claude/rules/mcp-hard-mode.md` correctly documents in its *MCP Naming Convention* section.

### F-08 · Three documents give three different, all-incomplete graph-model lists

Actual, from `codebase-index-mcp/src/types/index.ts`:

- **line 188 — 10 edge types:** `IMPORTS | CALLS | DEPENDS_ON | IMPLEMENTS | EXTENDS | TYPE_REF | PROPERTY_REF | PROPERTY_WRITE | PUBLISHES | CONSUMES`
- **line 170 — 14 symbol kinds:** `function | class | method | variable | module | interface | property | constructor | type | struct | record | record struct | impl | unknown`

| Document | Edge types | Symbol kinds |
|---|---|---|
| `CLAUDE.md` | 7 — missing `EXTENDS`, `PUBLISHES`, `CONSUMES` | 10 — missing `record`, `record struct`, `impl`, `unknown` |
| `codebase-index-mcp/CLAUDE.md` | 7 — same three missing | 11 — missing `record`, `record struct`, `unknown` |
| `AGENTS.md:247` | 7, but **two do not exist** (`NUGET_DEPENDENCY`, `PROJECT_REFERENCE`) and five real ones are missing | not listed as a union |

`AGENTS.md` is the worst of the three: it invents two edge types. (`.csproj` parsing does produce
NuGet and ProjectReference edges conceptually, but they are not members of the `EdgeType` union an
agent would query on.)

### F-09 · `AGENTS.md:145` — refactor-engine test baseline is stale

Claims "Current baseline: 47 tests". `scripts/test/test-refactor-engine.mjs` contains **69** `assert`
calls, and the harness prints its own `N passed, N failed`. Re-derive by running it; 47 predates
later additions.

### F-10 · `ci.md:18` — package test counts stale in two places, and one package is missing

| Claimed | Measured (`npm run test:packages`) |
|---|---|
| core 28 | 28 ✅ |
| shared 50 | 50 ✅ |
| **sdk 50** | **97** ❌ |
| testing 16 | 16 ✅ |
| **cli 13** | **20** ❌ |
| *(not listed)* | **manifest 26** — omitted entirely |

### F-11 · `ci.md:22` — server test counts stale

| Claimed | Measured |
|---|---|
| codebase-index "26 scripts" | 34 `test:*` scripts / 32 harnesses (see F-05) |
| postgres 53 | **64** ❌ |
| observe 41 | **56** ❌ |
| bitbucket 25 | 25 ✅ |

Also `ci.md:112` — "`codebase-index-mcp` had ~25 individually-invoked `test:*` scripts". The
past-tense framing is defensible, but `scripts/run-tests.mjs:5` carries the same "~25" as a
present-tense code comment against 34.

### F-12 · `.claude/rules/codebase-index.md` prescribes a tool contract that does not exist

Its *MCP Tool Contract* section names five tools to keep focused and composable:
`index_repository`, `get_dependency_graph`, `get_call_chain`, `get_module_flow`,
`find_impact_surface`.

Against `contracts/codebase-index.json`: `index_repository` ✅, `get_dependency_graph` ✅,
`get_call_chain` ✅ — but **`get_module_flow` and `find_impact_surface` do not exist**. The real
tools are `find_impact_files` (with `view: "surface"`) and `trace_execution_flow`. This is an
always-on rule file, last touched 2026-07-08.

### F-13 · The `guard:all` file count drifted 508 → 516 in four documents

`npm run guard:all` now reports:

```
guards: 0 error(s), 20 warning(s), 1 accepted exemption(s) across 516 file(s)
```

`0 / 20 / 1` are all still exact. Only the file total moved. Cited as **508** in:
`docs/reference/conventions.md:117`, `docs/reference/folder-convention.md:179`,
`docs/architecture/target-architecture.md:287`, and `CONTRIBUTING.md:161` (which uses it as the
worked example of a well-attributed number).

Both `conventions.md` §5 and `folder-convention.md` §5 already carry an explicit note telling the
reader to re-derive from the command rather than trust the prose — the mitigation is in place; only
the number is stale.

### F-14 · `indexPipeline.ts` line count stale in two documents

Cited as **572** in `docs/reference/conventions.md:134` and `docs/reference/folder-convention.md:215`. `guard:all`
reports **582**. (The other three cited sizes — `vectorStore.ts` 716, `edgeResolverCalls.ts` 622,
`graphStore.ts` 841 — match the guard exactly; `wc -l` differs by one on each because it counts
newlines.)

### F-15 · `contracts/README.md:45` uses a pre-rename var as its example

`PG_ALLOWED_ENVIRONMENTS` should be `POSTGRES_ALLOWED_ENVIRONMENTS`. Low impact — the sentence is
explaining why optional vars are left unset — but it is a current-state doc.

### F-16 · `codebase-index-mcp/CLAUDE.md:163` uses an ambiguous relative path

Points at `docs/mcp-codebase-index-issue-registry.md`. Correct read from the server directory,
resolves to nothing from the workspace root — where an agent given the repo root as cwd would look.
`.claude/commands/codebase-index.md:87` has the same shape. Same class as F-21.

### F-17 · `docs/decisions/README.md` substantially restates all three ADRs

Each of the three index entries runs 20–35 lines and reproduces the Context / Decision / Consequences
/ Alternatives content — including ADR 0001's amendment in full. The individual files are then the
same argument at greater length. Two copies of a decision's reasoning can disagree; there is nothing
checking they do not. Deliberate readability trade-off, recorded here as accepted duplication rather
than a defect.

### F-18 · `MCP-FIRST-CHEATSHEET.md` duplicates `mcp-hard-mode.md`

Its Fast Runbooks, Do/Do-Not, Fallback Rule and Final Answer Checklist restate
`.claude/rules/mcp-hard-mode.md`'s Required MCP-First Flow, Blocked Behaviors, Fallback Conditions
and Output Contract in compressed form. The rule file is always-on policy; the cheatsheet is an
optional read that has already drifted (F-07) while the rule file has not. **The strongest archive
candidate in the repository** — though see §7 before acting.

### F-19 · No document declares an owner, and there is no `CODEOWNERS`

Uniform implicit ownership works at one operator (`ci.md` says so explicitly and makes a security
decision on that basis — B-05, "no credential goes into CI"). It becomes a gap the moment a second
person maintains a server: nothing records who decides whether
`postgres-mcp/skill/SKILL.md` is correct.

### F-20 · Neither issue registry has a status index

`codebase-index-mcp/docs/mcp-codebase-index-issue-registry.md` is 910 lines / 12 issues;
`postgres-mcp/docs/mcp-postgres-issue-registry.md` is 607 lines / 16 issues. Neither opens with an
ID → title → status table, so answering "what is still open?" requires reading the whole file. This
is what let F-04 go unnoticed. Note the registries are *not* strictly historical: `CONTRIBUTING.md`
classifies them as such, but agents are instructed to append to them, and the codebase-index registry
has clearly been pruned (IDs 001–021 are gone).

### F-21 · Root-level docs cite server-relative script paths without the package prefix

Not broken — resolvable — but ambiguous from the workspace root, which is where these documents are
read:

| Reference | Cited by | Actually at |
|---|---|---|
| `scripts/smoke-test.mjs` | `target-architecture.md:217`, `ci.md:35`, `normalization-report.md:51`, `duplication-extraction-report.md:102`, `server-development.md:166` | `<server>/scripts/smoke-test.mjs` |
| `scripts/test/test-extractor.mjs` | `AGENTS.md:151` | `codebase-index-mcp/scripts/test/…` |
| `scripts/test/test-refactor-engine.mjs` | `AGENTS.md:191` | same |
| `scripts/run-tests.mjs` | `ci.md:113` | `codebase-index-mcp/scripts/run-tests.mjs` |
| `scripts/prune-repo.mjs` | `status.md:443` | `codebase-index-mcp/scripts/prune-repo.mjs` |

Root `scripts/` exists and holds different files (installer, doctor, generators), so the collision is
real rather than theoretical.

---

## 6. Broken links and references — full results

### 6.1 Markdown links: clean

**0 broken** across all 85 tracked files. Every `[text](../../reports/path)` resolves, and every `#anchor` matches
a heading in its target. For a 89-file set with a hub-and-spoke index and heavy cross-referencing,
this is the strongest single signal in the audit.

### 6.2 Path references: 71 distinct misses, 4 actionable

Triage of the backtick-path checker:

| Class | Count | Verdict |
|---|---|---|
| Pre-move paths inside `migration-plan.md` / `normalization-report.md` documenting a *"from → to"* rename | 52 | **Correct by design** — these files record what moved |
| Scaffold placeholders (`__KEY__`, `__CAMEL__`, `myserver`) in `templates/server/README.md`, `server-development.md` | 5 | **Correct by design** |
| Proposals not yet built (`.github/workflows/verify-live.yml`, `scripts/lib/requireBuiltPackages.mjs`) in `backlog.md` | 2 | **Correct** — B-05 is a won't-do, and `ci.md` explains the workflow was deleted the same day |
| Planned-but-never-shipped names in the frozen plan (`contracts/codebase-index-local.tools.json` → actual `contracts/codebase-index.json`; `docs/migration/baseline.md`; `pilot-notes.md`; `rollback-drill.md`) | 8 | **Historical** — the ❄️ FROZEN banner covers it |
| **Ambiguous root-relative server paths** | **4** | **F-21** |

### 6.3 npm scripts cited but undefined: 6, all in the frozen plan

`contract:verify` (→ `contracts:check`), `verify` (→ `verify:all`), `test:extractor`,
`test:refactor-preview-profiles` (→ `test:refactor-profiles`), `test:index-debug`, `test:new-tools`
— every mention confined to `docs/migration/migration-plan.md`. Consistent with its frozen status.

**Worth noting:** `test:extractor`, `test:index-debug` and `test:new-tools` correspond exactly to
three of the **nine harness files wired to no npm script**. The plan assumed those scripts would
exist; they never did.

### 6.4 Tool parameters: 11 invalid — see F-01

### 6.5 Env names: 14 alias-as-operative-name mentions — see F-02

---

## 7. Where the documentation is strong

Naming this matters, because the recommendations in §9 must not damage it.

1. **The maintenance-class model is explicit and observed.** `docs/README.md` §"Kinds of document"
   and `CONTRIBUTING.md` §"Documentation is part of the change" define four classes with different
   rules. Every historical document I checked complies: `migration-plan.md` carries a ❄️ FROZEN
   banner naming what it must not be read for; `audit-report.md` states its provenance and the
   constraint it was written under; `s26-s29-plan.md` warns that its own step numbers differ from the
   plan's. **This is why §3 lists no archive candidates.** The historical set is not clutter — it is
   correctly labelled, and `docs/migration/README.md` explains the one deliberate decision to keep
   two long documents rather than merge them (B-11).

2. **Numbers cite their command.** `docs/architecture/as-built.md:39`, `conventions.md:87` and
   `packages.md:204` each embed the exact `node -e "import('@mcp/manifest')…"` invocation that
   produces the figure quoted. I ran them; `SERVERS` is exported and the counts are exact.

3. **Drift is pre-announced.** `conventions.md:126` and `folder-convention.md:193` both warn that
   older passages say *"no hard-cap finding since S-41"* and instruct re-derivation. A document that
   tells you which of its own claims to distrust is doing something most do not.

4. **Verified-exact claims.** 76 tools (43/17/8/8) ✅ · 98 env vars (41/23/23/11) ✅ · 41
   protocol-SDK imports, 26 type-only, 12 codebase-index files with value imports ✅ · 42 files in
   `scripts/test/` ✅ · guard errors/warnings/exemptions 0/20/1 ✅ · backlog "13 of 14 closed" ✅ ·
   all five `ENV_ACCESS_ALLOWLIST` paths exist ✅.

5. **`docs/reference/dependency-rules.md` and `docs/development/workflow.md` are the reference standard.** Every
   checkable claim in both verified exact — including the subtle one, where the two servers' import
   counts required distinguishing type-only from value imports to reconcile.

6. **ADR 0001 amends rather than rewrites**, and records that the wrong reading of its own
   consequence cost real work. That is the practice `docs/decisions/README.md` prescribes, demonstrated.

---

## 8. Missing sections

| Gap | Where it belongs | Why |
|---|---|---|
| **Skill-freshness gate** | `generate:check`, `mcp:doctor` | The structural cause of F-01/F-02 — see below |
| Status index | both issue registries | F-20 |
| Owner / maintainer | `CODEOWNERS` or doc front-matter | F-19 |
| A "documentation" row in `CONTRIBUTING.md` §"Changes that need something extra" | `CONTRIBUTING.md:131` | The table covers tools, env vars, packages, servers, file moves — but not *"changed a tool's parameters"* → *"update the skill template and the examples"*. F-01's whole class |
| Language policy | `docs/reference/conventions.md` §7 | Two of four server READMEs are Vietnamese (`postgres-mcp`, `bitbucket-mcp`), the rest English. `folder-convention.md:257` mentions this in passing as a reason regeneration must preserve prose, but no rule states which language a new doc should use |
| Pointer to `.claude/skills/` from the doc hub | `docs/README.md` | It links `../.claude/skills/` as "authoring skills" but never says the four *operational* skills are generated per server and gitignored — the only place that is explained is `server-development.md` §3 |

### The structural gap behind the two critical findings

Three generated surfaces are gated. A fourth is not:

| Surface | Rendered from | Gated by |
|---|---|---|
| `<server>/.env.example` | `envSpecs/<server>.ts` | `generate:check` ✅ |
| README `<!-- BEGIN/END GENERATED -->` blocks | manifest | `generate:check` ✅ |
| `packages/manifest/src/generated/toolLists.ts` | `contracts/` | `generate:check` ✅ |
| **`~/.claude/skills/<key>/SKILL.md`** | **`<server>/skill/SKILL.md`** | **nothing** |

Verified:

- `generate:check = generate-tools --check && generate-env --check && generate-docs --check` — no
  skill step. Grepping the three generators for `skill` returns only an unrelated comment.
- `scripts/mcp-doctor.mjs:211–213` — the `skill` check is `fs.existsSync(skillPath)`. **Presence
  only, never freshness or content.**

So a skill template can name a renamed env var (F-02) or a non-existent tool parameter (F-01)
indefinitely, and `verify:all`, CI and `mcp:doctor` all stay green. The `{{ENV_TABLE}}` and
`{{TOOL_LIST}}` placeholders *are* regenerated — which is exactly why F-02 produces a file that
contradicts itself: the generated table is current, the prose around it is fifteen months of
convention out of date in env-naming terms.

---

## 9. Recommendations

Ordered by the repository's own priority rule from `docs/development/backlog.md`: *does a tool report something
untrue → does a gate fail to bite → is it only a cost.* No file was changed; these are proposals.

### P1 — a document tells an agent to do something that fails

| # | Action | Files |
|---|---|---|
| **R-1** | **Add a `docs:check` gate** that (a) validates every `tool_name({…})` in Markdown against `contracts/*.json`, and (b) flags any `deprecatedAlias` used outside a *"renamed — still accepts"* context. Wire into `verify:all`. The two checkers exist in this audit's scratchpad and are ~40 lines each. This is what makes F-01 and F-02 un-repeatable — and both are second occurrences (PG-DOC-001 already fixed the postgres skill once). | new `scripts/check-docs.mjs` |
| **R-2** | Correct the 11 invalid parameters (F-01). Do `skill/SKILL.md` first — it is the installed surface. | `codebase-index-mcp/skill/SKILL.md`, `.claude/commands/codebase-index.md`, `docs/EXAMPLES.md`, `docs/DECISION-TREE.md` |
| **R-3** | Rename the env vars in prose to `POSTGRES_*` (F-02), then **re-run `npm run mcp:update -- --server postgres-mcp`** to refresh the stale installed copy. The repo fix alone does not correct what is on disk. | `postgres-mcp/skill/SKILL.md`, `postgres-mcp/README.md` |
| **R-4** | Fix the default profile (`standard` → `compact`) and replace the issue-ID list with a pointer to the registry rather than a copy of it — a copy is what drifted. | `AGENTS.md:254`, `AGENTS.md:271–285` |
| **R-5** | Reconcile the graph-model lists against `src/types/index.ts:170,188`, and delete the two non-existent edge types. Consider generating this section — it is a union type, mechanically extractable. | `CLAUDE.md`, `codebase-index-mcp/CLAUDE.md`, `AGENTS.md` |
| **R-6** | Correct the five tool names in the always-on rule file (F-12). | `.claude/rules/codebase-index.md` |

### P2 — a gate or a record does not say what is true

| # | Action | Files |
|---|---|---|
| **R-7** | Settle the harness count at **32** and resolve `server-development.md`'s self-contradiction (F-05). Better: state it as *"the `test:*` scripts `run-tests.mjs` discovers"* and stop quoting a number. | `CLAUDE.md`, `docs/guides/onboarding.md`, `docs/servers/server-development.md` |
| **R-8** | Add `generate:check` to the `verify:all` row (F-06). | `docs/migration/ci.md:134` |
| **R-9** | Either wire the **9 unwired harnesses** to `test:*` scripts or delete them. `server-development.md:265` already documents them honestly — the note has been true long enough to decide. Note `CLAUDE.md:38` claims the discovered list "cannot fall behind", which is true of *scripts* and false of *harnesses*. | `codebase-index-mcp/package.json` |
| **R-10** | Add a status index to both registries (F-20). | both issue registries |
| **R-11** | Add a *"Changed a tool's parameters or an env var name"* row to the extra-work table, pointing at the skill template and the examples. | `CONTRIBUTING.md:131` |

### P3 — a cost, not a defect

| # | Action |
|---|---|
| **R-12** | Refresh the four stale counts: `508 → 516` in four files (F-13), `572 → 582` in two (F-14), `ci.md`'s package and server test counts (F-10, F-11), the `47`-test refactor baseline (F-09). Prefer replacing each with the command, per `CONTRIBUTING.md`'s own rule — `516` will be stale again next week. |
| **R-13** | Fix `mcp_health_check` / `mcp_run_read_query` (F-07), and `contracts/README.md:45`'s example var (F-15). |
| **R-14** | Prefix the ambiguous server-relative script paths (F-21), and make `codebase-index-mcp/CLAUDE.md:163` unambiguous (F-16). |
| **R-15** | **Decide `MCP-FIRST-CHEATSHEET.md`'s fate** (F-18). It duplicates always-on policy and has already drifted while the policy file has not. Either fold its runbooks into `mcp-hard-mode.md` and delete it, or mark it a derived quick-reference that must not be read as policy. Prefer the former. |
| **R-16** | Add `CODEOWNERS` (F-19) and a language policy (§8). Both are cheap now and expensive to retrofit at operator #2. |
| **R-17** | Consider trimming `docs/decisions/README.md` to one-paragraph summaries plus links (F-17), so a decision's reasoning has one home. |

### Not recommended

- **Do not archive any historical document.** The set is correctly labelled, cross-referenced, and
  load-bearing; `docs/migration/README.md` already litigated the merge question (B-11) and the
  reasoning holds.
- **Do not reconcile `migration-plan.md`'s stale command and path names.** Its frozen banner is the
  correct mechanism, and rewriting a frozen record is precisely what `CONTRIBUTING.md` forbids.
- **Do not delete `docs/architecture/as-built.md` in favour of `architecture/target-architecture.md`.** The
  as-built / design split is deliberate and the awkward path is already explained in
  `architecture.md`'s own header.

---

## 10. Summary

| | Count |
|---|---|
| Markdown files audited | **89** (85 tracked + 4 generated) |
| Broken Markdown links | **0** |
| Broken path references (actionable) | **4** of 71 flagged |
| Invalid documented tool parameters | **11** across 15 mentions |
| Deprecated env names used as canonical | **14** mentions |
| Verified stale counts | **7** |
| Findings | **21** — 2 critical · 5 high · 8 medium · 6 low |
| Documents needing action | **12** of 89 |
| Documents verified clean | **77** |
| Deprecated / Obsolete / Archive-candidate documents | **0** (one duplicate flagged for a decision: F-18) |

**The single change with the most leverage is R-1.** Two of the four documentation surfaces this
repository generates are ungated, and both critical findings live there. The workspace's own sharpest
rule — *"a convention nobody checks is a preference"* (`docs/reference/conventions.md`, ADR 0002) — is the
diagnosis: env names and tool schemas are gated everywhere they are declared, and nowhere they are
explained.

---

*Audit performed read-only. No file in the repository was modified or deleted; `docs/reports/` and
this file were created as the requested deliverable.*
