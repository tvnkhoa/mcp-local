---
name: tree-sitter-extraction
description: "Change what codebase-index-mcp extracts from source: add or fix a language lane, a symbol kind, or an edge (CALLS, IMPORTS, TYPE_REF, PROPERTY_REF/WRITE, IMPLEMENTS, EXTENDS, PUBLISHES/CONSUMES) in src/services/extractors/. Use when editing treeSitterExtractor.ts, a <language>Extractor.ts, csharp*/js* internals, extractorPrimitives.ts, or the worker pool, or when upgrading a tree-sitter grammar. Not for edge resolution after extraction (index-unresolved-symbol-policy) or run bookkeeping (index-metadata-governance)."
---

# Tree-sitter Extraction

Naming rules for `services/extractors/` and the six-step "add a language" list are in
`codebase-index-mcp/CLAUDE.md` §"Extending the extractor". Follow that list. This skill covers the
traps that list does not.

## What is parsed by what

| Lane | Files | How |
|---|---|---|
| JS / TS (+ TSX dialect) | `jsExtractor.ts`, `js*.ts` | tree-sitter (`tree-sitter-javascript`, `tree-sitter-typescript`) |
| C# | `csharpExtractor.ts`, `csharp*.ts` | tree-sitter (`tree-sitter-c-sharp`) |
| Python, `.proto` | `pythonExtractor.ts`, `protoExtractor.ts` | **regex**, not tree-sitter |
| `.csproj` / `.sln` / `.slnx` | `dotnetProjectParser.ts` | regex (NuGet + ProjectReference `DEPENDS_ON`) |
| Markdown | `markdownParser.ts` | docs lane |

The grammar pins are in `codebase-index-mcp/package.json`. The registry is
`getOrCreateParserForLanguage` in `treeSitterExtractor.ts`. If a language is missing from it, the
file comes back as a lone module symbol with no edges, and **nothing reports an error**. If an
extension is missing from `LANGUAGE_BY_EXTENSION` (`services/indexing/fileFilter.ts`), the file is
skipped as `unknown_extension`.

## Invariants (each one has broken before)

1. **Mint every symbol id with `makeSymbolId(input, kind, name, row)`** (`extractorPrimitives.ts`),
   including the enclosing-symbol lookup that builds an edge's `fromId`. Before this rule, 77% of
   TS edges pointed at symbols that did not exist. The id is
   `sha256(repoId:filePath:kind:name:row)` truncated to 24 hex characters. **`row` is part of the
   id**, so moving a declaration to another line gives it a new id. Ids stay stable across runs only
   for unchanged files.
2. **Never compare tree-sitter nodes with `===`.** Each `.parent` / `.childForFieldName()` call
   returns a new wrapper object, so `===` only holds while the binding's cache keeps the wrapper. That
   made edge counts depend on GC (MCP-ISSUE-032). Use `isSameNode` (`extractorEdges.ts`) instead.
   Guarded by `npm run test:node-identity`.
3. **Emit an unresolved target as a prefixed token; never drop it.** The prefixes are `callee:`,
   `import:`, `type:`, `property:`, `iface:`, `nuget:`. The `services/graph/edgeResolver*.ts`
   modules resolve them after every file has been seen. See `index-unresolved-symbol-policy`.
4. **Parse in bounded steps.** `TREE_SITTER_MAX_BUFFER` is 32 MiB: a larger file is skipped and
   yields no symbols. `bufferSize` is adaptive (this fixed the 32 KB native-buffer crash noted in
   `treeSitterExtractor.ts`). A parse
   that exceeds `CODEBASE_INDEX_PARSE_TIMEOUT_MS` throws `ParseTimeoutError`. A worker job is capped
   by `CODEBASE_INDEX_PARSE_JOB_TIMEOUT_MS`. Any on-demand C# parse outside the pipeline must call
   `parseCSharpOnDemand`, never `parser.parse` directly.
5. **Edge caps are policy, and they are counted.** `applyEdgePolicy` enforces
   `CODEBASE_INDEX_MAX_CALL_EDGES_PER_FILE`, `CODEBASE_INDEX_MAX_TYPE_REF_EDGES_PER_FILE` and
   `CODEBASE_INDEX_MIN_EDGE_CONFIDENCE`. Each drop shows up in `edges_dropped_by_*` on `index_runs`. A
   new cap needs a counter; otherwise you repeat MCP-ISSUE-038, where a profile silently discarded
   every unresolved TYPE_REF.
6. **Keep `extractionWorker.ts` beside `extractionWorkerPool.ts`.** The pool loads the worker with
   `new URL("./extractionWorker.js", import.meta.url)`.
7. **No LLM.** Extraction is parser- or regex-based only. `npm run guard:no-llm-runtime` matches
   import specifiers by substring, so a local path containing `llm` fails it.

## Verify a change

```bash
cd codebase-index-mcp
npm run typecheck && npm run build          # harnesses import dist/ by path
npm run test:unit                           # src/**/*.test.ts (extractorPrimitives, edgeResolver*, moduleResolution)
npm run test:typescript-symbols && npm run test:typescript-edges          # JS/TS lane
npm run test:csharp-type-refs && npm run test:csharp-inheritance-bridge \
  && npm run test:csharp-using-bridge && npm run test:issue-052-qualified-call   # C# lane
npm run test:node-identity && npm run test:string-literals && npm run test:bus-edges
```

- Add a regression harness as `scripts/test/test-<name>.mjs` **and** a `test:<name>` script.
  `scripts/run-tests.mjs` discovers harnesses from `package.json`, so a harness with no script never
  runs. These files in `scripts/test/` are unwired today: `test-extractor`, `test-csharp-parser`,
  `test-markdown-extraction`, `test-property-edges(-real)`, `test-orphan-edges`,
  `test-route-map-roundtrip`, `test-new-tools`, `test-index-debug`. Do not count them as coverage.
- If the change alters output for files that did not change, bump `INDEX_VERSION`
  (`indexPipeline.ts`). Otherwise incremental runs fast-skip and never pick up the new extraction.
- After a grammar or extractor upgrade, follow *After a parser or indexer upgrade* in
  `.claude/rules/mcp-hard-mode.md`. Then check fidelity on the live index, not only on fixtures
  (three defects in one session got past a green suite). Run
  `search_symbols(repoId: "codebase-index-mcp", query: "<a symbol you touched>", strategy: "name")`
  and compare against the source.

## Authoritative reference

`src/types/index.ts` (symbol-kind and edge-type unions), `codebase-index-mcp/CLAUDE.md`
§"Extending the extractor", and the issue registry entries MCP-ISSUE-032/034/036/038/052.
