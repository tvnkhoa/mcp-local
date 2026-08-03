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
  → services/indexing/fileFilter.ts     # extension/binary sniff → include/exclude + language tag
  → services/indexing/indexPipeline.ts  # batch, hash, dispatch  (scan/limits/finalize in sibling files)
      ├─ services/extractors/treeSitterExtractor.ts   # JS/TS/C# → symbols + edges (CALLS, IMPORTS, TYPE_REF, PROPERTY_REF, PROPERTY_WRITE)
      ├─ services/extractors/extractionWorkerPool.ts  # worker threads (threshold is env-tuned; 0 = always)
      ├─ services/extractors/dotnetProjectParser.ts   # .csproj/.sln → NuGet + ProjectReference edges
      └─ services/extractors/markdownParser.ts        # headings + code blocks + backtick mentions
  → repositories/graphStore.ts          # upsert into SQLite (better-sqlite3)
  → services/graph/edgeResolver.ts      # resolve cross-file edges after all files are seen
  → index.ts                            # entry: env, construction, start-up
```

### Layout

`src/` follows the workspace standard structure — the same nine slots in every server. S-41 re-homed
59 loose files into domain folders; the standard-structure refactor then folded those folders into
the shared vocabulary, keeping their names as sub-domains under `services/`.

| Folder | Owns |
|--------|------|
| `tools/` | `tools/list` declarations via `@mcp/sdk` |
| `tools/handlers/` | one function per tool, called by the declarations beside it |
| `resources/` | the four `repo://` resources and their URI parsing |
| `middleware/` | cross-cutting call-pipeline concerns: guardrails, serialization, error mapping |
| `services/` | domain logic, one sub-folder per sub-domain (below) |
| `repositories/` | every SQLite read and write |
| `config/` | the only modules permitted to read `process.env` (dependency rule 10) |
| `types/` | shared types plus `types/schemas/` — zod input schemas, one file per tool group |

`services/` sub-domains:

| Folder | Owns |
|--------|------|
| `services/analysis/` | static analysis over the built graph: dead code, cycles, test linkage, value contracts |
| `services/extractors/` | source → symbols/edges, per language, plus the worker lane |
| `services/graph/` | edge resolution and traversal |
| `services/impact/` | blast radius: who calls, who is affected, what changed |
| `services/indexing/` | the index run — scan, limits, batches, progress, finalize |
| `services/refactor/` | preview → apply → rollback, and the HMAC approval path |
| `services/search/` | symbol search, FTS, regex search, candidate resolution |
| `services/watch/` | chokidar watcher and its lifecycle |

Root: `index.ts` (S1 — the only entry point) and `server.ts`, its protocol-wiring half. `prompts/` is
absent because this server declares no MCP prompts.

### Key source files

| File | Role |
|------|------|
| `src/index.ts` | Entry: env parsing, construction, start-up |
| `src/server.ts` | Protocol wiring; `tools/list` table lives in `src/tools/` |
| `src/repositories/graphStore.ts` | All SQLite reads/writes; schema migrations; refactor tables |
| `src/services/indexing/indexPipeline.ts` | Core batch indexing loop; progress snapshots; commit-SHA staleness check |
| `src/services/indexing/fileFilter.ts` | File include/exclude rules; binary sniff; language detection |
| `src/services/extractors/treeSitterExtractor.ts` | AST extraction per language; edge policy by performance profile |
| `src/services/extractors/extractionWorkerPool.ts` | Worker-thread pool for large-file parse isolation |
| `src/services/extractors/dotnetProjectParser.ts` | Regex-based .csproj/.sln parser (NuGet + ProjectReference edges) |
| `src/services/extractors/markdownParser.ts` | Docs-lane extraction for `.md` files |
| `src/middleware/indexGuardrails.ts` | Path allowlist enforcement; sensitive-pattern redaction; env parsing helpers |
| `src/middleware/sqliteGuardrails.ts` | Blocks mutation SQL tokens in `query_graph` tool to prevent injection |
| `src/services/watch/watchManager.ts` | chokidar watcher; debounced incremental re-index |
| `src/types/index.ts` | Shared types: `SymbolRecord`, `EdgeRecord`, `RefactorPreviewRecord`, etc. |

> `extractionWorkerPool.ts` spawns its worker with `new URL("./extractionWorker.js",
> import.meta.url)`, so those two files must stay in the same folder.

> The integration harnesses in `scripts/test/` import compiled modules by path
> (`dist/repositories/graphStore.js`, …). Moving a source file moves its `dist/` twin, so those
> imports must be retargeted in the same change — `tsc` will not warn, and the harness fails at
> `ERR_MODULE_NOT_FOUND`.

> `dist/` is not pruned by `tsc`. After renaming or moving a source file, `rm -rf dist` before
> trusting a run — a stale module at the old path will still load and can mask a broken import.
> `npm run mcp:doctor` (from the workspace root) reports orphaned `dist/*.js` files by name, so
> this is detectable rather than only documented.

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
