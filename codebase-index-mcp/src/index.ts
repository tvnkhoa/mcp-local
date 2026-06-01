import process from "node:process";
import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  McpError,
  ErrorCode,
  type CallToolResult
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { GraphStore } from "./graphStore.js";
import { runIndexPipeline, type PerformanceProfile } from "./indexPipeline.js";
import {
  assertPathAllowed,
  clamp,
  parseAllowedRoots,
  parseAutoWatchRepos,
  parseBooleanEnv,
  parseWatchConfigFromEnv
} from "./indexGuardrails.js";
import { validateAllowedTables, validateReadOnlyGraphSql } from "./sqliteGuardrails.js";
import { WatchManager } from "./watchManager.js";
import type {
  CallChainDirection,
  RefactorApplyHunkRecord,
  IndexRunSummary,
  RefactorApplyChangeRecord,
  RefactorApplyRecord,
  RefactorPreviewHunkRecord,
  RefactorPreviewRecord,
  RefactorRiskFlag,
  RefactorRollbackRecord,
  ResolutionStats
} from "./types.js";
import { numberFromEnv, ratioFromEnv, nonNegativeNumberFromEnv, parseOptionalBooleanEnv } from "./envConfig.js";
import {
  runGit,
  runGitLines,
  resolveHeadCommitSha,
  parseGitBlamePorcelain,
  redactEmail,
  getRepoWorkingTreeState,
  hasWorkingTreeChanges,
  collectGitChangedFiles,
  getRepoStaleness
} from "./gitHelpers.js";
import {
  type ResponseProfile,
  type ToolRequestContext,
  type ToolTelemetryEvent,
  resolveResponseProfile,
  estimateResultCount,
  emitTelemetry,
  asText as asTextCore,
  asArgsRecord,
  toNugetContractId
} from "./responseFormatter.js";
import {
  PolicyViolationError,
  normalizeRelativePath,
  sha256,
  safeReadText,
  assertSafeRepoFilePath,
  inferLanguageFromPath,
  isGeneratedFilePath,
  findEnclosingObjectInitializer,
  isApplyRunnableHunk,
  collectExpectedApplyFiles,
  countPreviewRisks,
  createPreviewDigest,
  issueApprovalToken,
  verifyApprovalToken,
  groupPreviewHunks,
  mapPreviewStatusFromApplyStatus,
  deriveApplyStatus,
  noLlmAudit,
  resolveApprovalSecret
} from "./refactorUtils.js";
import {
  buildRefactorPreview,
  applyCompilerAssistToPreview,
  buildSymbolMigrationPreview,
  executeRefactorApplyPlan
} from "./refactorEngine.js";
import { scoreChangeRisk, resolveDetectChangesPolicy } from "./policyResolver.js";
import { resolveServerVersion, parseRepoResourceUri } from "./serverUtils.js";
import { resolveDocsMode as resolveDocsModeUtil, assertDocsLaneEnabled as assertDocsLaneEnabledUtil } from "./docsUtils.js";
import { mapError, assertNoLlmRuntimePolicy, assertRefactorApprovalPolicy } from "./errorHandler.js";
import * as schemas from "./schemas/toolSchemas.js";
import { handleListResources, handleReadResource } from "./handlers/resourceHandler.js";
import { traverseDependencyGraph, traverseCallGraph } from "./graphTraversal.js";
import { parsePerformanceProfileEnv, resolvePostPhasePolicy } from "./performanceConfig.js";

import {
  handleHealthCheck,
  handleIndexRepository,
  handleWatchRepo,
  handleDetectChanges,
  resolveDocsMode,
  activateWatchForRepo as activateWatchForRepoFn,
  armWatchInactivityTimer as armWatchInactivityTimerFn,
  clearWatchInactivityTimer as clearWatchInactivityTimerFn
} from "./handlers/indexHandler.js";
import type { HandlerContext } from "./handlers/handlerContext.js";
import {
  handleSearchSymbols,
  handleFindSymbolAtLine,
  handleGetSymbolDetail,
  handleGetSymbolContextPack,
  handleGetSymbolBlame
} from "./handlers/searchHandler.js";
import {
  handleGetDependencyGraph,
  handleGetCallChain,
  handleFindImpactFiles,
  handleGetChangeContext,
  handleGetFileSummary,
  handleListRepositories,
  handleGetFileContext,
  handleGetFolderSummary,
  handleRouteMap,
  handleQueryGraph,
  handleQueryDocs,
  formatChangeContextPayload
} from "./handlers/impactHandler.js";
import {
  handleDeadCodeScan,
  handleDetectCircularDependencies,
  handleFindEntryPoints,
  handleFindImplementations,
  handleLinkTestsToSource
} from "./handlers/analysisHandler.js";
import {
  handleGetCrossRepoImpact,
  handleFindPackageConsumers
} from "./handlers/crossRepoHandler.js";
import {
  handleRenameAssist,
  handleRefactorReplacePreview,
  handleRefactorReplaceApply,
  handleRefactorReplaceRollback,
  handleRefactorSymbolMigration,
  handleTraceExecutionFlow
} from "./handlers/refactorHandler.js";

const dbPath = process.env.CODEBASE_INDEX_DB_PATH ?? "./codebase-index.db";
const allowedRoots = parseAllowedRoots(process.env.CODEBASE_INDEX_ALLOWED_ROOTS);
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

const MAX_FILES_PER_RUN = numberFromEnv("CODEBASE_INDEX_MAX_FILES_PER_RUN", 20_000);
const MAX_RESULT_LIMIT = numberFromEnv("CODEBASE_INDEX_MAX_RESULT_LIMIT", 500);
const MAX_DEPTH = numberFromEnv("CODEBASE_INDEX_MAX_DEPTH", 5);
/** Files per sub-transaction inside a batch. Lower = shorter lock windows; higher = fewer transactions. Default 20. */
const SUBTX_SIZE = numberFromEnv("CODEBASE_INDEX_SUBTX_SIZE", 20);
/** Run WAL checkpoint after every N completed batches. Default 1 = every batch. Increase for very large repos. */
const CHECKPOINT_EVERY_N_BATCHES = numberFromEnv("CODEBASE_INDEX_CHECKPOINT_EVERY_N_BATCHES", 1);
// Route ALL non-markdown files to the worker pool (threshold=0).
// The old default of 512KB exceeded the 500KB fileFilter cap, meaning workers were never used.
const LARGE_FILE_THRESHOLD_BYTES = numberFromEnv("CODEBASE_INDEX_LARGE_FILE_THRESHOLD_BYTES", 0);
/** Hard cap on file size. Default 500KB. Raise (e.g. 2_000_000) for repos with large generated files worth indexing. */
const MAX_FILE_SIZE_BYTES = numberFromEnv("CODEBASE_INDEX_MAX_FILE_SIZE_BYTES", 500_000);
const DEFAULT_PARSE_WORKERS = Math.max(1, Math.floor(os.cpus().length / 2));
const PARSE_WORKERS = numberFromEnv("CODEBASE_INDEX_PARSE_WORKERS", DEFAULT_PARSE_WORKERS);
const PARSE_JOB_TIMEOUT_MS = numberFromEnv("CODEBASE_INDEX_PARSE_JOB_TIMEOUT_MS", 20_000);
const WATCH_AUTO_START = parseBooleanEnv(process.env.CODEBASE_INDEX_WATCH_AUTO_START, false);
const WATCH_ACTIVE_ONLY = parseBooleanEnv(process.env.CODEBASE_INDEX_WATCH_ACTIVE_ONLY, true);
const WATCH_ACTIVE_TTL_MS = clamp(numberFromEnv("CODEBASE_INDEX_WATCH_ACTIVE_TTL_MS", 15 * 60 * 1000), 5_000, 24 * 60 * 60 * 1000);
const AUTO_WATCH_REPOS = parseAutoWatchRepos(process.env.CODEBASE_INDEX_AUTO_WATCH_REPOS);
const watchConfig = parseWatchConfigFromEnv(process.env);
const TELEMETRY_ENABLED = parseBooleanEnv(process.env.CODEBASE_INDEX_TELEMETRY_ENABLED, false);
const TELEMETRY_SAMPLE_RATE = ratioFromEnv(process.env.CODEBASE_INDEX_TELEMETRY_SAMPLE_RATE, 1);
const DOCS_INDEXING_ENABLED = parseBooleanEnv(process.env.CODEBASE_INDEX_DOCS_INDEXING_ENABLED, false);
const DOCS_TOOLS_ENABLED = parseBooleanEnv(process.env.CODEBASE_INDEX_DOCS_TOOLS_ENABLED, false);
const LLM_ENABLED = parseBooleanEnv(process.env.CODEBASE_INDEX_LLM_ENABLED, false);
const REFACTOR_STRICT_APPROVAL = parseBooleanEnv(process.env.CODEBASE_INDEX_REFACTOR_STRICT_APPROVAL, false);
const NODE_ENV = (process.env.NODE_ENV ?? "development").toLowerCase();
const REFACTOR_APPROVAL_SECRET = process.env.CODEBASE_INDEX_REFACTOR_APPROVAL_SECRET ?? "";
const REFACTOR_PREVIEW_TTL_MS = numberFromEnv("CODEBASE_INDEX_REFACTOR_PREVIEW_TTL_MS", 30 * 60 * 1000);
const REFACTOR_LOW_CONFIDENCE_THRESHOLD = 0.8;
const SERVER_VERSION = resolveServerVersion(MODULE_DIR);

