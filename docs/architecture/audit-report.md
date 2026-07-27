# Repository Audit — Internal Local MCP Platform

**Audited state** — commit `01c532e` (the repository as it stood before any restructuring)
**Written** — 2026-07-27

> **Provenance.** This audit was performed as Phase 0 of the architecture engagement, under the
> constraint *"DO NOT MODIFY ANY FILE"*, so its findings were originally delivered as a report
> rather than committed. It is recorded here retroactively. Every quantitative claim below has been
> **re-verified against commit `01c532e`** via `git show` rather than restated from memory; the two
> exceptions are marked. §9 states what has changed since.

---

## 1. Current architecture

Four **independent** MCP servers in one repository. This is not a monorepo: there is no workspace
declaration, no shared package, no common build. Each server is a standalone npm project that
happens to share a directory.

```
mcp-local/
├── codebase-index-mcp/     code graph indexing + analysis  (largest)
├── postgres-mcp/           PostgreSQL access, read-only by default
├── observe-mcp/            OpenObserve logs/traces, read-only
├── bitbucket-mcp/          Bitbucket Cloud repos/PRs, can create PRs
├── scripts/                data-driven installer / doctor / skill generator
├── .claude/                workspace rules + MCP authoring skills
└── package.json            installer scripts only — no workspaces
```

Every server: TypeScript 5.7+, ESM (`"type": "module"`), `@modelcontextprotocol/sdk`, `zod`, its
own `tsconfig.json`, its own `dist/`, its own `node_modules`, its own `package-lock.json`.

### Server responsibilities

| Server | Responsibility | Write surface |
|---|---|---|
| **codebase-index-mcp** | Indexes a repo into a SQLite code graph (symbols + edges) via tree-sitter; exposes search, impact analysis, call chains, docs queries, and a rule-based refactor engine | Writes **source files** through preview→apply→rollback, HMAC-gated |
| **postgres-mcp** | SQL access across environments; introspection, profiling, environment comparison, EF Core migration tooling | Read-only by default; data writes and migrations each behind an explicit env flag; `prod` forced read-only |
| **observe-mcp** | Queries a self-hosted OpenObserve `_search` API to search logs and trace a request end-to-end | None — read-only |
| **bitbucket-mcp** | Reads repositories/branches/pull requests and **creates pull requests** | PR creation, off unless `BITBUCKET_WRITE_ENABLED=true` |

### Dependency map

The striking finding is what is **absent**:

```
codebase-index-mcp ─┐
postgres-mcp ───────┼──> @modelcontextprotocol/sdk, zod        (4 independent copies)
observe-mcp ────────┤
bitbucket-mcp ──────┘

codebase-index-mcp ──> better-sqlite3, tree-sitter{,-c-sharp,-javascript,-typescript},
                       sqlite-vec, chokidar, glob, minimatch    (native)
postgres-mcp ──────> pg
observe-mcp ───────> (no runtime deps beyond sdk + zod)
bitbucket-mcp ─────> (no runtime deps beyond sdk + zod)

server ──> server                : NONE  (verified — no cross-server imports)
server ──> shared package        : NONE  (no shared package exists)
scripts/lib/manifest.mjs ──> all : the only thing that knows all four exist
```

There is exactly **one** integration point: `scripts/lib/manifest.mjs`, a data-driven manifest the
installer, doctor, and skill generator all read. That part of the repository is genuinely well
designed and is the model the rest should follow.

**Verified:** no server imports another. The isolation is real — which is why the duplication below
is duplication rather than coupling.

---

## 2. Duplicated logic

Verified by symbol-name intersection across servers plus normalized-line overlap. The duplication
is **self-documented copy-paste**, not coincidence: several files carry comments like
*"Ported from postgres-mcp/src/sqlGuardrails.ts"*.

| Concern | Copies | Evidence at `01c532e` |
|---|---|---|
| **SQL guardrails** | 3 | `stripStringsAndComments`, `hasMultipleStatements`, `findForbiddenToken`, `validateReadOnlySql` in postgres-mcp, observe-mcp, and (as `sqliteGuardrails.ts`) codebase-index-mcp |
| **Response formatting** | 4 | `normalizePayload` / `asText` / `asError` / `ResponseProfile`. postgres **68**, observe **67**, bitbucket **67** lines — 95–97% identical; codebase-index a **193**-line diverged superset |
| **Approval HMAC** | 2 | `issueApprovalToken` byte-identical in postgres-mcp and codebase-index-mcp; `verifyApprovalToken` identical except the signature comparison |
| **HTTP client scaffolding** | 2 | `sleep`, `enc`, `truncate`, backoff schedule `[250, 750]`, retry loop — observe-mcp and bitbucket-mcp |
| **Env parsing** | 2–4 | `numberFromEnv`, `stringFromEnv`, `nonNegFromEnv`, `parseBoolEnv` |
| **Error taxonomy** | 3–4 | `PolicyViolationError` byte-identical ×3; `mapError` near-identical ×2 |
| **Logging** | 3 | `logInfo` / `logError` byte-identical — `console.error(JSON.stringify({level, event, ...detail}))` |

