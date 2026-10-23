# CLAUDE.md

Guidance for Claude Code when working in this repository.

## Workspace Overview

Six independent MCP servers — **not** a monorepo with shared packages. Each has its own
`package.json`, `tsconfig.json` and `dist/`; all are TypeScript 5.7+ ESM on `@modelcontextprotocol/sdk`.
Every server is read-only by default; each write path is behind its own env flag.

| Server | What it is | The non-obvious part |
|---|---|---|
| `codebase-index-mcp/` | Code graph indexing and analysis. Most work happens here | No runtime LLM, by hard policy — see *Critical Constraints* |
| `postgres-mcp/` | PostgreSQL. `SELECT` / `WITH … SELECT` only | `prod` is force read-only regardless of config |
| `sqlserver-mcp/` | Microsoft SQL Server, T-SQL guardrails; gated write lane | **The unit of work is a catalog, not the server** |
| `observe-mcp/` | OpenObserve logs/traces for CommunicationHub / CRM | **Service identity is resolved, not raw** |
| `bitbucket-mcp/` | Repos, commits, source, PRs and **pipelines**; gated PR create/comment/merge, server-side commits, scratch branches | No server-side branch protection, so merge-commit-only and never-force live in the tools. Pipelines are read-only. Bitbucket's `x..y` is head-first: build it only via `buildCompareSpec` |
| `board-mcp/` | Thin wrapper over wec.aria's pipeline board CLI (`checks/board/board.mjs`); writes gated by `BOARD_WRITE_ENABLED` | **Not a second board**: execFile with an args array, no rule re-implemented. Gate words go in as `--gate` with the caller's session UUID as `--as` — proof the owner typed them in that session, not that the caller is that session |

Details that cost time if you learn them the hard way:

- **sqlserver-mcp.** One SQL login reaches every database, so every data tool takes an optional
  `database`, pools are keyed `(environment, catalog)` with an LRU cap, and `run_read_query` takes
  `databases[]` to fan one statement across catalogs. Three-part names are permitted, four-part refused.
  T-SQL has no `LIMIT` (the stream is cancelled; the statement is never rewritten) and no read-only
  transaction, so the deployment control is a `db_datareader` login plus `SQLSERVER_ALLOWED_DATABASES`.
  Procedure execution is off unless `SQLSERVER_EXEC_ENABLED=true` and is annotated destructive for
  **every** routine (`docs/decisions/0004-tsql-guardrail-policy.md`). Data writes (`write_preview` →
  `write_apply`) are off unless `SQLSERVER_WRITE_ENABLED=true` and the environment is in
  `SQLSERVER_WRITABLE_ENVIRONMENTS` (never prod/uat); transactions do not nest, so read
  `docs/decisions/0006-tsql-write-lane.md` before touching it.
- **observe-mcp.** Serilog-sink rows arrive as `unknown_service:dotnet` with the real name in
  `applicationname`, so every logs tool matches
  `COALESCE(NULLIF(service_name, sentinel), applicationname, service_name)` and echoes an `identity`
  block. Traces are always raw. A dated service inventory is committed at
  `observe-mcp/docs/service-catalog.json` (`catalog:refresh` needs live credentials; `catalog:check`
  validates offline).
- **Multi-environment** (postgres / sqlserver / observe): a flat env trio plus an `*_ENV_<NAME>`
  family, and every tool takes an optional `environment` — e.g. `OBSERVE_BASE_URL` / `OBSERVE_ORG` /
  `OBSERVE_LOG_STREAM` plus `OBSERVE_ENV_<NAME>`.
- **bitbucket-mcp** auth is env-only: `BITBUCKET_ACCESS_TOKEN` (Bearer) **or**
  `BITBUCKET_EMAIL`+`BITBUCKET_API_TOKEN` (Basic). Writes are off unless `BITBUCKET_WRITE_ENABLED=true`;
  `get_pipeline_step_log` returns a bounded **tail** (default 256 KiB, max 1 MiB) via HTTP `Range`.

## Commands

```bash
# per server — all six answer to the same four scripts (plus start, dev)
cd <server> && npm run build | typecheck | test | smoke

# codebase-index-mcp extras
npm run guard:no-llm-runtime   # no LLM client imports in src/
npm run benchmark:plan:check   # compact-mode token savings >= 40%
npm run test:unit              # node:test over src/**/*.test.ts — no build, no DB
npm run test:integration       # the .mjs harnesses only (needs a build)
npm run test:<name>            # one harness
```

