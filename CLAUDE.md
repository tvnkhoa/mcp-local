# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Workspace Overview

Five independent MCP servers — **not** a monorepo with shared packages. Each has its own `package.json`, `tsconfig.json`, and `dist/`. All use TypeScript 5.7+ with ESM (`"type": "module"`) and `@modelcontextprotocol/sdk`.

- `codebase-index-mcp/` — Code graph indexing and analysis server. Most development work happens here.
- `postgres-mcp/` — PostgreSQL MCP server. Read-only by default (SQL guardrails); optional multi-environment access, reviewed/confirmed data writes, and EF Core migration tooling, each gated behind explicit env flags.
- `sqlserver-mcp/` — Microsoft SQL Server MCP server. Read-only by default (T-SQL guardrails). **The unit of work is a catalog, not the server**: one SQL Server login reaches every database on the instance, so every data tool takes an optional `database`, pools are keyed `(environment, catalog)` with an LRU cap, and `run_read_query` takes `databases[]` to fan one statement across catalogs. Three-part names (`OtherDb.dbo.Thing`) are permitted — they are how SQL Server joins catalogs; four-part names are refused. T-SQL has no `LIMIT` (rows are bounded by cancelling the stream, the statement is never rewritten) and no read-only transaction, so the deployment control is a read-only SQL login (db_datareader) plus `SQLSERVER_ALLOWED_DATABASES`. `find_cross_database_references` maps the dependency graph *between* catalogs. Stored-procedure execution is OFF unless `SQLSERVER_EXEC_ENABLED=true` and is annotated destructive for every routine — the catalog records nothing about whether a procedure writes. See `docs/decisions/0004-tsql-guardrail-policy.md`.
- `observe-mcp/` — OpenObserve log/trace MCP server for the CommunicationHub / CRM backend. Read-only; queries the self-hosted OpenObserve `_search` API to search logs, trace a request end-to-end by trace id, and discover what is in the index (`search_logs`, `trace_logs`, `get_trace_spans`, `log_stats`, `discover_services`, `list_environments`, ...). **Multi-environment in one process**: environments come from the flat `OBSERVE_BASE_URL`/`ORG`/`LOG_STREAM` trio plus the `OBSERVE_ENV_<NAME>` family, and every tool takes an optional `environment`. A dated 7-day service inventory is committed at `observe-mcp/docs/service-catalog.json` (`npm run catalog:refresh`, live credentials, never CI; `catalog:check` validates it offline, `catalog:verify` re-tests its assertions live). **Service identity is resolved, not raw**: these apps emit logs down two OTLP paths, and rows from the Serilog sink arrive as `unknown_service:dotnet` with the real name in `applicationname`, so every logs tool matches `COALESCE(NULLIF(service_name, sentinel), applicationname, service_name)` and echoes an `identity` block. Traces are always raw — that stream has no such column. Credentials via env only. Registered as `observe-mcp` in `~/.claude.json`.
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

# Test layers
npm run test              # everything: unit + integration, one result
npm run test:unit         # node:test over src/**/*.test.ts — no build, no DB
npm run test:integration  # the .mjs harnesses only (needs a build)

