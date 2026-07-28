# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Workspace Overview

Four independent MCP servers — **not** a monorepo with shared packages. Each has its own `package.json`, `tsconfig.json`, and `dist/`. All use TypeScript 5.7+ with ESM (`"type": "module"`) and `@modelcontextprotocol/sdk`.

- `codebase-index-mcp/` — Code graph indexing and analysis server. Most development work happens here.
- `postgres-mcp/` — PostgreSQL MCP server. Read-only by default (SQL guardrails); optional multi-environment access, reviewed/confirmed data writes, and EF Core migration tooling, each gated behind explicit env flags.
- `observe-mcp/` — OpenObserve log/trace MCP server for the CommunicationHub backend. Read-only; queries the self-hosted OpenObserve `_search` API to search logs and trace a request end-to-end by trace id (`search_logs`, `trace_logs`, `get_trace_spans`, `log_stats`, ...). Credentials via env only. Registered as `observe-mcp` in `~/.claude.json`.
- `bitbucket-mcp/` — Bitbucket Cloud MCP server. Reads repositories/pull requests and **creates pull requests** (`list_repositories`, `get_repository`, `list_branches`, `list_pull_requests`, `get_pull_request`, `get_pull_request_diff`, `create_pull_request`). Uses scopes `read:repository` / `read:pullrequest` / `write:pullrequest`. Auth via env (`BITBUCKET_ACCESS_TOKEN` Bearer, or `BITBUCKET_EMAIL`+`BITBUCKET_API_TOKEN` Basic). **PR creation is OFF unless `BITBUCKET_WRITE_ENABLED=true`**; `create_pull_request` supports `dryRun`. Registered as `bitbucket-mcp` in `~/.claude.json`.

## Commands

### codebase-index-mcp

```bash
cd codebase-index-mcp

npm run build              # Compile TypeScript → dist/
npm run typecheck          # Type check only (no emit)
npm run dev                # Run with tsx (no build needed)

# Integration test — requires build first
node scripts/smoke-test.mjs

# Policy guard — verify no LLM imports exist at runtime
npm run guard:no-llm-runtime

# Quality gate — compact-mode token savings must be ≥ 40%
npm run benchmark:plan:check

# Individual test scripts
npm run test:endpoint-bridge
npm run test:csharp-inheritance-bridge
npm run test:refactor-engine
```

**Pre-commit sequence:** run the workspace gate from the repo root instead — see
*Verification* below. Within this package, `npm run test` now runs the whole
suite (it discovers every `test:*` script from `package.json`, so the list cannot
fall behind).

### postgres-mcp

```bash
cd postgres-mcp
npm run build
npm run typecheck
npm run dev
```

### Verification (run from the workspace root)

All four servers answer to the same four scripts — `build`, `typecheck`, `test`, `smoke` — so the
root aggregates work uniformly. They are driven by `@mcp/manifest`, so a newly
registered server is covered automatically.

```bash
npm run verify:all     # the gate: packages + servers + tool contracts. Credential-free.
npm run verify:live    # the four live smoke tests. NEEDS REAL CREDENTIALS.
```

`verify:all` is what CI runs (`.github/workflows/ci.yml`, Windows + Node 22) and is deliberately
credential-free, so it means the same thing on a fresh clone as it does in CI. `contracts:check`
inside it boots all four servers over a real stdio handshake with placeholder env — that is the
credential-free boot check, and it is what catches a module that compiles but cannot load.

The live smoke tests reach real Postgres / OpenObserve / Bitbucket and are **not** in CI. Run
`verify:live` before a release. See `docs/migration/ci.md`.

Narrower targets: `verify:packages`, `verify:servers`, `test:servers`, `contracts:check`, and
`node scripts/run-servers.mjs <script> [--server <key>]`.

## Architecture (codebase-index-mcp)

**Indexing data flow:**
```
fileFilter.ts          # binary sniff + extension → language tag
indexPipeline.ts       # glob, hash, batch dispatch
  ├─ treeSitterExtractor.ts / extractionWorkerPool.ts   # AST → symbols + edges
  ├─ dotnetProjectParser.ts   # .csproj/.sln → NuGet + ProjectReference edges
  └─ markdownParser.ts        # headings + code blocks
graphStore.ts          # SQLite upsert (WAL mode, batched writes)
src/index.ts           # MCP tool dispatch
```

**Graph model:**
- Symbols: `function | class | method | variable | module | interface | property | constructor | type | struct`
- Edge types: `CALLS | IMPORTS | TYPE_REF | PROPERTY_REF | PROPERTY_WRITE | DEPENDS_ON | IMPLEMENTS`
- Stable IDs: SHA-256(`repoId:filePath:symbolName`) truncated to 24 hex chars
- All tables scoped by `repoId`; one SQLite DB can hold multiple repos

