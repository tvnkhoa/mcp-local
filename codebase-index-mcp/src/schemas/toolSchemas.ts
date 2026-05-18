/**
 * Zod validation schemas for all MCP tools
 * Extracted from index.ts for better organization and reusability
 */

import { z } from "zod";

// Response profile schema used across multiple tools
export const responseProfileSchema = z.enum(["nano", "compact", "standard", "verbose"]);

// Health check
export const healthCheckSchema = z
  .object({
    repoId: z.string().min(1).max(200).optional()
  })
  .strict();

// Index repository
export const indexRepositorySchema = (MAX_FILES_PER_RUN: number) => z
  .object({
    repoId: z.string().min(1).max(200),
    repoPath: z.string().min(1),
    mode: z.enum(["full", "incremental"]).default("incremental"),
    docsMode: z.enum(["auto", "on", "off"]).default("auto"),
    maxFiles: z.number().int().min(1).max(MAX_FILES_PER_RUN).default(MAX_FILES_PER_RUN),
    batchSize: z.number().int().min(1).max(2_000).default(200)
  })
  .strict();

// Dependency graph
export const getDependencyGraphSchema = (MAX_DEPTH: number, MAX_RESULT_LIMIT: number) => z
  .object({
    repoId: z.string().min(1).max(200),
    symbolId: z.string().min(1).max(200).optional(),
    filePath: z.string().min(1).optional(),
    depth: z.number().int().min(1).max(MAX_DEPTH).default(1),
    limit: z.number().int().min(1).max(MAX_RESULT_LIMIT).default(100)
  })
  .strict()
  .refine((v) => Boolean(v.symbolId || v.filePath), {
    message: "symbolId or filePath is required",
    path: ["symbolId"]
  });

// Call chain
export const getCallChainSchema = (MAX_DEPTH: number, MAX_RESULT_LIMIT: number) => z
  .object({
    repoId: z.string().min(1).max(200),
    symbolId: z.string().min(1).max(200),
    direction: z.enum(["callers", "callees"]).default("callees"),
    depth: z.number().int().min(1).max(MAX_DEPTH).default(1),
    limit: z.number().int().min(1).max(MAX_RESULT_LIMIT).default(100)
  })
  .strict();

// List repositories
export const listRepositoriesSchema = z.object({}).strict();

// Search symbols
export const searchSymbolsSchema = (MAX_RESULT_LIMIT: number) => z
  .object({
    query: z.string().min(1).max(200),
    repoId: z.string().min(1).max(200).optional(),
    language: z.string().max(50).optional(),
    kind: z.string().max(50).optional(),
    filePath: z.string().max(500).optional(),
    strategy: z.enum(["name", "intent"]).default("name"),
    limit: z.number().int().min(1).max(MAX_RESULT_LIMIT).default(50),
    compact: z.boolean().default(false),
    profile: responseProfileSchema.default("compact"),
    ranked: z.boolean().default(false)
  })
  .strict();

// File context
export const getFileContextSchema = (MAX_RESULT_LIMIT: number) => z
  .object({
    repoId: z.string().min(1).max(200),
    filePath: z.string().min(1).optional(),
    filePaths: z.array(z.string().min(1)).min(1).max(50).optional(),
    limit: z.number().int().min(1).max(MAX_RESULT_LIMIT).default(200),
    compact: z.boolean().default(false),
    profile: responseProfileSchema.default("standard")
  })
  .strict()
  .refine((v) => Boolean(v.filePath || v.filePaths), {
    message: "filePath or filePaths is required",
    path: ["filePath"]
  });

// Symbol detail
export const getSymbolDetailSchema = (MAX_RESULT_LIMIT: number) => z
  .object({
    repoId: z.string().min(1).max(200),
    symbolId: z.string().min(1).max(200),
    limit: z.number().int().min(1).max(MAX_RESULT_LIMIT).default(100)
  })
  .strict();

// Impact files
export const findImpactFilesSchema = (MAX_RESULT_LIMIT: number) => z
  .object({
    repoId: z.string().min(1).max(200),
    filePath: z.string().min(1),
    limit: z.number().int().min(1).max(MAX_RESULT_LIMIT).default(50),
    groupBy: z.enum(["file", "module"]).default("file"),
    view: z.enum(["files", "surface"]).default("files")
  })
  .strict();