### The duplication has already drifted — and it is security logic

The forbidden-token lists in the three SQL guardrails, counted at `01c532e`:

| Server | Tokens | Notes |
|---|---|---|
| postgres-mcp | **18** | includes `comment`, `do`, `analyze`, `reindex`, `refresh`, `merge` |
| observe-mcp | **13** | missing five of postgres's |
| codebase-index-mcp | **16** | SQLite-specific `attach`, `detach`, `pragma`; no `copy`/`call`/`do`/`refresh`/`merge` |

This is the audit's most important single finding. Three copies of a security control, already
divergent, with no test asserting the difference is intentional. Some of the divergence is
**correct** (SQLite genuinely needs `pragma`; DataFusion has no `merge`) and some looks accidental
— but nothing in the repository distinguishes the two.

---

## 3. Dead code, obsolete files, legacy experiments

| Item | Assessment |
|---|---|
| `codebase-index-mcp/src/treeSitterExtractor.ts.backup` | **Obsolete.** A hand-made backup inside a compiled source tree, excluded from `tsc` only by file extension. Nothing imports it. Git already is the backup |
| `codebase-index-mcp/commands/codebase-index.md` | **Duplicate.** Byte-identical to `codebase-index-mcp/.claude/commands/codebase-index.md`, which is the path Claude Code actually reads. No installer script consumes `commands/` |
| 9 of 31 `test-*.mjs` harnesses | **Orphaned.** Wired to no npm script, so nothing runs them |
| 3 of those 9 | **Broken.** Hardcode an absolute path into an unrelated repository (`D:\1.SourceCode\crm\wec.commnunication-hub\…`) that need not exist on any given machine |
| `postgres-mcp/scripts/smoke-test.mjs` | **Orphaned.** Exists, works, but is wired to no npm script — nobody runs it |

No genuinely abandoned experiment directories were found. The dead weight is small and localized.

---

## 4. Inconsistent structure

Each server invented its own internal layout. Same concern, four different addresses:

| Concern | codebase-index | postgres | observe | bitbucket |
|---|---|---|---|---|
| Response formatting | `src/responseFormatter.ts` | `src/response/` | `src/response/` | `src/response/` |
| Config | `src/envConfig.ts` + `src/performanceConfig.ts` | `src/config/environments.ts` | `src/config.ts` | `src/config.ts` |
| Guardrails | `src/sqliteGuardrails.ts`, `src/indexGuardrails.ts` | `src/sqlGuardrails.ts` + `src/sql/writeGuardrails.ts` | `src/sqlGuardrails.ts` | — |
| Tests | 31 `.mjs` harnesses mixed into `scripts/` | none | `*.test.ts` colocated | none |
| Docs | 4 markdown files loose at server root | 1 at server root | in README | in README |

npm script vocabulary, verified at `01c532e`:

| Server | build | typecheck | test | start | dev | smoke-test |
|---|---|---|---|---|---|---|
| codebase-index-mcp | ✓ | ✓ | — (32 ad-hoc `test:*`) | ✓ | ✓ | — |
| postgres-mcp | ✓ | ✓ | — | ✓ | ✓ | — |
| observe-mcp | ✓ | ✓ | ✓ | ✓ | ✓ | — |
| bitbucket-mcp | ✓ | ✓ | — | ✓ | ✓ | ✓ |

No two servers agree. There is no way to "run the tests" across the repository.

---

## 5. Hidden coupling and circular dependencies

**Circular dependencies — one real cycle** (verified on the code graph, `mode: "module"`):

```
codebase-index-mcp/src/graphStore.ts
  → codebase-index-mcp/src/regexSearch.ts
  → codebase-index-mcp/src/graphStore.ts          (IMPORTS, IMPORTS)
```

A mutual import between the storage layer and a search feature. It compiles because ESM tolerates
it, but it means neither module can be understood or tested alone.
*(Verified on the current graph; not re-verifiable retroactively at `01c532e` without a checkout —
both files existed then and neither was touched by later restructuring, so the cycle predates it.)*

**Hidden coupling — the significant kind is external, not internal:**

