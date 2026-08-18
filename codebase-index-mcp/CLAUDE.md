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
| `services/git/` | `git` shell-outs: HEAD sha, branch, working-tree dirt, staleness warnings |
| `services/graph/` | edge resolution and traversal |
| `services/impact/` | blast radius: who calls, who is affected, what changed |
| `services/indexing/` | the index run — scan, limits, batches, progress, finalize |
| `services/refactor/` | preview → apply → rollback, and the HMAC approval path |
| `services/search/` | symbol search, FTS, regex search, candidate resolution |
| `services/watch/` | chokidar watcher and its lifecycle |

Root: `index.ts` (S1 — the only entry point) and `server.ts`, its protocol-wiring half. `prompts/` is
absent because this server declares no MCP prompts.

**Naming inside `services/extractors/`.** Two prefixes, and the split is by scope, not by taste:
`<language>Extractor.ts` is a language's entry point (`jsExtractor`, `pythonExtractor`,
`csharpExtractor`); `csharp*` / `js*` are that language's internals (`csharpSymbols`,
`csharpTypeRefs`, `csharpScope`, `jsCalls`); bare `extractor*` is machinery shared across
languages (`extractorEdges`, `extractorUtils`, `extractorPrimitives`, `extractorTypes`,
`extractorRoutes`). Two files broke the rule by carrying the shared prefix while being
language-specific — `extractorCSharpScope.ts` and `extractorJsCalls.ts` — and were renamed to
`csharpScope.ts` and `jsCalls.ts` on 2026-08-03.

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

> The harnesses above are why stale `dist/` bites hardest in this server: they import compiled
> modules **by path**, so an orphaned `dist/*.js` keeps resolving.
> [`../docs/development/workflow.md`](../docs/development/workflow.md) §7 has the remedy.

### Graph model

Both unions are declared in `src/types/index.ts` — that file is authoritative, and this table is a
copy. Re-derive rather than trust it:

```bash
grep -nE '^  (kind|type):' src/types/index.ts
```

- **Symbol kinds** (14, `src/types/index.ts:170`): `function | class | method | variable | module | interface | property | constructor | type | struct | record | record struct | impl | unknown`
- **Edge types** (10, `src/types/index.ts:188`): `IMPORTS | CALLS | DEPENDS_ON | IMPLEMENTS | EXTENDS | TYPE_REF | PROPERTY_REF | PROPERTY_WRITE | PUBLISHES | CONSUMES`
- **Stable IDs**: SHA-256 of `repoId:filePath:symbolName` truncated to 24 hex chars
- **Multi-repo**: All tables are scoped by `repoId`; a single SQLite DB can hold multiple repos
- **Confidence**: edges carry a 0.0–1.0 score; unresolved edges are tracked separately for diagnostics

**Schema guardrails** — apply these when adding an edge type or changing persistence:

- Keep the repo boundary explicit in **every** primary index and query path. `repoId` scoping is the
  isolation mechanism, not a convention.
- Track provenance on every index run: parser version, rule version, run id. Without it a graph
  cannot be reproduced, and MCP-ISSUE-032 was exactly that failure.
- Do not store raw sensitive source spans unless justified; prefer hashes and metadata.
- Document the migration path and backward compatibility before changing an existing table.

*(Guardrails absorbed from the `graph-schema-design` authoring skill, archived 2026-08-03. That skill
prescribed nodes `Repository/Revision/File/Module/Symbol/IndexRun` and edges
`CONTAINS/IMPORTS/EXPORTS/CALLS/DEPENDS_ON/CHANGED_IN` — three of those edges never existed and seven
real ones were missing. The unions above are the measured truth.)*

### Refactor engine

`refactor_replace_preview` → `refactor_replace_apply` → `refactor_replace_rollback` is rule-based only:
- `decisionSource=rule_engine`, `llmInvolved=false` — enforced by the no-LLM guard
- Approval tokens use HMAC (env: `CODEBASE_INDEX_REFACTOR_APPROVAL_SECRET`)
- C# object-initializer rewrites require explicit `initializerRewrite` config; dotted paths without it are blocked as `ambiguous_target`