**Refactor flow:** `refactor_replace_preview` → `refactor_replace_apply` → `refactor_replace_rollback`
- Rule-based only (`decisionSource=rule_engine`, `llmInvolved=false`)
- HMAC-signed approval token (TTL: 30 min, env: `CODEBASE_INDEX_REFACTOR_APPROVAL_SECRET`)
- C# object-initializer dotted targets require `initializerRewrite` metadata or preview blocks as `ambiguous_target`

**Response profiles:** `nano | compact | standard | verbose` — `compact` is the default for all read tools. Only `verbose` is pretty-printed; the rest emit minified JSON with `null` fields dropped. All response paths are normalized to forward slashes.

## Critical Constraints

**No-LLM policy (codebase-index-mcp, hard):** Runtime LLM invocation is prohibited by design. `npm run guard:no-llm-runtime` statically verifies no LLM client imports exist in `src/`. Setting `CODEBASE_INDEX_LLM_ENABLED=true` causes startup to fail. This constraint must not be relaxed.

**Path allowlist (codebase-index-mcp):** `CODEBASE_INDEX_ALLOWED_ROOTS` (comma-separated absolute paths) is the only required env var. Always use the exact `repoPath` from `list_repositories` output — do not change drive-letter casing or slash style, as mismatches cause allowlist rejection.

**postgres-mcp default-safe:** Read path permits only `SELECT` and `WITH ... SELECT`. A connection source is required (`CH_DB_CONNECTION`, or `PG_ENV_*`, or `CH_APPSETTINGS_ROOTS`). Data writes are OFF unless `PG_WRITE_ENABLED=true` (preview→apply→rollback, HMAC-approved, mandatory WHERE); migrations OFF unless `PG_MIGRATION_ENABLED=true`. The approval token is signed/verified in-process, so `PG_WRITE_APPROVAL_SECRET` is auto-generated per process when unset (set it only to keep tokens valid across restarts). **`prod` is force read-only** regardless of config. No secrets in code.

**Smoke test requires build:** `node scripts/smoke-test.mjs` runs `dist/index.js`, not source. Always `npm run build` first.

**better-sqlite3 on Windows:** Requires Visual Studio C++ Build Tools. If native build fails, install VS Build Tools or switch to the JS-only SQLite backend.

## Installation, Skills & Doctor

All servers are installed and managed from the **workspace root** via a single data-driven
installer (source of truth: `packages/manifest/src/servers.ts`).

```bash
npm run setup                              # install/build/configure + skills for ALL servers
node scripts/install-mcp.mjs --server postgres-mcp   # just one server
npm run mcp:doctor                         # health report (build/config/env/skill/start) — never prints secrets
npm run mcp:uninstall -- --server <key>    # remove config + skill (config backed up)
npm run mcp:update -- --all                # rebuild + regenerate skills + verify
```

On install, each server gets a **native Claude Code skill** rendered from its
`<server>/skill/SKILL.md` template and written to `~/.claude/skills/<key>/` (global) and
`.claude/skills/<key>/` (project). Those generated dirs are gitignored (machine-specific paths);
the committed source of truth is the template. Registration writes to `~/.claude.json` (per-agent
config, secrets kept there per the workspace convention).

Adding a new MCP server: append it to `packages/manifest/src/servers.ts` and add
`<dir>/skill/SKILL.md` — the installer, doctor, and skill generator pick it up automatically. See
the `mcp-skill-authoring` skill.

> `scripts/lib/manifest.mjs` still exists as a re-export shim (S-34) and is scheduled for
> deletion. Edit the package, not the shim. Because packages compile to gitignored `dist/`, every
> `scripts/` entry point needs `npm run build:packages` once on a fresh clone — `setup` and
> `mcp:install` now do it for you.

## Local Dev MCP Test Cycle

After each code change, use this cycle to test immediately via MCP:

```bash
cd codebase-index-mcp
npm run build
# Then restart MCP server in Claude Code (/mcp or IDE MCP panel)
# MCP tool calls now hit the updated build — test directly without running smoke test
```

Use this for rapid iteration. Run the full pre-commit sequence before committing.

## MCP-First Operating Rules

When analyzing this codebase, use the `codebase-index-local` MCP tools **before** falling back to grep/read:

- Registered repoIds: `codebase-index-mcp` (the sub-project) and `mcp-local` (this workspace)
- Prefer `search_symbols` → `get_symbol_context_pack` → `find_impact_files` for code navigation
- **For regex/pattern searches use `search_regex`** (matches + context + enclosing symbol; `scanAll:true` to include non-code text like json/yaml) instead of baseline grep
- **To read a symbol's code, use `get_symbol_source` (by symbolId or name) instead of `read_file`** — it returns the exact source span from disk via MCP; fall back to `read_file` only for non-symbol regions
- **To refactor/rename, stay in MCP:** `rename_assist(emitPreview:true)` → `refactor_replace_apply` (use `includeLowConfidence:true` for top-level identifiers); for pattern edits use `refactor_replace_preview(findMode:"regex")` with capture groups. Preview-gated, HMAC-approved, reversible via `refactor_replace_rollback`
- `search_symbols(ranked:true)` now honors `strategy:"intent"` (multi-word scored candidates); `find_impact_files`/`get_change_context` warn via `staleWarning` instead of erroring on a stale index
- Soft cap: 5 MCP calls per question; hard cap: 8 before falling back to baseline tools
- Keep `watch_repo` off unless actively debugging; stop watchers immediately after
- If MCP returns empty or low-confidence results after 2 attempts, log to `codebase-index-mcp/docs/mcp-codebase-index-issue-registry.md` before continuing with grep/read

## Workspace Rules & Skills (`.claude/`)

- `.claude/rules/` — always-on policy docs (migrated from the old `.github/instructions/`):
  `mcp-hard-mode` (MCP-first enforcement), `mcp-base`, `typescript-mcp`, `db-guardrails`, `codebase-index`.
- `.claude/skills/` — MCP **authoring** skills (scaffold, security-review, release-checklist,
  tool-annotations, error-taxonomy, contract-conformance, observability, host-integration-security,
  db-parameterization-audit, db-query-budgeting) plus `mcp-skill-authoring`. Operational
  "how to use server X" skills are generated per server (gitignored).
- `codebase-index-mcp/.claude/skills/` — indexing-internals skills (tree-sitter, graph-schema,
  incremental-indexing, conformance, metadata-governance, unresolved-symbol-policy, etc.).
- `.claude/commands/mcp-effectiveness-eval.md` — slash command benchmarking baseline vs MCP.

## References

**Start here:** `docs/migration/status.md` — all 44 steps verified against the working
tree, what blocks what, and the step-number reconciliation for three commits whose labels
drifted from the plan.

**Decision records:** `docs/adr/0001-workspace-native-deps.md` (why servers stay outside
the npm workspace, and why `instanceof` fails across packages) ·
`docs/adr/0002-sql-guardrail-token-lists.md` (why the three SQL token lists stay
different, and the two-part rule for adding one).

**Architecture & migration** (read in this order for the full picture):

- `docs/architecture/audit-report.md` — Phase 0 audit of the pre-restructuring repository (`01c532e`): dependency map, duplication, technical-debt register, risks
- `docs/architecture/target-architecture.md` — the tier model, dependency rules, and the naming / coding / server / package conventions. §9 reconciles design against what is actually built
- `docs/migration/migration-plan.md` — 44 reversible steps (S-01…S-44) across phases A–K
- `docs/migration/foundation-notes.md` — what the `packages/` foundation contains and why
- `docs/migration/normalization-report.md` — the 48-file in-place folder normalization
- `docs/refactor/duplication-extraction-report.md` — the shared-component extraction, its measured behaviour deltas, and the one cluster deliberately left alone
- `docs/migration/s06-s23-notes.md` — contract snapshots + the `bitbucket-mcp` SDK pilot; read this before migrating another server
- `docs/migration/s24-notes.md` — the `postgres-mcp` SDK migration: the call-replay method, and why the SDK gained `resources` and `rawResult`
- `docs/migration/s25-notes.md` — the `observe-mcp` SDK migration; the first needing no new SDK capability, and a profile-dependent serialization finding no schema could reveal
- `docs/migration/s26-s29-plan.md` — the `codebase-index-mcp` entry-point survey, the three SDK gaps that block migrating it, and why the work is four steps (S-26 done)
- `docs/migration/ci.md` — what CI covers, what it deliberately does not (no live backends, no secrets), and the script vocabulary that makes the root aggregates work
- `contracts/README.md` — what the golden `tools/list` snapshots are and how to update them

**Per-server:**

- `codebase-index-mcp/CLAUDE.md` — full sub-project guide (key files, env vars, refactor engine details)
- `AGENTS.md` — env var reference, common pitfalls, integration config examples
- `codebase-index-mcp/README.md` — complete MCP tool catalog with usage examples

> **Build order:** servers consume `packages/*/dist` through `file:` dependencies, so on a fresh
> clone run `npm run build:packages` **before** building any server.
