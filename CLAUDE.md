# CLAUDE.md

Guidance for Claude Code when working in this repository.

## Workspace Overview

Five independent MCP servers — **not** a monorepo with shared packages. Each has its own
`package.json`, `tsconfig.json` and `dist/`. All are TypeScript 5.7+ ESM (`"type": "module"`) on
`@modelcontextprotocol/sdk`. Every server is read-only by default; each write path is behind its own
env flag.

| Server | What it is | The non-obvious part |
|---|---|---|
| `codebase-index-mcp/` | Code graph indexing and analysis. Most work happens here | No runtime LLM, by hard policy — see *Critical Constraints* |
| `postgres-mcp/` | PostgreSQL. `SELECT` / `WITH … SELECT` only | `prod` is force read-only regardless of config |
| `sqlserver-mcp/` | Microsoft SQL Server, T-SQL guardrails | **The unit of work is a catalog, not the server** |
| `observe-mcp/` | OpenObserve logs/traces for CommunicationHub / CRM | **Service identity is resolved, not raw** |
| `bitbucket-mcp/` | Repos, PRs and **pipelines**; creates PRs | The four pipeline tools are read-only — no trigger/stop |

Four details that cost time if you learn them the hard way:

- **sqlserver-mcp.** One SQL login reaches every database on the instance, so every data tool takes an
  optional `database`, pools are keyed `(environment, catalog)` with an LRU cap, and `run_read_query`
  takes `databases[]` to fan one statement across catalogs. Three-part names (`OtherDb.dbo.Thing`) are
  permitted — that is how SQL Server joins catalogs; four-part names are refused. T-SQL has no `LIMIT`
  (rows are bounded by cancelling the stream; the statement is never rewritten) and no read-only
  transaction, so the deployment control is a `db_datareader` login plus `SQLSERVER_ALLOWED_DATABASES`.
  Stored-procedure execution is off unless `SQLSERVER_EXEC_ENABLED=true` and is annotated destructive
  for **every** routine, because the catalog records nothing about whether a procedure writes.
  `docs/decisions/0004-tsql-guardrail-policy.md`.
- **observe-mcp.** These apps emit down two OTLP paths, and rows from the Serilog sink arrive as
  `unknown_service:dotnet` with the real name in `applicationname` — so every logs tool matches
  `COALESCE(NULLIF(service_name, sentinel), applicationname, service_name)` and echoes an `identity`
  block. Traces are always raw; that stream has no such column. A dated 7-day service inventory is
  committed at `observe-mcp/docs/service-catalog.json` (`catalog:refresh` needs live credentials and
  never runs in CI; `catalog:check` validates it offline).
- **Multi-environment** in one process, for postgres / sqlserver / observe: a flat env trio plus an
  `*_ENV_<NAME>` family, and every tool takes an optional `environment`. For observe that is
  `OBSERVE_BASE_URL` / `OBSERVE_ORG` / `OBSERVE_LOG_STREAM` plus `OBSERVE_ENV_<NAME>`.
- **bitbucket-mcp** auth is env-only: `BITBUCKET_ACCESS_TOKEN` (Bearer) **or**
  `BITBUCKET_EMAIL`+`BITBUCKET_API_TOKEN` (Basic). PR creation is off unless
  `BITBUCKET_WRITE_ENABLED=true`; `create_pull_request` supports `dryRun`.
  `get_pipeline_step_log` returns a bounded **tail** (default 256 KiB, max 1 MiB) via HTTP `Range`.

## Commands

```bash
# per server — all five answer to the same four scripts
cd <server> && npm run build | typecheck | test | smoke     # plus start, dev

# codebase-index-mcp extras
npm run guard:no-llm-runtime   # policy guard: no LLM client imports in src/
npm run benchmark:plan:check   # quality gate: compact-mode token savings >= 40%
npm run test:unit              # node:test over src/**/*.test.ts — no build, no DB
npm run test:integration       # the .mjs harnesses only (needs a build)
npm run test:<name>            # one harness; ~40 of them, each keeps its own name
```

`npm run test` discovers every `test:*` script from `package.json`, so the list cannot fall behind,
and runs `test:unit` first — a compile-level break should not wait behind the integration harnesses.
`typecheck` covers `src/**/*.test.ts` via each server's own `tsconfig.test.json`.