const toolContextStorage = new AsyncLocalStorage<ToolRequestContext>();

// Create schema instances with constants
const healthCheckSchema = schemas.healthCheckSchema;
const indexRepositorySchema = schemas.indexRepositorySchema(MAX_FILES_PER_RUN);
const getDependencyGraphSchema = schemas.getDependencyGraphSchema(MAX_DEPTH, MAX_RESULT_LIMIT);
const getCallChainSchema = schemas.getCallChainSchema(MAX_DEPTH, MAX_RESULT_LIMIT);
const listRepositoriesSchema = schemas.listRepositoriesSchema;
const searchSymbolsSchema = schemas.searchSymbolsSchema(MAX_RESULT_LIMIT);
const getFileContextSchema = schemas.getFileContextSchema(MAX_RESULT_LIMIT);
const getSymbolDetailSchema = schemas.getSymbolDetailSchema(MAX_RESULT_LIMIT);
const findImpactFilesSchema = schemas.findImpactFilesSchema(MAX_RESULT_LIMIT);
const getChangeContextSchema = schemas.getChangeContextSchema(MAX_DEPTH, MAX_RESULT_LIMIT);
const getFileSummarySchema = schemas.getFileSummarySchema;
const findSymbolAtLineSchema = schemas.findSymbolAtLineSchema;
const queryDocsSchema = schemas.queryDocsSchema(MAX_RESULT_LIMIT);
const getSymbolContextPackSchema = schemas.getSymbolContextPackSchema(MAX_DEPTH, MAX_RESULT_LIMIT);
const detectChangesSchema = schemas.detectChangesSchema(MAX_RESULT_LIMIT);
const deadCodeScanSchema = schemas.deadCodeScanSchema(MAX_RESULT_LIMIT);
const detectCircularDependenciesSchema = schemas.detectCircularDependenciesSchema(MAX_DEPTH, MAX_RESULT_LIMIT);
const crossRepoImpactSchema = schemas.crossRepoImpactSchema(MAX_RESULT_LIMIT);
const findPackageConsumersSchema = schemas.findPackageConsumersSchema(MAX_RESULT_LIMIT);
const symbolBlameSchema = schemas.symbolBlameSchema;
const linkTestsToSourceSchema = schemas.linkTestsToSourceSchema(MAX_RESULT_LIMIT);
const getFolderSummarySchema = schemas.getFolderSummarySchema(MAX_RESULT_LIMIT);
const findEntryPointsSchema = schemas.findEntryPointsSchema(MAX_RESULT_LIMIT);
const findImplementationsSchema = schemas.findImplementationsSchema(MAX_RESULT_LIMIT);
const watchRepoSchema = schemas.watchRepoSchema;
const renameAssistSchema = schemas.renameAssistSchema(MAX_RESULT_LIMIT);
const traceExecutionFlowSchema = schemas.traceExecutionFlowSchema;
const routeMapSchema = schemas.routeMapSchema(MAX_RESULT_LIMIT);
const queryGraphSchema = schemas.queryGraphSchema(MAX_RESULT_LIMIT);
const refactorReplacePreviewSchema = schemas.refactorReplacePreviewSchema;
const refactorReplaceApplySchema = schemas.refactorReplaceApplySchema;
const refactorReplaceRollbackSchema = schemas.refactorReplaceRollbackSchema;
const refactorSymbolMigrationSchema = schemas.refactorSymbolMigrationSchema;

assertNoLlmRuntimePolicy(LLM_ENABLED);
assertRefactorApprovalPolicy(REFACTOR_STRICT_APPROVAL, REFACTOR_APPROVAL_SECRET);

const server = new Server(
  {
    name: "codebase-index-mcp",
    version: "0.1.0"
  },
  {
    capabilities: {
      tools: {},
      resources: {}
    }
  }
);

const store = new GraphStore(dbPath);

const watchManager = new WatchManager(
  watchConfig,
  async (repoId, repoPath, config) => {
    assertPathAllowed(repoPath, allowedRoots);
    await runIndexAndResolve(repoId, repoPath, "incremental", DOCS_INDEXING_ENABLED, config.maxFilesPerRun, config.batchSize);
  },
  (repoId, deletedRelativePaths) => store.pruneFiles(repoId, deletedRelativePaths),
  ({ repoId }) => {
    if (WATCH_ACTIVE_ONLY && activeWatchRef.current === repoId) {
      armWatchInactivityTimer(repoId);
    }
  }
);

const activeWatchRef = { current: null as string | null };
const watchInactivityTimers = new Map<string, NodeJS.Timeout>();

