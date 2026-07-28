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
        description: "Index repository files into internal graph storage (incremental by default). mode='dirty' re-indexes ONLY git working-tree-changed files (unstaged+staged+untracked) — a fast refresh of just-edited files (extraction is scoped to the changed set; edge resolution still runs repo-wide). Pruning is suppressed (subset scan). docsMode controls docs lane isolation: auto uses server default, on forces docs indexing, off disables docs indexing for this run.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["repoId", "repoPath"],
          properties: {
            repoId: { type: "string" },
            repoPath: { type: "string" },
            mode: { type: "string", enum: ["full", "incremental", "dirty"] },
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
        name: "find_field_accesses",
        description: "List every read/write callsite of a property (field) with its enclosing symbol — the 'who reads vs who writes this field' audit for wrong-level-resolution checks. Reads the PROPERTY_REF (read) / PROPERTY_WRITE (write) edges. Provide a property symbolId or a resolvable name. mode=read|write|all (default all). Returns reads/writes partitioned, each with enclosingName/filePath/line, plus a coverage block. Use this instead of grepping a field name across the repo.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["repoId"],
          properties: {
            repoId: { type: "string" },
            symbolId: { type: "string" },
            name: { type: "string" },
            mode: { type: "string", enum: ["read", "write", "all"] },
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
        description: "Search symbols across all repos or a specific repo. strategy=name is strict name/signature matching; strategy=intent uses broader tokenized matching (multi-word natural-language queries work, e.g. 'send notification email'). ranked=true returns scored/ranked candidates (with qualifiedName 'EnclosingType.Member' for class members; enclosing-type names participate in intent matching; test files get a rank penalty) and honors strategy plus the kind/language/filePath filters. excludeTests=true drops test-path results entirely.",
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
            ranked: { type: "boolean" },
            excludeTests: { type: "boolean" }
          }
        }
      },
      {
        name: "search_literals",
        description: "Search string-literal CONTENT (notification titles, error messages, log templates, user-facing text) across a repo's indexed code. Returns each literal with file, line, and enclosing symbol — use for 'what text does this repo emit' audits (notification catalogs, error-message inventories, i18n sweeps) instead of grep. Interpolated/template strings are indexed with {…} placeholders.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["repoId", "query"],
          properties: {
            repoId: { type: "string" },
            query: { type: "string" },
            filePath: { type: "string" },
            limit: { type: "integer", minimum: 1, maximum: MAX_RESULT_LIMIT },
            profile: { type: "string", enum: ["nano", "compact", "standard", "verbose"] }
          }
        }
      },
      {
        name: "search_regex",
        description: "Search repo source by REGEX and get matches with context lines + the enclosing symbol. Use this instead of baseline grep for arbitrary pattern searches (TODO/FIXME sweeps, API-usage hunts, call-site patterns, config keys). Scans indexed files by default; set scanAll=true to also walk non-code text files (json/yaml/etc). Flags limited to [ims] (g is implicit). filePathPrefix (string OR array of prefixes, OR-semantics) / language / excludeTests narrow scope; pathExclude (minimatch glob or array, e.g. \"**/Tests/**\") subtracts subtrees; contextLines controls surrounding lines (returned in every profile except nano). Results cap at `limit` and a per-file cap — `truncated`/`truncationReason` flag when capped.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["repoId", "pattern"],
          properties: {
            repoId: { type: "string" },
            pattern: { type: "string" },
            regexFlags: { type: "string", description: "Subset of i, m, s (g is always applied)." },
            filePathPrefix: {
              description: "Path prefix, or array of prefixes (a file is in scope if it starts with ANY).",
              oneOf: [{ type: "string" }, { type: "array", items: { type: "string" }, maxItems: 20 }]
            },
            pathExclude: {
              description: "Minimatch glob, or array of globs, matched against the full repo-relative path, to subtract from scope (e.g. \"**/Tests/**\", \"**/*.generated.cs\"). A leading \"*\" does not cross \"/\", so use \"**/*.ext\" to match nested files.",
              oneOf: [{ type: "string" }, { type: "array", items: { type: "string" }, maxItems: 20 }]
            },
            language: { type: "string" },
            excludeTests: { type: "boolean" },
            scanAll: { type: "boolean" },
            contextLines: { type: "integer", minimum: 0, maximum: 10 },
            limit: { type: "integer", minimum: 1, maximum: MAX_RESULT_LIMIT },
            profile: { type: "string", enum: ["nano", "compact", "standard", "verbose"] }
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
        description: "Scope blast radius for a file change. view='files' (default): which files import/call symbols in this file. view='surface': which external symbols call into this file. Use before refactor_replace_preview to scope the change. profile='nano' for top-10 count, 'compact' (default) for full list. A stale index (indexed commit ≠ HEAD) is reported as a non-fatal `staleWarning` field in the response, not an error — re-index for exact results.",
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
        description: "Get callers (BFS up to depth), callees, and type deps for a symbol. Accepts symbolId or name (one required). Use profile=nano for ultra-compact, compact to reduce payload during planning, standard for balanced, verbose for debugging. A stale index (indexed commit ≠ HEAD) is reported as a non-fatal `staleWarning` field in the response, not an error.",
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
        description: "Single-call planning pack for a symbol name: ranked candidates + callers + callees + importers + change-context. When a name resolves to several symbols (e.g. a class and its same-named constructor), the substantive symbol (class/interface/method) is selected for the context, so callers/importers are meaningful. Use this instead of get_change_context when you need symbol detail without deep caller traversal. Use profile='compact' (default) or 'nano' in Plan mode.",
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
        name: "get_symbol_source",
        description: "Return the raw source text span of a symbol (by symbolId or name) read from disk — so you can read the exact code without a separate file read. Uses the persisted end-line when available (re-index to populate), else estimates the span from the next symbol. `contextLines` adds surrounding lines; `maxLines` caps output. A stale index is reported as a non-fatal `staleWarning` (line numbers may differ from HEAD).",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["repoId"],
          properties: {
            repoId: { type: "string" },
            symbolId: { type: "string" },
            name: { type: "string" },
            contextLines: { type: "integer", minimum: 0, maximum: 50 },
            maxLines: { type: "integer", minimum: 1, maximum: 2000 },
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
        name: "change_impact",
        description: "Composite 'what did my change affect and which tests cover it' for the working-tree diff (or a commit range): maps changed files → static dependents → covering tests, returning a ranked testsToRun list (by source risk × link score) plus a residualRisk note for changed files with no linked test. Use after editing to run a trusted targeted test subset instead of the whole suite. Defaults baseRef to the indexed commit (working-tree diff when no new commits).",
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
            testLinkMinScore: { type: "number", minimum: 0, maximum: 1 },
            testLinkMaxCandidates: { type: "integer", minimum: 1, maximum: 20 },
            maxTestsToRun: { type: "integer", minimum: 1, maximum: 500 },
            profile: { type: "string", enum: ["nano", "compact", "standard", "verbose"] }
          }
        }
      },
      {
        name: "get_feature_bundle",
        description: "Gather a whole vertical-slice feature from one seed: given an entity (seedSymbol e.g. 'ConversationNote', or seedFile) it walks the C# convention (entity → {E}Configuration → Create/Update/Delete{E}Command + handlers + validators → Get{E}Query + handlers → {E}Endpoints) and returns the related symbols with source in one call. Use for 'implement X by mirroring Y' tasks instead of reading 6+ files separately. Heuristic, name-pattern based; unresolvedRoles lists roles not found by name.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["repoId"],
          properties: {
            repoId: { type: "string" },
            seedSymbol: { type: "string" },
            seedFile: { type: "string" },
            convention: { type: "string", enum: ["csharp-vertical-slice"] },
            maxFiles: { type: "integer", minimum: 1, maximum: 60 },
            maxBytesPerFile: { type: "integer", minimum: 1, maximum: 20000 },
            includeSource: { type: "boolean" },
            profile: { type: "string", enum: ["nano", "compact", "standard", "verbose"] }
          }
        }
      },
      {
        name: "orient",
        description: "Task router: given a free-text intent (e.g. 'implement a feature like ConversationNote', 'rename X', 'what breaks if I change Y', 'which tests to run') returns the recommended MCP tool(s) + caveats, and resolves an optional seed to seedSymbols. Deterministic keyword classification (no LLM). Use first when unsure which tool to start with.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["intent"],
          properties: {
            repoId: { type: "string" },
            intent: { type: "string" },
            seed: { type: "string" },
            profile: { type: "string", enum: ["nano", "compact", "standard", "verbose"] }
          }
        }
      },
      {
        name: "get_folder_summary",
        description: "List all files under a folder path with per-file stats (language, symbol count, caller count). Use at session start to orient — cheaper than get_file_context on individual files. Prefer this over reading file contents when you just need to find the right files. Response includes indexMeta with branch and commitSha from the last index run — verify these match your current branch before trusting file listings. After a branch switch, run index_repository(mode='full') to purge stale entries.",
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
        description: "Rename impact for a symbol: returns all callers and importers that need updating. Default (emitPreview=false) is read-only advisory (hints). Set emitPreview=true to get an applyable refactor preview (previewId + approvalToken) that renames the identifier on word boundaries across the affected files — then call refactor_replace_apply (use includeLowConfidence=true for top-level identifiers, which have no enclosing owner type). Use before refactoring to understand blast radius, or to execute the rename directly.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["repoId", "symbolId", "newName"],
          properties: {
            repoId: { type: "string" },
            symbolId: { type: "string" },
            newName: { type: "string" },
            limit: { type: "integer", minimum: 1, maximum: MAX_RESULT_LIMIT },
            emitPreview: { type: "boolean", description: "Return an applyable refactor preview instead of read-only hints." },
            wholeWord: { type: "boolean", description: "Match the identifier on word boundaries (default true)." },
            profile: { type: "string", enum: ["nano", "compact", "standard", "verbose"] }
          }
        }
      },
      {
        name: "refactor_replace_preview",
        description: "Preview bulk replacements with scope and type-ownership guards. findMode='literal' (default) matches `find` as plain text; findMode='regex' treats `find` as a regular expression and substitutes capture-group backreferences in `replaceExpression` — numbered ($1..$99), whole-match ($&), named ($<name> or ${name}), and a literal `$` via $$ — ideal for context-preserving bulk edits in one pass. A backreference to a group that did not match is flagged `unsubstituted_backreference` and blocked at apply (it is never silently written). profile='nano' returns only match count + affected files (fastest blast-radius check); 'compact' omits before/after text; 'standard' (default) returns full hunk content.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["repoId", "find", "replaceExpression"],
          properties: {
            repoId: { type: "string" },
            find: { type: "string" },
            replaceExpression: { type: "string" },
            findMode: { type: "string", enum: ["literal", "regex"] },
            regexFlags: { type: "string", description: "Optional regex flags, subset of i|m|s (g is always applied)." },
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
        name: "change_value_representation",
        description: "Promote a property's literal values to enum members (e.g. HandledBy = \"ai\" → ConversationHandledBy.Ai) across assignments, object initializers, ==/!= comparisons, and assertion arguments. Sites are located via the C# AST (no user-authored regex/backreference) and rewritten through the preview/apply/rollback engine — dry-run by default. Cross-type sites (a same-named property on a different owner type) are skipped; sites where the owner type can't be proven are flagged ambiguous_target.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["repoId", "property", "requiredOwnerType", "valueMap"],
          properties: {
            repoId: { type: "string" },
            property: { type: "string", description: "Property identifier whose literals are promoted, e.g. \"HandledBy\"." },
            requiredOwnerType: { type: "string", description: "Owner type scoping the rewrite, e.g. \"Conversation\"." },
            valueMap: {
              type: "object",
              minProperties: 1,
              additionalProperties: { type: "string" },
              description: "Literal value (unquoted) → replacement expression, e.g. { \"ai\": \"ConversationHandledBy.Ai\" }."
            },
            includeComparisons: { type: "boolean", description: "Also rewrite ==/!= and assertion-argument sites (default true); false = assignments/initializers only." },
            scopePaths: { type: "array", items: { type: "string" }, maxItems: 200 },
            dryRun: { type: "boolean" },
            profile: { type: "string", enum: ["nano", "compact", "standard", "verbose"] }
          }
        }
      },
      {
        name: "get_persistence_mapping",
        description: "Return the EF persistence mapping for a property — column name, value converter, max length, CHECK constraints — plus DB_TRANSLATED_PROJECTION warnings when a value-converted property is used inside an EF-translated .Select()/.Where() with no preceding materialization (.ToListAsync()/.AsEnumerable()). Surfaces the persistence-layer facts a symbol graph can't see (rule/AST-based, no LLM).",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["repoId", "property"],
          properties: {
            repoId: { type: "string" },
            property: { type: "string", description: "Property name, e.g. \"HandledBy\"." },
            ownerType: { type: "string", description: "Optional owner/entity type to scope the mapping, e.g. \"Conversation\"." },
            profile: { type: "string", enum: ["nano", "compact", "standard", "verbose"] }
          }
        }
      },
      {
        name: "get_value_contract_impact",
        description: "Trace a stored/wire VALUE (e.g. a status string \"resolved\" or magic code) across ALL registered repos by fanning search_literals, grouping exact-value hits by repo and classifying each as producer (assigned/written) or consumer (compared/read) where inferable. This is the data-contract gate for a storage-format migration — what get_cross_repo_impact (symbol-oriented) can't answer. Rule-based, no LLM.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["value"],
          properties: {
            value: { type: "string", description: "The exact stored/wire literal to trace, e.g. \"resolved\"." },
            column: { type: "string", description: "Optional DB column/field name to sharpen producer/consumer classification, e.g. \"status\"." },
            repoIds: { type: "array", items: { type: "string" }, maxItems: 50, description: "Optional subset of registered repoIds; defaults to all." },
            profile: { type: "string", enum: ["nano", "compact", "standard", "verbose"] }
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