# Individual harnesses — each keeps its own name (32 of them)
npm run test:endpoint-bridge
npm run test:csharp-inheritance-bridge
npm run test:refactor-engine
```

**Pre-commit sequence:** run the workspace gate from the repo root instead — see
*Verification* below. Within this package, `npm run test` runs the whole suite
(it discovers every `test:*` script from `package.json`, so the list cannot fall
behind) and puts `test:unit` first, since a compile-level break should not wait
behind the 32 integration harnesses.

`typecheck` covers `src/**/*.test.ts` too, via each server's own
`tsconfig.test.json`. Before S-39 no server's test files were type-checked
anywhere: each server's build excludes them, and the root `tsconfig.test.json`
covers `packages/` only.

### postgres-mcp

```bash
cd postgres-mcp
npm run build
npm run typecheck
npm run dev
```

### Verification (run from the workspace root)

All five servers answer to the same four scripts — `build`, `typecheck`, `test`, `smoke` — so the
root aggregates work uniformly. They are driven by `@mcp/manifest`, so a newly
registered server is covered automatically.

```bash
npm run verify:all     # the gate: packages + servers + tool contracts + generated docs. Credential-free.
npm run verify:live    # the live smoke tests. NEEDS REAL CREDENTIALS.
```

`verify:all` is the pre-commit gate and is deliberately credential-free, so it means the same thing
on a fresh clone as in CI. `contracts:check` inside it boots all five servers over a real stdio
handshake with placeholder env — that is the credential-free boot check, and it is what catches a
module that compiles but cannot load.

CI (`.github/workflows/ci.yml`, Windows + Node 22) runs the same steps **plus** `install:servers`
and `benchmark:plan:check`, and **minus** `test:scripts`. Since 2026-08-03 it also runs
`generate:check` and `docs:check`, so generated-file and documentation drift are caught on every
push rather than only locally.

The live smoke tests reach real Postgres / SQL Server / OpenObserve / Bitbucket and are **not** in CI. Run
`verify:live` before a release. See `docs/development/ci.md`.

Narrower targets: `verify:packages`, `verify:servers`, `test:servers`, `contracts:check`,
`generate:check`, `docs:check`, and `node scripts/run-servers.mjs <script> [--server <key>]`.

### Generated files — do not hand-edit (S-35, S-36)

Each server's `.env.example`, the `<!-- BEGIN/END GENERATED -->` blocks in its `README.md`, and
its `tools` list are **rendered from `@mcp/manifest`**. `observe-mcp/docs/service-catalog.json` is
also generated, but by `npm run catalog:refresh` against live OpenObserve — its `code` blocks are
hand-written and preserved across refreshes, so it is not part of `generate:all`. Edit the manifest,
then regenerate:

```bash
npm run generate:all     # tools (from contracts/) -> env -> README blocks
npm run generate:check   # fails on drift; runs inside verify:all
```

`mcp:doctor` reports a stale generated file per server as a warning. Env vars are declared once,
in `packages/manifest/src/envSpecs/<server>.ts` — **124** across the five servers (41/23/18/31/11).

## Architecture (codebase-index-mcp)

**Standard structure (all five servers):** `src/{tools,resources,prompts,middleware,services,repositories,config,types}/`
plus `src/index.ts`. A slot exists only where the server has that concern — see
`docs/archive/refactor/standard-structure-report.md` for the per-server map and which slots are N/A.

**Indexing data flow:**
```
services/indexing/fileFilter.ts       # binary sniff + extension → language tag
services/indexing/indexPipeline.ts    # glob, hash, batch dispatch
  ├─ services/extractors/treeSitterExtractor.ts / extractionWorkerPool.ts   # AST → symbols + edges
  ├─ services/extractors/dotnetProjectParser.ts   # .csproj/.sln → NuGet + ProjectReference edges
  └─ services/extractors/markdownParser.ts        # headings + code blocks
repositories/graphStore.ts            # SQLite upsert (WAL mode, batched writes)
src/index.ts                          # MCP tool dispatch
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

**postgres-mcp default-safe:** Read path permits only `SELECT` and `WITH ... SELECT`. A connection source is required (`POSTGRES_CONNECTION`, or `POSTGRES_ENV_*`, or `POSTGRES_APPSETTINGS_ROOTS`). Data writes are OFF unless `POSTGRES_WRITE_ENABLED=true` (preview→apply→rollback, HMAC-approved, mandatory WHERE); migrations OFF unless `POSTGRES_MIGRATION_ENABLED=true`. The approval token is signed/verified in-process, so `POSTGRES_WRITE_APPROVAL_SECRET` is auto-generated per process when unset (set it only to keep tokens valid across restarts). **`prod` is force read-only** regardless of config. No secrets in code. S-43 renamed all 21 vars to `POSTGRES_*`; every pre-rename name (`CH_*`, `PG_*`, `MCP_DB_*`) is still honoured with a one-time deprecation warning.

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

Adding a new MCP server: run `npm run new:server -- --key <name>` (scaffolds from
`templates/server/`, then builds/tests/smokes it), then append it to
`packages/manifest/src/servers.ts` and add its env contract to
`packages/manifest/src/envSpecs/<name>.ts` — the installer, doctor, and skill generator pick it up automatically. See
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

When analyzing this codebase, use the `codebase-index` MCP tools **before** falling back to grep/read:

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