function buildHandlerContext(): HandlerContext {
  return {
    store,
    watchManager,
    activeWatchRef,
    watchInactivityTimers,
    runIndexAndResolve,
    asText,
    constants: {
      MAX_FILES_PER_RUN,
      MAX_RESULT_LIMIT,
      MAX_DEPTH,
      WATCH_AUTO_START,
      WATCH_ACTIVE_ONLY,
      WATCH_ACTIVE_TTL_MS,
      DOCS_INDEXING_ENABLED,
      DOCS_TOOLS_ENABLED,
      LLM_ENABLED,
      REFACTOR_STRICT_APPROVAL,
      REFACTOR_APPROVAL_SECRET,
      REFACTOR_PREVIEW_TTL_MS,
      REFACTOR_LOW_CONFIDENCE_THRESHOLD,
      SERVER_VERSION,
      dbPath,
      allowedRoots
    }
  };
}

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "health_check",
        description: "Check server availability plus codebase readiness (staleness, working tree, watch state) with action hints for re-index/watch.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            repoId: { type: "string" }
          }
        }
      },
      {
        name: "index_repository",
        description: "Index repository files into internal graph storage (incremental by default). docsMode controls docs lane isolation: auto uses server default, on forces docs indexing, off disables docs indexing for this run.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["repoId", "repoPath"],
          properties: {
            repoId: { type: "string" },
            repoPath: { type: "string" },
            mode: { type: "string", enum: ["full", "incremental"] },
            docsMode: { type: "string", enum: ["auto", "on", "off"] },
            maxFiles: { type: "integer", minimum: 1, maximum: MAX_FILES_PER_RUN },
            batchSize: { type: "integer", minimum: 1, maximum: 2000 }
          }
        }
      },
      {
        name: "get_dependency_graph",
        description: "Get IMPORTS/DEPENDS_ON dependency edges for a symbol (symbolId) or module-level flow edges for a file (filePath). One required. Use profile='nano' for top-10 edge count, 'compact' (default) for all edges with minimal fields.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["repoId"],
          properties: {
            repoId: { type: "string" },
            symbolId: { type: "string" },
            filePath: { type: "string" },
            depth: { type: "integer", minimum: 1, maximum: MAX_DEPTH },
            limit: { type: "integer", minimum: 1, maximum: MAX_RESULT_LIMIT },
            profile: { type: "string", enum: ["nano", "compact", "standard", "verbose"] }
          }
        }
      },
      {
        name: "get_call_chain",
        description: "Trace a call path from a symbolId (direction=callers or callees). Shows the path, not a caller list — use get_change_context for caller lists. Requires a callable symbolId (function/method), not a class. Use profile='nano' for path summary, 'compact' (default) for full edge list.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["repoId", "symbolId"],
          properties: {
            repoId: { type: "string" },
            symbolId: { type: "string" },
            direction: { type: "string", enum: ["callers", "callees"] },
            depth: { type: "integer", minimum: 1, maximum: MAX_DEPTH },
            limit: { type: "integer", minimum: 1, maximum: MAX_RESULT_LIMIT },
            profile: { type: "string", enum: ["nano", "compact", "standard", "verbose"] }
          }
        }
      },
      {
        name: "list_repositories",
        description: "List all indexed repositories. Use profile='nano' for a brief count+status list, omit for full metadata.",
        inputSchema: { type: "object", additionalProperties: false, properties: { profile: { type: "string", enum: ["nano", "compact", "standard", "verbose"] } } }
      },
      {
        name: "search_symbols",
        description: "Search symbols across all repos or a specific repo. strategy=name is strict name/signature matching; strategy=intent uses broader tokenized matching. Use ranked=true to get scored/ranked candidates when a name may map to multiple symbols.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["query"],
          properties: {
            query: { type: "string" },
            repoId: { type: "string" },
            language: { type: "string" },
            kind: { type: "string" },
            filePath: { type: "string" },
            strategy: { type: "string", enum: ["name", "intent"] },
            limit: { type: "integer", minimum: 1, maximum: MAX_RESULT_LIMIT },
            compact: { type: "boolean" },
            profile: { type: "string", enum: ["nano", "compact", "standard", "verbose"] },
            ranked: { type: "boolean" }
          }
        }
      },
      {
        name: "get_file_context",
        description: "Get symbols and graph edges for a file (provide filePath) or multiple files (provide filePaths array). One of filePath or filePaths is required. Use profile=nano for ultra-compact planning output, compact for token-saving, standard for balanced, verbose for debug-rich.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["repoId"],
          properties: {
            repoId: { type: "string" },
            filePath: { type: "string" },
            filePaths: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 50 },
            limit: { type: "integer", minimum: 1, maximum: MAX_RESULT_LIMIT },
            compact: { type: "boolean" },
            profile: { type: "string", enum: ["nano", "compact", "standard", "verbose"] }
          }
        }
      },
      {
        name: "get_symbol_detail",
        description: "Get full detail for a symbol by ID — returns the symbol record plus all outgoing and incoming edges with resolved names. Use after search_symbols to drill into a specific symbol.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["repoId", "symbolId"],
          properties: {
            repoId: { type: "string" },
            symbolId: { type: "string" },
            limit: { type: "integer", minimum: 1, maximum: MAX_RESULT_LIMIT }
          }
        }
      },
      {
        name: "find_impact_files",
        description: "Scope blast radius for a file change. view='files' (default): which files import/call symbols in this file. view='surface': which external symbols call into this file. Use before refactor_replace_preview to scope the change. profile='nano' for top-10 count, 'compact' (default) for full list.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["repoId", "filePath"],
          properties: {
            repoId: { type: "string" },
            filePath: { type: "string" },
            limit: { type: "integer", minimum: 1, maximum: MAX_RESULT_LIMIT },
            groupBy: { type: "string", enum: ["file", "module"] },
            view: { type: "string", enum: ["files", "surface"] },
            profile: { type: "string", enum: ["nano", "compact", "standard", "verbose"] }
          }
        }
      },
      {
        name: "get_change_context",
        description: "Get callers (BFS up to depth), callees, and type deps for a symbol. Accepts symbolId or name (one required). Use profile=nano for ultra-compact, compact to reduce payload during planning, standard for balanced, verbose for debugging.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["repoId"],
          properties: {
            repoId: { type: "string" },
            symbolId: { type: "string" },
            name: { type: "string" },
            callerDepth: { type: "integer", minimum: 1, maximum: MAX_DEPTH },
            calleeDepth: { type: "integer", minimum: 1, maximum: MAX_DEPTH },
            limit: { type: "integer", minimum: 1, maximum: MAX_RESULT_LIMIT },
            profile: { type: "string", enum: ["nano", "compact", "standard", "verbose"] }
          }
        }
      },
      {
        name: "get_file_summary",
        description: "File overview: exported symbols, outgoing imports, and which files import it. Use before get_file_context — lighter payload. profile='nano' for symbol count + top-5, 'compact' (default) for full summary.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["repoId", "filePath"],
          properties: {
            repoId: { type: "string" },
            filePath: { type: "string" },
            profile: { type: "string", enum: ["nano", "compact", "standard", "verbose"] }
          }
        }
      },
      {
        name: "watch_repo",
        description: "Manage real-time file watching for a repository. action=start begins debounced incremental re-index on file changes; action=stop halts watching; action=status returns current watch state and counters.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["action"],
          properties: {
            action: { type: "string", enum: ["start", "stop", "status"] },
            repoId: { type: "string" },
            repoPath: { type: "string" }
          }
        }
      },
      {
        name: "find_symbol_at_line",
        description: "Find the symbol enclosing a given line number in a file. Use when you have a file path and line from a stack trace, error message, or diff hunk to get the symbolId for further graph queries — avoids a manual search hop.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["repoId", "filePath", "line"],
          properties: {
            repoId: { type: "string" },
            filePath: { type: "string" },
            line: { type: "integer", minimum: 1 }
          }
        }
      },
      {
        name: "get_symbol_context_pack",
        description: "Single-call planning pack for a symbol name: ranked candidates + callers + callees + importers + change-context. Use this instead of get_change_context when you need symbol detail without deep caller traversal. Use profile='compact' (default) or 'nano' in Plan mode.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["repoId", "name"],
          properties: {
            repoId: { type: "string" },
            name: { type: "string" },
            callerDepth: { type: "integer", minimum: 1, maximum: MAX_DEPTH },
            calleeDepth: { type: "integer", minimum: 1, maximum: MAX_DEPTH },
            limit: { type: "integer", minimum: 1, maximum: MAX_RESULT_LIMIT },
            profile: { type: "string", enum: ["nano", "compact", "standard", "verbose"] }
          }
        }
      },
      {
        name: "query_docs",
        description: "Unified docs tool. mode=search: full-text search across indexed documentation sections (requires query); mode=stale: find docs that mention changed symbols (requires symbolIds); mode=coverage: show which exported symbols are documented (requires filePath). Requires docs lane enabled.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["repoId", "mode"],
          properties: {
            repoId: { type: "string" },
            mode: { type: "string", enum: ["search", "stale", "coverage"] },
            query: { type: "string" },
            symbolIds: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 100 },
            filePath: { type: "string" },
            limit: { type: "integer", minimum: 1, maximum: MAX_RESULT_LIMIT }
          }
        }
      },
      {
        name: "dead_code_scan",
        description: "Find likely dead symbols using deterministic graph rules: symbols with no incoming CALLS/TYPE_REF/IMPORTS edges (excluding bootstrap entry files).",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["repoId"],
          properties: {
            repoId: { type: "string" },
            filePathPrefix: { type: "string" },
            language: { type: "string" },
            kind: { type: "string" },
            includePrivate: { type: "boolean" },
            limit: { type: "integer", minimum: 1, maximum: MAX_RESULT_LIMIT },
            profile: { type: "string", enum: ["nano", "compact", "standard", "verbose"] }
          }
        }
      },
      {
        name: "detect_circular_dependencies",
        description: "Detect circular dependencies via DFS on graph edges. Supports mode='module' or mode='symbol' and returns explicit cycle paths.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["repoId"],
          properties: {
            repoId: { type: "string" },
            filePathPrefix: { type: "string" },
            mode: { type: "string", enum: ["module", "symbol"] },
            includeCalls: { type: "boolean" },
            maxDepth: { type: "integer", minimum: 2, maximum: MAX_DEPTH },
            maxCycles: { type: "integer", minimum: 1, maximum: 200 },
            profile: { type: "string", enum: ["nano", "compact", "standard", "verbose"] }
          }
        }
      },
      {
        name: "get_cross_repo_impact",
        description: "Expose cross-repo dependencies for a symbol from cross_repo_deps. Supports outbound or inbound direction.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["repoId"],
          properties: {
            repoId: { type: "string" },
            symbolId: { type: "string" },
            name: { type: "string" },
            direction: { type: "string", enum: ["outbound", "inbound"] },
            limit: { type: "integer", minimum: 1, maximum: MAX_RESULT_LIMIT },
            profile: { type: "string", enum: ["nano", "compact", "standard", "verbose"] }
          }
        }
      },
      {
        name: "find_package_consumers",
        description: "Find repositories/symbols that depend on a NuGet package contract (nuget:<name>) without requiring a symbolId.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["packageName"],
          properties: {
            packageName: { type: "string" },
            repoId: { type: "string" },
            limit: { type: "integer", minimum: 1, maximum: MAX_RESULT_LIMIT },
            profile: { type: "string", enum: ["nano", "compact", "standard", "verbose"] }
          }
        }
      },
      {
        name: "get_symbol_blame",
        description: "Return git blame metadata for a symbol line by joining symbol location with `git blame -L line,line --porcelain`.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["repoId"],
          properties: {
            repoId: { type: "string" },
            symbolId: { type: "string" },
            name: { type: "string" },
            redactEmail: { type: "boolean" },
            profile: { type: "string", enum: ["nano", "compact", "standard", "verbose"] }
          }
        }
      },
      {
        name: "link_tests_to_source",
        description: "Link tests to likely source files using deterministic naming heuristics plus IMPORTS/CALLS tracing.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["repoId"],
          properties: {
            repoId: { type: "string" },
            filePath: { type: "string" },
            limit: { type: "integer", minimum: 1, maximum: MAX_RESULT_LIMIT },
            maxCandidates: { type: "integer", minimum: 1, maximum: 20 },
            minScore: { type: "number", minimum: 0, maximum: 1 },
            profile: { type: "string", enum: ["nano", "compact", "standard", "verbose"] }
          }
        }
      },
      {
        name: "detect_changes",
        description: "Detect changed files from git, estimate graph impact, and compute deterministic risk scores (high/medium/low) for review prioritization. Supports policy presets (quick-triage|strict-review|release-gate|custom). Defaults baseRef to latest indexed commit when available.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["repoId"],
          properties: {
            repoId: { type: "string" },
            baseRef: { type: "string" },
            headRef: { type: "string" },
            includeUntracked: { type: "boolean" },
            maxFiles: { type: "integer", minimum: 1, maximum: 500 },
            impactLimit: { type: "integer", minimum: 1, maximum: MAX_RESULT_LIMIT },
            policy: { type: "string", enum: ["quick-triage", "strict-review", "release-gate", "custom"] },
            minRiskScore: { type: "integer", minimum: 0, maximum: 100 },
            riskLevels: { type: "array", items: { type: "string", enum: ["high", "medium", "low"] }, minItems: 1, maxItems: 3 },
            maxResults: { type: "integer", minimum: 1, maximum: 500 },
            sortBy: { type: "string", enum: ["risk", "impact", "path"] },
            groupBy: { type: "string", enum: ["file", "module"] },
            profile: { type: "string", enum: ["nano", "compact", "standard", "verbose"] }
          }
        }
      },
      {
        name: "get_folder_summary",
        description: "List all files under a folder path with per-file stats (language, symbol count, caller count). Use at session start to orient — cheaper than get_file_context on individual files. Prefer this over reading file contents when you just need to find the right files.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["repoId", "folderPath"],
          properties: {
            repoId: { type: "string" },
            folderPath: { type: "string" },
            maxFiles: { type: "integer", minimum: 1, maximum: MAX_RESULT_LIMIT }
          }
        }
      },
      {
        name: "find_entry_points",
        description: "Find symbols with 0 incoming CALLS edges — these are publicly callable entry points not called by other code in the repo. Use to discover public API surface, HTTP endpoints, or top-level service methods. Filter by kind='method' for controllers, kind='class' for services, kind='route_handler' to surface C# ASP.NET route handlers from the routes table (fast-path, does not require call-graph analysis).",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["repoId"],
          properties: {
            repoId: { type: "string" },
            filePathPrefix: { type: "string" },
            kind: { type: "string" },
            limit: { type: "integer", minimum: 1, maximum: MAX_RESULT_LIMIT }
          }
        }
      },
      {
        name: "find_implementations",
        description: "Find all classes or structs that implement a named interface (via IMPLEMENTS edges). Useful for .NET/C# DI tracing — e.g. find_implementations('IUserRepository') to locate concrete implementations. Requires C# indexing.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["repoId", "interfaceName"],
          properties: {
            repoId: { type: "string" },
            interfaceName: { type: "string" },
            limit: { type: "integer", minimum: 1, maximum: MAX_RESULT_LIMIT }
          }
        }
      },
      {
        name: "route_map",
        description: "Map ASP.NET C# routes to handler methods using extracted route attributes ([Route], [HttpGet], [HttpPost], ...). Use to inspect API surface deterministically.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["repoId"],
          properties: {
            repoId: { type: "string" },
            filePathPrefix: { type: "string" },
            httpMethod: { type: "string", enum: ["GET", "POST", "PUT", "DELETE", "PATCH"] },
            limit: { type: "integer", minimum: 1, maximum: MAX_RESULT_LIMIT },
            profile: { type: "string", enum: ["nano", "compact", "standard", "verbose"] }
          }
        }
      },
      {
        name: "query_graph",
        description: [
          "Run a read-only SQL query against graph tables in a sandboxed mode.",
          "Requires :repoId named parameter in SQL and blocks write/admin statements.",
          "Allowed tables: repositories, files, symbols, edges, index_runs, routes, cross_repo_deps, refactor_previews, refactor_preview_hunks, refactor_applies, refactor_apply_changes, refactor_apply_hunks, refactor_rollbacks, vec_symbol_map.",
          "Key columns — symbols: (repo_id, symbol_id, name, kind, file_path, line, signature);",
          "edges: (repo_id, from_id, to_id, type, confidence, reason) — type values: CALLS, IMPORTS, TYPE_REF, DEPENDS_ON, PROPERTY_REF, PROPERTY_WRITE;",
          "cross_repo_deps: (from_repo_id, from_symbol_id, to_repo_id, to_symbol_id, type);",
          "routes: (repo_id, file_path, controller_symbol_id, handler_symbol_id, http_method, route_template, line).",
          "Note: 'package_consumers' is not a table — query edges WHERE type='DEPENDS_ON' AND to_id LIKE 'nuget:%' instead."
        ].join(" "),
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["repoId", "sql"],
          properties: {
            repoId: { type: "string" },
            sql: { type: "string" },
            params: { type: "object", additionalProperties: true },
            limit: { type: "integer", minimum: 1, maximum: MAX_RESULT_LIMIT },
            timeoutMs: { type: "integer", minimum: 1, maximum: 30000 },
            profile: { type: "string", enum: ["nano", "compact", "standard", "verbose"] }
          }
        }
      },
      {
        name: "rename_assist",
        description: "Preview deterministic rename impact for a symbol: returns all callers and importers that will need updating. Read-only — does NOT modify any files. Use before refactoring to understand blast radius.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["repoId", "symbolId", "newName"],
          properties: {
            repoId: { type: "string" },
            symbolId: { type: "string" },
            newName: { type: "string" },
            limit: { type: "integer", minimum: 1, maximum: MAX_RESULT_LIMIT },
            profile: { type: "string", enum: ["nano", "compact", "standard", "verbose"] }
          }
        }
      },
      {
        name: "refactor_replace_preview",
        description: "Preview bulk replacements with scope and type-ownership guards. profile='nano' returns only match count + affected files (no hunk content — fastest for blast-radius check). profile='compact' includes hunks without before/after text. profile='standard' (default) returns full hunk content.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["repoId", "find", "replaceExpression"],
          properties: {
            repoId: { type: "string" },
            find: { type: "string" },
            replaceExpression: { type: "string" },
            profile: { type: "string", enum: ["nano", "compact", "standard", "verbose"] },
            scope: {
              type: "object",
              additionalProperties: false,
              properties: {
                includePaths: { type: "array", items: { type: "string" }, maxItems: 200 },
                excludePaths: { type: "array", items: { type: "string" }, maxItems: 200 },
                fileGlobs: { type: "array", items: { type: "string" }, maxItems: 200 }
              }
            },
            guards: {
              type: "object",
              additionalProperties: false,
              properties: {
                language: { type: "string" },
                symbolKinds: { type: "array", items: { type: "string", enum: ["class", "property", "field", "method"] }, maxItems: 10 },
                allowOwnerTypes: { type: "array", items: { type: "string" }, maxItems: 200 },
                disallowOwnerTypes: { type: "array", items: { type: "string" }, maxItems: 200 },
                disallowTypeList: { type: "array", items: { type: "string" }, maxItems: 200 }
              }
            },
            compilerAssist: {
              type: "object",
              additionalProperties: false,
              properties: {
                diagnostics: {
                  type: "array",
                  maxItems: 1000,
                  items: {
                    type: "object",
                    additionalProperties: false,
                    required: ["code", "filePath", "line"],
                    properties: {
                      code: { type: "string" },
                      filePath: { type: "string" },
                      line: { type: "integer", minimum: 1 },
                      message: { type: "string" },
                      expectedType: { type: "string" },
                      actualType: { type: "string" }
                    }
                  }
                },
                codes: { type: "array", items: { type: "string" }, maxItems: 20 },
                lineWindow: { type: "integer", minimum: 0, maximum: 20 },
                filePathPrefix: { type: "string" }
              }
            },
            mode: { type: "string", enum: ["text", "syntax-aware", "symbol-aware"] },
            ambiguityThresholdPercent: { type: "number", minimum: 0, maximum: 100 }
          }
        }
      },
      {
        name: "refactor_replace_apply",
        description: "Apply an approved replacement plan using previewId and approvalToken from preview. profile='nano' returns only success status + file count. profile='compact' omits expectedFiles list. profile='standard' (default) returns full scope check.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["previewId", "approvalToken"],
          properties: {
            previewId: { type: "string" },
            approvalToken: { type: "string" },
            maxFilesPerBatch: { type: "integer", minimum: 1, maximum: 500 },
            stopOnFirstConflict: { type: "boolean" },
            includeLowConfidence: { type: "boolean" },
            profile: { type: "string", enum: ["nano", "compact", "standard", "verbose"] }
          }
        }
      },
      {
        name: "refactor_replace_rollback",
        description: "Rollback one previous apply operation by rollbackId.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["rollbackId"],
          properties: {
            rollbackId: { type: "string" }
          }
        }
      },
      {
        name: "refactor_symbol_migration",
        description: "Run owner-type constrained symbol migrations (dry-run by default) using the same preview/apply engine.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["repoId", "migrations"],
          properties: {
            repoId: { type: "string" },
            migrations: {
              type: "array",
              minItems: 1,
              maxItems: 200,
              items: {
                type: "object",
                additionalProperties: false,
                required: ["fromSymbol", "toSymbol", "requiredOwnerType"],
                properties: {
                  fromSymbol: { type: "string" },
                  toSymbol: { type: "string" },
                  requiredOwnerType: { type: "string" },
                  forbiddenOwnerTypes: { type: "array", items: { type: "string" }, maxItems: 200 },
                  initializerRewrite: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      objectProperty: { type: "string" },
                      objectType: { type: "string" },
                      targetMember: { type: "string" }
                    },
                    required: ["objectProperty", "objectType"]
                  }
                }
              }
            },
            scopePaths: { type: "array", items: { type: "string" }, maxItems: 200 },
            dryRun: { type: "boolean" }
          }
        }
      },
      {
        name: "trace_execution_flow",
        description: "BFS-trace the call graph starting from an entry symbol, following CALLS edges outbound up to maxDepth levels. Returns nodes and edges forming the execution sub-graph. Use to understand how a method propagates through the codebase.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["repoId", "entrySymbolId"],
          properties: {
            repoId: { type: "string" },
            entrySymbolId: { type: "string" },
            maxDepth: { type: "integer", minimum: 1, maximum: 8 },
            maxNodes: { type: "integer", minimum: 1, maximum: 100 },
            profile: { type: "string", enum: ["nano", "compact", "standard", "verbose"] }
          }
        }
      }
    ]
  };
});

