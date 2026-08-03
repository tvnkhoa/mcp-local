/**
 * The standard-structure move map (one entry per server).
 *
 * Target layout, and the rule that decides which folder a file belongs in:
 *
 *   tools/         MCP tool definitions (name, description, JSON Schema) and the
 *                  handlers that implement them.
 *   resources/     MCP resource providers — `resources/list` + `resources/read`.
 *   prompts/       MCP prompt definitions.
 *   middleware/    Cross-cutting call-pipeline concerns: guardrails, response
 *                  serialization, error mapping.
 *   services/      Domain logic. Nested by sub-domain where one already existed.
 *   repositories/  Data access and persistence.
 *   config/        Configuration loading.
 *   types/         Shared type and schema declarations.
 *   index.ts       Entry point.
 *
 * A folder with no content in a given server is absent rather than empty — the
 * same rule target-architecture.md §S2 already applies.
 *
 * Keys and values are paths relative to `<server>/src/`. A file not listed here
 * stays where it is; its imports are still rewritten to follow files that moved.
 */

/** @type {Record<string, Record<string, string>>} */
export const MOVE_MAP = {
  "bitbucket-mcp": {
    "tools.ts": "tools/index.ts",
    "tools.test.ts": "tools/tools.test.ts",
    "bitbucketClient.ts": "services/bitbucketClient.ts",
    "errors.ts": "middleware/errors.ts",
    "response/responseFormatter.ts": "middleware/responseFormatter.ts",
    "response/responseFormatter.test.ts": "middleware/responseFormatter.test.ts"
  },

  "observe-mcp": {
    "tools.ts": "tools/index.ts",
    "tools.test.ts": "tools/tools.test.ts",
    "observeClient.ts": "services/observeClient.ts",
    "queryBuilder.ts": "services/queryBuilder.ts",
    "queryBuilder.test.ts": "services/queryBuilder.test.ts",
    "logParser.ts": "services/logParser.ts",
    "logParser.test.ts": "services/logParser.test.ts",
    "errors.ts": "middleware/errors.ts",
    "guardrails/sqlGuardrails.ts": "middleware/sqlGuardrails.ts",
    "guardrails/sqlGuardrails.test.ts": "middleware/sqlGuardrails.test.ts",
    "response/responseFormatter.ts": "middleware/responseFormatter.ts",
    "response/responseFormatter.test.ts": "middleware/responseFormatter.test.ts"
  },

  "postgres-mcp": {
    // Tool handlers join the definitions they implement.
    "write/writeHandlers.ts": "tools/handlers/writeHandlers.ts",
    "migration/migrationHandlers.ts": "tools/handlers/migrationHandlers.ts",

    // Domain logic behind those handlers.
    "write/approval.ts": "services/write/approval.ts",
    "write/approval.test.ts": "services/write/approval.test.ts",
    "write/auditLog.ts": "services/write/auditLog.ts",
    "write/previewStore.ts": "services/write/previewStore.ts",
    "migration/efRunner.ts": "services/migration/efRunner.ts",
    "migration/schemaSnapshot.ts": "services/migration/schemaSnapshot.ts",

    // Data access.
    "db/connectionManager.ts": "repositories/connectionManager.ts",
    "db/introspection.ts": "repositories/introspection.ts",

    // Cross-cutting.
    "errors.ts": "middleware/errors.ts",
    "guardrails/ident.ts": "middleware/ident.ts",
    "guardrails/sqlGuardrails.ts": "middleware/sqlGuardrails.ts",
    "guardrails/sqlGuardrails.test.ts": "middleware/sqlGuardrails.test.ts",
    "guardrails/writeGuardrails.ts": "middleware/writeGuardrails.ts",
    "response/responseFormatter.ts": "middleware/responseFormatter.ts",
    "response/responseFormatter.test.ts": "middleware/responseFormatter.test.ts"
  },

  "codebase-index-mcp": {
    // --- tools/ : handlers join the definitions they implement -------------
    "handlers/analysisHandler.ts": "tools/handlers/analysisHandler.ts",
    "handlers/bundleHandler.ts": "tools/handlers/bundleHandler.ts",
    "handlers/crossRepoHandler.ts": "tools/handlers/crossRepoHandler.ts",
    "handlers/handlerContext.ts": "tools/handlers/handlerContext.ts",
    "handlers/impactHandler.ts": "tools/handlers/impactHandler.ts",
    "handlers/indexHandler.ts": "tools/handlers/indexHandler.ts",
    "handlers/orientHandler.ts": "tools/handlers/orientHandler.ts",
    "handlers/persistenceHandler.ts": "tools/handlers/persistenceHandler.ts",
    "handlers/refactorApplyGate.ts": "tools/handlers/refactorApplyGate.ts",
    "handlers/refactorApplyHandlers.ts": "tools/handlers/refactorApplyHandlers.ts",
    "handlers/refactorHandler.ts": "tools/handlers/refactorHandler.ts",
    "handlers/refactorMigrationHandlers.ts": "tools/handlers/refactorMigrationHandlers.ts",
    "handlers/refactorPreviewHandlers.ts": "tools/handlers/refactorPreviewHandlers.ts",
    "handlers/searchHandler.ts": "tools/handlers/searchHandler.ts",
    "handlers/traceHandler.ts": "tools/handlers/traceHandler.ts",

    // --- resources/ : the `repo://` provider -------------------------------
    "handlers/resourceHandler.ts": "resources/resourceHandler.ts",

    // --- repositories/ : SQLite persistence --------------------------------
    "store/crossRepoStore.ts": "repositories/crossRepoStore.ts",
    "store/docsStore.ts": "repositories/docsStore.ts",
    "store/graphQueries.ts": "repositories/graphQueries.ts",
    "store/graphStore.ts": "repositories/graphStore.ts",
    "store/literalsStore.ts": "repositories/literalsStore.ts",
    "store/refactorStore.ts": "repositories/refactorStore.ts",
    "store/runStore.ts": "repositories/runStore.ts",
    "store/schema.ts": "repositories/schema.ts",
    "store/vectorStore.ts": "repositories/vectorStore.ts",
    "store/vectorStore.test.ts": "repositories/vectorStore.test.ts",
    "store/writeStore.ts": "repositories/writeStore.ts",

    // --- middleware/ : guardrails, serialization, error mapping ------------
    "errorHandler.ts": "middleware/errorHandler.ts",
    "guardrails/indexGuardrails.ts": "middleware/indexGuardrails.ts",
    "guardrails/sqliteGuardrails.ts": "middleware/sqliteGuardrails.ts",
    "response/coverage.ts": "middleware/coverage.ts",
    "response/responseFormatter.ts": "middleware/responseFormatter.ts",

    // --- types/ : shared declarations --------------------------------------
    "types.ts": "types/index.ts",
    "vendor.d.ts": "types/vendor.d.ts",
    "schemas/graphImpact.ts": "types/schemas/graphImpact.ts",
    "schemas/indexingWatch.ts": "types/schemas/indexingWatch.ts",
    "schemas/readMetadata.ts": "types/schemas/readMetadata.ts",
    "schemas/refactor.ts": "types/schemas/refactor.ts",
    "schemas/search.ts": "types/schemas/search.ts",
    "schemas/shared.ts": "types/schemas/shared.ts",
    "schemas/toolSchemas.ts": "types/schemas/toolSchemas.ts",

    // --- services/ : domain logic, sub-domains preserved -------------------
    "gitHelpers.ts": "services/gitHelpers.ts",

    "analysis/conventions.ts": "services/analysis/conventions.ts",
    "analysis/efPersistence.ts": "services/analysis/efPersistence.ts",
    "analysis/orient.ts": "services/analysis/orient.ts",
    "analysis/policyResolver.ts": "services/analysis/policyResolver.ts",
    "analysis/staticAnalyzer.ts": "services/analysis/staticAnalyzer.ts",
    "analysis/staticAnalyzerCycles.ts": "services/analysis/staticAnalyzerCycles.ts",
    "analysis/staticAnalyzerDeadCode.ts": "services/analysis/staticAnalyzerDeadCode.ts",
    "analysis/staticAnalyzerDeadCode.test.ts": "services/analysis/staticAnalyzerDeadCode.test.ts",
    "analysis/staticAnalyzerDeadCodeCSharp.ts": "services/analysis/staticAnalyzerDeadCodeCSharp.ts",
    "analysis/staticAnalyzerDeadCodeCSharp.test.ts": "services/analysis/staticAnalyzerDeadCodeCSharp.test.ts",
    "analysis/staticAnalyzerDiscovery.ts": "services/analysis/staticAnalyzerDiscovery.ts",
    "analysis/staticAnalyzerNameAffinity.ts": "services/analysis/staticAnalyzerNameAffinity.ts",
    "analysis/valueContract.ts": "services/analysis/valueContract.ts",
    "analysis/valueRepresentation.ts": "services/analysis/valueRepresentation.ts",

    "extractors/csharpExtractor.ts": "services/extractors/csharpExtractor.ts",
    "extractors/csharpPropertyEdges.ts": "services/extractors/csharpPropertyEdges.ts",
    "extractors/csharpRoutes.ts": "services/extractors/csharpRoutes.ts",
    "extractors/csharpSymbols.ts": "services/extractors/csharpSymbols.ts",
    "extractors/csharpTypeRefs.ts": "services/extractors/csharpTypeRefs.ts",
    "extractors/dotnetProjectParser.ts": "services/extractors/dotnetProjectParser.ts",
    "extractors/extractionWorker.ts": "services/extractors/extractionWorker.ts",
    "extractors/extractionWorkerPool.ts": "services/extractors/extractionWorkerPool.ts",
    "extractors/extractorCSharpScope.ts": "services/extractors/extractorCSharpScope.ts",
    "extractors/extractorEdges.ts": "services/extractors/extractorEdges.ts",
    "extractors/extractorJsCalls.ts": "services/extractors/extractorJsCalls.ts",
    "extractors/extractorPrimitives.ts": "services/extractors/extractorPrimitives.ts",
    "extractors/extractorRoutes.ts": "services/extractors/extractorRoutes.ts",
    "extractors/extractorTypes.ts": "services/extractors/extractorTypes.ts",
    "extractors/extractorUtils.ts": "services/extractors/extractorUtils.ts",
    "extractors/jsExtractor.ts": "services/extractors/jsExtractor.ts",
    "extractors/literalExtractor.ts": "services/extractors/literalExtractor.ts",
    "extractors/markdownParser.ts": "services/extractors/markdownParser.ts",
    "extractors/protoExtractor.ts": "services/extractors/protoExtractor.ts",
    "extractors/pythonExtractor.ts": "services/extractors/pythonExtractor.ts",
    "extractors/treeSitterExtractor.ts": "services/extractors/treeSitterExtractor.ts",

    "graph/edgeResolver.ts": "services/graph/edgeResolver.ts",
    "graph/edgeResolverCalls.ts": "services/graph/edgeResolverCalls.ts",
    "graph/edgeResolverContracts.ts": "services/graph/edgeResolverContracts.ts",
    "graph/edgeResolverImports.ts": "services/graph/edgeResolverImports.ts",
    "graph/edgeResolverRefs.ts": "services/graph/edgeResolverRefs.ts",
    "graph/edgeResolverShared.ts": "services/graph/edgeResolverShared.ts",
    "graph/graphTraversal.ts": "services/graph/graphTraversal.ts",
    "graph/interfaceSiblings.ts": "services/graph/interfaceSiblings.ts",

    "impact/changeAnalysis.ts": "services/impact/changeAnalysis.ts",
    "impact/impactAnalyzer.ts": "services/impact/impactAnalyzer.ts",
    "impact/impactFileContext.ts": "services/impact/impactFileContext.ts",
    "impact/impactRenameTrace.ts": "services/impact/impactRenameTrace.ts",
    "impact/impactRepoSummaries.ts": "services/impact/impactRepoSummaries.ts",
    "impact/impactShared.ts": "services/impact/impactShared.ts",
    "impact/impactSurface.ts": "services/impact/impactSurface.ts",

    "indexing/fileFilter.ts": "services/indexing/fileFilter.ts",
    "indexing/fileFilter.test.ts": "services/indexing/fileFilter.test.ts",
    "indexing/fileScan.ts": "services/indexing/fileScan.ts",
    "indexing/indexPipeline.ts": "services/indexing/indexPipeline.ts",
    "indexing/indexProgress.ts": "services/indexing/indexProgress.ts",
    "indexing/indexRunner.ts": "services/indexing/indexRunner.ts",
    "indexing/runFinalize.ts": "services/indexing/runFinalize.ts",
    "indexing/runLimits.ts": "services/indexing/runLimits.ts",
    "indexing/runPolicy.ts": "services/indexing/runPolicy.ts",
    "indexing/runPolicy.test.ts": "services/indexing/runPolicy.test.ts",

    "refactor/refactorApplyPlan.ts": "services/refactor/refactorApplyPlan.ts",
    "refactor/refactorCompilerAssist.ts": "services/refactor/refactorCompilerAssist.ts",
    "refactor/refactorEngine.ts": "services/refactor/refactorEngine.ts",
    "refactor/refactorPreviewBuild.ts": "services/refactor/refactorPreviewBuild.ts",
    "refactor/refactorSymbolMigration.ts": "services/refactor/refactorSymbolMigration.ts",
    "refactor/refactorTypes.ts": "services/refactor/refactorTypes.ts",
    "refactor/refactorUtils.ts": "services/refactor/refactorUtils.ts",

    "search/regexSearch.ts": "services/search/regexSearch.ts",
    "search/symbolSearch.ts": "services/search/symbolSearch.ts",
    "search/symbolSearchCandidates.ts": "services/search/symbolSearchCandidates.ts",
    "search/symbolSearchContextPack.ts": "services/search/symbolSearchContextPack.ts",
    "search/symbolSearchFts.ts": "services/search/symbolSearchFts.ts",
    "search/symbolSearchQuery.ts": "services/search/symbolSearchQuery.ts",
    "search/symbolSearchResolve.ts": "services/search/symbolSearchResolve.ts",

    "watch/watchLifecycle.ts": "services/watch/watchLifecycle.ts",
    "watch/watchManager.ts": "services/watch/watchManager.ts"
  }
};