- `~/.claude.json` holds every server's registration path and secrets. It is machine state outside
  the repository that the running integration depends on. Any change to a server's directory or
  entry point silently breaks every agent session until re-registration.
- `scripts/lib/manifest.mjs` hardcodes each server's `dir`. It is the single point that must change
  in lockstep with any directory move.
- `observe-mcp` is registered under keys (`observe-mcp-ssdev_au`, `observe-mcp-wecrm_au_prod`) that
  do not match the manifest's declared key `observe-mcp`. The doctor therefore reports it
  unhealthy — it passes no env, and the server correctly fails fast on missing credentials. A
  pre-existing configuration mismatch, not a code defect.

**Structural coupling inside codebase-index-mcp:** `src/index.ts` is **2,154 lines** and
`src/graphStore.ts` is **1,924 lines**. Every tool definition, request dispatch, and env parse
lives in the former; every SQL statement in the latter. These two files are the real barrier to
changing anything in that server.

---

## 6. Technical debt register

| # | Debt | Severity | Why it matters |
|---|---|---|---|
| D1 | SQL guardrail logic triplicated **and drifted** (18/13/16 tokens) | **High** | Security control with no single source of truth and no test asserting intended divergence |
| D2 | `codebase-index-mcp/src/index.ts` 2,154 lines; `graphStore.ts` 1,924 | **High** | Blocks safe change in the most active server |
| D3 | Approval-token HMAC duplicated ×2 | **High** | Auth code. One copy compares signatures with `!==`, the other constant-time |
| D4 | Response formatting duplicated ×4 | Medium | Every tool's output shape; drift is invisible to clients |
| D5 | No shared test infrastructure; no aggregate `test` | Medium | Cannot assert anything repository-wide |
| D6 | No CI | Medium | Every guarantee is manual |
| D7 | No tool-contract snapshot | Medium | A rename or schema change is undetectable in review |
| D8 | Four copies of `zod` / protocol SDK | Medium | Wasteful, and blocks any shared code that uses `instanceof` on them |
| D9 | Inconsistent folder layout and script vocabulary | Medium | Onboarding cost; nothing is where you'd guess |
| D10 | `graphStore ↔ regexSearch` cycle | Low | Localized but blocks isolated testing |
| D11 | Obsolete `.backup` file, duplicate command file, 9 orphaned + 3 broken harnesses | Low | Noise that erodes trust in the tree |
| D12 | `postgres-mcp` mixes three env prefixes (`CH_*`, `PG_*`, `MCP_DB_*`) | Low | Operator confusion |

---

## 7. Refactor opportunities, in value order

1. **Extract the SQL guardrails behind one mechanism with injected policy.** Highest value: it is
   security logic, triplicated, already drifted. The token list must stay per-server — the
   divergence is partly legitimate — so this is *mechanism shared, policy local*, and the
   extraction must be paired with tests that name each divergence.
2. **Extract the approval-token HMAC.** Small, auth-critical, and the two copies differ only in
   whether the comparison is constant-time.
3. **Extract response formatting.** Four copies, highest line count, purely functional and
   therefore the easiest to prove equivalent.
4. **Extract env parsing, error taxonomy, logging, HTTP scaffolding.** Individually minor,
   collectively most of the remaining duplication.
5. **Decompose `codebase-index-mcp/src/index.ts`.** Not extraction but decomposition; the single
   biggest unblocking move for that server.
6. **Normalize folder layout and script vocabulary.** Cheap, no behaviour change, makes everything
   afterwards easier to navigate.
7. **Break the `graphStore ↔ regexSearch` cycle.**

**Shared-logic candidates, tiered by dependency weight:**

- *Zero-dependency* (usable by anything): result/error types, redaction, env reading, logging,
  response profiles, path helpers, JSON normalization
- *Capability* (needs no protocol knowledge): SQL guardrails, approval tokens, HTTP client, path
  allowlist
- *Protocol-aware* (needs the MCP SDK): tool definition, registry, dispatch, lifecycle, health

That tiering is what the target architecture should encode as an enforced rule, not a convention.

---

