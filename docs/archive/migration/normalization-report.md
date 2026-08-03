# Repository Normalization Report

**Date** — 2026-07-27
**Baseline commit** — `e82bcc7` (Phase 3 platform foundation)
**Scope** — folder layout only. No logic rewritten, no behaviour changed, no external state touched.

---

## 1. What was asked, and what was honoured

| Requirement | Status |
|---|---|
| Create a consistent folder layout | Done — see §3 |
| Move files only; do **not** rewrite logic | Honoured. Every content edit is an import specifier, a script path, or a doc cross-reference. No function body, signature, or control flow was altered. |
| Keep Git history whenever possible | **48 / 48 moves recorded as renames** (`git status -M`: 16 `R` + 32 `RM`). `git log --follow` works on every moved file. |
| Update imports | 31 files re-pointed |
| Update build | `package.json` script paths + the CLI guard's env allowlist |
| Update paths | 32 test harnesses re-based one level deeper |
| Everything must compile | 4/4 servers typecheck **and** build; `packages/` verify green — §5 |
| Generate a migration report | This document |

**One decision was escalated rather than assumed.** Moving the four servers into `servers/` (migration-plan step **S-42**) was offered and **declined** in favour of normalizing in place. That was the right call: S-42 is the only step in the whole plan that rewrites `~/.claude.json`, and it would have broken every registered MCP server for every agent session until the client was restarted. **External state is byte-for-byte untouched by this change.**

---

## 2. The convention now in force

Previously each server had invented its own internal shape. The rule now:

```
<server>/
├── src/
│   ├── index.ts          # MCP entrypoint            (was already consistent)
│   ├── errors.ts         # error taxonomy            (was already consistent)
│   ├── config/           # config + env resolution   ← NEW, now in all four
│   ├── guardrails/       # ALL safety/validation     ← NEW, wherever such logic exists
│   ├── response/         # response formatting       ← NEW in codebase-index-mcp
│   └── <domain>/         # server-specific (db/ write/ migration/ handlers/ extractors/ schemas/)
├── scripts/
│   ├── smoke-test.mjs    # integration entry         (was already consistent — left in place)
│   └── test/             # test harnesses + fixtures ← NEW
├── docs/                 # everything except README/CLAUDE  ← NEW
├── skill/SKILL.md        # skill template            (was already consistent)
├── README.md  CLAUDE.md  # stay at server root by convention
└── package.json  tsconfig.json
```

Two things were **deliberately left alone** because they were *already* consistent across all four servers — churning them would have destroyed consistency, not created it:

- `src/errors.ts` at the src root (all four identical already).
- `scripts/smoke-test.mjs` at `scripts/` root (all four identical already).

Resulting shape — every server now answers "where is the config / the response layer / the safety logic?" the same way:

| | config/ | guardrails/ | response/ | domain dirs | src root files |
|---|---|---|---|---|---|
| codebase-index-mcp | 2 | 2 | 1 | extractors 7, handlers 11, schemas 1 | 40 |
| postgres-mcp | 1 | 3 | 1 | db 2, migration 3, write 4 | 2 |
| observe-mcp | 1 | 1 | 2 | — | 7 |
| bitbucket-mcp | 1 | — | 1 | — | 3 |

`bitbucket-mcp` has no `guardrails/` because it has no SQL or query-validation surface — a Bitbucket REST client needs none. That is the convention applied correctly, not a gap.

---

## 3. Complete move table

### 3.1 Source — safety logic consolidated

The single highest-value move. Phase 0 found the SQL guardrail logic hand-copied into **three** servers and already drifting (postgres 18 forbidden tokens vs. observe 13). Colocating each server's copy under `guardrails/` makes the duplication impossible to miss and makes the planned S-17 extraction a mechanical lift.

| From | To |
|---|---|
| `postgres-mcp/src/sqlGuardrails.ts` | `postgres-mcp/src/guardrails/sqlGuardrails.ts` |
| `postgres-mcp/src/sql/writeGuardrails.ts` | `postgres-mcp/src/guardrails/writeGuardrails.ts` |
| `postgres-mcp/src/sql/ident.ts` | `postgres-mcp/src/guardrails/ident.ts` |
| `observe-mcp/src/sqlGuardrails.ts` | `observe-mcp/src/guardrails/sqlGuardrails.ts` |
| `codebase-index-mcp/src/sqliteGuardrails.ts` | `codebase-index-mcp/src/guardrails/sqliteGuardrails.ts` |
| `codebase-index-mcp/src/indexGuardrails.ts` | `codebase-index-mcp/src/guardrails/indexGuardrails.ts` |

`src/sql/` is now gone from postgres-mcp. `ident.ts` (identifier quoting) moved with the guardrails deliberately — it is injection prevention, not a SQL utility.

### 3.2 Source — config and response

