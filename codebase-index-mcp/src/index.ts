import process from "node:process";
import { AsyncLocalStorage } from "node:async_hooks";
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

import { GraphStore } from "./graphStore.js";
import {
  assertPathAllowed,
  clamp,
  parseAllowedRoots,
  parseAutoWatchRepos,
  parseBooleanEnv,
  parseWatchConfigFromEnv
} from "./guardrails/indexGuardrails.js";
import { WatchManager } from "./watchManager.js";
import { createIndexRunner } from "./indexing/indexRunner.js";
import {
  armWatchInactivityTimer,
  maybeAutoActivateWatchFromArgs,
  startAutoWatchers
} from "./watch/watchLifecycle.js";
import { parsePerformanceProfileEnv } from "./config/performanceConfig.js";
import { numberFromEnv, ratioFromEnv } from "./config/envConfig.js";
import {
  type ResponseProfile,
  type ToolRequestContext,
  emitTelemetry,
  asText as asTextCore,
  asArgsRecord
} from "./response/responseFormatter.js";
import { resolveServerVersion } from "./serverUtils.js";
import { mapError, assertNoLlmRuntimePolicy, assertRefactorApprovalPolicy } from "./errorHandler.js";
import { legacyToolDescriptors } from "./tools/descriptors/index.js";
import * as schemas from "./schemas/toolSchemas.js";
import { handleListResources, handleReadResource } from "./handlers/resourceHandler.js";

import {
  handleHealthCheck,
  handleIndexRepository,
  handleWatchRepo,
  handleDetectChanges,
  handleChangeImpact
} from "./handlers/indexHandler.js";
import type { HandlerContext } from "./handlers/handlerContext.js";
import {
  handleSearchSymbols,
  handleSearchLiterals,
  handleSearchRegex,
  handleFindSymbolAtLine,
  handleGetSymbolDetail,
  handleGetSymbolContextPack,
  handleGetSymbolBlame,
  handleGetSymbolSource
} from "./handlers/searchHandler.js";
import { handleGetFeatureBundle } from "./handlers/bundleHandler.js";
import { handleOrient } from "./handlers/orientHandler.js";
import {
  handleGetDependencyGraph,
  handleGetCallChain,
  handleFindFieldAccesses,
  handleFindImpactFiles,
  handleGetChangeContext,
  handleGetFileSummary,
  handleListRepositories,
  handleGetFileContext,
  handleGetFolderSummary,
  handleRouteMap,
  handleQueryGraph,
  handleQueryDocs
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
  handleChangeValueRepresentation,
  handleTraceExecutionFlow
} from "./handlers/refactorHandler.js";
import { handleGetPersistenceMapping, handleGetValueContractImpact } from "./handlers/persistenceHandler.js";

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
const searchLiteralsSchema = schemas.searchLiteralsSchema(MAX_RESULT_LIMIT);
const searchRegexSchema = schemas.searchRegexSchema(MAX_RESULT_LIMIT);
const getFileContextSchema = schemas.getFileContextSchema(MAX_RESULT_LIMIT);
const getSymbolDetailSchema = schemas.getSymbolDetailSchema(MAX_RESULT_LIMIT);
const findImpactFilesSchema = schemas.findImpactFilesSchema(MAX_RESULT_LIMIT);
const findFieldAccessesSchema = schemas.findFieldAccessesSchema(MAX_RESULT_LIMIT);
const getChangeContextSchema = schemas.getChangeContextSchema(MAX_DEPTH, MAX_RESULT_LIMIT);
const getFileSummarySchema = schemas.getFileSummarySchema;
const findSymbolAtLineSchema = schemas.findSymbolAtLineSchema;
const queryDocsSchema = schemas.queryDocsSchema(MAX_RESULT_LIMIT);
const getSymbolContextPackSchema = schemas.getSymbolContextPackSchema(MAX_DEPTH, MAX_RESULT_LIMIT);
const detectChangesSchema = schemas.detectChangesSchema(MAX_RESULT_LIMIT);
const changeImpactSchema = schemas.changeImpactSchema(MAX_RESULT_LIMIT);
const getFeatureBundleSchema = schemas.getFeatureBundleSchema;
const orientSchema = schemas.orientSchema;
const deadCodeScanSchema = schemas.deadCodeScanSchema(MAX_RESULT_LIMIT);
const detectCircularDependenciesSchema = schemas.detectCircularDependenciesSchema(MAX_DEPTH, MAX_RESULT_LIMIT);
const crossRepoImpactSchema = schemas.crossRepoImpactSchema(MAX_RESULT_LIMIT);
const findPackageConsumersSchema = schemas.findPackageConsumersSchema(MAX_RESULT_LIMIT);
const symbolBlameSchema = schemas.symbolBlameSchema;
const getSymbolSourceSchema = schemas.getSymbolSourceSchema;
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
const changeValueRepresentationSchema = schemas.changeValueRepresentationSchema;
const getPersistenceMappingSchema = schemas.getPersistenceMappingSchema;
const getValueContractImpactSchema = schemas.getValueContractImpactSchema;

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

/**
 * The index run orchestrator (S-26: extracted to `indexing/indexRunner.ts`).
 *
 * Built once here because it needs `store` and the env-derived tuning limits, both
 * of which only the entry point owns. The two callbacks stay lazy on purpose: the
 * progress sink is per-request, and the profile override was read from the env on
 * every run before the extraction. Resolving either eagerly would change behaviour.
 */