// Change context
export const getChangeContextSchema = (MAX_DEPTH: number, MAX_RESULT_LIMIT: number) => z
  .object({
    repoId: z.string().min(1).max(200),
    symbolId: z.string().min(1).max(200).optional(),
    name: z.string().min(1).max(200).optional(),
    callerDepth: z.number().int().min(1).max(MAX_DEPTH).default(2),
    calleeDepth: z.number().int().min(1).max(MAX_DEPTH).default(1),
    limit: z.number().int().min(1).max(MAX_RESULT_LIMIT).default(20),
    profile: responseProfileSchema.default("standard")
  })
  .strict()
  .refine((v) => Boolean(v.symbolId || v.name), {
    message: "symbolId or name is required",
    path: ["symbolId"]
  });

// File summary
export const getFileSummarySchema = z
  .object({
    repoId: z.string().min(1).max(200),
    filePath: z.string().min(1)
  })
  .strict();

// Find symbol at line
export const findSymbolAtLineSchema = z
  .object({
    repoId: z.string().min(1).max(200),
    filePath: z.string().min(1),
    line: z.number().int().min(1)
  })
  .strict();

// Query docs
export const queryDocsSchema = (MAX_RESULT_LIMIT: number) => z
  .object({
    repoId: z.string().min(1).max(200),
    mode: z.enum(["search", "stale", "coverage"]),
    query: z.string().min(1).max(200).optional(),
    symbolIds: z.array(z.string().min(1).max(200)).min(1).max(100).optional(),
    filePath: z.string().min(1).optional(),
    limit: z.number().int().min(1).max(MAX_RESULT_LIMIT).default(20)
  })
  .strict()
  .refine(
    (v) => {
      if (v.mode === "search") return Boolean(v.query);
      if (v.mode === "stale") return Boolean(v.symbolIds);
      if (v.mode === "coverage") return Boolean(v.filePath);
      return true;
    },
    (v) => ({
      message: v.mode === "search" ? "query is required for mode=search" : v.mode === "stale" ? "symbolIds is required for mode=stale" : "filePath is required for mode=coverage",
      path: ["query"]
    })
  );

// Symbol context pack
export const getSymbolContextPackSchema = (MAX_DEPTH: number, MAX_RESULT_LIMIT: number) => z
  .object({
    repoId: z.string().min(1).max(200),
    name: z.string().min(1).max(200),
    callerDepth: z.number().int().min(1).max(MAX_DEPTH).default(2),
    calleeDepth: z.number().int().min(1).max(MAX_DEPTH).default(1),
    limit: z.number().int().min(1).max(MAX_RESULT_LIMIT).default(20),
    profile: responseProfileSchema.default("compact")
  })
  .strict();

// Detect changes
export const detectChangesSchema = (MAX_RESULT_LIMIT: number) => z
  .object({
    repoId: z.string().min(1).max(200),
    baseRef: z.string().min(1).max(100).optional(),
    headRef: z.string().min(1).max(100).default("HEAD"),
    includeUntracked: z.boolean().default(true),
    maxFiles: z.number().int().min(1).max(500).default(100),
    impactLimit: z.number().int().min(1).max(MAX_RESULT_LIMIT).default(20),
    policy: z.enum(["quick-triage", "strict-review", "release-gate", "custom"]).default("custom"),
    minRiskScore: z.number().int().min(0).max(100).optional(),
    riskLevels: z.array(z.enum(["high", "medium", "low"])).min(1).max(3).optional(),
    maxResults: z.number().int().min(1).max(500).optional(),
    sortBy: z.enum(["risk", "impact", "path"]).optional(),
    groupBy: z.enum(["file", "module"]).default("file"),
    profile: responseProfileSchema.default("compact")
  })
  .strict();

// Dead code scan
export const deadCodeScanSchema = (MAX_RESULT_LIMIT: number) => z
  .object({
    repoId: z.string().min(1).max(200),
    filePathPrefix: z.string().max(500).optional(),
    language: z.string().max(50).optional(),
    kind: z.string().max(50).optional(),
    includePrivate: z.boolean().default(false),
    limit: z.number().int().min(1).max(MAX_RESULT_LIMIT).default(100),
    profile: responseProfileSchema.default("compact")
  })
  .strict();

// Detect circular dependencies
export const detectCircularDependenciesSchema = (MAX_DEPTH: number, MAX_RESULT_LIMIT: number) => z
  .object({
    repoId: z.string().min(1).max(200),
    filePathPrefix: z.string().max(500).optional(),
    mode: z.enum(["module", "symbol"]).default("module"),
    includeCalls: z.boolean().default(false),
    maxDepth: z.number().int().min(2).max(MAX_DEPTH).default(Math.min(4, MAX_DEPTH)),
    maxCycles: z.number().int().min(1).max(200).default(50),
    profile: responseProfileSchema.default("compact")
  })
  .strict();