`npm run test` discovers every `test:*` script from `package.json` and runs `test:unit` first.
`typecheck` covers `src/**/*.test.ts` via each server's `tsconfig.test.json`. The smoke test runs
`dist/index.js`, so it needs a build.

### Verification (workspace root)

```bash
npm run verify:all     # the full gate: packages + servers + contracts + generated docs
npm run verify:live    # live smoke tests. NEEDS REAL CREDENTIALS; not in CI — run before a release
```

**`verify:all` takes ~10 minutes** (codebase-index alone runs ~58 sequential harnesses). **Do not
run it for a change confined to one server** — only when the change reaches other servers (shared
`packages/*`, `scripts/*`, root config, or several servers). When it is warranted, run it once,
piped to a file (`npm run verify:all > <scratch>/verify.log 2>&1`), and read
that file for follow-ups — never re-run it to grep output. It is `&&`-chained, so a pass from the last
step (`docs:check`) proves every earlier one. If it fails but the narrow target passes, read the
durations already printed before re-running: a slow harness under load is a timeout, not a defect.

Per change, run only the narrow targets that cover it: `test:unit`, the touched `test:*` harnesses,
`contracts:check` (a tool schema or description changed), `generate:check`, `docs:check`, or
`node scripts/run-servers.mjs <script> [--server <key>]`. Wider: `verify:packages`, `verify:servers`,
`test:servers`.

`verify:all` is **credential-free**; `contracts:check` boots all six servers over a real stdio
handshake with placeholder env, which catches a module that compiles but cannot load. CI
(`.github/workflows/ci.yml`, Windows + Node 22) adds `install:servers` and `benchmark:plan:check` and
drops `test:scripts` — `docs/development/ci.md`.

**In a git worktree**, junction every server's `node_modules` (and the root's) to the main tree's up
front, or the run is wasted; remove the junctions with `cmd /c rmdir` **before** `git worktree remove`.
`test:scripts`' skills test only counts when run from the main tree.

### Generated files — do not hand-edit (S-35, S-36)

Each server's `.env.example`, the `<!-- BEGIN/END GENERATED -->` blocks in its `README.md`, and its
`tools` list are **rendered from `@mcp/manifest`**: edit the manifest, then `npm run generate:all`
(`generate:check` fails on drift). Env vars are declared once, in
`packages/manifest/src/envSpecs/<server>.ts` — **158** across the six servers (48/35/25/31/16/3).
`observe-mcp/docs/service-catalog.json` is generated by `catalog:refresh` against live OpenObserve and
is **not** part of `generate:all`.

## Architecture

All six servers use `src/{tools,resources,prompts,middleware,services,repositories,config,types}/`
plus `src/index.ts`; a slot exists only where the server has that concern.

For `codebase-index-mcp` — graph model, refactor engine, extractor naming and gotchas — read
**`codebase-index-mcp/CLAUDE.md`**. The symbol-kind and edge-type unions live only in
`codebase-index-mcp/src/types/index.ts`; do not copy them here.

**Response profiles:** `nano | compact | standard | verbose`; `compact` is the default for read tools,
only `verbose` is pretty-printed, and all response paths use forward slashes.

## Critical Constraints

**No-LLM policy (codebase-index-mcp, hard).** `npm run guard:no-llm-runtime` statically verifies no
LLM client imports in `src/`; `CODEBASE_INDEX_LLM_ENABLED=true` fails start-up. Never relax this. The
guard matches by substring over the whole import specifier, comments included — a local path
containing `llm` or ending `/inference` fails it.

**Path allowlist (codebase-index-mcp).** `CODEBASE_INDEX_ALLOWED_ROOTS` (comma-separated absolute
paths) is the only required env var. Use the exact `repoPath` from `list_repositories` — changed
drive-letter casing or slash style is rejected.