### Verification (run from the workspace root)

```bash
npm run verify:all     # the pre-commit gate: packages + servers + contracts + generated docs
npm run verify:live    # the live smoke tests. NEEDS REAL CREDENTIALS.
```

`verify:all` is deliberately **credential-free**, so it means the same thing on a fresh clone as in
CI. `contracts:check` inside it boots all five servers over a real stdio handshake with placeholder
env — that is what catches a module that compiles but cannot load.

CI (`.github/workflows/ci.yml`, Windows + Node 22) runs the same steps **plus** `install:servers` and
`benchmark:plan:check`, **minus** `test:scripts`, and also `generate:check` + `docs:check`. The live
smoke tests reach real backends and are **not** in CI; run `verify:live` before a release.
`docs/development/ci.md`.

Narrower targets — prefer these over re-running the aggregate: `verify:packages`, `verify:servers`,
`test:servers`, `contracts:check`, `generate:check`, `docs:check`, and
`node scripts/run-servers.mjs <script> [--server <key>]`.

### Generated files — do not hand-edit (S-35, S-36)

Each server's `.env.example`, the `<!-- BEGIN/END GENERATED -->` blocks in its `README.md`, and its
`tools` list are **rendered from `@mcp/manifest`**. Edit the manifest, then `npm run generate:all`
(`generate:check` fails on drift and runs inside `verify:all`). Env vars are declared once, in
`packages/manifest/src/envSpecs/<server>.ts` — **125** across the five servers (41/23/19/31/11).

`observe-mcp/docs/service-catalog.json` is also generated, but by `catalog:refresh` against live
OpenObserve; its `code` blocks are hand-written and preserved, so it is **not** part of
`generate:all`. `mcp:doctor` reports a stale generated file as a warning.

## Architecture

**Standard structure (all five servers):**
`src/{tools,resources,prompts,middleware,services,repositories,config,types}/` plus `src/index.ts`.
A slot exists only where the server has that concern.

For `codebase-index-mcp` — data flow, the graph model, the refactor engine, the extractor naming
rules and the per-file guidance — read **`codebase-index-mcp/CLAUDE.md`**. Do not keep a second copy
of the graph model here: the symbol-kind and edge-type unions live in
`codebase-index-mcp/src/types/index.ts` and are the only authority.

```bash
grep -nE '^  (kind|type):' codebase-index-mcp/src/types/index.ts
```

**Response profiles:** `nano | compact | standard | verbose`; `compact` is the default for all read
tools. Only `verbose` is pretty-printed. All response paths are normalized to forward slashes.

## Critical Constraints

**No-LLM policy (codebase-index-mcp, hard).** Runtime LLM invocation is prohibited by design.
`npm run guard:no-llm-runtime` statically verifies no LLM client imports exist in `src/`;
`CODEBASE_INDEX_LLM_ENABLED=true` fails start-up. This must not be relaxed. The guard matches by
substring over the whole import specifier, comments included — a local path containing `llm` or
ending `/inference` fails it.

**Path allowlist (codebase-index-mcp).** `CODEBASE_INDEX_ALLOWED_ROOTS` (comma-separated absolute
paths) is the only required env var. Always use the exact `repoPath` from `list_repositories` — do not
change drive-letter casing or slash style, or the allowlist rejects it.

**postgres-mcp default-safe.** A connection source is required (`POSTGRES_CONNECTION`, or
`POSTGRES_ENV_*`, or `POSTGRES_APPSETTINGS_ROOTS`). Writes off unless `POSTGRES_WRITE_ENABLED=true`
(preview→apply→rollback, HMAC-approved, mandatory WHERE); migrations off unless
`POSTGRES_MIGRATION_ENABLED=true`. `POSTGRES_WRITE_APPROVAL_SECRET` is auto-generated per process when
unset — set it only to keep tokens valid across restarts. **`prod` is force read-only.** S-43 renamed
all 21 vars to `POSTGRES_*`; every pre-rename name (`CH_*`, `PG_*`, `MCP_DB_*`) still works with a
one-time deprecation warning.

**Smoke test requires build.** `node scripts/smoke-test.mjs` runs `dist/index.js`, not source.

