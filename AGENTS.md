# AGENTS.md

Agent guidance for the `mcp-local` workspace: four MCP servers over a six-package platform.

New here? `docs/onboarding.md` (install), `docs/architecture.md` (what this is),
`docs/conventions.md` (the rules, and which ones are enforced).

## Workspace Structure

Four independent MCP servers:
- `codebase-index-mcp/` - TypeScript/Node.js codebase indexing and graph analysis server (43 tools)
- `postgres-mcp/` - Read-only PostgreSQL query server with SQL guardrails (17 tools)
- `observe-mcp/` - Read-only OpenObserve log/trace query server for the CommunicationHub backend (8 tools)
- `bitbucket-mcp/` - Bitbucket Cloud server: read repositories/PRs and create pull requests (write-gated, 8 tools)

Plus `packages/` — the shared platform the servers are built on: `@mcp/core` (tier 0,
zero-dependency), `@mcp/sdk` (tier 1, the only importer of `@modelcontextprotocol/sdk`),
`@mcp/shared`, `@mcp/testing`, `@mcp/cli` (the guards), `@mcp/manifest` (workspace tooling data).

**The servers are not npm workspace members** — `workspaces` is `["packages/*"]` only, so each
server has its own `node_modules`, and a fresh clone must run `npm run build:packages` before any
server builds. This is deliberate: see `docs/adr/0001-workspace-native-deps.md`.

All use `type: "module"` (ES modules), TypeScript 5.7+, and `@modelcontextprotocol/sdk` (via
`@mcp/sdk`).

## Essential Commands

### Workspace root — install & manage all servers

```bash
npm run setup                              # build + configure + install skills for ALL servers
node scripts/install-mcp.mjs --server <key> [--yes] [--skip-smoke]   # one server
npm run mcp:doctor                         # health report per server (never prints secrets)
npm run mcp:uninstall -- --server <key>    # remove config + skill (config backed up)
npm run mcp:update -- --all                # rebuild + regenerate skills + verify
```

Server keys: `codebase-index`, `postgres-mcp`, `observe-mcp`, `bitbucket-mcp`.
Source of truth for every server (entry path, env schema, tools, skill source) is
`packages/manifest` (`@mcp/manifest`). The installer writes MCP config into each detected agent
(`~/.claude.json` for Claude Code) and renders a native skill per server.

### codebase-index-mcp

```bash
cd codebase-index-mcp
npm install
npm run typecheck          # Type check only, no build
npm run build              # Compile to dist/
npm run guard:no-llm-runtime  # Verify no LLM imports (policy enforcement)
npm run dev                # Run with tsx (no build needed)
npm run benchmark:plan     # Run token efficiency benchmark
npm run benchmark:plan:check  # Quality gate (fails if compact savings < 40%)
node scripts/smoke-test.mjs   # Full integration test (requires build first)
```

Test scripts (all require build first):
```bash
npm run test:endpoint-bridge
npm run test:csharp-inheritance-bridge
npm run test:refactor-engine
```

### postgres-mcp

```bash
cd postgres-mcp
npm install
npm run typecheck
npm run build
npm run dev
```

## Critical Constraints

### codebase-index-mcp

**No-LLM policy (hard constraint):**
- Runtime LLM invocation is prohibited by design
- `npm run guard:no-llm-runtime` enforces this at build time
- Refactor engine uses rule-based decision logic only (`decisionSource=rule_engine`, `llmInvolved=false`)
- If `CODEBASE_INDEX_LLM_ENABLED=true`, server startup is rejected

**Path allowlist (required):**
- `CODEBASE_INDEX_ALLOWED_ROOTS` must be set (comma-separated absolute paths)
- All indexing operations validate paths against this allowlist
- Use exact paths from `list_repositories` output when calling `index_repository`

**Benchmark quality gate:**
- `npm run benchmark:plan:check` enforces compact-mode token savings ≥ 40%
- Per-scenario check: `compact <= standard <= verbose` response bytes
- Fails CI if thresholds regress

**Worker pool architecture:**
- Tree-sitter parsing runs in worker threads (default: `cpus/2` workers)
- `LARGE_FILE_THRESHOLD_BYTES=0` routes all non-markdown files to workers
- Job timeout: 20s per file (configurable via `CODEBASE_INDEX_PARSE_JOB_TIMEOUT_MS`)