server.setRequestHandler(ListResourcesRequestSchema, async (request) => {
  return handleListResources(store, request.params?.cursor);
});

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  return handleReadResource(request.params.uri, store, MAX_RESULT_LIMIT);
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const toolName = request.params.name;
  const startedAt = Date.now();
  const args = asArgsRecord(request.params.arguments);

  return toolContextStorage.run({ toolName, startedAt, args }, async () => {
    try {
      await maybeAutoActivateWatchFromArgs(toolName, args);

      const ctx = buildHandlerContext();

      switch (request.params.name) {
      case "health_check": {
        const hArgs = healthCheckSchema.parse(request.params.arguments ?? {});
        return handleHealthCheck(hArgs, ctx);
      }
      case "index_repository": {
        const hArgs = indexRepositorySchema.parse(request.params.arguments ?? {});
        return handleIndexRepository(hArgs, ctx);
      }
      case "get_dependency_graph": {
        const hArgs = getDependencyGraphSchema.parse(request.params.arguments ?? {});
        return handleGetDependencyGraph(hArgs, ctx);
      }
      case "get_call_chain": {
        const hArgs = getCallChainSchema.parse(request.params.arguments ?? {});
        return handleGetCallChain(hArgs, ctx);
      }
      case "find_impact_files": {
        const hArgs = findImpactFilesSchema.parse(request.params.arguments ?? {});
        return handleFindImpactFiles(hArgs, ctx);
      }
      case "get_change_context": {
        const hArgs = getChangeContextSchema.parse(request.params.arguments ?? {});
        return handleGetChangeContext(hArgs, ctx);
      }
      case "get_file_summary": {
        const hArgs = getFileSummarySchema.parse(request.params.arguments ?? {});
        return handleGetFileSummary(hArgs, ctx);
      }
      case "list_repositories": {
        const hArgs = listRepositoriesSchema.parse(request.params.arguments ?? {});
        return handleListRepositories(hArgs, ctx);
      }
      case "search_symbols": {
        const hArgs = searchSymbolsSchema.parse(request.params.arguments ?? {});
        return handleSearchSymbols(hArgs, ctx);
      }
      case "get_file_context": {
        const hArgs = getFileContextSchema.parse(request.params.arguments ?? {});
        return handleGetFileContext(hArgs, ctx);
      }
      case "get_symbol_detail": {
        const hArgs = getSymbolDetailSchema.parse(request.params.arguments ?? {});
        return handleGetSymbolDetail(hArgs, ctx);
      }
      case "query_docs": {
        const hArgs = queryDocsSchema.parse(request.params.arguments ?? {});
        return handleQueryDocs(hArgs, ctx);
      }
      case "watch_repo": {
        const hArgs = watchRepoSchema.parse(request.params.arguments ?? {});
        return handleWatchRepo(hArgs, ctx);
      }
      case "find_symbol_at_line": {
        const hArgs = findSymbolAtLineSchema.parse(request.params.arguments ?? {});
        return handleFindSymbolAtLine(hArgs, ctx);
      }
      case "get_symbol_context_pack": {
        const hArgs = getSymbolContextPackSchema.parse(request.params.arguments ?? {});
        return handleGetSymbolContextPack(hArgs, ctx);
      }
      case "dead_code_scan": {
        const hArgs = deadCodeScanSchema.parse(request.params.arguments ?? {});
        return handleDeadCodeScan(hArgs, ctx);
      }
      case "detect_circular_dependencies": {
        const hArgs = detectCircularDependenciesSchema.parse(request.params.arguments ?? {});
        return handleDetectCircularDependencies(hArgs, ctx);
      }
      case "get_cross_repo_impact": {
        const hArgs = crossRepoImpactSchema.parse(request.params.arguments ?? {});
        return handleGetCrossRepoImpact(hArgs, ctx);
      }
      case "find_package_consumers": {
        const hArgs = findPackageConsumersSchema.parse(request.params.arguments ?? {});
        return handleFindPackageConsumers(hArgs, ctx);
      }
      case "get_symbol_blame": {
        const hArgs = symbolBlameSchema.parse(request.params.arguments ?? {});
        return handleGetSymbolBlame(hArgs, ctx);
      }
      case "link_tests_to_source": {
        const hArgs = linkTestsToSourceSchema.parse(request.params.arguments ?? {});
        return handleLinkTestsToSource(hArgs, ctx);
      }
      case "detect_changes": {
        const hArgs = detectChangesSchema.parse(request.params.arguments ?? {});
        return handleDetectChanges(hArgs, ctx);
      }
      case "get_folder_summary": {
        const hArgs = getFolderSummarySchema.parse(request.params.arguments ?? {});
        return handleGetFolderSummary(hArgs, ctx);
      }
      case "find_entry_points": {
        const hArgs = findEntryPointsSchema.parse(request.params.arguments ?? {});
        return handleFindEntryPoints(hArgs, ctx);
      }
      case "find_implementations": {
        const hArgs = findImplementationsSchema.parse(request.params.arguments ?? {});
        return handleFindImplementations(hArgs, ctx);
      }
      case "route_map": {
        const hArgs = routeMapSchema.parse(request.params.arguments ?? {});
        return handleRouteMap(hArgs, ctx);
      }
      case "query_graph": {
        const hArgs = queryGraphSchema.parse(request.params.arguments ?? {});
        return handleQueryGraph(hArgs, ctx);
      }
      case "rename_assist": {
        const hArgs = renameAssistSchema.parse(request.params.arguments ?? {});
        return handleRenameAssist(hArgs, ctx);
      }
      case "refactor_replace_preview": {
        const hArgs = refactorReplacePreviewSchema.parse(request.params.arguments ?? {});
        return handleRefactorReplacePreview(hArgs, ctx);
      }
      case "refactor_replace_apply": {
        const hArgs = refactorReplaceApplySchema.parse(request.params.arguments ?? {});
        return handleRefactorReplaceApply(hArgs, ctx);
      }
      case "refactor_replace_rollback": {
        const hArgs = refactorReplaceRollbackSchema.parse(request.params.arguments ?? {});
        return handleRefactorReplaceRollback(hArgs, ctx);
      }
      case "refactor_symbol_migration": {
        const hArgs = refactorSymbolMigrationSchema.parse(request.params.arguments ?? {});
        return handleRefactorSymbolMigration(hArgs, ctx);
      }
      case "trace_execution_flow": {
        const hArgs = traceExecutionFlowSchema.parse(request.params.arguments ?? {});
        return handleTraceExecutionFlow(hArgs, ctx);
      }
      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${request.params.name}`);
      }
    } catch (error) {
      const mapped = mapError(error, request.params.name);
      const text = JSON.stringify(mapped, null, 2);
      emitTelemetry({
        ts: new Date().toISOString(),
        toolName,
        elapsedMs: Date.now() - startedAt,
        responseBytes: Buffer.byteLength(text, "utf8"),
        resultCount: 0,
        profile: "none",
        requestedProfile: typeof args.profile === "string" ? args.profile : null,
        compactRequested: args.compact === true,
        isError: true,
        errorCode: mapped.code
      }, TELEMETRY_ENABLED, TELEMETRY_SAMPLE_RATE);
      return {
        content: [{ type: "text", text }],
        isError: true
      } satisfies CallToolResult;
    }
  });
});

// parseRepoResourceUri → serverUtils.ts
// buildRiskSnapshot → handlers/resourceHandler.ts

function handleHealthCheckLocal(repoId?: string): CallToolResult {
  const latestRun = repoId ? store.getLatestRun(repoId) : null;
  const staleness = repoId ? getRepoStaleness(repoId, store) : null;
  const repo = repoId ? store.getRepository(repoId) : null;
  const watchStatuses = repoId ? watchManager.getStatus(repoId) : [];
  const watchRunning = watchStatuses.length > 0;
  const workingTree = repo ? getRepoWorkingTreeState(repo.repoPath) : null;
  const packageBridge = repoId ? store.getPackageBridgeStats(repoId) : null;

  const reasons: string[] = [];
  if (repoId && !repo) {
    reasons.push("repository not registered; run index_repository first");
  }
  if (repoId && repo && !latestRun) {
    reasons.push("repository has no indexed run yet");
  }
  if (staleness?.isStale === true) {
    reasons.push("indexed commit differs from HEAD");
  }
  if (workingTree?.isDirty === true) {
    reasons.push("working tree has uncommitted changes");
  }

  let codebaseStatus: "unknown" | "needs_index" | "stale" | "dirty" | "ready" = "unknown";
  if (!repoId || !repo) {
    codebaseStatus = "unknown";
  } else if (!latestRun) {
    codebaseStatus = "needs_index";
  } else if (staleness?.isStale === true) {
    codebaseStatus = "stale";
  } else if (workingTree?.isDirty === true) {
    codebaseStatus = "dirty";
  } else if (staleness?.isStale === false) {
    codebaseStatus = "ready";
  }

  const shouldReindex = codebaseStatus === "needs_index" || codebaseStatus === "stale" || codebaseStatus === "dirty";
  const shouldEnableWatch = Boolean(repoId && repo && workingTree?.isDirty === true && !watchRunning);
  const actionHints = repoId && repo
    ? [
      {
        action: "index_repository",
        recommended: shouldReindex,
        urgency: codebaseStatus === "stale" || codebaseStatus === "needs_index" ? "high" : codebaseStatus === "dirty" ? "medium" : "low",
        reason:
            codebaseStatus === "needs_index"
              ? "No successful index run exists for this repo."
              : codebaseStatus === "stale"
                ? "Indexed commit does not match HEAD."
                : codebaseStatus === "dirty"
                  ? "Working tree changed after latest index run."
                  : "Index appears up-to-date.",
        arguments: {
          repoId,
          repoPath: repo.repoPath,
          mode: "incremental"
        }
      },
      {
        action: "watch_repo_start",
        recommended: shouldEnableWatch,
        urgency: shouldEnableWatch ? "medium" : "low",
        reason: shouldEnableWatch
          ? "Uncommitted edits detected and no active watcher for this repo."
          : watchRunning
            ? "Watcher is already active for this repo."
            : "Use watch only for active edit sessions that need continuous indexing.",
        arguments: {
          action: "start",
          repoId,
          repoPath: repo.repoPath
        }
      }
    ]
    : [];

  return asText({
    status: "ok",
    serverVersion: SERVER_VERSION,
    dbPath,
    allowedRootCount: allowedRoots.length,
    docsLane: {
      docsIndexingEnabled: DOCS_INDEXING_ENABLED,
      docsToolsEnabled: DOCS_TOOLS_ENABLED
    },
    latestRun,
    staleness,
    watch: {
      autoStartEnabled: WATCH_AUTO_START,
      activeOnly: WATCH_ACTIVE_ONLY,
      activeWatchRepoId: activeWatchRef.current,
      running: watchRunning,
      watcherCount: watchStatuses.length,
      watchers: watchStatuses
    },
    codebaseState: {
      repoId: repoId ?? null,
      status: codebaseStatus,
      shouldReindex,
      shouldEnableWatch,
      workingTree,
      reasons
    },
    packageBridge,
    actionHints
  });
}

// resolveServerVersion → serverUtils.ts
// getRepoWorkingTreeState, runGitStatusPorcelain, resolveHeadCommitSha,
// runGit, runGitLines, parseGitBlamePorcelain, redactEmail → gitHelpers.ts
// scoreChangeRisk, resolveDetectChangesPolicy → policyResolver.ts
// getRepoStaleness → gitHelpers.ts (now takes store as parameter)
// resolveDocsModeLocal, assertDocsLaneEnabled → docsUtils.ts

// resolveResponseProfile → responseFormatter.ts

// PolicyViolationError → refactorUtils.ts

// Refactor types → refactorTypes.ts

// Refactor utility functions → refactorUtils.ts

// findInitializerMemberAssignment, isDottedMemberPath, isSimpleIdentifier,
// isInvalidCsharpInitializerReplacement, resolveInitializerRewriteTargetMember → refactorUtils.ts

// buildRefactorPreview → refactorEngine.ts

// applyCompilerAssistToPreview, buildSymbolMigrationPreview, countPreviewRisks,
// createPreviewDigest, issueApprovalToken, verifyApprovalToken, groupPreviewHunks,
// executeRefactorApplyPlan, buildFinalOffsetMap → refactorEngine.ts / refactorUtils.ts

function formatChangeContextPayloadLocal(
  result: ReturnType<GraphStore["getChangeContext"]>,
  profile: ResponseProfile
): unknown {
  if (profile === "nano") {
    const topCallers = result.callers.slice(0, 10).map((x) => ({
      fromName: x.fromName,
      fromFilePath: x.fromFilePath,
      distance: x.distance,
      confidence: x.confidence ?? null
    }));
    const topCallees = result.callees.slice(0, 10).map((x) => ({
      toName: x.toName,
      toFilePath: x.toFilePath,
      confidence: x.confidence ?? null
    }));
    const topTypeDeps = result.typeDeps.slice(0, 10).map((x) => ({
      toName: x.toName,
      toFilePath: x.toFilePath,
      confidence: x.confidence ?? null
    }));

    return {
      symbol: result.symbol
        ? { symbolId: result.symbol.symbolId, name: result.symbol.name, kind: result.symbol.kind, filePath: result.symbol.filePath, line: result.symbol.line }
        : null,
      callerCount: result.callers.length,
      calleeCount: result.callees.length,
      typeDepCount: result.typeDeps.length,
      topCallers,
      topCallees,
      topTypeDeps,
      hasMoreCallers: result.callers.length > topCallers.length,
      hasMoreCallees: result.callees.length > topCallees.length,
      hasMoreTypeDeps: result.typeDeps.length > topTypeDeps.length,
      unresolved: {
        calls: result.graphHealth.unresolvedCalls,
        imports: result.graphHealth.unresolvedImports,
        typeRefs: result.graphHealth.unresolvedTypeRefs
      },
      reliability: {
        medianConfidence: result.reliabilitySummary.medianConfidence,
        unresolvedRatio: result.reliabilitySummary.unresolvedRatio,
        warning: result.reliabilitySummary.warning
      }
    };
  }

  if (profile === "compact") {
    return {
      symbol: result.symbol
        ? { symbolId: result.symbol.symbolId, name: result.symbol.name, kind: result.symbol.kind, filePath: result.symbol.filePath, line: result.symbol.line }
        : null,
      callers: result.callers.map((x) => ({
        fromId: x.fromId,
        fromName: x.fromName,
        fromFilePath: x.fromFilePath,
        distance: x.distance,
        confidence: x.confidence ?? null,
        reason: x.reason ?? null
      })),
      callees: result.callees.map((x) => ({ toId: x.toId, toName: x.toName, toFilePath: x.toFilePath, confidence: x.confidence ?? null, reason: x.reason ?? null })),
      typeDeps: result.typeDeps.map((x) => ({ toId: x.toId, toName: x.toName, toFilePath: x.toFilePath, confidence: x.confidence ?? null, reason: x.reason ?? null })),
      graphHealth: result.graphHealth,
      reliabilitySummary: result.reliabilitySummary
    };
  }

  if (profile === "verbose") {
    return {
      ...result,
      summary: {
        callerCount: result.callers.length,
        calleeCount: result.callees.length,
        typeDepCount: result.typeDeps.length
      }
    };
  }

  return result;
}

function asText(payload: unknown, profile: ResponseProfile = "standard"): CallToolResult {
  return asTextCore(payload, profile, toolContextStorage.getStore(), TELEMETRY_ENABLED, TELEMETRY_SAMPLE_RATE);
}

// mapError, assertNoLlmRuntimePolicy, assertRefactorApprovalPolicy → errorHandler.ts
// resolveApprovalSecret → refactorUtils.ts (now takes secret + strictApproval as params)
// mapPreviewStatusFromApplyStatus, deriveApplyStatus, noLlmAudit → refactorUtils.ts
// numberFromEnv, ratioFromEnv → envConfig.ts
// toNugetContractId, asArgsRecord → responseFormatter.ts
// estimateResultCount, emitTelemetry → responseFormatter.ts
// traverseDependencyGraph, traverseCallGraph → graphTraversal.ts

async function runIndexAndResolve(
  repoId: string,
  repoPath: string,
  mode: "full" | "incremental",
  docsEnabled: boolean,
  maxFiles: number,
  batchSize: number
): Promise<IndexRunSummary & { crossRepoLinked?: number; callEdgesResolved?: number; importEdgesResolved?: number; mentionsResolved?: number; skipReason?: string }> {
  const yieldToEventLoop = async (): Promise<void> => {
    await new Promise<void>((resolve) => setImmediate(resolve));
  };

  /**
   * Run a synchronous resolve function in batches to avoid blocking the event loop.
   * Each batch processes BATCH_SIZE rows, then yields before the next batch.
   * If maxRows=0 (unlimited), uses BATCH_SIZE per iteration until no more rows resolved.
   */
  const resolveInBatches = async (
    _repoId: string,
    label: string,
    resolveFn: (batchSize: number) => number,
    maxRows: number
  ): Promise<number> => {
    const BATCH_SIZE = 5_000;
    let totalResolved = 0;
    let remaining = maxRows > 0 ? maxRows : Infinity;
    let iteration = 0;
    const maxIterations = 200; // safety cap: 200 * 5000 = 1M rows max

    while (remaining > 0 && iteration < maxIterations) {
      const batchLimit = Math.min(BATCH_SIZE, remaining === Infinity ? BATCH_SIZE : remaining);
      const resolved = resolveFn(batchLimit);
      totalResolved += resolved;
      iteration += 1;

      process.stderr.write(
        `[index-post-batch] repoId=${_repoId} type=${label} batch=${String(iteration)} resolved=${String(resolved)} total=${String(totalResolved)}\n`
      );

      // If nothing resolved in this batch, we're done
      if (resolved === 0) break;

      if (maxRows > 0) {
        remaining -= batchLimit;
      }

      await yieldToEventLoop();
    }

    return totalResolved;
  };

  if (mode === "incremental") {
    const skipDecision = evaluateIncrementalSkip(repoId, repoPath);
    if (skipDecision.shouldSkip) {
      const now = new Date().toISOString();
      const skippedSummary: IndexRunSummary & {
        crossRepoLinked?: number;
        callEdgesResolved?: number;
        importEdgesResolved?: number;
        mentionsResolved?: number;
        skipReason?: string;
      } = {
        runId: randomUUID(),
        repoId,
        commitSha: skipDecision.headCommitSha,
        indexVersion: skipDecision.indexVersion,
        mode,
        status: "ok",
        startedAt: now,
        finishedAt: now,
        filesScanned: 0,
        filesIndexed: 0,
        filesSkipped: 0,
        symbolsUpserted: 0,
        edgesUpserted: 0,
        docsUpserted: 0,
        mentionsUpserted: 0,
        parseFailures: 0,
        parseTimeouts: 0,
        elapsedMs: 0,
        crossRepoLinked: 0,
        callEdgesResolved: 0,
        importEdgesResolved: 0,
        mentionsResolved: 0,
        crossRepoAttempts: 0,
        crossRepoResolved: 0,
        unresolvedNoCandidate: 0,
        unresolvedAmbiguous: 0,
        unresolvedBoundaryBlocked: 0,
        unresolvedLowConfidence: 0,
        skipReason: skipDecision.reason
      };
      store.recordRun(skippedSummary);
      process.stderr.write(`[index-skip] repoId=${repoId} reason=${skipDecision.reason}\n`);
      return skippedSummary;
    }
  }

  const profileDecision = resolvePerformanceProfileDecision(repoId, mode, maxFiles);
  const performanceProfile = profileDecision.profile;
  const postPolicy = resolvePostPhasePolicy(performanceProfile);
  // Resolve implements in post-phase for ALL modes (full + incremental).
  // Previous condition `mode !== "full"` was a bug — full index rebuilds all edges from scratch
  // so implements edges also need post-phase resolution.
  const effectiveResolveImplementsInPost = postPolicy.resolveImplementsInPost;
  process.stderr.write(
    `[index-policy] repoId=${repoId} profile=${performanceProfile} source=${profileDecision.source} reason=${profileDecision.reason} fileCount=${String(profileDecision.fileCount)} symbolCount=${String(profileDecision.symbolCount)} maxUnresolvedRows=${String(postPolicy.maxUnresolvedRows)} resolveTypeRefs=${String(postPolicy.resolveTypeRefs)} resolvePropertyRefs=${String(postPolicy.resolvePropertyRefs)} resolveImplementsInPost=${String(postPolicy.resolveImplementsInPost)} effectiveResolveImplementsInPost=${String(effectiveResolveImplementsInPost)}\n`
  );

  // Disable WAL auto-checkpoint during indexing to prevent lock contention
  // with concurrent readers. Will be re-enabled in endIndexSession().
  store.beginIndexSession();

  const summary = await runIndexPipeline(store, {
    repoId,
    repoPath,
    mode,
    performanceProfile,
    includeDocs: docsEnabled,
    maxFiles,
    batchSize,
    subtxSize: SUBTX_SIZE,
    checkpointEveryNBatches: CHECKPOINT_EVERY_N_BATCHES,
    largeFileThresholdBytes: LARGE_FILE_THRESHOLD_BYTES,
    maxFileSizeBytes: MAX_FILE_SIZE_BYTES,
    parseWorkers: PARSE_WORKERS,
    parseJobTimeoutMs: PARSE_JOB_TIMEOUT_MS
  });
  const resolvePhaseStart = Date.now();
  let ftsRebuildMs = 0;
  let buildContextMs = 0;
  let unresolvedCallsTotal = 0;
  let callResolveMs = 0;
  let importResolveMs = 0;
  let typeResolveMs = 0;
  let propertyResolveMs = 0;
  let implementsResolveMs = 0;

  process.stderr.write(`[index-post] repoId=${repoId} rebuilding FTS indexes...\n`);
  const ftsStart = Date.now();
  try { store.rebuildFts(); } catch { /* non-fatal */ }
  await yieldToEventLoop();
  if (docsEnabled) {
    process.stderr.write(`[index-post] repoId=${repoId} rebuilding docs FTS...\n`);
    try { store.rebuildDocsFts(); } catch { /* non-fatal */ }
    await yieldToEventLoop();
  }
  ftsRebuildMs = Date.now() - ftsStart;

  process.stderr.write(`[index-post] repoId=${repoId} resolving cross-repo links...\n`);
  const crossStats = safeCrossRepoResolve(repoId);
  await yieldToEventLoop();

  process.stderr.write(`[index-post] repoId=${repoId} resolving call edges...\n`);
  const callEdgesResolved = await (async () => {
    const callStart = Date.now();
    try {
      // Build lookup maps ONCE, then process in batches to avoid blocking event loop
      process.stderr.write(`[index-post] repoId=${repoId} building call resolution context...\n`);
      const ctxStart = Date.now();
      const ctx = store.buildCallResolutionContext(repoId);
      buildContextMs = Date.now() - ctxStart;
      unresolvedCallsTotal = ctx.unresolvedRows.length;
      process.stderr.write(`[index-post] repoId=${repoId} pre-fetched ${String(ctx.unresolvedRows.length)} unresolved call edges\n`);
      if (ctx.unresolvedRows.length === 0) return 0;

      // Optimization: drop secondary edge indexes before bulk resolve to speed up UPDATEs.
      // Each UPDATE otherwise must maintain 4 secondary indexes on the edges table.
      process.stderr.write(`[index-post] repoId=${repoId} dropping edge indexes for bulk resolve...\n`);
      store.dropEdgeIndexesForBulkWrite();

      const BATCH_SIZE = 5_000;
      let total = 0;
      let iteration = 0;
      const maxIterations = 1000;
      while (iteration < maxIterations) {
        const resolved = store.resolveCallEdgesBatch(repoId, ctx, BATCH_SIZE);
        total += resolved;
        iteration += 1;
        process.stderr.write(
          `[index-post-batch] repoId=${repoId} type=call batch=${String(iteration)} resolved=${String(resolved)} total=${String(total)}\n`
        );
        if (resolved === 0) break;
        await yieldToEventLoop();
      }
      return total;
    } catch { return 0; }
    finally {
      // Always rebuild indexes after resolve, even on error
      process.stderr.write(`[index-post] repoId=${repoId} rebuilding edge indexes after resolve...\n`);
      try { store.rebuildEdgeIndexes(); } catch { /* non-fatal */ }
      callResolveMs = Date.now() - callStart;
    }
  })();
  await yieldToEventLoop();

  process.stderr.write(`[index-post] repoId=${repoId} resolving import edges...\n`);
  const importStart = Date.now();
  const importEdgesResolved = await resolveInBatches(
    repoId,
    "import",
    (batchSize) => { try { return store.resolveImportEdges(repoId, batchSize); } catch { return 0; } },
    postPolicy.maxUnresolvedRows
  );
  importResolveMs = Date.now() - importStart;
  await yieldToEventLoop();

  if (postPolicy.resolveTypeRefs) {
    process.stderr.write(`[index-post] repoId=${repoId} resolving type references...\n`);
    const typeStart = Date.now();
    (() => { try { store.resolveTypeRefEdges(repoId, postPolicy.maxUnresolvedRows); } catch { /* non-fatal */ } })();
    typeResolveMs = Date.now() - typeStart;
  } else {
    process.stderr.write(`[index-post-skip] repoId=${repoId} skipping type reference resolution by policy\n`);
  }
  await yieldToEventLoop();

  if (postPolicy.resolvePropertyRefs) {
    process.stderr.write(`[index-post] repoId=${repoId} resolving property references...\n`);
    const propertyStart = Date.now();
    (() => { try { store.resolvePropertyEdges(repoId, postPolicy.maxUnresolvedRows); } catch { /* non-fatal */ } })();
    propertyResolveMs = Date.now() - propertyStart;
  } else {
    process.stderr.write(`[index-post-skip] repoId=${repoId} skipping property reference resolution by policy\n`);
  }
  await yieldToEventLoop();

  const shouldResolveImplementsInPost = effectiveResolveImplementsInPost;
  if (shouldResolveImplementsInPost) {
    process.stderr.write(`[index-post] repoId=${repoId} resolving interface implementations...\n`);
    const implementsStart = Date.now();
    try { store.resolveImplementsEdges(repoId); } catch { /* non-fatal */ }
    implementsResolveMs = Date.now() - implementsStart;
  } else {
    process.stderr.write(`[index-post-skip] repoId=${repoId} skipping interface implementation resolution in post-phase\n`);
  }
  await yieldToEventLoop();

  // Post-resolve dedup: remove duplicate resolved edges that arise when both simple and
  // qualified edges resolve to the same symbolId (e.g. callee:Save + callee:IRepo.Save → same target).
  process.stderr.write(`[index-post] repoId=${repoId} deduplicating resolved edges...\n`);
  const dedupCount = (() => { try { return store.deduplicateResolvedEdges(repoId); } catch { return 0; } })();
  process.stderr.write(`[index-post] repoId=${repoId} removed ${dedupCount} duplicate resolved edges\n`);
  await yieldToEventLoop();

  const mentionsStart = Date.now();
  process.stderr.write(`[index-post] repoId=${repoId} resolving mentions...\n`);
  const mentionsResolved = docsEnabled
    ? (() => { try { return store.resolveMentions(repoId); } catch { return 0; } })()
    : 0;
  const mentionsElapsed = Date.now() - mentionsStart;
  process.stderr.write(`[index-post] repoId=${repoId} resolved ${mentionsResolved} mentions in ${mentionsElapsed}ms\n`);

  const recordStart = Date.now();
  process.stderr.write(`[index-post] repoId=${repoId} recording run metadata...\n`);

  const fullSummary = {
    ...summary,
    crossRepoLinked: crossStats.resolved,
    callEdgesResolved,
    importEdgesResolved,
    mentionsResolved,
    crossRepoAttempts: crossStats.attempts,
    crossRepoResolved: crossStats.resolved,
    unresolvedNoCandidate: crossStats.unresolvedByReason.no_candidate,
    unresolvedAmbiguous: crossStats.unresolvedByReason.ambiguous_candidates,
    unresolvedBoundaryBlocked: crossStats.unresolvedByReason.boundary_blocked,
    unresolvedLowConfidence: crossStats.unresolvedByReason.low_confidence,
    resolvePhaseMs: Date.now() - resolvePhaseStart,
    buildContextMs,
    callResolveMs,
    importResolveMs,
    typeResolveMs,
    propertyResolveMs,
    implementsResolveMs,
    ftsRebuildMs,
    unresolvedCallsTotal,
    unresolvedImportsCappedByPolicy: postPolicy.maxUnresolvedRows > 0,
    resolveCallsCoverage: unresolvedCallsTotal > 0 ? callEdgesResolved / unresolvedCallsTotal : 1,
    performanceProfile
  };
  store.recordRun(fullSummary);
  const recordElapsed = Date.now() - recordStart;
  process.stderr.write(`[index-post] repoId=${repoId} recorded run metadata in ${recordElapsed}ms\n`);

  // Re-enable WAL auto-checkpoint and force a full checkpoint to shrink WAL file
  store.endIndexSession();

  process.stderr.write(`[index-post-done] repoId=${repoId} crossRepo=${String(crossStats.resolved)} calls=${String(callEdgesResolved)} imports=${String(importEdgesResolved)} mentions=${String(mentionsResolved)}\n`);

  return fullSummary;
}

function evaluateIncrementalSkip(
  repoId: string,
  repoPath: string
): {
  shouldSkip: boolean;
  reason: string;
  headCommitSha: string | null;
  indexVersion: string;
} {
  const latestRun = store.getLatestRun(repoId);
  if (!latestRun?.commitSha) {
    return {
      shouldSkip: false,
      reason: "no previous indexed commit",
      headCommitSha: null,
      indexVersion: latestRun?.indexVersion ?? "v1-tree-sitter-property-edges"
    };
  }

  const headCommitSha = resolveHeadCommitSha(repoPath);
  if (!headCommitSha) {
    return {
      shouldSkip: false,
      reason: "unable to resolve HEAD",
      headCommitSha,
      indexVersion: latestRun.indexVersion
    };
  }

  if (latestRun.commitSha !== headCommitSha) {
    return {
      shouldSkip: false,
      reason: "index commit differs from HEAD",
      headCommitSha,
      indexVersion: latestRun.indexVersion
    };
  }

  const dirtyState = hasWorkingTreeChanges(repoPath);
  if (dirtyState === true) {
    return {
      shouldSkip: false,
      reason: "working tree has uncommitted changes",
      headCommitSha,
      indexVersion: latestRun.indexVersion
    };
  }

  if (dirtyState === null) {
    return {
      shouldSkip: false,
      reason: "unable to resolve working tree state",
      headCommitSha,
      indexVersion: latestRun.indexVersion
    };
  }

  return {
    shouldSkip: true,
    reason: "head unchanged and working tree clean",
    headCommitSha,
    indexVersion: latestRun.indexVersion
  };
}

// hasWorkingTreeChanges → gitHelpers.ts
// parsePerformanceProfileEnv, resolvePostPhasePolicy → performanceConfig.ts

function resolvePerformanceProfileDecision(
  repoId: string,
  mode: "full" | "incremental",
  maxFiles: number
): {
  profile: PerformanceProfile;
  source: "env" | "auto";
  reason: string;
  fileCount: number;
  symbolCount: number;
} {
  const configured = parsePerformanceProfileEnv(process.env.CODEBASE_INDEX_LARGE_REPO_PROFILE);
  if (configured !== "auto") {
    const snap = store.getRepoSchemaSnapshot(repoId);
    return {
      profile: configured,
      source: "env",
      reason: "explicit override",
      fileCount: snap.fileCount,
      symbolCount: snap.symbolCount
    };
  }

  const snapshot = store.getRepoSchemaSnapshot(repoId);
  const estimatedFileCount = snapshot.fileCount;
  const estimatedSymbolCount = snapshot.symbolCount;

  if (estimatedFileCount === 0 && estimatedSymbolCount === 0) {
    if (mode === "full" && maxFiles >= 8000) {
      return {
        profile: "large",
        source: "auto",
        reason: "cold-start full index with high maxFiles",
        fileCount: estimatedFileCount,
        symbolCount: estimatedSymbolCount
      };
    }
    return {
      profile: "standard",
      source: "auto",
      reason: "cold-start fallback",
      fileCount: estimatedFileCount,
      symbolCount: estimatedSymbolCount
    };
  }

  if (estimatedFileCount >= 8000 || estimatedSymbolCount >= 60000) {
    return {
      profile: "very-large",
      source: "auto",
      reason: "snapshot scale threshold",
      fileCount: estimatedFileCount,
      symbolCount: estimatedSymbolCount
    };
  }
  if (estimatedFileCount >= 3000 || estimatedSymbolCount >= 20000) {
    return {
      profile: "large",
      source: "auto",
      reason: "snapshot scale threshold",
      fileCount: estimatedFileCount,
      symbolCount: estimatedSymbolCount
    };
  }
  return {
    profile: "standard",
    source: "auto",
    reason: "snapshot scale threshold",
    fileCount: estimatedFileCount,
    symbolCount: estimatedSymbolCount
  };
}

function safeCrossRepoResolve(repoId: string): ResolutionStats {
  try {
    return store.resolveUnlinkedEdges(repoId);
  } catch {
    return {
      attempts: 0,
      resolved: 0,
      unresolvedByReason: {
        no_candidate: 0,
        ambiguous_candidates: 0,
        boundary_blocked: 0,
        low_confidence: 0
      }
    };
  }
}

// nonNegativeNumberFromEnv, parseOptionalBooleanEnv → envConfig.ts

function resolveAutoWatchTargets(): { repoId: string; repoPath: string }[] {
  if (AUTO_WATCH_REPOS.length > 0) {
    return AUTO_WATCH_REPOS;
  }
  return store.listRepositories().map((r) => ({ repoId: r.repoId, repoPath: r.repoPath }));
}

async function startAutoWatchers(): Promise<void> {
  if (!WATCH_AUTO_START) {
    return;
  }

  const targets = resolveAutoWatchTargets();
  const selectedTargets = WATCH_ACTIVE_ONLY ? targets.slice(0, 1) : targets;
  for (const target of selectedTargets) {
    try {
      assertPathAllowed(target.repoPath, allowedRoots);
      const started = await activateWatchForRepo(target.repoId, target.repoPath, "auto-start");
      if (started.started) {
        process.stderr.write(`[watch-start] repoId=${target.repoId} path=${target.repoPath}\n`);
      }
    } catch (error) {
      process.stderr.write(`[watch-start-error] repoId=${target.repoId}: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }
}

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const timer of watchInactivityTimers.values()) {
    clearTimeout(timer);
  }
  watchInactivityTimers.clear();
  try {
    await watchManager.stopAll();
  } catch {
    // best-effort
  }
  try {
    store.close();
  } catch {
    // best-effort
  }
}

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  await startAutoWatchers();

  process.once("SIGINT", () => {
    void shutdown().finally(() => process.exit(0));
  });
  process.once("SIGTERM", () => {
    void shutdown().finally(() => process.exit(0));
  });
}

