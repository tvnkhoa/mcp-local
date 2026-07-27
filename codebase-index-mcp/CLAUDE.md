# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# One-command setup (install, build, configure agents, verify)
npm run setup

# Build (TypeScript → dist/)
npm run build

# Type check only (no emit)
npm run typecheck

# Run dev server directly with tsx (no build needed)
npm run dev

# Smoke test — MCP handshake, health_check, index, graph queries
node scripts/smoke-test.mjs

# Guard: verify no LLM invocation paths exist at runtime
npm run guard:no-llm-runtime

# Benchmark plan-mode response sizes (quality gate, non-zero exit on regression)
npm run benchmark:plan:check

# Individual bridge/parser tests
npm run test:endpoint-bridge
npm run test:csharp-inheritance-bridge
npm run test:nuget-bridge
npm run test:minimal-api-guard
```

## Architecture

This is an **MCP (Model Context Protocol) server** that builds a code graph over a repository and exposes it as tools. It has no web server, no LLM invocations at runtime, and no external service dependencies beyond the local filesystem and SQLite.

### Data flow

```
Files on disk
  → fileFilter.ts         # extension/binary sniff → include/exclude + language tag
  → indexPipeline.ts      # glob, hash, batch, dispatch
      ├─ treeSitterExtractor.ts   # JS/TS/C# → symbols + edges (CALLS, IMPORTS, TYPE_REF, PROPERTY_REF, PROPERTY_WRITE)
      ├─ extractionWorkerPool.ts  # worker threads for files > 512 KB
      ├─ dotnetProjectParser.ts   # .csproj/.sln → NuGet + ProjectReference edges
      └─ markdownParser.ts        # headings + code blocks + backtick mentions
  → graphStore.ts          # upsert into SQLite (better-sqlite3)
  → index.ts               # MCP tool handlers (query + refactor + watch)
```

### Key source files

| File | Role |
|------|------|
| `src/index.ts` | MCP server entry; all tool definitions, request dispatch, env parsing |
| `src/graphStore.ts` | All SQLite reads/writes; schema migrations; refactor preview/apply/rollback tables |
| `src/indexPipeline.ts` | Core batch indexing loop; progress snapshots; commit-SHA staleness check |
| `src/treeSitterExtractor.ts` | AST extraction per language; edge policy by performance profile |
| `src/extractionWorkerPool.ts` | Worker-thread pool for large-file parse isolation |
| `src/dotnetProjectParser.ts` | Regex-based .csproj/.sln parser (NuGet + ProjectReference edges) |
| `src/fileFilter.ts` | File include/exclude rules; binary sniff; language detection |
| `src/guardrails/indexGuardrails.ts` | Path allowlist enforcement; sensitive-pattern redaction; env parsing helpers |
| `src/guardrails/sqliteGuardrails.ts` | Blocks mutation SQL tokens in `query_graph` tool to prevent injection |
| `src/watchManager.ts` | chokidar watcher; debounced incremental re-index |
| `src/markdownParser.ts` | Docs-lane extraction for `.md` files |
| `src/types.ts` | Shared types: `SymbolRecord`, `EdgeRecord`, `RefactorPreviewRecord`, etc. |

### Graph model

- **Symbols**: `function | class | method | variable | module | interface | property | constructor | type | struct | impl`
- **Edge types**: `IMPORTS | CALLS | DEPENDS_ON | IMPLEMENTS | TYPE_REF | PROPERTY_REF | PROPERTY_WRITE`
- **Stable IDs**: SHA-256 of `repoId:filePath:symbolName` truncated to 24 hex chars
- **Multi-repo**: All tables are scoped by `repoId`; a single SQLite DB can hold multiple repos

### Refactor engine

`refactor_replace_preview` → `refactor_replace_apply` → `refactor_replace_rollback` is rule-based only:
- `decisionSource=rule_engine`, `llmInvolved=false` — enforced by the no-LLM guard
- Approval tokens use HMAC (env: `CODEBASE_INDEX_REFACTOR_APPROVAL_SECRET`)
- C# object-initializer rewrites require explicit `initializerRewrite` config; dotted paths without it are blocked as `ambiguous_target`

### No-LLM policy

`npm run guard:no-llm-runtime` (scripts/guard-no-llm-runtime.mjs) statically verifies the `src/` tree contains no LLM client imports. Setting `CODEBASE_INDEX_LLM_ENABLED=true` causes startup to fail. This must remain true.

## Environment

Only `CODEBASE_INDEX_ALLOWED_ROOTS` (comma-separated absolute paths) is required. All other env vars have safe defaults. See README.md for the full list.

## MCP Workspace Operating Rules

This workspace has `.claude/rules/mcp-hard-mode.md` as the policy source for how Claude should use its own MCP tools when working in this repo. Key rules:

- **MCP-first**: use `search_symbols` / `get_symbol_context_pack` / `find_impact_files` before baseline grep/read tools for any codebase analysis task
- **Regex/pattern search via MCP**: use `search_regex` (matches with context lines + enclosing symbol; `scanAll:true` also walks non-code text like json/yaml) instead of baseline grep for arbitrary pattern searches
- **Read code via MCP**: use `get_symbol_source` (by symbolId or name) to read a symbol's exact source span instead of `read_file`; fall back to `read_file` only for non-symbol regions
- **Refactor via MCP**: `rename_assist(emitPreview:true)` → `refactor_replace_apply` (`includeLowConfidence:true` for top-level identifiers) for renames; `refactor_replace_preview(findMode:"regex")` with capture groups for pattern edits — all preview-gated and reversible via `refactor_replace_rollback`
- **Registered repoIds**: `codebase-index-mcp` (this repo) and `mcp-local` (parent workspace)
- **Path normalization**: run `list_repositories` and reuse the exact registered `repoPath` — do not rewrite drive-letter casing or slash style
- **Watch policy**: keep `watch_repo` off except during active implementation/debug sessions; stop immediately after
- **Tool budget**: soft cap 5 MCP calls per question; hard cap 8 with fallback; max 2 query rewrites
- **Fallback logging**: if MCP returns empty/low-confidence after 2 attempts, log to `docs/mcp-codebase-index-issue-registry.md` before continuing with baseline tools