// Cross repo impact
export const crossRepoImpactSchema = (MAX_RESULT_LIMIT: number) => z
  .object({
    repoId: z.string().min(1).max(200),
    symbolId: z.string().min(1).max(200).optional(),
    name: z.string().min(1).max(200).optional(),
    direction: z.enum(["outbound", "inbound"]).default("outbound"),
    limit: z.number().int().min(1).max(MAX_RESULT_LIMIT).default(50),
    profile: responseProfileSchema.default("compact")
  })
  .strict()
  .refine((v) => Boolean(v.symbolId || v.name), {
    message: "symbolId or name is required",
    path: ["symbolId"]
  });

// Find package consumers
export const findPackageConsumersSchema = (MAX_RESULT_LIMIT: number) => z
  .object({
    packageName: z.string().min(1).max(200),
    repoId: z.string().min(1).max(200).optional(),
    limit: z.number().int().min(1).max(MAX_RESULT_LIMIT).default(100),
    profile: responseProfileSchema.default("compact")
  })
  .strict();

// Symbol blame
export const symbolBlameSchema = z
  .object({
    repoId: z.string().min(1).max(200),
    symbolId: z.string().min(1).max(200).optional(),
    name: z.string().min(1).max(200).optional(),
    redactEmail: z.boolean().default(true),
    profile: responseProfileSchema.default("compact")
  })
  .strict()
  .refine((v) => Boolean(v.symbolId || v.name), {
    message: "symbolId or name is required",
    path: ["symbolId"]
  });

// Link tests to source
export const linkTestsToSourceSchema = (MAX_RESULT_LIMIT: number) => z
  .object({
    repoId: z.string().min(1).max(200),
    filePath: z.string().max(500).optional(),
    limit: z.number().int().min(1).max(MAX_RESULT_LIMIT).default(100),
    maxCandidates: z.number().int().min(1).max(20).default(3),
    minScore: z.number().min(0).max(1).default(0.4),
    profile: responseProfileSchema.default("compact")
  })
  .strict();

// Folder summary
export const getFolderSummarySchema = (MAX_RESULT_LIMIT: number) => z
  .object({
    repoId: z.string().min(1).max(200),
    folderPath: z.string().min(1),
    maxFiles: z.number().int().min(1).max(MAX_RESULT_LIMIT).default(100)
  })
  .strict();

// Find entry points
export const findEntryPointsSchema = (MAX_RESULT_LIMIT: number) => z
  .object({
    repoId: z.string().min(1).max(200),
    filePathPrefix: z.string().max(500).optional(),
    kind: z.string().max(50).optional(),
    limit: z.number().int().min(1).max(MAX_RESULT_LIMIT).default(50)
  })
  .strict();

// Find implementations
export const findImplementationsSchema = (MAX_RESULT_LIMIT: number) => z
  .object({
    repoId: z.string().min(1).max(200),
    interfaceName: z.string().min(1).max(200),
    limit: z.number().int().min(1).max(MAX_RESULT_LIMIT).default(50)
  })
  .strict();

// Watch repo
export const watchRepoSchema = z
  .object({
    action: z.enum(["start", "stop", "status"]),
    repoId: z.string().min(1).max(200).optional(),
    repoPath: z.string().min(1).optional()
  })
  .strict();

// Rename assist
export const renameAssistSchema = (MAX_RESULT_LIMIT: number) => z
  .object({
    repoId: z.string().min(1).max(200),
    symbolId: z.string().min(1).max(200),
    newName: z.string().min(1).max(200),
    limit: z.number().int().min(1).max(MAX_RESULT_LIMIT).default(50),
    profile: responseProfileSchema.default("compact")
  })
  .strict();

// Trace execution flow
export const traceExecutionFlowSchema = z
  .object({
    repoId: z.string().min(1).max(200),
    entrySymbolId: z.string().min(1).max(200),
    maxDepth: z.number().int().min(1).max(8).default(4),
    maxNodes: z.number().int().min(1).max(100).default(30),
    profile: responseProfileSchema.default("compact")
  })
  .strict();

// Route map
export const routeMapSchema = (MAX_RESULT_LIMIT: number) => z
  .object({
    repoId: z.string().min(1).max(200),
    filePathPrefix: z.string().max(500).optional(),
    httpMethod: z.enum(["GET", "POST", "PUT", "DELETE", "PATCH"]).optional(),
    limit: z.number().int().min(1).max(MAX_RESULT_LIMIT).default(100),
    profile: responseProfileSchema.default("compact")
  })
  .strict();