| From | To |
|---|---|
| `bitbucket-mcp/src/config.ts` | `bitbucket-mcp/src/config/index.ts` |
| `observe-mcp/src/config.ts` | `observe-mcp/src/config/index.ts` |
| `codebase-index-mcp/src/envConfig.ts` | `codebase-index-mcp/src/config/envConfig.ts` |
| `codebase-index-mcp/src/performanceConfig.ts` | `codebase-index-mcp/src/config/performanceConfig.ts` |
| `codebase-index-mcp/src/responseFormatter.ts` | `codebase-index-mcp/src/response/responseFormatter.ts` |

`postgres-mcp/src/config/environments.ts` was already correct and did not move.

### 3.3 Test harnesses split out of `scripts/`

`codebase-index-mcp/scripts/` mixed 31 test harnesses in with 10 genuine operational scripts (setup, audit, benchmark, guard, index-self, query-db, eval-graph, check-symbols, verify-enhancements, smoke-test). Harnesses moved; operational scripts stayed.

| From | To | Count |
|---|---|---|
| `codebase-index-mcp/scripts/test-*.mjs` | `codebase-index-mcp/scripts/test/` | 31 |
| `codebase-index-mcp/scripts/_fixtures.mjs` | `codebase-index-mcp/scripts/test/_fixtures.mjs` | 1 |

Path rewrites inside them: `../dist/` → `../../dist/`, `../../scripts/lib/agents.mjs` → `../../../scripts/lib/agents.mjs`, plus two that also crossed a `src/` folder boundary (`dist/responseFormatter.js` → `dist/response/responseFormatter.js`, `dist/sqliteGuardrails.js` → `dist/guardrails/sqliteGuardrails.js`). All 22 `test:*` / `verify:*` entries in `package.json` re-pointed. **Script names are unchanged**, so every documented command still works verbatim.

### 3.4 Server docs

| From | To |
|---|---|
| `codebase-index-mcp/DECISION-TREE.md` | `codebase-index-mcp/docs/DECISION-TREE.md` |
| `codebase-index-mcp/EXAMPLES.md` | `codebase-index-mcp/docs/EXAMPLES.md` |
| `codebase-index-mcp/MCP-FIRST-CHEATSHEET.md` | `codebase-index-mcp/docs/MCP-FIRST-CHEATSHEET.md` |
| `codebase-index-mcp/mcp-codebase-index-issue-registry.md` | `codebase-index-mcp/docs/mcp-codebase-index-issue-registry.md` |
| `postgres-mcp/mcp-postgres-issue-registry.md` | `postgres-mcp/docs/mcp-postgres-issue-registry.md` |

---

## 4. Deletions — 2 files, both flagged obsolete by the Phase 0 audit

These are the only two content removals. Both are recoverable from history.

| File | Why | Recover with |
|---|---|---|
| `codebase-index-mcp/src/treeSitterExtractor.ts.backup` | A hand-made backup living inside a compiled source tree, excluded from `tsc` only by file extension. Nothing imports it. Git *is* the backup. | `git show e82bcc7:codebase-index-mcp/src/treeSitterExtractor.ts.backup` |
| `codebase-index-mcp/commands/codebase-index.md` | **Byte-identical** duplicate (verified with `diff`) of `codebase-index-mcp/.claude/commands/codebase-index.md`, which is the location Claude Code actually reads. Confirmed no installer script consumes `commands/`. | `git show e82bcc7:codebase-index-mcp/commands/codebase-index.md` |

If you would rather keep either, restoring it is a one-line `git checkout` and changes nothing else in this report.

## 4a. Reference updates

Stale paths would have made the docs lie, so every cross-reference was repaired — 9 references across 7 files:

- `.claude/rules/mcp-hard-mode.md` — `DECISION-TREE.md` and the issue registry, both previously written as bare filenames that resolved from nowhere; now repo-root-relative.
- `AGENTS.md` (4 refs), `CLAUDE.md` (1 ref) — now point into `codebase-index-mcp/docs/`.
- `codebase-index-mcp/CLAUDE.md` — issue-registry ref, plus the **key-files table** rows for `indexGuardrails.ts` and `sqliteGuardrails.ts`.
- `codebase-index-mcp/.claude/commands/codebase-index.md`, `postgres-mcp/docs/mcp-postgres-issue-registry.md` — cross-refs.
- `packages/cli/src/guards/rules.ts` — `ENV_ACCESS_ALLOWLIST` entry `"/src/config.ts"` → `"/src/config/index.ts"`. **Path correction only; the policy is unchanged** — had this been missed, two servers' legitimate config modules would have started reporting as `env/direct-access` violations.

---

## 5. Verification evidence

Every check below was run after the final move.