**Refactor approval flow:**
- `refactor_replace_preview` generates signed approval token
- `refactor_replace_apply` requires valid token from preview
- Token TTL: 30 minutes (configurable via `CODEBASE_INDEX_REFACTOR_PREVIEW_TTL_MS`)
- Set `CODEBASE_INDEX_REFACTOR_APPROVAL_SECRET` for HMAC signing (recommended)
- Strict mode: `CODEBASE_INDEX_REFACTOR_STRICT_APPROVAL=true` rejects startup without secret

**C# object initializer rewrites:**
- `refactor_symbol_migration` supports `initializerRewrite` metadata for owned-state migrations
- Without `initializerRewrite`, dotted targets (e.g., `DispatchContext.CrmCampaignId`) in object initializers are blocked as `ambiguous_target`
- Apply-stage guard rejects invalid dotted initializer rewrites with `INVALID_CSHARP_INITIALIZER_REWRITE`
- See `codebase-index-mcp/docs/mcp-codebase-index-issue-registry.md` MCP-ISSUE-003 for context

### postgres-mcp

**Read-only guardrails (hard constraint):**
- Only `SELECT` and `WITH ... SELECT` allowed
- Blocks: `INSERT`, `UPDATE`, `DELETE`, `TRUNCATE`, `ALTER`, `DROP`, `CREATE`, etc.
- Single statement only (no semicolon-separated batches)
- Parameterized queries required for user input
- Connection string via `POSTGRES_CONNECTION` env var (never commit secrets). The pre-S-43 name `CH_DB_CONNECTION` still works.

## Development Workflow

### Before committing (codebase-index-mcp)

Run in order:
```bash
npm run typecheck
npm run build
npm run guard:no-llm-runtime
node scripts/smoke-test.mjs
npm run benchmark:plan:check
```

If any step fails, fix before commit. The benchmark gate is a quality contract.

### Testing refactor engine changes

After modifying refactor logic:
```bash
npm run build
npm run test:refactor-engine
```

Regression suite must show `N passed, 0 failed`. Current baseline: 47 tests.

### Adding new tree-sitter language support

1. Add parser dependency to `package.json` (e.g., `tree-sitter-python`)
2. Update `treeSitterExtractor.ts` with language-specific extraction logic
3. Add test coverage in `scripts/test/test-extractor.mjs`
4. Update `README.md` feature list

### Watch behavior (codebase-index-mcp)

Default: watchless operation (`CODEBASE_INDEX_WATCH_AUTO_START=false`)
- Use `watch_repo` only for short debug sessions
- Stop immediately after diagnostics
- Active-only mode: one watcher at a time, 15min idle TTL
- Prefer incremental `index_repository` over continuous watching

## Common Pitfalls

**Path normalization (codebase-index-mcp):**
- Always use exact `repoPath` from `list_repositories` output
- Do not manually change drive letter casing or slash style
- Path mismatch causes allowlist rejection

**Smoke test requires build:**
- `node scripts/smoke-test.mjs` runs `dist/index.js`, not source
- Run `npm run build` first or test will fail

**Better-sqlite3 native build (Windows):**
- Requires Visual Studio C++ Build Tools
- If build fails, install VS Build Tools or switch to JS-only SQLite backend

**Benchmark false positives:**
- Telemetry must be enabled: `CODEBASE_INDEX_TELEMETRY_ENABLED=true`
- Sample rate must be 1.0: `CODEBASE_INDEX_TELEMETRY_SAMPLE_RATE=1`
- Benchmark script sets these automatically

**Refactor preview/apply lifecycle:**
- Preview generates approval token valid for 30 minutes
- Apply must use exact `previewId` and `approvalToken` from preview
- Stale tokens are rejected
- Rollback requires `applyId` from apply response

**C# initializer migrations:**
- For dotted targets in object initializers, provide `initializerRewrite` metadata
- Without it, preview blocks with `ambiguous_target` (safe default)
- See `scripts/test/test-refactor-engine.mjs` suite 3.6-3.8 for examples

## Environment Variables

### codebase-index-mcp (required)

- `CODEBASE_INDEX_ALLOWED_ROOTS` - Comma-separated absolute paths for indexing

### codebase-index-mcp (optional, common)