**Owner types are proven, not scanned (B-13).** `services/refactor/ownerResolver.ts` is the single
answer to "which type owns this site", shared by `refactorPreviewBuild` and
`analysis/valueRepresentation`. For C# it types the receiver from the AST — instance, `this`, `base`,
static (`Codec.M`), namespace-qualified, one nested hop (`a.B.M`), object initializers, and
declaration sites — so `requiredOwnerType` means *sites that touch this type's member*, not *sites
inside the declaring type*. Other languages keep the text scan
(`refactorUtils.findEnclosingTypeNameByScan`), reported as rule `enclosing_type_fallback`.
Three verdicts: `verified` keeps the site, `cross_type` rejects it into `rejectedSites`, and
`unknown` **keeps** it flagged `ambiguous_target` with the failing rule in `ambiguousReasons` —
an unprovable owner is never a silent drop and never applies.

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
- **Fallback logging**: if MCP returns empty/low-confidence after 2 attempts, log to `codebase-index-mcp/docs/mcp-codebase-index-issue-registry.md` before continuing with baseline tools

## Extending the extractor

Adding a tree-sitter language:

1. Add the parser dependency to `package.json` (e.g. `tree-sitter-python`).
2. Register the grammar in `getOrCreateParserForLanguage` and add the dispatch branch in
   `extractGraphData` (both in `services/extractors/treeSitterExtractor.ts`). A language absent from
   the registry returns a lone module symbol and no edges, **silently** — there is no error.
3. Map the extension in `LANGUAGE_BY_EXTENSION` (`services/indexing/fileFilter.ts`). Nothing runs
   without this: an unmapped extension is skipped as `unknown_extension`.
4. Add the language's entry point as `services/extractors/<language>Extractor.ts`, following the
   naming rule above.
5. Add a new `scripts/test/test-<language>-*.mjs` harness — copy the shape of
   `test-csharp-inheritance-bridge.mjs` (or `test-typescript-symbols.mjs`) — and wire it to a
   `test:*` script in `package.json`. `scripts/run-tests.mjs` discovers the list *from
   package.json*, so a harness with no script is invisible and never runs.
   > Do not add to `scripts/test/test-extractor.mjs`. It is unwired, has no assertions, and still
   > reads `./src/graphStore.ts` — a path that moved in S-41 — so it cannot run at all.
6. Update the feature list in `README.md`.

**A symbol id is minted in one place.** `makeSymbolId(input, kind, name, row)` in
`extractorPrimitives.ts` is the only correct way to spell one, and the enclosing-symbol lookup that
builds an edge's `fromId` must call it too. When the JS lane spelled the id by hand on one side and
not the other, 77% of this repo's own TypeScript edges pointed at a symbol that did not exist, and
nothing failed — the graph was simply wrong. `row` is the tree-sitter 0-indexed `startPosition.row`,
not the 1-indexed `line` stored on the record.

**Worker pool.** Tree-sitter parsing runs in worker threads, `cpus/2` by default.
`LARGE_FILE_THRESHOLD_BYTES=0` routes every non-markdown file to a worker. The per-file job timeout is
`CODEBASE_INDEX_PARSE_JOB_TIMEOUT_MS` (20s).

**Benchmark false positives.** `npm run benchmark:plan:check` needs telemetry on
(`CODEBASE_INDEX_TELEMETRY_ENABLED=true`) and a sample rate of 1
(`CODEBASE_INDEX_TELEMETRY_SAMPLE_RATE=1`). The benchmark script sets both itself; a hand-run that
skips them reports a false regression.

**C# initializer migrations.** For dotted targets in object initializers, supply `initializerRewrite`
metadata; without it the preview blocks with `ambiguous_target`, which is the safe default. Worked
examples: `scripts/test/test-refactor-engine.mjs` suites 3.6–3.8.