- `.claude/rules/` — always-on policy docs:
  `mcp-hard-mode` (MCP-first enforcement), `mcp-base`, `typescript-mcp`, `db-guardrails`, `codebase-index`.
- `.claude/skills/` — MCP **authoring** skills (security-review, tool-annotations, error-taxonomy,
  contract-conformance, observability, host-integration-security, db-parameterization-audit,
  db-query-budgeting) plus `mcp-skill-authoring`. Each ends with an *Authoritative reference* section
  naming the maintained doc that governs it. Operational "how to use server X" skills are generated
  per server (gitignored). `mcp-scaffold` and `mcp-release-checklist` were archived 2026-08-03 —
  superseded by `docs/servers/server-development.md` §1–2 and `docs/development/workflow.md` §4.
- `codebase-index-mcp/.claude/skills/` — indexing-internals skills (tree-sitter,
  incremental-indexing, conformance, metadata-governance, unresolved-symbol-policy, etc.).
  `graph-schema-design` was archived 2026-08-03; its guardrails are in
  `codebase-index-mcp/CLAUDE.md` §"Graph model".
- `.claude/commands/mcp-effectiveness-eval.md` — slash command benchmarking baseline vs MCP.

## References

**The doc index is `docs/README.md`.** The guides most likely to answer a question about this
workspace:

| | |
|---|---|
| `docs/architecture/as-built.md` | what this is, as built |
| `docs/development/workflow.md` | the loop, the test layers, the gate, and what CI does *not* cover |
| `docs/servers/server-development.md` · `docs/servers/tool-development.md` | adding or changing a server / a tool |
| `docs/reference/folder-convention.md` · `docs/reference/dependency-rules.md` | where a file goes; what may import what |
| `docs/reference/packages.md` | what each of the six packages is for |
| `docs/reference/conventions.md` | every rule, sorted by what enforces it |
| `CONTRIBUTING.md` | commits, review, and what a change has to carry with it |
| `docs/decisions/README.md` · `docs/archive/migration/README.md` | the decisions, and the migration record |

**What is left:** `docs/development/backlog.md` — the post-migration backlog (B-01…B-12), prioritized by whether
a tool reports something untrue, a gate does not bite, or it is only a cost. Also lists the accepted
debt that is **not** in it, so decided questions stay decided.

**Decision records:** `docs/decisions/0001-workspace-native-deps.md` (why servers stay outside
the npm workspace, and why `instanceof` fails across packages) ·
`docs/decisions/0002-sql-guardrail-token-lists.md` (why the four SQL token lists stay
different, and the two-part rule for adding one) ·
`docs/decisions/0003-single-root-gitignore.md` (one root `.gitignore`; no per-server copies) ·
`docs/decisions/0004-tsql-guardrail-policy.md` (the T-SQL token list, the bracket-identifier scanner
switch, and why four-part names are refused while three-part names are not).

**Current-state reference:**

- `docs/architecture/target-architecture.md` — the tier model, dependency rules, and the naming / coding / server / package conventions. §9 reconciles design against what is actually built
- `docs/development/ci.md` — what CI covers, what it deliberately does not (no live backends, no secrets), and the script vocabulary that makes the root aggregates work
- `contracts/README.md` — what the golden `tools/list` snapshots are and how to update them

**History — `docs/archive/`.** The 44-step migration (43 done, S-42 skipped, closed 2026-07-29), the
two post-migration refactor reports, the pre-restructuring audit at `01c532e`, and four superseded
documents. **Nothing there is maintained; do not read a current state out of it.**
`docs/archive/README.md` is the cover note — it says what closed, and which maintained document
replaced each piece. Start there rather than with a specific file.

Two things from it worth knowing without opening it:

- `docs/archive/migration/status.md` is where the **step-number reconciliation** lives: three commits
  carry S-numbers that differ from the plan's.
- `docs/archive/migration/migration-plan.md` is **frozen** — never read a status out of it.

**Per-server:**

- `codebase-index-mcp/CLAUDE.md` — full sub-project guide (key files, env vars, refactor engine details)
- `AGENTS.md` — env var reference, common pitfalls, integration config examples
- `codebase-index-mcp/README.md` — complete MCP tool catalog with usage examples

> **Build order:** servers consume `packages/*/dist` through `file:` dependencies, so on a fresh
> clone run `npm run build:packages` **before** building any server.