// Query graph
const queryGraphParamsValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
export const queryGraphSchema = (MAX_RESULT_LIMIT: number) => z
  .object({
    repoId: z.string().min(1).max(200),
    sql: z.string().min(1).max(10_000),
    params: z.record(queryGraphParamsValueSchema).default({}),
    limit: z.number().int().min(1).max(MAX_RESULT_LIMIT).default(100),
    timeoutMs: z.number().int().min(1).max(30_000).default(5_000),
    profile: responseProfileSchema.default("compact")
  })
  .strict();

// Refactor schemas
export const refactorSymbolKindSchema = z.enum(["class", "property", "field", "method"]);

export const refactorScopeSchema = z
  .object({
    includePaths: z.array(z.string().min(1).max(500)).max(200).default([]),
    excludePaths: z.array(z.string().min(1).max(500)).max(200).default([]),
    fileGlobs: z.array(z.string().min(1).max(500)).max(200).default([])
  })
  .strict()
  .default({ includePaths: [], excludePaths: [], fileGlobs: [] });

export const refactorGuardsSchema = z
  .object({
    language: z.string().min(1).max(50).optional(),
    symbolKinds: z.array(refactorSymbolKindSchema).max(10).default([]),
    allowOwnerTypes: z.array(z.string().min(1).max(200)).max(200).default([]),
    disallowOwnerTypes: z.array(z.string().min(1).max(200)).max(200).default([]),
    disallowTypeList: z.array(z.string().min(1).max(200)).max(200).default([])
  })
  .strict()
  .default({ symbolKinds: [], allowOwnerTypes: [], disallowOwnerTypes: [], disallowTypeList: [] });

export const refactorInitializerRewriteSchema = z
  .object({
    objectProperty: z.string().min(1).max(200),
    objectType: z.string().min(1).max(200),
    targetMember: z.string().min(1).max(200).optional()
  })
  .strict();

export const refactorCompilerDiagnosticSchema = z
  .object({
    code: z.string().min(1).max(20),
    filePath: z.string().min(1).max(500),
    line: z.number().int().min(1).max(2_000_000),
    message: z.string().max(1_000).optional(),
    expectedType: z.string().min(1).max(300).optional(),
    actualType: z.string().min(1).max(300).optional()
  })
  .strict();

export const refactorCompilerAssistSchema = z
  .object({
    diagnostics: z.array(refactorCompilerDiagnosticSchema).max(1_000).default([]),
    codes: z.array(z.string().min(1).max(20)).max(20).default(["CS0029", "CS1503"]),
    lineWindow: z.number().int().min(0).max(20).default(2),
    filePathPrefix: z.string().min(1).max(500).optional()
  })
  .strict();

export const refactorReplacePreviewSchema = z
  .object({
    repoId: z.string().min(1).max(200),
    find: z.string().min(1).max(2_000),
    replaceExpression: z.string().max(2_000),
    scope: refactorScopeSchema,
    guards: refactorGuardsSchema,
    compilerAssist: refactorCompilerAssistSchema.optional(),
    mode: z.enum(["text", "syntax-aware", "symbol-aware"]).default("symbol-aware"),
    ambiguityThresholdPercent: z.number().min(0).max(100).default(1)
  })
  .strict();

export const refactorReplaceApplySchema = z
  .object({
    previewId: z.string().min(1).max(200),
    approvalToken: z.string().min(1).max(2_000),
    maxFilesPerBatch: z.number().int().min(1).max(500).default(50),
    stopOnFirstConflict: z.boolean().default(true),
    includeLowConfidence: z.boolean().default(false)
  })
  .strict();

export const refactorReplaceRollbackSchema = z
  .object({
    rollbackId: z.string().min(1).max(200)
  })
  .strict();

export const refactorSymbolMigrationSchema = z
  .object({
    repoId: z.string().min(1).max(200),
    migrations: z
      .array(
        z
          .object({
            fromSymbol: z.string().min(1).max(500),
            toSymbol: z.string().min(1).max(500),
            requiredOwnerType: z.string().min(1).max(200),
            forbiddenOwnerTypes: z.array(z.string().min(1).max(200)).max(200).default([]),
            initializerRewrite: refactorInitializerRewriteSchema.optional()
          })
          .strict()
      )
      .min(1)
      .max(200),
    scopePaths: z.array(z.string().min(1).max(500)).max(200).default([]),
    dryRun: z.boolean().default(true)
  })
  .strict();