- `CODEBASE_INDEX_DB_PATH` - SQLite database location (default: `./codebase-index.db`)
- `CODEBASE_INDEX_MAX_FILES_PER_RUN` - Hard cap per index run (default: 20000)
- `CODEBASE_INDEX_LARGE_REPO_PROFILE` - `auto|standard|large|very-large` (default: `auto`)
- `CODEBASE_INDEX_DOCS_INDEXING_ENABLED` - Index markdown/docs (default: `false`)
- `CODEBASE_INDEX_DOCS_TOOLS_ENABLED` - Enable docs tools (default: `false`)
- `CODEBASE_INDEX_REFACTOR_APPROVAL_SECRET` - HMAC secret for refactor approval tokens
- `CODEBASE_INDEX_WATCH_AUTO_START` - Auto-start watchers (default: `false`)

### postgres-mcp (required)

- `POSTGRES_CONNECTION` - PostgreSQL connection string (Npgsql format). *(was `CH_DB_CONNECTION`)*

### postgres-mcp (optional)

- `POSTGRES_DEFAULT_LIMIT` - Default row limit (default: 500). *(was `MCP_DB_DEFAULT_LIMIT`)*
- `POSTGRES_MAX_LIMIT` - Maximum row limit (default: 2000). *(was `MCP_DB_MAX_LIMIT`)*
- `POSTGRES_DEFAULT_TIMEOUT_MS` - Default query timeout (default: 30000). *(was `MCP_DB_DEFAULT_TIMEOUT_MS`)*
- `POSTGRES_MAX_TIMEOUT_MS` - Maximum query timeout (default: 60000). *(was `MCP_DB_MAX_TIMEOUT_MS`)*

### bitbucket-mcp (required)

- `BITBUCKET_ACCESS_TOKEN` - Repository/Workspace Access Token (sent as `Bearer`). Alternative: `BITBUCKET_EMAIL` + `BITBUCKET_API_TOKEN` (Atlassian API token, Basic auth)
- `BITBUCKET_WORKSPACE` - Workspace slug

### bitbucket-mcp (optional)

- `BITBUCKET_DEFAULT_REPO` - Default repo slug (omit `repoSlug` per call)
- `BITBUCKET_BASE_URL` - API base URL (default: `https://api.bitbucket.org/2.0`)
- `BITBUCKET_WRITE_ENABLED` - Allow `create_pull_request` (default: `false`; ON only for `true`/`1`)
- `BITBUCKET_TIMEOUT_MS` - Per-request timeout (default: 30000)
- `BITBUCKET_MAX_RETRIES` - Retries for network/429/5xx (default: 2)
- `BITBUCKET_DEFAULT_PAGELEN` / `BITBUCKET_MAX_PAGELEN` - List page size (default: 25 / 100)

## Architecture Notes

### codebase-index-mcp

**Indexing pipeline:**
- Glob with ignore patterns (skips `node_modules`, `dist`, `.git`, etc.)
- Binary sniff (first 512 bytes) + extension filter
- Tree-sitter AST extraction for JS/TS/C#
- .NET project parser for `.csproj`/`.sln` (NuGet + ProjectReference edges)
- SQLite storage with WAL mode, batched upserts, periodic checkpoints

**Graph schema:**
- Symbols: `id`, `name`, `kind`, `filePath`, `line`, `repoId`
- Edges: `CALLS`, `TYPE_REF`, `PROPERTY_REF`, `PROPERTY_WRITE`, `IMPORTS`, `NUGET_DEPENDENCY`, `PROJECT_REFERENCE`
- Confidence scores on edges (0.0-1.0)
- Unresolved edges tracked separately for diagnostics

**Response profiles:**
- `nano` - Minimal fields, fastest
- `compact` - Lightweight, minified JSON (Plan mode default)
- `standard` - Balanced (default)
- `verbose` - Full details with debug metadata

**Staleness detection:**
- Compares indexed commit vs `HEAD` + working tree status
- Fast-skips when clean and up-to-date
- `health_check` returns actionable `shouldReindex` flag

### postgres-mcp

**Guardrail layers:**
1. Token-based SQL validation (blocks mutation keywords)
2. Single-statement enforcement (no semicolon batches)
3. Parameterized query support (prevents injection)
4. Timeout and row limit enforcement
5. Read-only transaction isolation

## Issue Registry