**postgres-mcp default-safe.** A connection source is required (`POSTGRES_CONNECTION`,
`POSTGRES_ENV_*` or `POSTGRES_APPSETTINGS_ROOTS`). Writes need `POSTGRES_WRITE_ENABLED=true`
(preview→apply→rollback, HMAC-approved, mandatory WHERE); EF Core migrations need
`POSTGRES_MIGRATION_ENABLED=true`; raw-SQL DDL (`ddl_*`) needs `POSTGRES_DDL_ENABLED=true` and has its
own tokenizer, not `scanSql` (`docs/decisions/0005-ddl-migration-lane.md`). `mcp_ops` (ledger
`mcp_ops.ddl_history`) belongs to the server: no tool writes to it, and it is not in schema snapshots.
`POSTGRES_APPROVAL_SECRET` is auto-generated per process; set it only to keep tokens valid across
restarts. Legacy names (`CH_*`, `PG_*`, `MCP_DB_*`) still work with a deprecation warning — write the
canonical ones.

**better-sqlite3 on Windows** needs Visual Studio C++ Build Tools; there is no fallback and no driver
abstraction (MCP-ISSUE-061(j)).

## Installation, Skills & Doctor

Run from the **workspace root**; the installer is data-driven from `packages/manifest/src/servers.ts`.

```bash
npm run setup                              # install/build/configure + skills, ALL servers
node scripts/install-mcp.mjs --server postgres-mcp
npm run mcp:doctor                         # health report — never prints secrets
npm run mcp:uninstall -- --server <key>    # remove config + skill (config backed up)
npm run mcp:update -- --all
```

Each server's native skill is rendered from its committed `<server>/skill/SKILL.md` template.
Placement is chosen at install: `--scope user|local|project` (`~/.claude.json`, its per-repo
`projects[...]`, or `<repo>/.mcp.json`) and `--skill none|project|user`, with `--repo <path>`. A
`repoBound` server (board-mcp) defaults to local + project, the rest to user + user. Re-runs,
`mcp:update` and `mcp:doctor` **keep the placement they find**.

Adding a server: `npm run new:server -- --key <name>`, then append it to
`packages/manifest/src/servers.ts` and add `packages/manifest/src/envSpecs/<name>.ts` — see the
`mcp-skill-authoring` skill.

> **Build order:** servers consume `packages/*/dist` through `file:` dependencies, and every
> `scripts/` entry point needs it too — on a fresh clone run `npm run build:packages` first (`setup`
> does it for you). `scripts/lib/manifest.mjs` is a re-export shim (S-34); edit the package.

**Local dev cycle:** `cd codebase-index-mcp && npm run build`, then restart the server with `/mcp`;
tool calls hit the new build directly. Served over HTTP (`scripts/serve-http.mjs`, one process for every
session), `/mcp` only reconnects: restart the served process to load the build — `docs/development/workflow.md` §9.

## Rules & Skills (`.claude/`)

- **`.claude/rules/` is policy.** `mcp-hard-mode` (the single source of truth for MCP-first rules:
  tool selection, gates, fallback, call budget, issue logging — do not restate it) and `mcp-base` are
  always loaded; `typescript-mcp`, `db-guardrails` and `codebase-index` load by `paths` frontmatter.
- `.claude/skills/` — MCP **authoring** skills (security-review, tool-annotations, error-taxonomy,
  contract-conformance, observability, host-integration-security, db-tool-review,
  `mcp-skill-authoring`). Per-server operational skills are generated and gitignored.
- `codebase-index-mcp/.claude/skills/` — indexing internals (tree-sitter, incremental-indexing with
  its full-vs-incremental conformance procedure, run-bookkeeping, …).
- `.claude/commands/mcp-effectiveness-eval.md` — benchmarks baseline vs MCP.

## References

**The doc index is `docs/README.md`** — go there first. Worth knowing without opening it:

| | |
|---|---|
| `docs/architecture/as-built.md` | what this is, as built |
| `docs/development/workflow.md` | the loop, the test layers, the gate, what CI does *not* cover |
| `docs/reference/conventions.md` | every rule, sorted by what enforces it |
| `docs/development/backlog.md` | what is left, **and** the accepted debt deliberately not in it |
| `docs/decisions/` | ADRs 0001–0006 (native deps, SQL token lists, single-root gitignore, T-SQL guardrails, DDL lane, T-SQL write lane) |
| `codebase-index-mcp/docs/mcp-codebase-index-issue-registry.md` | measured defects, fixes, before/after evidence |

`docs/archive/` is history and not maintained — never read current state from it; `docs/archive/README.md`
says which maintained document replaced each piece.