| Check | Result |
|---|---|
| `typecheck` — 4 servers | **4/4 PASS** |
| `build` — 4 servers | **4/4 PASS** |
| `observe-mcp` unit tests | **25 pass / 0 fail** |
| `codebase-index-mcp` wired harnesses | **23/23 PASS** |
| `codebase-index-mcp` unwired harnesses | 6/9 run clean; **3 pre-existing failures** (see below) |
| `benchmark:plan:check` (≥40% token saving gate) | `"passed": true`, `"regressions": []` |
| `guard:no-llm-runtime` | PASS — no model-provider imports |
| `npm run verify:packages` | **exit 0** |
| Platform guards | **0 errors, 34 warnings, 282 files** — *identical to the pre-move baseline* |
| Smoke tests | codebase-index **PASS**, postgres **PASS**; observe + bitbucket require credentials (see below) |
| `npm run mcp:doctor` | 3/4 `start: PASS`; observe-mcp FAIL (pre-existing, see below) |
| External state (`~/.claude.json`) | **unmodified** |

The guard verdict being *numerically identical* before and after is the strongest single signal here: the layout changed substantially while the platform's own static analysis found exactly the same 34 items in exactly the same 282 files.

### Three results that look like failures but are not mine

Each was verified against `HEAD` to confirm it predates this change:

1. **`test-index-debug.mjs`, `test-orphan-edges.mjs`, `test-property-edges-real.mjs` fail.** All three hardcode an absolute path into a *different* repository — `D:\1.SourceCode\crm\wec.commnunication-hub\...` — which is not present on this machine. `git show HEAD:...` confirms the hardcoded paths were already there (4 and 3 occurrences respectively). An absolute path cannot be affected by a move. These are also three of the nine harnesses wired to no npm script at all.

2. **`observe-mcp` / `bitbucket-mcp` smoke tests fail without credentials.** Both smoke tests document this in their own header comments. Re-run with dummy credentials, both **complete the full MCP handshake and dispatch every tool**, failing only on the network calls to the fake host — which is proof the relocated `config/` and `guardrails/` modules load and wire correctly. The observe failure trace even points at `dist/config/index.js:70` throwing its *correct* "no credentials configured" error, and bitbucket reported `"auth":"Bearer ****"`, showing redaction still intact.

3. **`mcp:doctor` reports `observe-mcp` FAIL.** Pre-existing and already diagnosed during Phase 3: it is registered as `observe-mcp-ssdev_au` and `observe-mcp-wecrm_au_prod`, while `scripts/lib/manifest.mjs` declares the key `observe-mcp`. The doctor therefore finds no config, passes no env, and the server correctly fails fast — server convention S6 working as designed. Belongs to migration-plan step S-40.

---

## 6. Rollback

All changes are uncommitted on top of `e82bcc7`.

- **Before committing** — `git reset --hard HEAD` restores everything. `packages/` and `docs/` are tracked as of `e82bcc7`, so nothing from the Phase 3 foundation is at risk.
- **After committing** — `git revert <sha>`, then `npm run build` in each server.

No rebuild of the index DB, no re-registration, and no MCP client restart is required in either direction, because no server directory or entry point path changed.

---

## 7. Deliberately not done

Each of these is real, and each is out of scope for a *move-only* change:

| Item | Why deferred | Plan step |
|---|---|---|
| Servers → `servers/` | Declined in favour of zero external-state risk | S-42 (recommended skip) |
| Reconcile SQL guardrail token lists (postgres 18 vs. observe 13) | A **policy** change with security consequences; must not ride along in a layout commit. Now much easier to spot — both files sit in `guardrails/`. | S-18 |
| Extract the triplicated guardrails into `@mcp/shared` | Needs characterization tests first | S-17 |
| Normalize npm script vocabulary (only `observe-mcp` has `test`; only `bitbucket-mcp` has `smoke-test`; `postgres-mcp` has 4 scripts vs. `codebase-index-mcp`'s 32) | Adding scripts is not moving files | S-03 |
| Wire the 9 orphaned test harnesses, and fix the 3 with hardcoded external paths | Content changes | S-02 |
| `postgres-mcp` has no `.gitignore` (the other three do) | A missing file, not a misplaced one | S-03 |
| Split the oversized entry points (`postgres-mcp/src/index.ts` 869 lines, `codebase-index-mcp/src/index.ts` 798) | The 24 size warnings are the debt the platform exists to remove | Phase F–H |

---

## 8. Net change

`git status --porcelain -M` at the final state:

```
48 files moved    — 16 pure renames (R) + 32 renamed-and-edited (RM)
                    all 48 detected as renames; git log --follow works on each
31 files edited   — modified in place (M), no move
 2 files deleted  — both audit-flagged obsolete; both recoverable (§4)
 1 file added     — this report
---------------------------------------------------------------
 0 behaviour changes
 0 external state changes
```

Every edit in the 32 `RM` and 31 `M` files falls into exactly one of three categories: an **import specifier**, a **script/relative path**, or a **documentation cross-reference**. No function body, signature, type, or control-flow statement was touched anywhere in this change.
