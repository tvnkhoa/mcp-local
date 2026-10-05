# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Architecture

This is an **MCP (Model Context Protocol) server** that builds a code graph over a repository and exposes it as tools. It has no web server, no LLM invocations at runtime, and no external service dependencies beyond the local filesystem and SQLite.

**Naming inside `services/extractors/`.** Two prefixes, and the split is by scope, not by taste:
`<language>Extractor.ts` is a language's entry point (`jsExtractor`, `pythonExtractor`,
`csharpExtractor`); `csharp*` / `js*` are that language's internals (`csharpSymbols`,
`csharpTypeRefs`, `csharpScope`, `jsCalls`); bare `extractor*` is machinery shared across
languages (`extractorEdges`, `extractorUtils`, `extractorPrimitives`, `extractorTypes`,
`extractorRoutes`).

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

The symbol-kind and edge-type unions live in `src/types/index.ts`, the only authority:

```bash
grep -nE '^  (kind|type):' src/types/index.ts
```

- **Stable IDs**: SHA-256 of `repoId:filePath:kind:name:row` truncated to 24 hex chars — `makeSymbolId` → `stableId` in `src/services/extractors/extractorPrimitives.ts`; `row` is the 0-indexed tree-sitter row (see *A symbol id is minted in one place* below)
- **Multi-repo**: All tables are scoped by `repoId`; a single SQLite DB can hold multiple repos
- **Confidence**: edges carry a 0.0–1.0 score; unresolved edges are tracked separately for diagnostics

**Schema guardrails** — apply these when adding an edge type or changing persistence:

- Keep the repo boundary explicit in **every** primary index and query path. `repoId` scoping is the
  isolation mechanism, not a convention.
- Track provenance on every index run: parser version, rule version, run id. Without it a graph
  cannot be reproduced, and MCP-ISSUE-032 was exactly that failure.
- Do not store raw sensitive source spans unless justified; prefer hashes and metadata.
- Document the migration path and backward compatibility before changing an existing table.

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

`.claude/rules/mcp-hard-mode.md` (always loaded) governs MCP-first use of this server's own tools.

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
6. Update the feature list in `README.md`.

**A symbol id is minted in one place.** `makeSymbolId(input, kind, name, row)` in
`extractorPrimitives.ts` is the only correct way to spell one, and the enclosing-symbol lookup that
builds an edge's `fromId` must call it too. When the JS lane spelled the id by hand on one side and
not the other, 77% of this repo's own TypeScript edges pointed at a symbol that did not exist, and
nothing failed — the graph was simply wrong. `row` is the tree-sitter 0-indexed `startPosition.row`,
not the 1-indexed `line` stored on the record.

**Worker pool.** Tree-sitter parsing runs in worker threads, `cpus/2` by default.
`CODEBASE_INDEX_LARGE_FILE_THRESHOLD_BYTES=0` routes every non-markdown file to a worker. The per-file job timeout is
`CODEBASE_INDEX_PARSE_JOB_TIMEOUT_MS` (20s).

**Benchmark false positives.** `npm run benchmark:plan:check` needs telemetry on
(`CODEBASE_INDEX_TELEMETRY_ENABLED=true`) and a sample rate of 1
(`CODEBASE_INDEX_TELEMETRY_SAMPLE_RATE=1`). The benchmark script sets both itself; a hand-run that
skips them reports a false regression.

**C# initializer migrations.** For dotted targets in object initializers, supply `initializerRewrite`
metadata; without it the preview blocks with `ambiguous_target`, which is the safe default. Worked
examples: `scripts/test/test-refactor-engine.mjs` suites 3.6–3.8.