**better-sqlite3 on Windows.** Requires Visual Studio C++ Build Tools. If the native build fails,
install them — there is no fallback. Every SQLite call site imports `better-sqlite3` directly; there
is no driver abstraction and no JS-only backend (MCP-ISSUE-061(j)).

## Installation, Skills & Doctor

Managed from the **workspace root** by a data-driven installer (source of truth:
`packages/manifest/src/servers.ts`).

```bash
npm run setup                              # install/build/configure + skills, ALL servers
node scripts/install-mcp.mjs --server postgres-mcp
npm run mcp:doctor                         # health report — never prints secrets
npm run mcp:uninstall -- --server <key>    # remove config + skill (config backed up)
npm run mcp:update -- --all
```

Each server gets a **native Claude Code skill** rendered from its `<server>/skill/SKILL.md` template
into `~/.claude/skills/<key>/` and `.claude/skills/<key>/`. Those generated dirs are gitignored; the
template is the committed source. Registration writes to `~/.claude.json`.

Adding a server: `npm run new:server -- --key <name>` (scaffolds from `templates/server/`, then
builds/tests/smokes it), then append it to `packages/manifest/src/servers.ts` and add its env contract
to `packages/manifest/src/envSpecs/<name>.ts` — installer, doctor and skill generator pick it up
automatically. See the `mcp-skill-authoring` skill.

> Packages compile to gitignored `dist/`, so every `scripts/` entry point needs
> `npm run build:packages` once on a fresh clone — `setup` and `mcp:install` do it for you.
> `scripts/lib/manifest.mjs` is a re-export shim (S-34) scheduled for deletion; edit the package.

## Local Dev MCP Test Cycle

```bash
cd codebase-index-mcp && npm run build
# then restart the MCP server in Claude Code (/mcp or the IDE MCP panel)
```

MCP tool calls then hit the updated build, so you can test directly without the smoke test. Run
`verify:all` once before committing.

## Rules & Skills (`.claude/`)

- **`.claude/rules/` is always-on policy and is already in your context.** `mcp-hard-mode` is the
  single source of truth for MCP-first operating rules — tool selection, enforcement gates, fallback
  conditions, the call budget, and mandatory issue logging. Do not restate it here or elsewhere.
  Alongside it: `mcp-base`, `typescript-mcp`, `db-guardrails`, `codebase-index`.
- `.claude/skills/` — MCP **authoring** skills (security-review, tool-annotations, error-taxonomy,
  contract-conformance, observability, host-integration-security, db-parameterization-audit,
  db-query-budgeting) plus `mcp-skill-authoring`. Each ends with an *Authoritative reference* naming
  the maintained doc that governs it. Operational "how to use server X" skills are generated per
  server and gitignored.
- `codebase-index-mcp/.claude/skills/` — indexing internals (tree-sitter, incremental-indexing,
  conformance, metadata-governance, unresolved-symbol-policy, …).
- `.claude/commands/mcp-effectiveness-eval.md` — slash command benchmarking baseline vs MCP.

## References

**The doc index is `docs/README.md`** — go there first. The entries worth knowing without opening it:

| | |
|---|---|
| `docs/architecture/as-built.md` | what this is, as built |
| `docs/development/workflow.md` | the loop, the test layers, the gate, what CI does *not* cover |
| `docs/reference/conventions.md` | every rule, sorted by what enforces it |
| `docs/development/backlog.md` | what is left (B-01…B-14), **and** the accepted debt that is deliberately not in it |
| `docs/decisions/` | four ADRs: native deps (0001), SQL token lists (0002), single-root gitignore (0003), T-SQL guardrails (0004) |
| `codebase-index-mcp/docs/mcp-codebase-index-issue-registry.md` | measured defects, their fixes, and the before/after evidence |

**History lives in `docs/archive/` and nothing there is maintained — do not read a current state out
of it.** Start at `docs/archive/README.md`, which says what closed and which maintained document
replaced each piece. `docs/archive/migration/migration-plan.md` is frozen; the step-number
reconciliation is in `docs/archive/migration/status.md`.

> **Build order:** servers consume `packages/*/dist` through `file:` dependencies, so on a fresh clone
> run `npm run build:packages` **before** building any server.
