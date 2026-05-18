# Refactor Plan — codebase-index-mcp

## Mục tiêu

Decompose 2 monolith files (`index.ts` 5,152 dòng, `graphStore.ts` 5,488 dòng) thành các module nhỏ, focused, dễ maintain. Sau đó fix MCP-ISSUE-004 (impact coverage gaps cho C# owned-state/shim patterns).

## Nguyên tắc

- **Incremental**: verify `typecheck + build + test` sau mỗi bước
- **Composition over inheritance**: standalone functions nhận `db: Database.Database`, GraphStore giữ thin delegate wrappers
- **No circular deps**: acyclic dependency graph
- **Regression**: `node scripts/test-refactor-engine.mjs` phải pass 39/39
- **Stash trước mỗi phase rủi ro** để tránh mất code khi rollback

---

## Trạng thái hiện tại (2026-05-14)

| File | Trước | Hiện tại | Giảm | Ghi chú |
|------|-------|----------|------|---------|
| `index.ts` | 5,152 | 3,478 | -32% | Đã extract 6 modules |
| `graphStore.ts` | 5,488 | 1,257 | **-77%** | Đã extract + wire 13 modules, hoàn tất delegate wiring |
| `treeSitterExtractor.ts` | 1,775 | 978 | **-45%** | Đã tách Python + JavaScript + C# extractor (Phase 4 completed) |

**Verification**: `tsc --noEmit` → 0 errors | `npm run build` → pass | `test-refactor-engine.mjs` → 39/39

### Modules đã tạo (Phase 1 + 3)

| Module | Dòng | Nội dung | Trạng thái |
|--------|------|----------|------------|
| `envConfig.ts` | 39 | `numberFromEnv`, `ratioFromEnv`, `nonNegativeNumberFromEnv` | ✅ Done + wired |
| `gitHelpers.ts` | 193 | `runGit`, `resolveHeadCommitSha`, `getRepoStaleness`, `parseGitBlamePorcelain`, `redactEmail` | ✅ Done + wired |
| `responseFormatter.ts` | 101 | `ResponseProfile`, `asTextCore`, `emitTelemetry`, `estimateResultCount`, `toNugetContractId` | ✅ Done + wired |
| `refactorTypes.ts` | 77 | `PreviewCandidateHunk`, `CompilerAssistOutcome`, scope/guard/migration input types | ✅ Done + wired |
| `refactorUtils.ts` | 435 | `PolicyViolationError`, path/hash utils, C# initializer parsing, approval token crypto | ✅ Done + wired |
| `refactorEngine.ts` | 564 | `buildRefactorPreview`, `applyCompilerAssistToPreview`, `buildSymbolMigrationPreview`, `executeRefactorApplyPlan` | ✅ Done + wired |
| `edgeResolver.ts` | 536 | 6 resolve methods + `buildNamedCandidateMap`/`pickBestNamedCandidate` | ✅ Done + wired (6/6) |
| `staticAnalyzer.ts` | 957 | `getDeadCodeCandidates`, `detectCircularDependencies`, `findEntryPoints`, `findImplementations`, `linkTestsToSource` | ✅ Done + wired (5/5) |
| `crossRepoStore.ts` | 284 | `upsertCrossRepoDep`, `getCrossRepoDeps`, `getCrossRepoImpact`, `findPackageConsumers`, `getPackageBridgeStats` | ✅ Done + wired (5/5) |
| `symbolSearch.ts` | 558 | `searchSymbols`, `getSearchSuggestions`, `getSymbolCandidates`, `getContextByName`, `findReferences`, `findCallersByName`, `findSymbolAtLine`, `getSymbolDetail`, `buildFtsQuery`, `extractIntentTokens`, `buildIntentFtsQuery`, `rebuildFts` | ✅ Done + wired (9/9) |
| `impactAnalyzer.ts` | 1,070 | `getImpactSurface`, `getImpactFiles`, `getFileSummary`, `getChangeContext`, `getFileContext`, `getBatchContext`, `getFolderSummary`, `getRouteMap`, `getRepoSchemaSnapshot`, `runReadOnlyGraphQuery`, `listRepositories`, `findModuleSymbolId`, `countUnresolvedEdgesForFile`, `buildReliabilitySummary`, `resolveCanonicalFilePath`, `normalizePath`, `getEdgeDefaults`, `TRIVIAL_CALLEE_TOKENS`, `getRenameImpact`, `traceExecutionFlow`, `groupFilesByModule`, `listIndexedFiles` | ✅ 16/16 wired |
| `docsStore.ts` | 469 | `upsertDocs`, `upsertDocMentions`, `rebuildDocsFts`, `resolveMentions`, `searchDocs`, `findStaleDocs`, `findDocCoverage`, `stringSimilarity`, `levenshteinDistance` | ✅ 7/7 wired |
| `refactorStore.ts` | 347 | `parseRiskFlags`, `saveRefactorPreview`, `getRefactorPreview`, `markRefactorPreviewStatus`, `recordRefactorApply`, `getApplyByRollbackId`, `recordRefactorRollback` | ✅ 6/6 wired |

### Wiring progress tổng hợp

| Module | Delegate | Chưa wire | Tổng |
|--------|----------|-----------|------|
| edgeResolver.ts | 6 | 0 | 6 |
| staticAnalyzer.ts | 5 | 0 | 5 |
| crossRepoStore.ts | 5 | 0 | 5 |
| symbolSearch.ts | 9 | 0 | 9 |
| impactAnalyzer.ts | 16 | 0 | 16 |
| docsStore.ts | 7 | 0 | 7 |
| refactorStore.ts | 6 | 0 | 6 |
| **Tổng** | **54** | **0** | **54** |

### Dead private methods đã xóa

6 private methods đã xóa khỏi graphStore.ts (thay bằng comment trỏ module):
- `stringSimilarity`, `levenshteinDistance` → docsStore.ts
- `buildFtsQuery`, `extractIntentTokens`, `buildIntentFtsQuery` → symbolSearch.ts
- `countUnresolvedEdgesForFile` → impactAnalyzer.ts

---

## Remaining Work

### Phase 3-wire (tiếp): Wire 9 methods còn lại

**Status**: ✅ Done (54/54 methods đã delegate). Verification pass: `npx tsc --noEmit`, `npm run build`, `node scripts/test-refactor-engine.mjs` (39/39).

| # | Method | Target Module | Trạng thái |
|---|--------|---------------|-----------|
| 1 | `resolveMentions` | docsStore.ts | ✅ Wired |
| 2 | `searchDocs` | docsStore.ts | ✅ Wired |
| 3 | `findStaleDocs` | docsStore.ts | ✅ Wired |
| 4 | `findDocCoverage` | docsStore.ts | ✅ Wired |
| 5 | `getRenameImpact` | impactAnalyzer.ts | ✅ Wired |
| 6 | `traceExecutionFlow` | impactAnalyzer.ts | ✅ Wired |
| 7 | `groupFilesByModule` | impactAnalyzer.ts | ✅ Wired |
| 8 | `listIndexedFiles` | impactAnalyzer.ts | ✅ Wired |
| 9 | `recordRefactorRollback` | refactorStore.ts | ✅ Wired |

**Lưu ý đặc biệt**:
- `searchDocs` → `searchDocsImpl` nhận thêm 2 callback: `buildFtsQuery`, `buildIntentFtsQuery` (đã import từ symbolSearch.ts)
- Các method còn lại theo pattern chuẩn: `xxxImpl(this.db, ...params)`

**Kết quả giảm**: `graphStore.ts` xuống ~1,257 dòng

**Verify**: `npx tsc --noEmit` → 0 errors, `npm run build` → pass, `node scripts/test-refactor-engine.mjs` → 39/39

### Phase 4: Split treeSitterExtractor.ts ✅ Completed (978 dòng còn lại)

Tách thành per-language extractors:
- `extractors/jsExtractor.ts` — JavaScript/TypeScript extraction ✅
- `extractors/csharpExtractor.ts` — C# extraction ✅
- `extractors/pythonExtractor.ts` — Python extraction ✅
- `treeSitterExtractor.ts` — orchestrator + shared utilities

**Tiến độ hiện tại**:
- Đã tạo: `src/extractors/pythonExtractor.ts`, `src/extractors/jsExtractor.ts`
- Đã tạo thêm: `src/extractors/csharpExtractor.ts`
- `treeSitterExtractor.ts` đã delegate Python/JS/C# sang `*Impl`
- Verify sau mỗi bước đều pass: `npx tsc --noEmit`, `npm run build`, `node scripts/test-refactor-engine.mjs` (39/39)
- **Phase 4: Completed** (đã tách `extractCSharpSymbols`, `extractCSharpRoutes`, endpoint contract emit + C# route helpers)

### Phase 5: Extract tool handlers từ index.ts

`index.ts` (3,478 dòng) vẫn chứa:
- 30+ tool schema definitions (ListTools handler)
- 30+ case switch dispatch (CallTool handler)

Tách thành:
- `handlers/` directory — mỗi tool group 1 file handler
- `toolDefinitions.ts` — tool schemas (deferred vì schemas reference module-level constants)

### Phase 6: Fix MCP-ISSUE-004

Enhance `impactAnalyzer.ts` cho C# owned-state/shim coverage:
- Staleness gate trên impact tools
- Object-initializer usage edges
- Reliability scoring improvements
- Target: `unresolvedRatio` < 0.05 cho Conversation.cs

---

## Đánh giá tiến độ

### Đã hoàn thành

1. **Phase 1** — Extract 6 utility modules từ index.ts (envConfig, gitHelpers, responseFormatter, refactorTypes, refactorUtils, refactorEngine) ✅
2. **Phase 3a** — Extract edgeResolver.ts (6 resolve methods) ✅
3. **Phase 3b** — Extract staticAnalyzer.ts (5 analysis methods) ✅
4. **Phase 3c-3e** — Extract docsStore, refactorStore, crossRepoStore, symbolSearch, impactAnalyzer (tạo file + import) ✅
5. **Phase 3-wire** — Fix 14 type errors (this.xxx → standalone calls) ✅
6. **Phase 3-cleanup** — Xóa 6 dead private methods ✅
7. **Phase 3-wire (bulk)** — Wire 26/35 methods thành delegate calls ✅
8. **Phase 3-wire (final)** — Wire nốt 9/9 methods còn lại, đạt 54/54 delegate ✅
9. **Phase 4** — Extract Python + JavaScript + C# khỏi `treeSitterExtractor.ts` ✅

### Kết quả đạt được

- `graphStore.ts`: **5,488 → 1,216 dòng** (-78%)
- `index.ts`: **5,152 → 3,478 dòng** (-32%)
- Tổng 13 modules mới, 54/54 methods đã delegate
- 0 type errors, 39/39 tests pass
- Không có circular dependencies

### Rủi ro còn lại

| Rủi ro | Mức | Giải pháp |
|--------|-----|-----------|
| Delegate wrappers có thể lệch signature khi module đổi | Thấp | Giữ typecheck/build/test trong CI để bắt drift sớm |
| `searchDocsImpl` nhận callback — coupling nhẹ | Thấp | Chấp nhận, callback pattern rõ ràng |
| Phase 4 tách C# có nhiều helper phụ thuộc (route + contract edge) | Trung bình | Tách theo cụm nhỏ, verify mỗi cụm bằng tsc/build/tests |

---

## Open Issues

| Issue | Mô tả | Status |
|-------|--------|--------|
| MCP-ISSUE-004 | Impact coverage gaps cho C# owned-state/shim patterns | Open — Phase 6 |
| MCP-ISSUE-005 | External contract impact (MassTransit consumers) | Open |
| MCP-ISSUE-006 | Package update impact (NuGet symbol bridge) | Open |
| MCP-ISSUE-2026-05-08-JSONKEY-SCAN | String literal JSON key detection | Open |

## Key Decisions

1. **Composition over inheritance** — GraphStore methods extracted as standalone `export function xxx(db, ...)`, GraphStore giữ thin delegate wrappers
2. **Phase 2 deferred** — tool schemas/ListTools extraction là cosmetic, schemas reference module-level constants
3. **Local wrappers for module-state** — `asText()` trong index.ts wraps `asTextCore()` để inject `toolContextStorage`, `TELEMETRY_ENABLED`, `TELEMETRY_SAMPLE_RATE`
4. **Stash before risky ops** — luôn stash trước operations có thể cần rollback
5. **Wire trước, cleanup sau** — Wire delegate calls trước, xóa dead code sau khi verify

## Commands

```bash
# Typecheck
npx tsc --noEmit

# Build
npm run build

# Test regression (39 tests)
node scripts/test-refactor-engine.mjs

# Stash checkpoint
git add -A && git stash push -m "checkpoint: <description>"

# Pop stash
git stash pop
```

## File Map

```
codebase-index-mcp/src/
├── index.ts                 # 3,478 — MCP entrypoint, tool schemas, dispatch
├── graphStore.ts            # 1,257 — Core CRUD, schema, migrations + thin delegates
├── treeSitterExtractor.ts   #   978 — Orchestrator + shared utilities
├── extractors/csharpExtractor.ts #  228 — C# extraction
├── extractors/jsExtractor.ts #   240 — JavaScript/TypeScript extraction
├── extractors/pythonExtractor.ts #   96 — Python extraction
├── impactAnalyzer.ts        # 1,070 — Impact/context/flow analysis
├── staticAnalyzer.ts        #   957 — Dead code, circular deps, entry points
├── refactorEngine.ts        #   564 — Preview/apply/migration engine
├── symbolSearch.ts          #   558 — FTS search, candidates, references
├── indexPipeline.ts         #   549 — Index orchestration pipeline
├── edgeResolver.ts          #   536 — Edge resolution (imports/calls/types/properties)
├── docsStore.ts             #   469 — Docs CRUD, FTS, mention resolution
├── refactorUtils.ts         #   435 — Refactor utilities, crypto, parsing
├── refactorStore.ts         #   347 — Refactor preview/apply/rollback persistence
├── crossRepoStore.ts        #   284 — Cross-repo deps, package consumers
├── types.ts                 #   243 — Shared type definitions
├── watchManager.ts          #   210 — File watcher for incremental re-index
├── gitHelpers.ts            #   193 — Git operations
├── markdownParser.ts        #   158 — Markdown doc extraction
├── extractionWorkerPool.ts  #   154 — Worker pool for parallel extraction
├── fileFilter.ts            #   151 — Binary/noisy file filtering
├── dotnetProjectParser.ts   #   140 — .csproj/.sln parsing
├── sqliteGuardrails.ts      #   124 — SQL safety validation
├── responseFormatter.ts     #   101 — Response formatting, telemetry
├── indexGuardrails.ts       #    99 — Index safety bounds
├── refactorTypes.ts         #    77 — Refactor type definitions
├── extractionWorker.ts      #    49 — Worker thread entry
├── envConfig.ts             #    39 — Environment config parsing
└── vendor.d.ts              #     6 — Vendor type declarations
```