const runIndexAndResolve = createIndexRunner({
  store,
  limits: {
    subtxSize: SUBTX_SIZE,
    checkpointEveryNBatches: CHECKPOINT_EVERY_N_BATCHES,
    largeFileThresholdBytes: LARGE_FILE_THRESHOLD_BYTES,
    maxFileSizeBytes: MAX_FILE_SIZE_BYTES,
    parseWorkers: PARSE_WORKERS,
    parseJobTimeoutMs: PARSE_JOB_TIMEOUT_MS
  },
  resolveProgressNotifier: () => toolContextStorage.getStore()?.progressNotifier,
  resolvePerformanceProfileOverride: () => parsePerformanceProfileEnv(process.env.CODEBASE_INDEX_LARGE_REPO_PROFILE)
});

const watchManager = new WatchManager(
  watchConfig,
  async (repoId, repoPath, config) => {
    assertPathAllowed(repoPath, allowedRoots);
    await runIndexAndResolve(repoId, repoPath, "incremental", DOCS_INDEXING_ENABLED, config.maxFilesPerRun, config.batchSize);
  },
  (repoId, deletedRelativePaths) => store.pruneFiles(repoId, deletedRelativePaths),
  ({ repoId }) => {
    if (WATCH_ACTIVE_ONLY && activeWatchRef.current === repoId) {
      armWatchInactivityTimer(repoId, buildHandlerContext());
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

// The descriptor table now lives under tools/descriptors/, grouped by S-32 migration batch.
// It is also what the SDK registry's legacy bridge publishes, so there is one source of truth
// for the wire contract whether a tool is served by the registry or the switch below.
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools: legacyToolDescriptors({ maxResultLimit: MAX_RESULT_LIMIT, maxDepth: MAX_DEPTH, maxFilesPerRun: MAX_FILES_PER_RUN }) };
});

server.setRequestHandler(ListResourcesRequestSchema, async (request) => {
  return handleListResources(store, request.params?.cursor);
});

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  return handleReadResource(request.params.uri, store, MAX_RESULT_LIMIT);
});

server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  const toolName = request.params.name;
  const startedAt = Date.now();
  const args = asArgsRecord(request.params.arguments);

  // If the host requested progress (supplied a progressToken), build a sink that
  // streams notifications/progress back for the duration of this tool call.
  const progressToken = (request.params._meta as { progressToken?: string | number } | undefined)?.progressToken;
  const progressNotifier =
    progressToken !== undefined
      ? (progress: number, total: number | undefined, message: string): void => {
          void extra
            .sendNotification({
              method: "notifications/progress",
              params: { progressToken, progress, ...(total !== undefined ? { total } : {}), message },
            })
            .catch(() => { /* progress is best-effort; never fail the tool over it */ });
        }
      : undefined;

  return toolContextStorage.run({ toolName, startedAt, args, progressNotifier }, async () => {
    try {
      await maybeAutoActivateWatchFromArgs(toolName, args, buildHandlerContext());

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
      case "find_field_accesses": {
        const hArgs = findFieldAccessesSchema.parse(request.params.arguments ?? {});
        return handleFindFieldAccesses(hArgs, ctx);
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
      case "search_literals": {
        const hArgs = searchLiteralsSchema.parse(request.params.arguments ?? {});
        return handleSearchLiterals(hArgs, ctx);
      }
      case "search_regex": {
        const hArgs = searchRegexSchema.parse(request.params.arguments ?? {});
        return handleSearchRegex(hArgs, ctx);
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
      case "get_symbol_source": {
        const hArgs = getSymbolSourceSchema.parse(request.params.arguments ?? {});
        return handleGetSymbolSource(hArgs, ctx);
      }
      case "link_tests_to_source": {
        const hArgs = linkTestsToSourceSchema.parse(request.params.arguments ?? {});
        return handleLinkTestsToSource(hArgs, ctx);
      }
      case "detect_changes": {
        const hArgs = detectChangesSchema.parse(request.params.arguments ?? {});
        return handleDetectChanges(hArgs, ctx);
      }
      case "change_impact": {
        const hArgs = changeImpactSchema.parse(request.params.arguments ?? {});
        return handleChangeImpact(hArgs, ctx);
      }
      case "get_feature_bundle": {
        const hArgs = getFeatureBundleSchema.parse(request.params.arguments ?? {});
        return handleGetFeatureBundle(hArgs, ctx);
      }
      case "orient": {
        const hArgs = orientSchema.parse(request.params.arguments ?? {});
        return handleOrient(hArgs, ctx);
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
        // await so a rejection (e.g. INVALID_INITIALIZER_REWRITE policy error) is caught by the
        // try/catch below and mapped to an isError result, not surfaced as a raw JSON-RPC error.
        return await handleRefactorSymbolMigration(hArgs, ctx);
      }
      case "change_value_representation": {
        const hArgs = changeValueRepresentationSchema.parse(request.params.arguments ?? {});
        return await handleChangeValueRepresentation(hArgs, ctx);
      }
      case "get_persistence_mapping": {
        const hArgs = getPersistenceMappingSchema.parse(request.params.arguments ?? {});
        return handleGetPersistenceMapping(hArgs, ctx);
      }
      case "get_value_contract_impact": {
        const hArgs = getValueContractImpactSchema.parse(request.params.arguments ?? {});
        return handleGetValueContractImpact(hArgs, ctx);
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

function asText(payload: unknown, profile: ResponseProfile = "standard"): CallToolResult {
  return asTextCore(payload, profile, toolContextStorage.getStore(), TELEMETRY_ENABLED, TELEMETRY_SAMPLE_RATE);
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
  await startAutoWatchers(buildHandlerContext(), AUTO_WATCH_REPOS);

  process.once("SIGINT", () => {
    void shutdown().finally(() => process.exit(0));
  });
  process.once("SIGTERM", () => {
    void shutdown().finally(() => process.exit(0));
  });
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  void shutdown().finally(() => process.exit(1));
});