async function maybeAutoActivateWatchFromArgs(toolName: string, args: Record<string, unknown>): Promise<void> {
  if (!WATCH_AUTO_START) {
    return;
  }

  if (toolName === "watch_repo" || toolName === "list_repositories") {
    return;
  }

  const rawRepoId = args.repoId;
  if (typeof rawRepoId !== "string" || rawRepoId.trim().length === 0) {
    return;
  }

  const repoId = rawRepoId.trim();
  const rawRepoPath = args.repoPath;
  const repoPath = typeof rawRepoPath === "string" && rawRepoPath.trim().length > 0
    ? rawRepoPath.trim()
    : store.getRepository(repoId)?.repoPath;

  if (!repoPath) {
    return;
  }

  await activateWatchForRepo(repoId, repoPath, `interaction:${toolName}`);
}

async function activateWatchForRepo(repoId: string, repoPath: string, reason: string): Promise<{ started: boolean; message: string }> {
  assertPathAllowed(repoPath, allowedRoots);

  if (WATCH_ACTIVE_ONLY && activeWatchRef.current && activeWatchRef.current !== repoId) {
    clearWatchInactivityTimer(activeWatchRef.current);
    await watchManager.stop(activeWatchRef.current);
  }

  const currentStatus = watchManager.getStatus(repoId);
  let result: { started: boolean; message: string };
  if (currentStatus.length === 0) {
    result = watchManager.start(repoId, repoPath);
  } else {
    result = { started: false, message: `watch already active for repoId '${repoId}'` };
  }

  activeWatchRef.current = repoId;
  armWatchInactivityTimer(repoId);
  if (result.started) {
    process.stderr.write(`[watch-activate] repoId=${repoId} reason=${reason}\n`);
  }
  return result;
}

function armWatchInactivityTimer(repoId: string): void {
  clearWatchInactivityTimer(repoId);
  const timer = setTimeout(() => {
    const current = activeWatchRef.current;
    if (WATCH_ACTIVE_ONLY && current === repoId) {
      activeWatchRef.current = null;
    }
    void watchManager.stop(repoId);
    watchInactivityTimers.delete(repoId);
    process.stderr.write(`[watch-idle-stop] repoId=${repoId} ttlMs=${String(WATCH_ACTIVE_TTL_MS)}\n`);
  }, WATCH_ACTIVE_TTL_MS);
  watchInactivityTimers.set(repoId, timer);
}

function clearWatchInactivityTimer(repoId: string): void {
  const timer = watchInactivityTimers.get(repoId);
  if (!timer) {
    return;
  }
  clearTimeout(timer);
  watchInactivityTimers.delete(repoId);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  void shutdown().finally(() => process.exit(1));
});
