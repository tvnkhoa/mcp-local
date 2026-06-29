# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Workspace Overview

Two independent MCP servers — **not** a monorepo with shared packages. Each has its own `package.json`, `tsconfig.json`, and `dist/`. Both use TypeScript 5.7+ with ESM (`"type": "module"`) and `@modelcontextprotocol/sdk`.

- `codebase-index-mcp/` — Code graph indexing and analysis server. Most development work happens here.
- `postgres-mcp/` — PostgreSQL MCP server. Read-only by default (SQL guardrails); optional multi-environment access, reviewed/confirmed data writes, and EF Core migration tooling, each gated behind explicit env flags.

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

**Pre-commit sequence:**
```bash
npm run typecheck && npm run build && npm run guard:no-llm-runtime && node scripts/smoke-test.mjs && npm run benchmark:plan:check
```

### postgres-mcp

```bash
cd postgres-mcp
npm run build
npm run typecheck
npm run dev
```

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

## Local Dev MCP Test Cycle

The workspace root has `.mcp.json` pointing to the local dev build of `codebase-index-mcp/dist/index.js`. After each code change, use this cycle to test immediately via MCP:

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
- If MCP returns empty or low-confidence results after 2 attempts, log to `codebase-index-mcp/mcp-codebase-index-issue-registry.md` before continuing with grep/read

## References

- `codebase-index-mcp/CLAUDE.md` — full sub-project guide (key files, env vars, refactor engine details)
- `AGENTS.md` — env var reference, common pitfalls, integration config examples
- `codebase-index-mcp/README.md` — complete MCP tool catalog with usage examples