`codebase-index-mcp/docs/mcp-codebase-index-issue-registry.md` tracks MCP tool gaps and workarounds:
- MCP-ISSUE-001: C# property edge extraction (✅ resolved)
- MCP-ISSUE-002: Object initializer migration (✅ resolved)
- MCP-ISSUE-003: Invalid dotted initializer rewrites (✅ resolved)
- MCP-ISSUE-004: Partial impact coverage for owned-state refactors (✅ resolved)
- MCP-ISSUE-005: Compiler-assisted refactor narrowing (✅ resolved)
- MCP-ISSUE-006: NuGet/cross-repo type resolution (✅ resolved)
- MCP-ISSUE-007: Minimal API route extraction (✅ resolved)
- MCP-ISSUE-008: find_package_consumers did-you-mean hints (✅ resolved)
- MCP-ISSUE-009: query_graph allowed-table guidance (✅ resolved)
- MCP-ISSUE-010: incremental prune + branch tracking (✅ resolved)
- MCP-ISSUE-011: ranked-intent search, context-pack selection, find_impact_files staleWarning (✅ resolved)
- MCP-ISSUE-012: get_symbol_source + regex refactor mode + executable rename_assist (✅ resolved)

When MCP tools fail to provide sufficient evidence, log new issues with:
- Scenario, tool attempted, expected vs actual, impact, workaround, enhancement proposal

## Integration Guidance

**MCP host config (workspace-local):**
```json
{
  "servers": {
    "codebase-index": {
      "command": "node",
      "args": ["${workspaceFolder}/codebase-index-mcp/dist/index.js"],
      "env": {
        "CODEBASE_INDEX_ALLOWED_ROOTS": "${workspaceFolder}",
        "CODEBASE_INDEX_DB_PATH": "${workspaceFolder}/mcp-local-index.db"
      }
    }
  }
}
```

**MCP host config (central cross-repo):**
```json
{
  "servers": {
    "codebase-index-central": {
      "command": "node",
      "args": ["D:/Repository/mcp-local/codebase-index-mcp/dist/index.js"],
      "env": {
        "CODEBASE_INDEX_ALLOWED_ROOTS": "D:/Repository/mcp-local,D:/Repository/other-repo",
        "CODEBASE_INDEX_DB_PATH": "D:/Repository/mcp-local/mcp-central-index.db"
      }
    }
  }
}
```

**Recommended index flow:**
1. `health_check(repoId)` - Check staleness
2. `index_repository(mode: "incremental", docsMode: "off")` - Code-first indexing
3. Use `profile: "compact"` on read tools for token efficiency
4. Re-index incrementally after code changes

**Recommended read/refactor flow (stay in MCP, avoid baseline fallback):**
1. Read a symbol's code with `get_symbol_source` (by symbolId or name) instead of `read_file` — returns the exact source span from disk. Re-index (full) once so `end_line` is populated for precise spans; otherwise the span is estimated.
2. Rename: `rename_assist(emitPreview: true)` → `refactor_replace_apply` (add `includeLowConfidence: true` for top-level identifiers) → `refactor_replace_rollback` if needed.
3. Pattern/signature edits: `refactor_replace_preview(findMode: "regex", ...)` with capture-group substitution (`$1`, `$&`), scoped via `includePaths`.

## References

Workspace-level:
- `docs/onboarding.md` - Fresh clone to a working install, and the two gotchas that waste the most time
- `docs/architecture.md` - The workspace as built; what enforces its shape
- `docs/conventions.md` - The rules, sorted by whether anything checks them
- `.claude/rules/mcp-hard-mode.md` - MCP-first enforcement policy

Per-server:
- `codebase-index-mcp/README.md` - Full tool catalog and usage examples
- `codebase-index-mcp/CLAUDE.md` - Sub-project guide, including the `src/` folder-ownership table
- `codebase-index-mcp/docs/MCP-FIRST-CHEATSHEET.md` - Quick operator guide
- `codebase-index-mcp/docs/mcp-codebase-index-issue-registry.md` - Known gaps and resolutions
- `postgres-mcp/README.md` - PostgreSQL MCP setup and guardrails
- `observe-mcp/README.md` - OpenObserve log/trace query setup
- `bitbucket-mcp/README.md` - Bitbucket auth and the PR-creation write gate