## 8. Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| **Native module breakage.** Hoisting `better-sqlite3` / `tree-sitter` into a workspace root can force a rebuild needing VS C++ Build Tools | High | High | Do **not** add servers to workspaces during consolidation. Scope workspaces to the shared packages only; connect servers with `file:` deps, which symlink without restructuring |
| **Breaking the live MCP integration.** Moving a server directory invalidates `~/.claude.json` | Medium | High | Treat any directory move as a separate, explicitly-approved step. The installer already backs up `~/.claude.json` |
| **Silent behaviour change during extraction.** Shared code that is "obviously equivalent" usually is not | High | High | Characterize first: capture current outputs as golden snapshots *before* touching anything; replay after and account for every delta |
| **Unifying divergent policy by accident.** Merging the 18/13/16 token lists would change every server's security posture | Medium | High | Extract mechanism, inject policy. Keep reconciliation as a separate, explicitly-labelled policy change |
| **`instanceof` across package boundaries.** Shared code branching on `zod`/`McpError` classes will silently fail while each server has its own copy | Medium | High | Do not extract such code until those deps are deduplicated |
| Big-bang refactor stalls half-done | Medium | Medium | Every step independently revertible; nothing depends on a later step |
| No-LLM policy relaxed by accident in codebase-index-mcp | Low | High | Keep the existing static guard and extend it platform-wide |

---

## 9. Suggested target architecture (summary)

Full specification: **`docs/architecture/target-architecture.md`**.

In brief: a tiered set of shared packages under `packages/`, with imports allowed only towards
lower tiers, enforced by a static guard rather than by convention:

```
L0  @mcp/core      zero runtime deps — result, errors, env, logging, redaction, json, paths, profiles
L1  @mcp/sdk       the ONLY importer of @modelcontextprotocol/sdk — tool definition, registry, dispatch
L2  @mcp/shared    capabilities, no protocol knowledge — sql guardrails, approval, http, fs allowlist
L3  @mcp/testing   harness, golden-contract snapshots, leak assertions
L4  @mcp/cli       dependency + convention guards
```

Servers stay independent, keep their own `tsconfig.json`/`dist/`, and consume the packages through
`file:` dependencies — deliberately **not** as workspace members, so native builds are never
hoisted.

## 10. Suggested migration strategy (summary)

Full 44-step plan: **`docs/migration/migration-plan.md`**.

Four principles:

1. **Safety net before change.** Commit a golden snapshot of every server's `tools/list` output
   first, so any contract drift is caught by diff rather than by a user.
2. **Strangler triplet.** Each extraction is three separate changes: *add* the shared
   implementation, *migrate* one consumer, *delete* the old copy. Each is independently
   revertible.
3. **Characterize, then extract.** Capture behaviour as a golden snapshot before touching a
   consumer; replay after; account for every delta including the ones that are fixes.
4. **Mechanism shared, policy local.** Never let a consolidation quietly become a policy change.

Phase order: safety net → build config → guards → shared packages → server migration →
documentation → deferred decisions. The `servers/` directory move and env-prefix unification are
deliberately deferred to the last phase behind explicit go/no-go, because they are the only steps
that touch machine state outside the repository.

---

## 11. What has changed since this audit

This audit describes `01c532e`. Work completed afterwards:

| Commit | Change | Debt addressed |
|---|---|---|
| `e82bcc7` | `packages/` foundation created — core, sdk, shared, testing, cli — plus shared tsconfig, project references, and dependency/convention guards | Enables D1–D4, D8; addresses D5 partly |
| `3f5b702` | Repository normalized in place: 48 files moved (all as git renames), consistent `src/{config,guardrails,response}/` in every server, docs into `docs/`, test harnesses split out of `scripts/`. Obsolete `.backup` and duplicate command file deleted | **D9, D11** (partly — orphaned harnesses remain) |
| `829ecd9` | Shared components extracted: 6 of 7 duplication clusters consolidated, with 174 regression tests and golden-snapshot equivalence proofs. The Postgres dollar-quote guardrail bypass closed | **D1, D3, D4**; D8's consequence documented |

**Still open:** D2 (oversized entry points), D5/D6 (aggregate test + CI), D7 (contract snapshot),
D8 (duplicate deps — now known to block the `mapError` extraction), D10 (the cycle), D12 (env
prefixes), and the orphaned/broken harnesses from D11.

Findings from that later work that this audit did not anticipate:

- The 18/13/16 divergence is **partly correct by dialect**, not simply drift — SQLite needs
  `pragma`/`attach`/`detach`, DataFusion has no `merge`. Reconciliation is a genuine policy
  decision (plan step S-18), not a cleanup.
- `postgres-mcp` and `observe-mcp` both **allowed** a dollar-quote guardrail bypass
  (`SELECT $$'$$; DROP TABLE t`). Not exploitable — a subquery wrap and a read-only transaction
  each stop it independently — but the guard was not doing its job. Now closed.
- `mapError` **cannot** be shared while each server carries its own `zod` and protocol SDK:
  `instanceof` compares class identity, so every validation error would silently degrade to
  `internal_error`. Measured, not assumed.
