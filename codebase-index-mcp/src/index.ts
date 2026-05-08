import process from "node:process";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { execFileSync } from "node:child_process";
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
import { globSync } from "glob";
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
const SERVER_VERSION = resolveServerVersion();
type ResponseProfile = "nano" | "compact" | "standard" | "verbose";
const responseProfileSchema = z.enum(["nano", "compact", "standard", "verbose"]);

type ToolRequestContext = {
  toolName: string;
  startedAt: number;
  args: Record<string, unknown>;
};

type ToolTelemetryEvent = {
  ts: string;
  toolName: string;
  elapsedMs: number;
  responseBytes: number;
  resultCount: number | null;
  profile: ResponseProfile | "none";
  requestedProfile: string | null;
  compactRequested: boolean;
  isError: boolean;
  errorCode?: string;
};

const toolContextStorage = new AsyncLocalStorage<ToolRequestContext>();

const healthCheckSchema = z
  .object({
    repoId: z.string().min(1).max(200).optional()
  })
  .strict();

const indexRepositorySchema = z
  .object({
    repoId: z.string().min(1).max(200),
    repoPath: z.string().min(1),
    mode: z.enum(["full", "incremental"]).default("incremental"),
    docsMode: z.enum(["auto", "on", "off"]).default("auto"),
    maxFiles: z.number().int().min(1).max(MAX_FILES_PER_RUN).default(MAX_FILES_PER_RUN),
    batchSize: z.number().int().min(1).max(2_000).default(200)
  })
  .strict();

const getDependencyGraphSchema = z
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

const getCallChainSchema = z
  .object({
    repoId: z.string().min(1).max(200),
    symbolId: z.string().min(1).max(200),
    direction: z.enum(["callers", "callees"]).default("callees"),
    depth: z.number().int().min(1).max(MAX_DEPTH).default(1),
    limit: z.number().int().min(1).max(MAX_RESULT_LIMIT).default(100)
  })
  .strict();

const listRepositoriesSchema = z.object({}).strict();

const searchSymbolsSchema = z
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

const getFileContextSchema = z
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

const getSymbolDetailSchema = z
  .object({
    repoId: z.string().min(1).max(200),
    symbolId: z.string().min(1).max(200),
    limit: z.number().int().min(1).max(MAX_RESULT_LIMIT).default(100)
  })
  .strict();

const findImpactFilesSchema = z
  .object({
    repoId: z.string().min(1).max(200),
    filePath: z.string().min(1),
    limit: z.number().int().min(1).max(MAX_RESULT_LIMIT).default(50),
    groupBy: z.enum(["file", "module"]).default("file"),
    view: z.enum(["files", "surface"]).default("files")
  })
  .strict();

const getChangeContextSchema = z
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

const getFileSummarySchema = z
  .object({
    repoId: z.string().min(1).max(200),
    filePath: z.string().min(1)
  })
  .strict();

const findSymbolAtLineSchema = z
  .object({
    repoId: z.string().min(1).max(200),
    filePath: z.string().min(1),
    line: z.number().int().min(1)
  })
  .strict();

const queryDocsSchema = z
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

const getSymbolContextPackSchema = z
  .object({
    repoId: z.string().min(1).max(200),
    name: z.string().min(1).max(200),
    callerDepth: z.number().int().min(1).max(MAX_DEPTH).default(2),
    calleeDepth: z.number().int().min(1).max(MAX_DEPTH).default(1),
    limit: z.number().int().min(1).max(MAX_RESULT_LIMIT).default(20),
    profile: responseProfileSchema.default("compact")
  })
  .strict();

const detectChangesSchema = z
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

const deadCodeScanSchema = z
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

const detectCircularDependenciesSchema = z
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

const crossRepoImpactSchema = z
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

const symbolBlameSchema = z
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

const linkTestsToSourceSchema = z
  .object({
    repoId: z.string().min(1).max(200),
    filePath: z.string().max(500).optional(),
    limit: z.number().int().min(1).max(MAX_RESULT_LIMIT).default(100),
    maxCandidates: z.number().int().min(1).max(20).default(3),
    minScore: z.number().min(0).max(1).default(0.4),
    profile: responseProfileSchema.default("compact")
  })
  .strict();

const getFolderSummarySchema = z
  .object({
    repoId: z.string().min(1).max(200),
    folderPath: z.string().min(1),
    maxFiles: z.number().int().min(1).max(MAX_RESULT_LIMIT).default(100)
  })
  .strict();

const findEntryPointsSchema = z
  .object({
    repoId: z.string().min(1).max(200),
    filePathPrefix: z.string().max(500).optional(),
    kind: z.string().max(50).optional(),
    limit: z.number().int().min(1).max(MAX_RESULT_LIMIT).default(50)
  })
  .strict();

const findImplementationsSchema = z
  .object({
    repoId: z.string().min(1).max(200),
    interfaceName: z.string().min(1).max(200),
    limit: z.number().int().min(1).max(MAX_RESULT_LIMIT).default(50)
  })
  .strict();

const watchRepoSchema = z
  .object({
    action: z.enum(["start", "stop", "status"]),
    repoId: z.string().min(1).max(200).optional(),
    repoPath: z.string().min(1).optional()
  })
  .strict();

const renameAssistSchema = z
  .object({
    repoId: z.string().min(1).max(200),
    symbolId: z.string().min(1).max(200),
    newName: z.string().min(1).max(200),
    limit: z.number().int().min(1).max(MAX_RESULT_LIMIT).default(50),
    profile: responseProfileSchema.default("compact")
  })
  .strict();

const traceExecutionFlowSchema = z
  .object({
    repoId: z.string().min(1).max(200),
    entrySymbolId: z.string().min(1).max(200),
    maxDepth: z.number().int().min(1).max(8).default(4),
    maxNodes: z.number().int().min(1).max(100).default(30),
    profile: responseProfileSchema.default("compact")
  })
  .strict();

const routeMapSchema = z
  .object({
    repoId: z.string().min(1).max(200),
    filePathPrefix: z.string().max(500).optional(),
    httpMethod: z.enum(["GET", "POST", "PUT", "DELETE", "PATCH"]).optional(),
    limit: z.number().int().min(1).max(MAX_RESULT_LIMIT).default(100),
    profile: responseProfileSchema.default("compact")
  })
  .strict();

const queryGraphParamsValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const queryGraphSchema = z
  .object({
    repoId: z.string().min(1).max(200),
    sql: z.string().min(1).max(10_000),
    params: z.record(queryGraphParamsValueSchema).default({}),
    limit: z.number().int().min(1).max(MAX_RESULT_LIMIT).default(100),
    timeoutMs: z.number().int().min(1).max(30_000).default(5_000),
    profile: responseProfileSchema.default("compact")
  })
  .strict();

const refactorSymbolKindSchema = z.enum(["class", "property", "field", "method"]);

const refactorScopeSchema = z
  .object({
    includePaths: z.array(z.string().min(1).max(500)).max(200).default([]),
    excludePaths: z.array(z.string().min(1).max(500)).max(200).default([]),
    fileGlobs: z.array(z.string().min(1).max(500)).max(200).default([])
  })
  .strict()
  .default({ includePaths: [], excludePaths: [], fileGlobs: [] });

const refactorGuardsSchema = z
  .object({
    language: z.string().min(1).max(50).optional(),
    symbolKinds: z.array(refactorSymbolKindSchema).max(10).default([]),
    allowOwnerTypes: z.array(z.string().min(1).max(200)).max(200).default([]),
    disallowOwnerTypes: z.array(z.string().min(1).max(200)).max(200).default([]),
    disallowTypeList: z.array(z.string().min(1).max(200)).max(200).default([])
  })
  .strict()
  .default({ symbolKinds: [], allowOwnerTypes: [], disallowOwnerTypes: [], disallowTypeList: [] });

const refactorInitializerRewriteSchema = z
  .object({
    objectProperty: z.string().min(1).max(200),
    objectType: z.string().min(1).max(200),
    targetMember: z.string().min(1).max(200).optional()
  })
  .strict();

const refactorReplacePreviewSchema = z
  .object({
    repoId: z.string().min(1).max(200),
    find: z.string().min(1).max(2_000),
    replaceExpression: z.string().max(2_000),
    scope: refactorScopeSchema,
    guards: refactorGuardsSchema,
    mode: z.enum(["text", "syntax-aware", "symbol-aware"]).default("symbol-aware"),
    ambiguityThresholdPercent: z.number().min(0).max(100).default(1)
  })
  .strict();

const refactorReplaceApplySchema = z
  .object({
    previewId: z.string().min(1).max(200),
    approvalToken: z.string().min(1).max(2_000),
    maxFilesPerBatch: z.number().int().min(1).max(500).default(50),
    stopOnFirstConflict: z.boolean().default(true),
    includeLowConfidence: z.boolean().default(false)
  })
  .strict();

const refactorReplaceRollbackSchema = z
  .object({
    rollbackId: z.string().min(1).max(200)
  })
  .strict();

const refactorSymbolMigrationSchema = z
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

assertNoLlmRuntimePolicy();
assertRefactorApprovalPolicy();

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
    if (WATCH_ACTIVE_ONLY && activeWatchRepoId === repoId) {
      armWatchInactivityTimer(repoId);
    }
  }
);

let activeWatchRepoId: string | null = null;
const watchInactivityTimers = new Map<string, NodeJS.Timeout>();

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
        description: "Get the IMPORTS/DEPENDS_ON dependency tree for a symbol (provide symbolId), or get module-level flow edges for a file (provide filePath). One of symbolId or filePath is required.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["repoId"],
          properties: {
            repoId: { type: "string" },
            symbolId: { type: "string" },
            filePath: { type: "string" },
            depth: { type: "integer", minimum: 1, maximum: MAX_DEPTH },
            limit: { type: "integer", minimum: 1, maximum: MAX_RESULT_LIMIT }
          }
        }
      },
      {
        name: "get_call_chain",
        description: "Get the full caller or callee chain from a symbolId. Use direction=callers to trace who calls this symbol, or direction=callees to see what it calls. Prefer get_context_by_name for quick single-symbol lookup.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["repoId", "symbolId"],
          properties: {
            repoId: { type: "string" },
            symbolId: { type: "string" },
            direction: { type: "string", enum: ["callers", "callees"] },
            depth: { type: "integer", minimum: 1, maximum: MAX_DEPTH },
            limit: { type: "integer", minimum: 1, maximum: MAX_RESULT_LIMIT }
          }
        }
      },
      {
        name: "list_repositories",
        description: "List all indexed repositories with file counts, symbol counts, and last index run status.",
        inputSchema: { type: "object", additionalProperties: false, properties: {} }
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
        description: "Given a file path, return which other files import or call symbols defined in it (view=files, default), or list external symbols that call into the file grouped by caller symbol (view=surface). Use groupBy='module' to group results by top-level folder.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["repoId", "filePath"],
          properties: {
            repoId: { type: "string" },
            filePath: { type: "string" },
            limit: { type: "integer", minimum: 1, maximum: MAX_RESULT_LIMIT },
            groupBy: { type: "string", enum: ["file", "module"] },
            view: { type: "string", enum: ["files", "surface"] }
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
        description: "Summarise a file: its exported symbols, outgoing imports, and which files import it. Use to understand module boundaries before editing.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["repoId", "filePath"],
          properties: {
            repoId: { type: "string" },
            filePath: { type: "string" }
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
        description: "Single-call planning pack for a symbol name: ranked candidates + callers + callees + importers + change-context. Use to replace multi-hop lookups (previously get_context_by_name, find_references, get_symbol_candidates) in Plan mode.",
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
        description: "Unified docs tool. mode=search: full-text search across indexed documentation sections; mode=stale: find docs that mention changed symbols; mode=coverage: show which exported symbols are documented. Requires docs lane enabled.",
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
        description: "List all files under a folder path with per-file stats (language, symbol count, caller count). Use at the start of a Plan mode session to orient in a codebase layer (e.g. src/Application/) without reading file contents.",
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
        description: "Run a read-only SQL query against graph tables in a sandboxed mode. Requires :repoId named parameter in SQL and blocks write/admin statements.",
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
        description: "Preview deterministic bulk replacements with scope and type-ownership guards before applying any change.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["repoId", "find", "replaceExpression"],
          properties: {
            repoId: { type: "string" },
            find: { type: "string" },
            replaceExpression: { type: "string" },
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
            mode: { type: "string", enum: ["text", "syntax-aware", "symbol-aware"] },
            ambiguityThresholdPercent: { type: "number", minimum: 0, maximum: 100 }
          }
        }
      },
      {
        name: "refactor_replace_apply",
        description: "Apply an approved replacement plan exactly as previewed using previewId and approval token.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["previewId", "approvalToken"],
          properties: {
            previewId: { type: "string" },
            approvalToken: { type: "string" },
            maxFilesPerBatch: { type: "integer", minimum: 1, maximum: 500 },
            stopOnFirstConflict: { type: "boolean" },
            includeLowConfidence: { type: "boolean" }
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
                  forbiddenOwnerTypes: { type: "array", items: { type: "string" }, maxItems: 200 }
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
  const cursor = request.params?.cursor;
  if (cursor) {
    return { resources: [] };
  }

  const resources = store.listRepositories().flatMap((repo) => ([
    {
      uri: `repo://${repo.repoId}/context`,
      name: `${repo.repoId} context`,
      description: "Repository metadata, latest run, and staleness snapshot",
      mimeType: "application/json"
    },
    {
      uri: `repo://${repo.repoId}/schema`,
      name: `${repo.repoId} schema`,
      description: "Graph storage counts and language distribution",
      mimeType: "application/json"
    },
    {
      uri: `repo://${repo.repoId}/routes`,
      name: `${repo.repoId} routes`,
      description: "C# ASP.NET route map extracted from attributes",
      mimeType: "application/json"
    },
    {
      uri: `repo://${repo.repoId}/risk`,
      name: `${repo.repoId} risk`,
      description: "Compact deterministic detect_changes snapshot",
      mimeType: "application/json"
    }
  ]));

  return { resources };
});

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const uri = request.params.uri;
  const parsed = parseRepoResourceUri(uri);
  if (!parsed) {
    throw new McpError(ErrorCode.InvalidParams, "resources/read: unsupported uri. Use repo://{repoId}/{context|schema|routes|risk}");
  }

  const repo = store.getRepository(parsed.repoId);
  if (!repo) {
    throw new McpError(ErrorCode.InvalidParams, `resources/read: unknown repoId '${parsed.repoId}'. Run index_repository first.`);
  }

  let payload: unknown;
  if (parsed.resource === "context") {
    payload = {
      repo: store.getRepository(parsed.repoId),
      latestRun: store.getLatestRun(parsed.repoId),
      staleness: getRepoStaleness(parsed.repoId)
    };
  } else if (parsed.resource === "schema") {
    payload = store.getRepoSchemaSnapshot(parsed.repoId);
  } else if (parsed.resource === "routes") {
    const routes = store.getRouteMap(parsed.repoId, null, null, Math.min(parsed.limit ?? 200, MAX_RESULT_LIMIT));
    payload = {
      repoId: parsed.repoId,
      count: routes.length,
      routes
    };
  } else {
    const risk = buildRiskSnapshot(parsed.repoId, "strict-review", Math.min(parsed.limit ?? 50, 100));
    payload = risk;
  }

  return {
    contents: [
      {
        uri,
        mimeType: "application/json",
        text: JSON.stringify(payload, null, 2)
      }
    ]
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const toolName = request.params.name;
  const startedAt = Date.now();
  const args = asArgsRecord(request.params.arguments);

  return toolContextStorage.run({ toolName, startedAt, args }, async () => {
    try {
      await maybeAutoActivateWatchFromArgs(toolName, args);

      switch (request.params.name) {
      case "health_check": {
        const args = healthCheckSchema.parse(request.params.arguments ?? {});
        return handleHealthCheck(args.repoId);
      }
      case "index_repository": {
        const args = indexRepositorySchema.parse(request.params.arguments ?? {});
        assertPathAllowed(args.repoPath, allowedRoots);
        const docsEnabled = resolveDocsMode(args.docsMode);
        store.ensureRepository(args.repoId, args.repoPath);
        const summary = await runIndexAndResolve(
          args.repoId,
          args.repoPath,
          args.mode,
          docsEnabled,
          clamp(args.maxFiles, 1, MAX_FILES_PER_RUN),
          clamp(args.batchSize, 1, 2_000)
        );
        return asText(summary);
      }
      case "get_dependency_graph": {
        const args = getDependencyGraphSchema.parse(request.params.arguments ?? {});
        if (args.filePath) {
          const result = store.getModuleFlow(args.repoId, args.filePath, args.limit);
          return asText({
            repoId: args.repoId,
            filePath: args.filePath,
            edges: result.edges,
            unresolvedCalls: result.unresolvedCalls
          });
        }
        let rows = traverseDependencyGraph(args.repoId, args.symbolId!, args.depth, args.limit);
        // Fallback: class/function symbols have no direct IMPORTS edges — use their file's module symbol
        if (rows.length === 0) {
          const detail = store.getSymbolDetail(args.repoId, args.symbolId!, 1);
          if (detail.symbol) {
            const moduleSymbolId = store.findModuleSymbolId(args.repoId, detail.symbol.filePath);
            if (moduleSymbolId) {
              rows = traverseDependencyGraph(args.repoId, moduleSymbolId, args.depth, args.limit);
            }
          }
        }
        return asText({ repoId: args.repoId, symbolId: args.symbolId, depth: args.depth, edges: rows });
      }
      case "get_call_chain": {
        const args = getCallChainSchema.parse(request.params.arguments ?? {});
        const direction: CallChainDirection = args.direction;
        const rows = traverseCallGraph(args.repoId, args.symbolId, direction, args.depth, args.limit);
        return asText({ repoId: args.repoId, symbolId: args.symbolId, direction, depth: args.depth, edges: rows });
      }
      case "find_impact_files": {
        const args = findImpactFilesSchema.parse(request.params.arguments ?? {});
        if (args.view === "surface") {
          const result = store.getImpactSurface(args.repoId, args.filePath, args.limit);
          return asText({ repoId: args.repoId, filePath: args.filePath, ...result });
        }
        const result = store.getImpactFiles(args.repoId, args.filePath, args.limit);
        if (args.groupBy === "module") {
          const filePaths = result.impactedFiles.map((f) => f.filePath);
          const grouped = store.groupFilesByModule(filePaths);
          const moduleGroups = Object.entries(grouped).map(([module, files]) => ({
            module,
            fileCount: files.length,
            topFiles: files.slice(0, 5)
          }));
          return asText({ repoId: args.repoId, filePath: args.filePath, moduleGroups, graphHealth: result.graphHealth, reliabilitySummary: result.reliabilitySummary });
        }
        return asText({ repoId: args.repoId, filePath: args.filePath, ...result });
      }
      case "get_change_context": {
        const args = getChangeContextSchema.parse(request.params.arguments ?? {});
        const profile = resolveResponseProfile(args.profile);
        let resolvedSymbolId = args.symbolId;
        if (!resolvedSymbolId && args.name) {
          const context = store.getContextByName(args.repoId, args.name, args.limit);
          if (!context.symbol) {
            return asText({
              symbol: null,
              callers: [],
              callees: [],
              typeDeps: [],
              graphHealth: { unresolvedCalls: 0, unresolvedImports: 0, unresolvedTypeRefs: 0, note: "symbol not found" },
              queryName: args.name
            }, profile);
          }
          resolvedSymbolId = context.symbol.symbolId;
        }
        const result = store.getChangeContext(args.repoId, resolvedSymbolId!, args.callerDepth, args.calleeDepth, args.limit);
        return asText(formatChangeContextPayload(result, profile), profile);
      }
      case "get_file_summary": {
        const args = getFileSummarySchema.parse(request.params.arguments ?? {});
        return asText(store.getFileSummary(args.repoId, args.filePath));
      }
      case "list_repositories": {
        listRepositoriesSchema.parse(request.params.arguments ?? {});
        return asText(store.listRepositories());
      }
      case "search_symbols": {
        const args = searchSymbolsSchema.parse(request.params.arguments ?? {});
        const profile = resolveResponseProfile(args.profile, args.compact);
        if (args.ranked) {
          const candidates = store.getSymbolCandidates(args.repoId ?? "", args.query, args.limit);
          return asText({ query: args.query, count: candidates.length, candidates }, profile);
        }
        const results = store.searchSymbols(
          args.query,
          args.repoId ?? null,
          args.language ?? null,
          args.kind ?? null,
          args.filePath ?? null,
          args.limit,
          args.strategy
        );
        const suggestions = results.length === 0 ? store.getSearchSuggestions(args.query, args.repoId ?? null, 5) : [];
        const staleness = args.repoId ? getRepoStaleness(args.repoId) : null;
        if (profile === "nano") {
          const topSymbols = results.slice(0, 10).map((s) => ({ name: s.name, kind: s.kind, filePath: s.filePath, line: s.line }));
          return asText({
            query: args.query,
            strategy: args.strategy,
            count: results.length,
            topSymbols,
            hasMore: results.length > topSymbols.length,
            suggestions: suggestions.slice(0, 3),
            isStale: staleness?.isStale ?? null
          }, profile);
        }
        if (profile === "compact") {
          return asText({
            query: args.query,
            strategy: args.strategy,
            count: results.length,
            symbols: results.map((s) => ({ name: s.name, kind: s.kind, filePath: s.filePath, line: s.line })),
            suggestions,
            staleness
          }, profile);
        }
        if (profile === "verbose") {
          return asText({
            query: args.query,
            strategy: args.strategy,
            count: results.length,
            symbols: results,
            suggestions,
            staleness,
            summary: {
              repoFilter: args.repoId ?? null,
              languageFilter: args.language ?? null,
              kindFilter: args.kind ?? null,
              filePathFilter: args.filePath ?? null
            }
          }, profile);
        }
        return asText({ query: args.query, strategy: args.strategy, count: results.length, symbols: results, suggestions, staleness }, profile);
      }
      case "get_file_context": {
        const args = getFileContextSchema.parse(request.params.arguments ?? {});
        const profile = resolveResponseProfile(args.profile, args.compact);
        if (args.filePaths) {
          const result = store.getBatchContext(args.repoId, args.filePaths, args.limit, profile === "compact" || profile === "nano");
          if (profile === "nano") {
            const symbols = (result.symbols as { name: string; kind: string; filePath: string; line: number }[]).slice(0, 20);
            return asText({
              fileCount: args.filePaths.length,
              symbolCount: result.symbols.length,
              topSymbols: symbols,
              hasMoreSymbols: result.symbols.length > symbols.length
            }, profile);
          }
          if (profile === "verbose") {
            return asText({
              ...result,
              summary: {
                fileCount: args.filePaths.length,
                symbolCount: result.symbols.length,
                edgeCount: result.edges.length
              }
            }, profile);
          }
          return asText(result, profile);
        }
        const result = store.getFileContext(args.repoId, args.filePath!, args.limit, profile === "compact" || profile === "nano");
        if (profile === "nano") {
          const symbols = (result.symbols as { name: string; kind: string; line: number }[]).slice(0, 12);
          return asText({
            filePath: args.filePath,
            symbolCount: result.symbols.length,
            topSymbols: symbols,
            hasMoreSymbols: result.symbols.length > symbols.length
          }, profile);
        }
        if (profile === "verbose") {
          return asText({ ...result, summary: { symbolCount: result.symbols.length, edgeCount: result.edges.length } }, profile);
        }
        return asText(result, profile);
      }
      case "get_symbol_detail": {
        const args = getSymbolDetailSchema.parse(request.params.arguments ?? {});
        return asText(store.getSymbolDetail(args.repoId, args.symbolId, args.limit));
      }
      case "query_docs": {
        assertDocsLaneEnabled("query_docs");
        const args = queryDocsSchema.parse(request.params.arguments ?? {});
        if (args.mode === "search") {
          return asText(store.searchDocs(args.repoId, args.query!, args.limit));
        }
        if (args.mode === "stale") {
          return asText(store.findStaleDocs(args.repoId, args.symbolIds!));
        }
        return asText(store.findDocCoverage(args.repoId, args.filePath!));
      }
      case "watch_repo": {
        const args = watchRepoSchema.parse(request.params.arguments ?? {});
        if (args.action === "start") {
          if (!args.repoId) {
            throw new McpError(ErrorCode.InvalidParams, "watch_repo: repoId is required for action=start");
          }
          if (!args.repoPath) {
            throw new McpError(ErrorCode.InvalidParams, "watch_repo: repoPath is required for action=start");
          }
          assertPathAllowed(args.repoPath, allowedRoots);
          store.ensureRepository(args.repoId, args.repoPath);
          const startResult = await activateWatchForRepo(args.repoId, args.repoPath, "watch_repo:start");
          return asText(startResult);
        } else if (args.action === "stop") {
          if (!args.repoId) {
            throw new McpError(ErrorCode.InvalidParams, "watch_repo: repoId is required for action=stop");
          }
          if (activeWatchRepoId === args.repoId) {
            activeWatchRepoId = null;
          }
          clearWatchInactivityTimer(args.repoId);
          return asText(await watchManager.stop(args.repoId));
        } else {
          return asText({
            autoStartEnabled: WATCH_AUTO_START,
            manualWatchSupported: true,
            activeOnly: WATCH_ACTIVE_ONLY,
            activeWatchRepoId,
            watchActiveTtlMs: WATCH_ACTIVE_TTL_MS,
            recommendation: "Use watch_repo start only for short debug sessions; stop after diagnostics.",
            config: watchConfig,
            watchers: watchManager.getStatus(args.repoId)
          });
        }
      }
      case "find_symbol_at_line": {
        const args = findSymbolAtLineSchema.parse(request.params.arguments ?? {});
        const symbol = store.findSymbolAtLine(args.repoId, args.filePath, args.line);
        return asText({ repoId: args.repoId, filePath: args.filePath, line: args.line, symbol });
      }
      case "get_symbol_context_pack": {
        const args = getSymbolContextPackSchema.parse(request.params.arguments ?? {});
        const profile = resolveResponseProfile(args.profile);
        const candidates = store.getSymbolCandidates(args.repoId, args.name, args.limit);
        const context = store.getContextByName(args.repoId, args.name, args.limit);
        const selectedSymbolId = context.symbol?.symbolId ?? candidates[0]?.symbolId ?? null;
        const change = selectedSymbolId
          ? store.getChangeContext(args.repoId, selectedSymbolId, args.callerDepth, args.calleeDepth, args.limit)
          : null;

        if (profile === "nano") {
          const topCandidates = candidates.slice(0, 5).map((x) => ({ name: x.name, kind: x.kind, filePath: x.filePath, score: x.score }));
          return asText({
            queryName: args.name,
            selectedSymbol: context.symbol ? { name: context.symbol.name, kind: context.symbol.kind, filePath: context.symbol.filePath } : null,
            candidateCount: candidates.length,
            topCandidates,
            callerCount: context.callers.length,
            calleeCount: context.callees.length,
            importerCount: context.importedByFiles.length,
            change: change ? formatChangeContextPayload(change, "nano") : null
          }, profile);
        }

        if (profile === "compact") {
          return asText({
            queryName: args.name,
            selectedSymbol: context.symbol
              ? { symbolId: context.symbol.symbolId, name: context.symbol.name, kind: context.symbol.kind, filePath: context.symbol.filePath, line: context.symbol.line }
              : null,
            candidates: candidates.map((x) => ({ symbolId: x.symbolId, name: x.name, kind: x.kind, filePath: x.filePath, line: x.line, score: x.score, confidence: x.confidence })),
            context: {
              callers: context.callers.map((x) => ({ callerName: x.callerName, callerFile: x.callerFile, callerLine: x.callerLine })),
              callees: context.callees.map((x) => ({ calleeName: x.calleeName, calleeFile: x.calleeFile, calleeLine: x.calleeLine })),
              importedByFiles: context.importedByFiles
            },
            change: change ? formatChangeContextPayload(change, "compact") : null
          }, profile);
        }

        if (profile === "verbose") {
          return asText({
            queryName: args.name,
            selectedSymbolId,
            candidates,
            context,
            change,
            summary: {
              candidateCount: candidates.length,
              contextMatchedCount: context.allMatchedSymbols.length,
              hasChangeContext: change != null
            }
          }, profile);
        }

        return asText({
          queryName: args.name,
          selectedSymbolId,
          candidates,
          context,
          change
        }, profile);
      }
      case "dead_code_scan": {
        const args = deadCodeScanSchema.parse(request.params.arguments ?? {});
        const profile = resolveResponseProfile(args.profile);
        const scan = store.getDeadCodeCandidates(
          args.repoId,
          args.filePathPrefix ?? null,
          args.language ?? null,
          args.kind ?? null,
          args.includePrivate,
          args.limit
        );
        const rows = scan.candidates;

        if (profile === "nano") {
          const topSymbols = rows.slice(0, 10).map((x) => ({ name: x.name, kind: x.kind, filePath: x.filePath, line: x.line }));
          return asText({
            repoId: args.repoId,
            count: rows.length,
            topSymbols,
            hasMore: rows.length > topSymbols.length,
            suppressed: scan.suppressed,
            scanPolicy: scan.scanPolicy
          }, profile);
        }

        if (profile === "compact") {
          return asText({
            repoId: args.repoId,
            count: rows.length,
            suppressed: scan.suppressed,
            scanPolicy: scan.scanPolicy,
            symbols: rows.map((x) => ({
              symbolId: x.symbolId,
              name: x.name,
              kind: x.kind,
              filePath: x.filePath,
              line: x.line,
              deadReason: x.deadReason
            }))
          }, profile);
        }

        return asText({
          repoId: args.repoId,
          count: rows.length,
          suppressed: scan.suppressed,
          scanPolicy: scan.scanPolicy,
          symbols: rows
        }, profile);
      }
      case "detect_circular_dependencies": {
        const args = detectCircularDependenciesSchema.parse(request.params.arguments ?? {});
        const profile = resolveResponseProfile(args.profile);
        const result = store.detectCircularDependencies(
          args.repoId,
          args.filePathPrefix ?? null,
          args.mode,
          args.includeCalls,
          args.maxDepth,
          args.maxCycles
        );

        if (profile === "nano") {
          const topCycles = result.cycles.slice(0, 5).map((c) => ({ path: c.path, length: c.length }));
          return asText({ repoId: args.repoId, mode: result.mode, cycleCount: result.cycleCount, topCycles }, profile);
        }

        if (profile === "compact") {
          return asText({
            repoId: args.repoId,
            mode: result.mode,
            cycleCount: result.cycleCount,
            cycles: result.cycles.map((c) => ({ path: c.path, edgeTypes: c.edgeTypes, length: c.length }))
          }, profile);
        }

        return asText({ repoId: args.repoId, ...result }, profile);
      }
      case "get_cross_repo_impact": {
        const args = crossRepoImpactSchema.parse(request.params.arguments ?? {});
        const profile = resolveResponseProfile(args.profile);

        let symbolId = args.symbolId;
        if (!symbolId && args.name) {
          const candidates = store.searchSymbols(args.name, args.repoId, null, null, null, 1, "name");
          symbolId = candidates[0]?.symbolId;
        }
        if (!symbolId) {
          throw new McpError(ErrorCode.InvalidParams, "get_cross_repo_impact: symbol not found. Provide symbolId or a resolvable name.");
        }

        const symbol = store.getSymbolDetail(args.repoId, symbolId, 1).symbol;
        if (!symbol) {
          throw new McpError(ErrorCode.InvalidParams, `get_cross_repo_impact: symbol '${symbolId}' not found in repo '${args.repoId}'.`);
        }

        const impactRows = store.getCrossRepoImpact(args.repoId, symbolId, args.direction, args.limit);

        if (profile === "nano") {
          return asText({
            repoId: args.repoId,
            symbol: { symbolId: symbol.symbolId, name: symbol.name, kind: symbol.kind },
            direction: args.direction,
            impactCount: impactRows.length,
            relatedRepos: [...new Set(impactRows.map((x) => (args.direction === "outbound" ? x.toRepoId : x.fromRepoId)))].slice(0, 10)
          }, profile);
        }

        return asText({
          repoId: args.repoId,
          symbol,
          direction: args.direction,
          impactCount: impactRows.length,
          impacts: impactRows
        }, profile);
      }
      case "get_symbol_blame": {
        const args = symbolBlameSchema.parse(request.params.arguments ?? {});
        const profile = resolveResponseProfile(args.profile);

        let symbolId = args.symbolId;
        if (!symbolId && args.name) {
          const candidates = store.searchSymbols(args.name, args.repoId, null, null, null, 1, "name");
          symbolId = candidates[0]?.symbolId;
        }
        if (!symbolId) {
          throw new McpError(ErrorCode.InvalidParams, "get_symbol_blame: symbol not found. Provide symbolId or a resolvable name.");
        }

        const symbol = store.getSymbolDetail(args.repoId, symbolId, 1).symbol;
        if (!symbol) {
          throw new McpError(ErrorCode.InvalidParams, `get_symbol_blame: symbol '${symbolId}' not found in repo '${args.repoId}'.`);
        }

        const repo = store.getRepository(args.repoId);
        if (!repo) {
          throw new McpError(ErrorCode.InvalidParams, `get_symbol_blame: unknown repoId '${args.repoId}'. Run index_repository first.`);
        }

        let blameRaw: string;
        try {
          blameRaw = runGit(repo.repoPath, ["blame", "-L", `${symbol.line},${symbol.line}`, "--porcelain", "--", symbol.filePath.replace(/\\/g, "/")]);
        } catch {
          throw new McpError(ErrorCode.InvalidRequest, `get_symbol_blame: unable to run git blame for ${symbol.filePath}:${symbol.line}`);
        }

        const parsed = parseGitBlamePorcelain(blameRaw);
        const authorMail = args.redactEmail ? redactEmail(parsed.authorMail) : parsed.authorMail;

        if (profile === "nano") {
          return asText({
            repoId: args.repoId,
            symbol: { symbolId: symbol.symbolId, name: symbol.name, filePath: symbol.filePath, line: symbol.line },
            commit: parsed.commit,
            author: parsed.author,
            summary: parsed.summary
          }, profile);
        }

        return asText({
          repoId: args.repoId,
          symbol,
          blame: {
            commit: parsed.commit,
            author: parsed.author,
            authorMail,
            authorTime: parsed.authorTime,
            summary: parsed.summary
          }
        }, profile);
      }
      case "link_tests_to_source": {
        const args = linkTestsToSourceSchema.parse(request.params.arguments ?? {});
        const profile = resolveResponseProfile(args.profile);
        const links = store.linkTestsToSource(
          args.repoId,
          args.filePath ?? null,
          args.limit,
          args.maxCandidates,
          args.minScore
        );

        if (profile === "nano") {
          const topLinks = links.slice(0, 10).map((x) => ({ testFile: x.testFile, sourceFile: x.sourceFile, score: x.score }));
          return asText({ repoId: args.repoId, count: links.length, topLinks, hasMore: links.length > topLinks.length }, profile);
        }

        if (profile === "compact") {
          return asText({
            repoId: args.repoId,
            count: links.length,
            links: links.map((x) => ({
              testFile: x.testFile,
              sourceFile: x.sourceFile,
              score: x.score,
              reasons: x.reasons
            }))
          }, profile);
        }

        return asText({ repoId: args.repoId, count: links.length, links }, profile);
      }
      case "detect_changes": {
        const args = detectChangesSchema.parse(request.params.arguments ?? {});
        const profile = resolveResponseProfile(args.profile);
        const repo = store.getRepository(args.repoId);
        if (!repo) {
          throw new McpError(ErrorCode.InvalidParams, `detect_changes: unknown repoId '${args.repoId}'. Run index_repository first.`);
        }

        const latestRun = store.getLatestRun(args.repoId);
        const indexedCommitSha = latestRun?.commitSha ?? null;
        const headRef = args.headRef;
        const baseRef = args.baseRef ?? indexedCommitSha;
        const policyDefaults = resolveDetectChangesPolicy(args.policy);
        const minRiskScore = args.minRiskScore ?? policyDefaults.minRiskScore;
        const riskLevels = args.riskLevels ?? policyDefaults.riskLevels;
        const maxResults = args.maxResults ?? policyDefaults.maxResults;
        const sortBy = args.sortBy ?? policyDefaults.sortBy;

        // Detect working-tree mode: when base === HEAD, there are no new commits since last index.
        // Fall back to working-tree diff (unstaged + staged) to capture uncommitted changes.
        const headCommitSha = resolveHeadCommitSha(repo.repoPath);
        const isWorkingTreeMode = !baseRef || (headCommitSha != null && baseRef === headCommitSha);

        let trackedChanged: string[];
        let note: string;
        if (isWorkingTreeMode) {
          const unstaged = runGitLines(repo.repoPath, ["diff", "--name-only", "HEAD"]);
          const staged = runGitLines(repo.repoPath, ["diff", "--cached", "--name-only"]);
          trackedChanged = [...new Set([...unstaged, ...staged])];
          note = baseRef
            ? "using working-tree diff (no new commits since last index; showing staged + unstaged changes)"
            : "baseRef unavailable; using working-tree diff against HEAD";
        } else {
          trackedChanged = runGitLines(repo.repoPath, ["diff", "--name-only", `${baseRef}..${headRef}`]);
          note = "using git range diff";
        }

        const untracked = args.includeUntracked
          ? runGitLines(repo.repoPath, ["ls-files", "--others", "--exclude-standard"])
          : [];

        const changedFiles = [...new Set([...trackedChanged, ...untracked].map((x) => x.replace(/\\/g, "/").trim()).filter((x) => x.length > 0))]
          .slice(0, args.maxFiles);

        const impacts = changedFiles.map((filePath) => {
          const impact = store.getImpactFiles(args.repoId, filePath, args.impactLimit);
          const risk = scoreChangeRisk(impact.impactedFiles.length, impact.reliabilitySummary, args.impactLimit);
          return {
            filePath,
            impactedFilesCount: impact.impactedFiles.length,
            reliabilitySummary: impact.reliabilitySummary,
            riskScore: risk.riskScore,
            riskLevel: risk.riskLevel,
            riskSignals: risk.signals,
            topImpactedFiles: impact.impactedFiles.slice(0, 5)
          };
        });

        const sortedImpacts = [...impacts].sort((a, b) => {
          if (sortBy === "impact") {
            return b.impactedFilesCount - a.impactedFilesCount || b.riskScore - a.riskScore || a.filePath.localeCompare(b.filePath);
          }
          if (sortBy === "path") {
            return a.filePath.localeCompare(b.filePath);
          }
          return b.riskScore - a.riskScore || b.impactedFilesCount - a.impactedFilesCount || a.filePath.localeCompare(b.filePath);
        });

        const allowedRiskLevels = new Set(riskLevels);
        const filteredImpacts = sortedImpacts.filter((x) => x.riskScore >= minRiskScore && allowedRiskLevels.has(x.riskLevel));
        const selectedImpacts = filteredImpacts.slice(0, maxResults);

        const riskSummary = {
          highRiskCount: selectedImpacts.filter((x) => x.riskLevel === "high").length,
          mediumRiskCount: selectedImpacts.filter((x) => x.riskLevel === "medium").length,
          lowRiskCount: selectedImpacts.filter((x) => x.riskLevel === "low").length,
          maxRiskScore: selectedImpacts[0]?.riskScore ?? 0,
          avgRiskScore: selectedImpacts.length > 0
            ? Math.round((selectedImpacts.reduce((sum, x) => sum + x.riskScore, 0) / selectedImpacts.length) * 100) / 100
            : 0
        };

        const impactedFileSet = new Set<string>();
        for (const row of selectedImpacts) {
          for (const impacted of row.topImpactedFiles) {
            impactedFileSet.add(impacted.filePath);
          }
        }

        // Phase 7A: module grouping
        const moduleGroups = args.groupBy === "module"
          ? (() => {
              const allImpactedFiles = selectedImpacts.flatMap((x) => x.topImpactedFiles.map((f) => f.filePath));
              const grouped = store.groupFilesByModule(allImpactedFiles);
              return Object.entries(grouped).map(([module, files]) => ({
                module,
                fileCount: files.length,
                topFiles: files.slice(0, 5)
              })).sort((a, b) => b.fileCount - a.fileCount);
            })()
          : undefined;

        const filterInfo = {
          policyUsed: args.policy,
          minRiskScore,
          riskLevels: Array.from(allowedRiskLevels),
          maxResults,
          sortBy,
          matchedCount: filteredImpacts.length,
          returnedCount: selectedImpacts.length,
          droppedByLimit: Math.max(0, filteredImpacts.length - selectedImpacts.length)
        };

        if (profile === "nano") {
          const topRiskChanges = selectedImpacts.slice(0, 5).map((x) => ({ filePath: x.filePath, riskScore: x.riskScore, riskLevel: x.riskLevel }));
          return asText({
            repoId: args.repoId,
            baseRef,
            headRef,
            changedFileCount: changedFiles.length,
            topChangedFiles: changedFiles.slice(0, 20),
            topRiskChanges,
            riskSummary,
            filter: filterInfo,
            impactedFileCount: impactedFileSet.size,
            ...(moduleGroups ? { moduleGroups } : {}),
            note
          }, profile);
        }

        if (profile === "compact") {
          return asText({
            repoId: args.repoId,
            indexedCommitSha,
            baseRef,
            headRef,
            changedFileCount: changedFiles.length,
            changedFiles,
            impacts: selectedImpacts,
            riskSummary,
            filter: filterInfo,
            impactedFileCount: impactedFileSet.size,
            ...(moduleGroups ? { moduleGroups } : {}),
            note
          }, profile);
        }

        if (profile === "verbose") {
          return asText({
            repoId: args.repoId,
            indexedCommitSha,
            latestRun,
            baseRef,
            headRef,
            includeUntracked: args.includeUntracked,
            changedFileCount: changedFiles.length,
            changedFiles,
            impacts: selectedImpacts,
            riskSummary,
            filter: filterInfo,
            impactedFileCount: impactedFileSet.size,
            ...(moduleGroups ? { moduleGroups } : {}),
            note,
            summary: {
              filesCapped: changedFiles.length === args.maxFiles,
              maxFiles: args.maxFiles,
              impactLimit: args.impactLimit,
              resultsLimited: filterInfo.droppedByLimit > 0
            }
          }, profile);
        }

        return asText({
          repoId: args.repoId,
          indexedCommitSha,
          baseRef,
          headRef,
          changedFileCount: changedFiles.length,
          changedFiles,
          impacts: selectedImpacts,
          riskSummary,
          filter: filterInfo,
          impactedFileCount: impactedFileSet.size,
          ...(moduleGroups ? { moduleGroups } : {}),
          note
        }, profile);
      }
      case "get_folder_summary": {
        const args = getFolderSummarySchema.parse(request.params.arguments ?? {});
        return asText(store.getFolderSummary(args.repoId, args.folderPath, args.maxFiles));
      }
      case "find_entry_points": {
        const args = findEntryPointsSchema.parse(request.params.arguments ?? {});
        const entries = store.findEntryPoints(args.repoId, args.filePathPrefix ?? null, args.kind ?? null, args.limit);
        return asText({
          repoId: args.repoId,
          total: entries.length,
          runtimeEntryPoints: entries.filter((e) => e.entryReason === "bootstrap_file"),
          graphEntryPoints: entries.filter((e) => e.entryReason === "uncalled_symbol"),
          entryPoints: entries
        });
      }
      case "find_implementations": {
        const args = findImplementationsSchema.parse(request.params.arguments ?? {});
        return asText(store.findImplementations(args.repoId, args.interfaceName, args.limit));
      }
      case "route_map": {
        const args = routeMapSchema.parse(request.params.arguments ?? {});
        const profile = resolveResponseProfile(args.profile);
        const routes = store.getRouteMap(args.repoId, args.filePathPrefix ?? null, args.httpMethod ?? null, args.limit);

        if (profile === "nano") {
          const topRoutes = routes.slice(0, 10).map((r) => ({ method: r.httpMethod, route: r.routeTemplate, handlerName: r.handlerName, filePath: r.filePath }));
          return asText({ repoId: args.repoId, count: routes.length, topRoutes, hasMore: routes.length > topRoutes.length }, profile);
        }

        if (profile === "compact") {
          return asText({
            repoId: args.repoId,
            count: routes.length,
            routes: routes.map((r) => ({
              filePath: r.filePath,
              controllerName: r.controllerName,
              handlerName: r.handlerName,
              httpMethod: r.httpMethod,
              routeTemplate: r.routeTemplate,
              line: r.line
            }))
          }, profile);
        }

        if (profile === "verbose") {
          const byMethod = routes.reduce<Record<string, number>>((acc, row) => {
            acc[row.httpMethod] = (acc[row.httpMethod] ?? 0) + 1;
            return acc;
          }, {});
          return asText({ repoId: args.repoId, count: routes.length, routes, summary: { byMethod } }, profile);
        }

        return asText({ repoId: args.repoId, count: routes.length, routes }, profile);
      }
      case "query_graph": {
        const args = queryGraphSchema.parse(request.params.arguments ?? {});
        const profile = resolveResponseProfile(args.profile);

        const readOnlyCheck = validateReadOnlyGraphSql(args.sql);
        if (!readOnlyCheck.ok) {
          throw new McpError(ErrorCode.InvalidParams, readOnlyCheck.message);
        }

        const allowlistCheck = validateAllowedTables(
          readOnlyCheck.sanitizedSql,
          new Set([
            "repositories",
            "files",
            "symbols",
            "edges",
            "index_runs",
            "routes",
            "cross_repo_deps",
            "refactor_previews",
            "refactor_preview_hunks",
            "refactor_applies",
            "refactor_apply_changes",
            "refactor_apply_hunks",
            "refactor_rollbacks"
          ])
        );
        if (!allowlistCheck.ok) {
          throw new McpError(ErrorCode.InvalidParams, allowlistCheck.message);
        }

        let result: ReturnType<typeof store.runReadOnlyGraphQuery>;
        try {
          result = store.runReadOnlyGraphQuery(
            allowlistCheck.sanitizedSql,
            { ...args.params, repoId: args.repoId },
            args.limit,
            args.timeoutMs
          );
        } catch (err: unknown) {
          const raw = err instanceof Error ? err.message : String(err);
          // Redact quoted literals that may contain user data from SQLite error messages
          const safe = raw.replace(/['"][^'"]{0,200}['"]/g, "'...'").slice(0, 300);
          throw new McpError(ErrorCode.InternalError, `query_graph: query failed — ${safe}. Check SQL syntax and allowed tables.`);
        }
        const elapsedMs = result.elapsedMs;
        const timeoutExceeded = result.timedOut;

        if (timeoutExceeded) {
          throw new McpError(ErrorCode.InvalidRequest, `query_graph: query exceeded timeout of ${args.timeoutMs}ms (took ${elapsedMs}ms). Simplify the query or increase timeoutMs.`);
        }

        if (profile === "nano") {
          return asText({ columns: result.columns, rowCount: result.rowCount, truncated: result.truncated, elapsedMs, timeoutExceeded }, profile);
        }

        if (profile === "compact") {
          return asText({
            columns: result.columns,
            rowCount: result.rowCount,
            truncated: result.truncated,
            elapsedMs,
            timeoutExceeded,
            rows: result.rows
          }, profile);
        }

        return asText({
          repoId: args.repoId,
          sql: allowlistCheck.sanitizedSql,
          params: { ...args.params, repoId: args.repoId },
          limit: args.limit,
          elapsedMs,
          timeoutMs: args.timeoutMs,
          timeoutExceeded,
          columns: result.columns,
          rows: result.rows,
          rowCount: result.rowCount,
          truncated: result.truncated
        }, profile);
      }
      case "rename_assist": {
        const args = renameAssistSchema.parse(request.params.arguments ?? {});
        const profile = resolveResponseProfile(args.profile);
        const result = store.getRenameImpact(args.repoId, args.symbolId, args.limit);
        if (!result.symbol) {
          throw new McpError(ErrorCode.InvalidParams, `rename_assist: symbol '${args.symbolId}' not found in repo '${args.repoId}'.`);
        }
        const affectedFiles = [
          ...new Set([
            ...result.callers.map((c) => c.fromFilePath).filter(Boolean),
            ...result.importers.map((i) => i.fromFilePath).filter(Boolean)
          ])
        ] as string[];
        const hints = affectedFiles.map((fp) => `In ${fp}: rename '${result.symbol!.name}' → '${args.newName}'`);
        if (profile === "nano") {
          return asText({
            oldName: result.symbol.name,
            newName: args.newName,
            symbolId: args.symbolId,
            affectedFileCount: result.affectedFileCount,
            affectedFiles
          }, profile);
        }
        const payload = {
          symbol: { symbolId: result.symbol.symbolId, name: result.symbol.name, kind: result.symbol.kind, filePath: result.symbol.filePath, line: result.symbol.line },
          newName: args.newName,
          affectedFileCount: result.affectedFileCount,
          affectedFiles,
          callerCount: result.callers.length,
          importerCount: result.importers.length,
          callers: profile === "verbose" ? result.callers : result.callers.map((c) => ({ fromId: c.fromId, fromName: c.fromName, fromFilePath: c.fromFilePath, confidence: c.confidence ?? null })),
          importers: profile === "verbose" ? result.importers : result.importers.map((i) => ({ fromId: i.fromId, fromName: i.fromName, fromFilePath: i.fromFilePath, confidence: i.confidence ?? null })),
          hints
        };
        return asText(payload, profile);
      }
      case "refactor_replace_preview": {
        const args = refactorReplacePreviewSchema.parse(request.params.arguments ?? {});
        const repo = store.getRepository(args.repoId);
        if (!repo) {
          throw new McpError(ErrorCode.InvalidParams, `refactor_replace_preview: repo '${args.repoId}' not found. Run index_repository first.`);
        }

        const previewResult = buildRefactorPreview(repo.repoPath, args.repoId, args.find, args.replaceExpression, args.scope, args.guards, args.mode);
        const riskCounts = countPreviewRisks(previewResult.hunks);
        const ambiguousRatio = previewResult.hunks.length > 0
          ? (riskCounts.ambiguous / previewResult.hunks.length) * 100
          : 0;
        const blockedByAmbiguity = ambiguousRatio > args.ambiguityThresholdPercent;

        const now = new Date();
        const expiresAt = new Date(now.getTime() + REFACTOR_PREVIEW_TTL_MS).toISOString();
        const digest = createPreviewDigest(args.repoId, args.find, args.replaceExpression, previewResult.hunks);
        const previewId = `preview_${randomUUID()}`;

        const previewRecord: RefactorPreviewRecord = {
          previewId,
          repoId: args.repoId,
          findPattern: args.find,
          replaceExpression: args.replaceExpression,
          mode: args.mode,
          ambiguityThresholdPercent: args.ambiguityThresholdPercent,
          createdAt: now.toISOString(),
          expiresAt,
          digest,
          status: "ready",
          totalMatches: previewResult.hunks.length,
          affectedFileCount: previewResult.affectedFiles.length,
          riskAmbiguousCount: riskCounts.ambiguous,
          riskCrossTypeCount: riskCounts.crossType,
          riskGeneratedCount: riskCounts.generated
        };

        const hunkRecords: RefactorPreviewHunkRecord[] = previewResult.hunks.map((hunk, index) => ({
          previewId,
          hunkId: `${previewId}_${String(index + 1).padStart(6, "0")}`,
          filePath: hunk.filePath,
          line: hunk.line,
          startOffset: hunk.startOffset,
          endOffset: hunk.endOffset,
          beforeText: hunk.beforeText,
          afterText: hunk.afterText,
          replacementText: args.replaceExpression,
          ownerType: hunk.ownerType,
          symbolKind: hunk.symbolKind,
          confidence: hunk.confidence,
          riskFlags: hunk.riskFlags,
          fileHashBefore: hunk.fileHashBefore
        }));

        store.saveRefactorPreview(previewRecord, hunkRecords);

        const approvalToken = issueApprovalToken(previewId, digest, expiresAt);

        return asText({
          previewId,
          mode: args.mode,
          totalMatches: previewResult.hunks.length,
          affectedFiles: previewResult.affectedFiles,
          groupedPreviewHunks: groupPreviewHunks(hunkRecords),
          riskFlags: {
            ambiguousTargets: riskCounts.ambiguous,
            crossTypeReplacements: riskCounts.crossType,
            generatedFiles: riskCounts.generated
          },
          ambiguity: {
            ratioPercent: Number(ambiguousRatio.toFixed(2)),
            thresholdPercent: args.ambiguityThresholdPercent,
            blockedByPolicy: blockedByAmbiguity
          },
          diagnostics: {
            code: blockedByAmbiguity ? "PREVIEW_BLOCKED_BY_AMBIGUITY" : "PREVIEW_READY",
            machineReadable: true
          },
          executionPolicy: noLlmAudit(),
          approvalToken,
          expiresAt
        });
      }
      case "refactor_replace_apply": {
        const args = refactorReplaceApplySchema.parse(request.params.arguments ?? {});
        const preview = store.getRefactorPreview(args.previewId);
        if (!preview) {
          throw new McpError(ErrorCode.InvalidParams, `refactor_replace_apply: preview '${args.previewId}' not found.`);
        }

        if (Date.parse(preview.preview.expiresAt) < Date.now()) {
          throw new PolicyViolationError("PREVIEW_EXPIRED", "refactor_replace_apply: preview expired. Create a fresh preview before apply.");
        }

        const ambiguousRatio = preview.preview.totalMatches > 0
          ? (preview.preview.riskAmbiguousCount / preview.preview.totalMatches) * 100
          : 0;
        if (ambiguousRatio > preview.preview.ambiguityThresholdPercent) {
          throw new PolicyViolationError(
            "AMBIGUITY_THRESHOLD_EXCEEDED",
            `refactor_replace_apply: ambiguous ratio ${ambiguousRatio.toFixed(2)}% exceeds threshold ${preview.preview.ambiguityThresholdPercent}%.`
          );
        }

        verifyApprovalToken(args.approvalToken, preview.preview.previewId, preview.preview.digest, preview.preview.expiresAt);

        const repo = store.getRepository(preview.preview.repoId);
        if (!repo) {
          throw new McpError(ErrorCode.InvalidParams, `refactor_replace_apply: repo '${preview.preview.repoId}' not found.`);
        }

        const applyId = `apply_${randomUUID()}`;
        const rollbackId = `rollback_${randomUUID()}`;
        const expectedApplyFiles = collectExpectedApplyFiles(preview.hunks, args.includeLowConfidence);
        const beforeChangedFiles = collectGitChangedFiles(repo.repoPath);
        const applyOutcome = executeRefactorApplyPlan(
          repo.repoPath,
          applyId,
          preview.hunks,
          args.maxFilesPerBatch,
          args.stopOnFirstConflict,
          args.includeLowConfidence
        );
        const afterChangedFiles = collectGitChangedFiles(repo.repoPath);
        const newlyChangedFiles = [...afterChangedFiles].filter((x) => !beforeChangedFiles.has(x));
        const unexpectedChangedFiles = newlyChangedFiles.filter((x) => !expectedApplyFiles.has(x));
        const scopeDriftPercent = expectedApplyFiles.size > 0
          ? (unexpectedChangedFiles.length / expectedApplyFiles.size) * 100
          : 0;
        const scopeDriftDetected = scopeDriftPercent > 5;
        const changes = applyOutcome.changes;

        const appliedFiles = changes.filter((x) => x.status === "applied");
        const conflicted = changes.filter((x) => x.status === "conflict");
        const totalReplacements = appliedFiles.reduce((sum, item) => sum + item.replacementCount, 0);
        const applyStatus = deriveApplyStatus(changes);

        const applyRecord: RefactorApplyRecord = {
          applyId,
          rollbackId,
          previewId: preview.preview.previewId,
          repoId: preview.preview.repoId,
          status: applyStatus,
          createdAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          totalFiles: appliedFiles.length,
          totalReplacements,
          conflictCount: conflicted.length
        };

        store.recordRefactorApply(applyRecord, changes, applyOutcome.appliedHunks);
        store.markRefactorPreviewStatus(preview.preview.previewId, mapPreviewStatusFromApplyStatus(applyRecord.status));

        return asText({
          applyId,
          rollbackId,
          appliedFiles: appliedFiles.map((x) => x.filePath),
          appliedReplacementsCount: totalReplacements,
          skippedReplacements: changes
            .filter((x) => x.status !== "applied")
            .map((x) => ({ filePath: x.filePath, status: x.status, reason: x.reason })),
          laneBreakdown: {
            highConfidenceEdits: applyOutcome.lane.highConfidenceEdits,
            lowConfidenceEdits: applyOutcome.lane.lowConfidenceEdits,
            lowConfidenceSkipped: applyOutcome.lane.lowConfidenceSkipped,
            lowConfidenceThreshold: REFACTOR_LOW_CONFIDENCE_THRESHOLD,
            includeLowConfidence: args.includeLowConfidence
          },
          scopeCheck: {
            expectedFiles: [...expectedApplyFiles].sort((a, b) => a.localeCompare(b)),
            newlyChangedFiles: newlyChangedFiles.sort((a, b) => a.localeCompare(b)),
            unexpectedFiles: unexpectedChangedFiles.sort((a, b) => a.localeCompare(b)),
            driftPercent: Number(scopeDriftPercent.toFixed(2)),
            driftThresholdPercent: 5
          },
          patchSummary: appliedFiles.map((x) => ({ filePath: x.filePath, replacementCount: x.replacementCount })),
          diagnostics: {
            code: scopeDriftDetected
              ? "SCOPE_DRIFT_DETECTED"
              : applyStatus !== "applied"
                ? "APPLY_PARTIAL_OR_CONFLICT"
                : "APPLY_OK",
            machineReadable: true
          },
          executionPolicy: noLlmAudit()
        });
      }
      case "refactor_replace_rollback": {
        const args = refactorReplaceRollbackSchema.parse(request.params.arguments ?? {});
        const payload = store.getApplyByRollbackId(args.rollbackId);
        if (!payload) {
          throw new McpError(ErrorCode.InvalidParams, `refactor_replace_rollback: rollbackId '${args.rollbackId}' not found.`);
        }

        const repo = store.getRepository(payload.apply.repoId);
        if (!repo) {
          throw new McpError(ErrorCode.InvalidParams, `refactor_replace_rollback: repo '${payload.apply.repoId}' not found.`);
        }

        let restored = 0;
        let conflicts = 0;
        const touchedFiles = new Set<string>();

        if (payload.hunks.length > 0) {
          const hunkByFile = new Map<string, RefactorApplyHunkRecord[]>();
          for (const hunk of payload.hunks) {
            const list = hunkByFile.get(hunk.filePath) ?? [];
            list.push(hunk);
            hunkByFile.set(hunk.filePath, list);
          }

          for (const [filePath, hunks] of hunkByFile.entries()) {
            const absolute = assertSafeRepoFilePath(repo.repoPath, filePath);
            if (!fs.existsSync(absolute)) {
              conflicts += 1;
              continue;
            }

            let content = safeReadText(absolute);
            let fileRestoredSegments = 0;

            try {
              for (const hunk of [...hunks].sort((a, b) => b.startOffsetApplied - a.startOffsetApplied || b.hunkId.localeCompare(a.hunkId))) {
                const expectedCurrent = content.slice(hunk.startOffsetApplied, hunk.endOffsetApplied);
                if (expectedCurrent !== hunk.afterText) {
                  conflicts += 1;
                  continue;
                }

                content = `${content.slice(0, hunk.startOffsetApplied)}${hunk.beforeText}${content.slice(hunk.endOffsetApplied)}`;
                fileRestoredSegments += 1;
              }

              if (fileRestoredSegments > 0) {
                fs.writeFileSync(absolute, content, "utf8");
                touchedFiles.add(filePath);
              }
            } catch {
              conflicts += 1;
            }
          }
        } else {
          for (const change of payload.changes) {
            if (change.status !== "applied") {
              continue;
            }
            if (change.beforeContent == null) {
              // Content was not stored (exceeded size cap). Hunk-level restore was unavailable
              // too (no hunks), so we cannot safely restore this file — count as conflict.
              conflicts += 1;
              continue;
            }
            const absolute = assertSafeRepoFilePath(repo.repoPath, change.filePath);
            if (!fs.existsSync(absolute)) {
              conflicts += 1;
              continue;
            }
            try {
              fs.writeFileSync(absolute, change.beforeContent, "utf8");
              touchedFiles.add(change.filePath);
            } catch {
              conflicts += 1;
            }
          }
        }

        restored = touchedFiles.size;

        const status: RefactorRollbackRecord["status"] = conflicts > 0 ? (restored > 0 ? "partial" : "failed") : "restored";
        store.recordRefactorRollback({
          rollbackId: args.rollbackId,
          applyId: payload.apply.applyId,
          status,
          createdAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          restoredFiles: restored,
          conflictCount: conflicts
        });

        if (status === "restored") {
          store.markRefactorPreviewStatus(payload.apply.previewId, "rolled_back");
        }

        return asText({
          rollbackId: args.rollbackId,
          restoredFilesCount: restored,
          conflicts,
          diagnostics: {
            code: conflicts > 0 ? "ROLLBACK_PARTIAL" : "ROLLBACK_OK",
            machineReadable: true
          },
          executionPolicy: noLlmAudit()
        });
      }
      case "refactor_symbol_migration": {
        const args = refactorSymbolMigrationSchema.parse(request.params.arguments ?? {});
        const repo = store.getRepository(args.repoId);
        if (!repo) {
          throw new McpError(ErrorCode.InvalidParams, `refactor_symbol_migration: repo '${args.repoId}' not found.`);
        }

        const migrationResults: Array<{
          fromSymbol: string;
          toSymbol: string;
          requiredOwnerType: string;
          previewId: string;
          totalMatches: number;
          unresolvedOccurrences: number;
          applyId?: string;
          rollbackId?: string;
        }> = [];
        const suggestedFollowUpFiles = new Set<string>();

        for (const migration of args.migrations) {
          const previewResult = buildSymbolMigrationPreview(repo.repoPath, args.repoId, migration, args.scopePaths);

          const now = new Date();
          const expiresAt = new Date(now.getTime() + REFACTOR_PREVIEW_TTL_MS).toISOString();
          const digest = createPreviewDigest(args.repoId, migration.fromSymbol, migration.toSymbol, previewResult.hunks);
          const previewId = `preview_${randomUUID()}`;
          const riskCounts = countPreviewRisks(previewResult.hunks);

          const hunkRecords: RefactorPreviewHunkRecord[] = previewResult.hunks.map((hunk, index) => ({
            previewId,
            hunkId: `${previewId}_${String(index + 1).padStart(6, "0")}`,
            filePath: hunk.filePath,
            line: hunk.line,
            startOffset: hunk.startOffset,
            endOffset: hunk.endOffset,
            beforeText: hunk.beforeText,
            afterText: hunk.afterText,
            replacementText: hunk.afterText,
            ownerType: hunk.ownerType,
            symbolKind: hunk.symbolKind,
            confidence: hunk.confidence,
            riskFlags: hunk.riskFlags,
            fileHashBefore: hunk.fileHashBefore
          }));

          const previewRecord: RefactorPreviewRecord = {
            previewId,
            repoId: args.repoId,
            findPattern: migration.fromSymbol,
            replaceExpression: migration.toSymbol,
            mode: "symbol-aware",
            ambiguityThresholdPercent: 1,
            createdAt: now.toISOString(),
            expiresAt,
            digest,
            status: "ready",
            totalMatches: previewResult.hunks.length,
            affectedFileCount: previewResult.affectedFiles.length,
            riskAmbiguousCount: riskCounts.ambiguous,
            riskCrossTypeCount: riskCounts.crossType,
            riskGeneratedCount: riskCounts.generated
          };

          store.saveRefactorPreview(previewRecord, hunkRecords);

          const resultRow: {
            fromSymbol: string;
            toSymbol: string;
            requiredOwnerType: string;
            previewId: string;
            totalMatches: number;
            unresolvedOccurrences: number;
            previewSummary: ReturnType<typeof groupPreviewHunks>;
            applyId?: string;
            rollbackId?: string;
          } = {
            fromSymbol: migration.fromSymbol,
            toSymbol: migration.toSymbol,
            requiredOwnerType: migration.requiredOwnerType,
            previewId,
            totalMatches: hunkRecords.length,
            unresolvedOccurrences: hunkRecords.filter((x) => x.riskFlags.includes("ambiguous_target")).length,
            previewSummary: groupPreviewHunks(hunkRecords)
          };

          for (const hunk of hunkRecords) {
            suggestedFollowUpFiles.add(hunk.filePath);
          }

          if (!args.dryRun) {
            // NOTE: refactor_symbol_migration with dryRun:false applies changes without a separate
            // approval-token gate. This is intentional for trusted automated migration pipelines
            // (e.g. symbol renames driven by a schema diff). Do NOT expose this path to untrusted
            // callers. If interactive approval is needed, use refactor_replace_preview +
            // refactor_replace_apply instead.
            const applyId = `apply_${randomUUID()}`;
            const rollbackId = `rollback_${randomUUID()}`;
            const applyOutcome = executeRefactorApplyPlan(repo.repoPath, applyId, hunkRecords, 50, true, false);
            const appliedFiles = applyOutcome.changes.filter((x) => x.status === "applied");
            const conflicted = applyOutcome.changes.filter((x) => x.status === "conflict");
            const totalReplacements = appliedFiles.reduce((sum, item) => sum + item.replacementCount, 0);
            const applyStatus = deriveApplyStatus(applyOutcome.changes);

            store.recordRefactorApply(
              {
                applyId,
                rollbackId,
                previewId,
                repoId: args.repoId,
                status: applyStatus,
                createdAt: new Date().toISOString(),
                completedAt: new Date().toISOString(),
                totalFiles: appliedFiles.length,
                totalReplacements,
                conflictCount: conflicted.length
              },
              applyOutcome.changes,
              applyOutcome.appliedHunks
            );
            store.markRefactorPreviewStatus(previewId, mapPreviewStatusFromApplyStatus(applyStatus));
            resultRow.applyId = applyId;
            resultRow.rollbackId = rollbackId;
          }

          migrationResults.push(resultRow);
        }

        return asText({
          repoId: args.repoId,
          dryRun: args.dryRun,
          migrationMap: migrationResults,
          exactSymbolOccurrencesChanged: migrationResults.reduce((sum, x) => sum + x.totalMatches, 0),
          unresolvedOccurrences: migrationResults.reduce((sum, x) => sum + x.unresolvedOccurrences, 0),
          suggestedFollowUpFiles: [...suggestedFollowUpFiles].sort((a, b) => a.localeCompare(b)),
          executionPolicy: noLlmAudit()
        });
      }
      case "trace_execution_flow": {
        const args = traceExecutionFlowSchema.parse(request.params.arguments ?? {});
        const profile = resolveResponseProfile(args.profile);
        const result = store.traceExecutionFlow(args.repoId, args.entrySymbolId, args.maxDepth, args.maxNodes);
        if (!result.entrySymbol) {
          throw new McpError(ErrorCode.InvalidParams, `trace_execution_flow: entry symbol '${args.entrySymbolId}' not found in repo '${args.repoId}'.`);
        }
        if (profile === "nano") {
          return asText({
            entrySymbol: { name: result.entrySymbol.name, filePath: result.entrySymbol.filePath },
            nodeCount: result.nodes.length,
            edgeCount: result.edges.length,
            depthReached: result.depthReached,
            truncated: result.truncated,
            topCallees: result.edges.slice(0, 10).map((e) => e.toName)
          }, profile);
        }
        if (profile === "compact") {
          return asText({
            entrySymbol: { symbolId: result.entrySymbol.symbolId, name: result.entrySymbol.name, kind: result.entrySymbol.kind, filePath: result.entrySymbol.filePath },
            nodeCount: result.nodes.length,
            edgeCount: result.edges.length,
            depthReached: result.depthReached,
            truncated: result.truncated,
            nodes: result.nodes.map((n) => ({ symbolId: n.symbolId, name: n.name, kind: n.kind, filePath: n.filePath })),
            edges: result.edges.map((e) => ({ fromId: e.fromId, toId: e.toId, fromName: e.fromName, toName: e.toName, confidence: e.confidence }))
          }, profile);
        }
        return asText({
          entrySymbol: result.entrySymbol,
          nodeCount: result.nodes.length,
          edgeCount: result.edges.length,
          depthReached: result.depthReached,
          truncated: result.truncated,
          nodes: result.nodes,
          edges: result.edges
        }, profile);
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
      });
      return {
        content: [{ type: "text", text }],
        isError: true
      } satisfies CallToolResult;
    }
  });
});

function parseRepoResourceUri(uri: string): { repoId: string; resource: "context" | "schema" | "routes" | "risk"; limit?: number } | null {
  const match = uri.match(/^repo:\/\/([^/]+)\/(context|schema|routes|risk)(?:\?(.*))?$/i);
  if (!match) {
    return null;
  }

  const repoId = decodeURIComponent(match[1]);
  const resource = match[2].toLowerCase() as "context" | "schema" | "routes" | "risk";
  const query = match[3] ?? "";
  const params = new URLSearchParams(query);
  const rawLimit = params.get("limit");

  return {
    repoId,
    resource,
    limit: rawLimit ? clamp(Number(rawLimit), 1, MAX_RESULT_LIMIT) : undefined
  };
}

function buildRiskSnapshot(repoId: string, policy: "quick-triage" | "strict-review" | "release-gate" | "custom", maxResults: number): {
  repoId: string;
  policy: string;
  changedFileCount: number;
  highRiskCount: number;
  mediumRiskCount: number;
  lowRiskCount: number;
  topRiskChanges: { filePath: string; riskScore: number; riskLevel: "high" | "medium" | "low" }[];
} {
  const repo = store.getRepository(repoId);
  if (!repo) {
    return {
      repoId,
      policy,
      changedFileCount: 0,
      highRiskCount: 0,
      mediumRiskCount: 0,
      lowRiskCount: 0,
      topRiskChanges: []
    };
  }

  const defaults = resolveDetectChangesPolicy(policy);
  const changedFiles = runGitLines(repo.repoPath, ["diff", "--name-only", "HEAD"]).map((x) => x.replace(/\\/g, "/")).slice(0, 100);
  const impacts = changedFiles.map((filePath) => {
    const impact = store.getImpactFiles(repoId, filePath, 20);
    const risk = scoreChangeRisk(impact.impactedFiles.length, impact.reliabilitySummary, 20);
    return { filePath, riskScore: risk.riskScore, riskLevel: risk.riskLevel };
  });

  const allowedLevels = new Set(defaults.riskLevels);
  const filtered = impacts
    .filter((x) => x.riskScore >= defaults.minRiskScore && allowedLevels.has(x.riskLevel))
    .sort((a, b) => b.riskScore - a.riskScore || a.filePath.localeCompare(b.filePath))
    .slice(0, Math.max(1, maxResults));

  return {
    repoId,
    policy,
    changedFileCount: changedFiles.length,
    highRiskCount: filtered.filter((x) => x.riskLevel === "high").length,
    mediumRiskCount: filtered.filter((x) => x.riskLevel === "medium").length,
    lowRiskCount: filtered.filter((x) => x.riskLevel === "low").length,
    topRiskChanges: filtered
  };
}

function handleHealthCheck(repoId?: string): CallToolResult {
  const latestRun = repoId ? store.getLatestRun(repoId) : null;
  const staleness = repoId ? getRepoStaleness(repoId) : null;
  const repo = repoId ? store.getRepository(repoId) : null;
  const watchStatuses = repoId ? watchManager.getStatus(repoId) : [];
  const watchRunning = watchStatuses.length > 0;
  const workingTree = repo ? getRepoWorkingTreeState(repo.repoPath) : null;

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
      activeWatchRepoId,
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
    actionHints
  });
}

function resolveServerVersion(): string {
  const npmVersion = (process.env.npm_package_version ?? "").trim();
  if (npmVersion.length > 0) {
    return npmVersion;
  }

  try {
    const packageJsonPath = path.resolve(MODULE_DIR, "..", "package.json");
    const text = fs.readFileSync(packageJsonPath, "utf8");
    const parsed = JSON.parse(text) as { version?: unknown };
    if (typeof parsed.version === "string" && parsed.version.trim().length > 0) {
      return parsed.version.trim();
    }
  } catch {
    // Keep a deterministic fallback for environments where package.json is unavailable.
  }

  return "unknown";
}

function getRepoWorkingTreeState(repoPath: string): {
  isDirty: boolean | null;
  hasTrackedChanges: boolean | null;
  hasUntrackedChanges: boolean | null;
  changedEntries: number;
  note: string;
} {
  const lines = runGitStatusPorcelain(repoPath);
  if (!lines) {
    return {
      isDirty: null,
      hasTrackedChanges: null,
      hasUntrackedChanges: null,
      changedEntries: 0,
      note: "non-git repo or unable to read working tree status"
    };
  }

  let hasTrackedChanges = false;
  let hasUntrackedChanges = false;
  for (const line of lines) {
    if (line.startsWith("??")) {
      hasUntrackedChanges = true;
      continue;
    }
    if (!line.startsWith("!!")) {
      hasTrackedChanges = true;
    }
  }

  const isDirty = hasTrackedChanges || hasUntrackedChanges;
  return {
    isDirty,
    hasTrackedChanges,
    hasUntrackedChanges,
    changedEntries: lines.length,
    note: isDirty ? "working tree has pending changes" : "working tree is clean"
  };
}

function runGitStatusPorcelain(repoPath: string): string[] | null {
  try {
    const text = runGit(repoPath, ["status", "--porcelain"]);
    if (!text) {
      return [];
    }
    return text.split(/\r?\n/).map((x) => x.trim()).filter((x) => x.length > 0);
  } catch {
    return null;
  }
}

function resolveHeadCommitSha(repoPath: string): string | null {
  try {
    return runGit(repoPath, ["rev-parse", "HEAD"]).trim();
  } catch {
    return null;
  }
}

function runGit(repoPath: string, args: string[]): string {
  return execFileSync("git", args, { cwd: repoPath, encoding: "utf8" }).trim();
}

function runGitLines(repoPath: string, args: string[]): string[] {
  try {
    const text = runGit(repoPath, args);
    if (!text) {
      return [];
    }
    return text.split(/\r?\n/).map((x) => x.trim()).filter((x) => x.length > 0);
  } catch {
    return [];
  }
}

function parseGitBlamePorcelain(text: string): {
  commit: string;
  author: string | null;
  authorMail: string | null;
  authorTime: number | null;
  summary: string | null;
} {
  const lines = text.split(/\r?\n/);
  const first = lines[0]?.trim() ?? "";
  const commit = first.split(" ")[0] ?? "";

  let author: string | null = null;
  let authorMail: string | null = null;
  let authorTime: number | null = null;
  let summary: string | null = null;

  for (const line of lines) {
    if (line.startsWith("author ")) {
      author = line.slice("author ".length).trim() || null;
      continue;
    }
    if (line.startsWith("author-mail ")) {
      authorMail = line.slice("author-mail ".length).trim().replace(/^<|>$/g, "") || null;
      continue;
    }
    if (line.startsWith("author-time ")) {
      const value = Number(line.slice("author-time ".length).trim());
      authorTime = Number.isFinite(value) ? value : null;
      continue;
    }
    if (line.startsWith("summary ")) {
      summary = line.slice("summary ".length).trim() || null;
    }
  }

  return {
    commit,
    author,
    authorMail,
    authorTime,
    summary
  };
}

function redactEmail(email: string | null): string | null {
  if (!email) {
    return null;
  }
  const [localPart, domain] = email.split("@");
  if (!domain || !localPart) {
    return "***";
  }
  const safeLocal = localPart.length <= 2 ? "**" : `${localPart.slice(0, 1)}***${localPart.slice(-1)}`;
  return `${safeLocal}@${domain}`;
}

function scoreChangeRisk(
  impactedFilesCount: number,
  reliabilitySummary: {
    edgeCount: number;
    medianConfidence: number;
    lowConfidenceEdgeCount: number;
    unresolvedRatio: number;
  },
  impactLimit: number
): {
  riskScore: number;
  riskLevel: "high" | "medium" | "low";
  signals: {
    impactBreadth: number;
    unresolvedPenalty: number;
    confidencePenalty: number;
    lowConfidencePenalty: number;
  };
} {
  const clampRisk = (value: number) => Math.max(0, Math.min(1, value));

  const impactBreadth = clampRisk(impactedFilesCount / Math.max(1, impactLimit));
  const unresolvedPenalty = clampRisk(reliabilitySummary.unresolvedRatio);
  const confidencePenalty = clampRisk(1 - reliabilitySummary.medianConfidence);
  const lowConfidencePenalty = reliabilitySummary.edgeCount > 0
    ? clampRisk(reliabilitySummary.lowConfidenceEdgeCount / reliabilitySummary.edgeCount)
    : 0;

  const score01 =
    impactBreadth * 0.5 +
    unresolvedPenalty * 0.25 +
    confidencePenalty * 0.2 +
    lowConfidencePenalty * 0.05;

  const riskScore = Math.round(score01 * 100);
  const riskLevel = riskScore >= 67 ? "high" : riskScore >= 34 ? "medium" : "low";

  return {
    riskScore,
    riskLevel,
    signals: {
      impactBreadth,
      unresolvedPenalty,
      confidencePenalty,
      lowConfidencePenalty
    }
  };
}

function resolveDetectChangesPolicy(policy: "quick-triage" | "strict-review" | "release-gate" | "custom"): {
  minRiskScore: number;
  riskLevels: ("high" | "medium" | "low")[];
  maxResults: number;
  sortBy: "risk" | "impact" | "path";
} {
  if (policy === "quick-triage") {
    return {
      minRiskScore: 20,
      riskLevels: ["high", "medium"],
      maxResults: 20,
      sortBy: "risk"
    };
  }

  if (policy === "strict-review") {
    return {
      minRiskScore: 40,
      riskLevels: ["high", "medium"],
      maxResults: 50,
      sortBy: "impact"
    };
  }

  if (policy === "release-gate") {
    return {
      minRiskScore: 67,
      riskLevels: ["high"],
      maxResults: 100,
      sortBy: "risk"
    };
  }

  return {
    minRiskScore: 0,
    riskLevels: ["high", "medium", "low"],
    maxResults: 100,
    sortBy: "risk"
  };
}

function getRepoStaleness(repoId: string): {
  repoId: string;
  indexedCommitSha: string | null;
  headCommitSha: string | null;
  isStale: boolean | null;
  note: string;
} {
  const repo = store.getRepository(repoId);
  const latestRun = store.getLatestRun(repoId);

  if (!repo) {
    return {
      repoId,
      indexedCommitSha: latestRun?.commitSha ?? null,
      headCommitSha: null,
      isStale: null,
      note: "repository not found"
    };
  }

  if (!latestRun) {
    return {
      repoId,
      indexedCommitSha: null,
      headCommitSha: resolveHeadCommitSha(repo.repoPath),
      isStale: null,
      note: "no indexed run yet"
    };
  }

  const headCommitSha = resolveHeadCommitSha(repo.repoPath);
  if (!headCommitSha) {
    return {
      repoId,
      indexedCommitSha: latestRun.commitSha,
      headCommitSha,
      isStale: null,
      note: "non-git repo or unable to resolve HEAD"
    };
  }

  if (!latestRun.commitSha) {
    return {
      repoId,
      indexedCommitSha: latestRun.commitSha,
      headCommitSha,
      isStale: null,
      note: "indexed commit unavailable"
    };
  }

  const isStale = latestRun.commitSha !== headCommitSha;
  return {
    repoId,
    indexedCommitSha: latestRun.commitSha,
    headCommitSha,
    isStale,
    note: isStale ? "index commit differs from repo HEAD" : "index is up-to-date"
  };
}

function resolveDocsMode(mode: "auto" | "on" | "off"): boolean {
  if (mode === "on") {
    return true;
  }
  if (mode === "off") {
    return false;
  }
  return DOCS_INDEXING_ENABLED;
}

function assertDocsLaneEnabled(toolName: string): void {
  if (!DOCS_TOOLS_ENABLED) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `${toolName}: docs lane is disabled. Set CODEBASE_INDEX_DOCS_TOOLS_ENABLED=true to enable docs tools.`
    );
  }
}

function resolveResponseProfile(profile: ResponseProfile, compact?: boolean): ResponseProfile {
  return compact ? "compact" : profile;
}

class PolicyViolationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

type RefactorScopeInput = z.infer<typeof refactorScopeSchema>;
type RefactorGuardsInput = z.infer<typeof refactorGuardsSchema>;
type RefactorModeInput = z.infer<typeof refactorReplacePreviewSchema>["mode"];
type RefactorSymbolMigrationInput = z.infer<typeof refactorSymbolMigrationSchema>["migrations"][number];

type PreviewCandidateHunk = {
  filePath: string;
  line: number;
  startOffset: number;
  endOffset: number;
  beforeText: string;
  afterText: string;
  ownerType: string | null;
  symbolKind: string | null;
  confidence: number;
  riskFlags: RefactorRiskFlag[];
  fileHashBefore: string;
};

type ObjectInitializerContext = {
  typeName: string;
  openBraceOffset: number;
  endOffset: number;
};

type InitializerAssignmentContext = {
  initializer: ObjectInitializerContext;
  assignmentStart: number;
  assignmentEnd: number;
  assignmentText: string;
  indent: string;
  expressionText: string;
  trailingComma: boolean;
  hasSiblingAssignments: boolean;
  line: number;
  lineEnding: string;
};

function normalizeRelativePath(filePath: string): string {
  return filePath.replace(/\\/g, "/").replace(/^\.\//, "");
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function safeReadText(absolutePath: string): string {
  return fs.existsSync(absolutePath) ? fs.readFileSync(absolutePath, "utf8") : "";
}

function assertSafeRepoFilePath(repoPath: string, relativePath: string): string {
  const fullPath = path.resolve(repoPath, relativePath);
  const normalizedRepo = path.resolve(repoPath);
  if (!fullPath.startsWith(normalizedRepo + path.sep) && fullPath !== normalizedRepo) {
    throw new PolicyViolationError("PATH_TRAVERSAL_BLOCKED", `Blocked path outside repo root: ${relativePath}`);
  }
  return fullPath;
}

function collectGitChangedFiles(repoPath: string): Set<string> {
  const files = runGitLines(repoPath, ["diff", "--name-only", "HEAD"])
    .map((x) => x.replace(/\\/g, "/"));
  return new Set(files);
}

function isApplyRunnableHunk(hunk: RefactorPreviewHunkRecord, includeLowConfidence: boolean): boolean {
  if (hunk.riskFlags.length > 0) {
    return false;
  }
  if (!includeLowConfidence && hunk.confidence < REFACTOR_LOW_CONFIDENCE_THRESHOLD) {
    return false;
  }
  return true;
}

function collectExpectedApplyFiles(hunks: RefactorPreviewHunkRecord[], includeLowConfidence: boolean): Set<string> {
  return new Set(hunks.filter((h) => isApplyRunnableHunk(h, includeLowConfidence)).map((h) => h.filePath));
}

function inferLanguageFromPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".ts" || ext === ".tsx") return "typescript";
  if (ext === ".js" || ext === ".jsx" || ext === ".mjs" || ext === ".cjs") return "javascript";
  if (ext === ".cs") return "csharp";
  if (ext === ".py") return "python";
  if (ext === ".java") return "java";
  return ext.replace(/^\./, "") || "unknown";
}

function isGeneratedFilePath(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return lower.includes("/generated/") || lower.endsWith(".g.ts") || lower.endsWith(".g.cs") || lower.endsWith(".generated.ts") || lower.endsWith(".generated.cs");
}

function offsetToLine(content: string, offset: number): number {
  return content.slice(0, Math.max(0, offset)).split(/\r?\n/).length;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeTypeToken(typeName: string): string {
  const withoutNamespace = typeName.split(".").pop() ?? typeName;
  return withoutNamespace.replace(/<.*>/g, "").trim();
}

function findMatchingBraceEnd(content: string, openBraceOffset: number): number {
  let depth = 0;
  for (let i = openBraceOffset; i < content.length; i += 1) {
    const ch = content[i];
    if (ch === "{") {
      depth += 1;
      continue;
    }
    if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        return i;
      }
    }
  }
  return -1;
}

function findEnclosingObjectInitializer(content: string, offset: number): ObjectInitializerContext | null {
  const prefix = content.slice(0, Math.max(0, offset));
  const matches = [...prefix.matchAll(/new\s+([A-Za-z_][A-Za-z0-9_.<>?,]*)\s*\{/g)];

  for (let i = matches.length - 1; i >= 0; i -= 1) {
    const match = matches[i];
    const openBraceOffset = (match.index ?? 0) + match[0].lastIndexOf("{");
    const endOffset = findMatchingBraceEnd(content, openBraceOffset);
    if (endOffset < 0) {
      continue;
    }
    if (offset >= openBraceOffset && offset <= endOffset) {
      return {
        typeName: normalizeTypeToken(match[1] ?? ""),
        openBraceOffset,
        endOffset
      };
    }
  }

  return null;
}

function findEnclosingClassName(content: string, offset: number): string | null {
  const prefix = content.slice(0, Math.max(0, offset));
  const classMatches = [...prefix.matchAll(/\bclass\s+([A-Za-z_][A-Za-z0-9_]*)/g)];
  if (classMatches.length > 0) {
    return classMatches[classMatches.length - 1][1] ?? null;
  }
  return null;
}

// Heuristic: scans all `class Foo` occurrences before `offset` and returns the last match.
// This is a best-effort regex approximation — it does not parse AST scope boundaries, so it
// can misidentify owner type when the pattern appears inside string literals, comments, or
// across nested class / function boundaries. For mode:"text" this has no effect (no owner
// check is performed). For mode:"symbol-aware" / "syntax-aware" it may produce a false
// ambiguous_target or cross_type flag. Acceptable as a lightweight heuristic; replace with
// a tree-sitter scope query if higher precision is required.
function findOwnerType(content: string, offset: number): string | null {
  const initializer = findEnclosingObjectInitializer(content, offset);
  if (initializer) {
    return initializer.typeName;
  }
  return findEnclosingClassName(content, offset);
}

function inferSymbolKind(lineText: string): "class" | "property" | "field" | "method" | null {
  const text = lineText.trim();
  if (/\bclass\b/.test(text)) return "class";
  if (/\b(get|set)\b/.test(text) || /\b[A-Za-z_][A-Za-z0-9_]*\s*\(/.test(text)) return "method";
  if (/\b[A-Za-z_][A-Za-z0-9_]*\s*[:=]/.test(text)) return "property";
  if (/\b(private|public|protected)\s+[A-Za-z_][A-Za-z0-9_]*\s*[:=]/.test(text)) return "field";
  return null;
}

function pathStartsWithAny(filePath: string, prefixes: string[]): boolean {
  if (prefixes.length === 0) {
    return true;
  }
  const normalized = normalizeRelativePath(filePath).toLowerCase();
  return prefixes.some((prefix) => normalized.startsWith(normalizeRelativePath(prefix).toLowerCase()));
}

function findInitializerMemberAssignment(
  content: string,
  offset: number,
  symbolName: string
): InitializerAssignmentContext | null {
  const initializer = findEnclosingObjectInitializer(content, offset);
  if (!initializer) {
    return null;
  }

  const lineStart = content.lastIndexOf("\n", Math.max(0, offset - 1)) + 1;
  const rawLineEnd = content.indexOf("\n", offset);
  const lineEnd = rawLineEnd >= 0 ? rawLineEnd : content.length;
  const lineText = content.slice(lineStart, lineEnd);
  const lineEnding = rawLineEnd >= 0 ? (content[lineEnd - 1] === "\r" ? "\r\n" : "\n") : "";
  const assignmentEnd = rawLineEnd >= 0 ? lineEnd + lineEnding.length : lineEnd;

  const headPattern = new RegExp(`^(\\s*)${escapeRegExp(symbolName)}\\s*=\\s*`);
  const match = lineText.match(headPattern);
  if (!match) {
    return null;
  }

  const indent = match[1] ?? "";
  const rhs = lineText.slice(match[0].length);
  if (rhs.length === 0) {
    return null;
  }

  let depthParen = 0;
  let depthBracket = 0;
  let depthBrace = 0;
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let escaped = false;
  let splitIndex = -1;

  for (let i = 0; i < rhs.length; i += 1) {
    const ch = rhs[i];
    if (escaped) {
      escaped = false;
      continue;
    }

    if (ch === "\\") {
      escaped = true;
      continue;
    }

    if (!inDoubleQuote && ch === "'") {
      inSingleQuote = !inSingleQuote;
      continue;
    }
    if (!inSingleQuote && ch === '"') {
      inDoubleQuote = !inDoubleQuote;
      continue;
    }
    if (inSingleQuote || inDoubleQuote) {
      continue;
    }

    if (ch === "(") depthParen += 1;
    else if (ch === ")") depthParen = Math.max(0, depthParen - 1);
    else if (ch === "[") depthBracket += 1;
    else if (ch === "]") depthBracket = Math.max(0, depthBracket - 1);
    else if (ch === "{") depthBrace += 1;
    else if (ch === "}") depthBrace = Math.max(0, depthBrace - 1);
    else if (ch === "," && depthParen === 0 && depthBracket === 0 && depthBrace === 0) {
      splitIndex = i;
      break;
    }
  }

  const expressionText = (splitIndex >= 0 ? rhs.slice(0, splitIndex) : rhs).trim();
  if (expressionText.length === 0) {
    return null;
  }

  const remainder = splitIndex >= 0 ? rhs.slice(splitIndex + 1).trim() : "";
  const hasSiblingAssignments = splitIndex >= 0 && /[A-Za-z_][A-Za-z0-9_]*\s*=/.test(remainder);

  return {
    initializer,
    assignmentStart: lineStart,
    assignmentEnd,
    assignmentText: content.slice(lineStart, assignmentEnd),
    indent,
    expressionText,
    trailingComma: splitIndex >= 0,
    hasSiblingAssignments,
    line: offsetToLine(content, lineStart),
    lineEnding
  };
}

function isDottedMemberPath(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+$/.test(value.trim());
}

function isSimpleIdentifier(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value.trim());
}

function isInvalidCsharpInitializerReplacement(replacementText: string): boolean {
  const trimmed = replacementText.trim();
  return /^[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*\s*=/.test(trimmed);
}

function resolveInitializerRewriteTargetMember(migration: RefactorSymbolMigrationInput): string {
  const targetMember = migration.initializerRewrite?.targetMember
    ?? migration.toSymbol.split(".").filter((x) => x.length > 0).at(-1)
    ?? migration.fromSymbol;

  const objectProperty = migration.initializerRewrite?.objectProperty;
  const objectType = migration.initializerRewrite?.objectType;

  if (objectProperty && !isSimpleIdentifier(objectProperty)) {
    throw new PolicyViolationError(
      "INVALID_INITIALIZER_REWRITE",
      `initializerRewrite.objectProperty must be a simple identifier (received '${objectProperty}').`
    );
  }

  if (!isSimpleIdentifier(targetMember)) {
    throw new PolicyViolationError(
      "INVALID_INITIALIZER_REWRITE",
      `initializerRewrite.targetMember must be a simple identifier (received '${targetMember}').`
    );
  }

  if (objectType && /[=;{}]/.test(objectType)) {
    throw new PolicyViolationError(
      "INVALID_INITIALIZER_REWRITE",
      `initializerRewrite.objectType contains invalid characters (received '${objectType}').`
    );
  }

  return targetMember;
}

function buildRefactorPreview(
  repoPath: string,
  repoId: string,
  findText: string,
  replaceText: string,
  scope: RefactorScopeInput,
  guards: RefactorGuardsInput,
  mode: RefactorModeInput
): {
  hunks: PreviewCandidateHunk[];
  affectedFiles: string[];
} {
  const indexedFiles = store.listIndexedFiles(repoId).map((x) => normalizeRelativePath(x.path));
  const includePaths = (scope.includePaths ?? []).map((x) => normalizeRelativePath(x));
  const excludePaths = (scope.excludePaths ?? []).map((x) => normalizeRelativePath(x));
  const globPaths = (scope.fileGlobs ?? []).map((x) => normalizeRelativePath(x));

  let allowedByGlob: Set<string> | null = null;
  if (globPaths.length > 0) {
    allowedByGlob = new Set<string>();
    for (const pattern of globPaths) {
      const matches = globSync(pattern, { cwd: repoPath, nodir: true, dot: false, windowsPathsNoEscape: true });
      for (const match of matches) {
        allowedByGlob.add(normalizeRelativePath(match));
      }
    }
  }

  const selectedFiles = indexedFiles
    .filter((filePath) => pathStartsWithAny(filePath, includePaths))
    .filter((filePath) => !excludePaths.some((prefix) => normalizeRelativePath(filePath).toLowerCase().startsWith(prefix.toLowerCase())))
    .filter((filePath) => (allowedByGlob ? allowedByGlob.has(normalizeRelativePath(filePath)) : true))
    .sort((a, b) => a.localeCompare(b));

  const hunks: PreviewCandidateHunk[] = [];
  const affected = new Set<string>();

  for (const filePath of selectedFiles) {
    const language = inferLanguageFromPath(filePath);
    if (guards.language && language !== guards.language) {
      continue;
    }

    const safeAbsolute = assertSafeRepoFilePath(repoPath, filePath);
    if (!fs.existsSync(safeAbsolute)) {
      continue;
    }

    const content = fs.readFileSync(safeAbsolute, "utf8");
    const fileHashBefore = sha256(content);
    let cursor = 0;

    while (true) {
      const start = content.indexOf(findText, cursor);
      if (start < 0) {
        break;
      }
      const end = start + findText.length;
      const line = offsetToLine(content, start);
      const lineText = content.split(/\r?\n/)[line - 1] ?? "";
      const ownerType = findOwnerType(content, start);
      const symbolKind = inferSymbolKind(lineText);

      if (guards.symbolKinds.length > 0) {
        if (!symbolKind || !guards.symbolKinds.includes(symbolKind)) {
          cursor = end;
          continue;
        }
      }

      if (guards.allowOwnerTypes.length > 0) {
        if (!ownerType || !guards.allowOwnerTypes.some((x) => x.toLowerCase() === ownerType.toLowerCase())) {
          cursor = end;
          continue;
        }
      }

      const riskFlags: RefactorRiskFlag[] = [];
      if ((mode === "symbol-aware" || mode === "syntax-aware") && !ownerType) {
        riskFlags.push("ambiguous_target");
      }
      const disallowNames = new Set([...guards.disallowOwnerTypes, ...guards.disallowTypeList].map((x) => x.toLowerCase()));
      if (ownerType && disallowNames.has(ownerType.toLowerCase())) {
        riskFlags.push("cross_type");
      }
      if (isGeneratedFilePath(filePath)) {
        riskFlags.push("generated_file");
      }

      let confidence = mode === "text" ? 0.85 : 0.95;
      if (!ownerType) confidence -= 0.25;
      if (riskFlags.includes("cross_type")) confidence -= 0.4;
      if (riskFlags.includes("generated_file")) confidence -= 0.2;
      confidence = Math.max(0, Math.min(1, Number(confidence.toFixed(2))));

      hunks.push({
        filePath,
        line,
        startOffset: start,
        endOffset: end,
        beforeText: content.slice(start, end),
        afterText: replaceText,
        ownerType,
        symbolKind,
        confidence,
        riskFlags,
        fileHashBefore
      });
      affected.add(filePath);
      cursor = end;
    }
  }

  hunks.sort((a, b) => a.filePath.localeCompare(b.filePath) || a.startOffset - b.startOffset);
  return {
    hunks,
    affectedFiles: [...affected].sort((a, b) => a.localeCompare(b))
  };
}

function buildSymbolMigrationPreview(
  repoPath: string,
  repoId: string,
  migration: RefactorSymbolMigrationInput,
  scopePaths: string[]
): {
  hunks: PreviewCandidateHunk[];
  affectedFiles: string[];
} {
  const preview = buildRefactorPreview(
    repoPath,
    repoId,
    migration.fromSymbol,
    migration.toSymbol,
    {
      includePaths: scopePaths,
      excludePaths: [],
      fileGlobs: []
    },
    {
      language: undefined,
      symbolKinds: ["property", "field"],
      allowOwnerTypes: [migration.requiredOwnerType],
      disallowOwnerTypes: migration.forbiddenOwnerTypes,
      disallowTypeList: migration.forbiddenOwnerTypes
    },
    "symbol-aware"
  );

  const fileCache = new Map<string, string>();

  if (!migration.initializerRewrite && isDottedMemberPath(migration.toSymbol)) {
    const guardedHunks = preview.hunks.map((hunk) => {
      if (inferLanguageFromPath(hunk.filePath) !== "csharp") {
        return hunk;
      }

      let content = fileCache.get(hunk.filePath);
      if (!content) {
        content = safeReadText(assertSafeRepoFilePath(repoPath, hunk.filePath));
        fileCache.set(hunk.filePath, content);
      }

      const assignment = findInitializerMemberAssignment(content, hunk.startOffset, migration.fromSymbol);
      if (!assignment || assignment.initializer.typeName.toLowerCase() !== migration.requiredOwnerType.toLowerCase()) {
        return hunk;
      }

      const blockedRiskFlags: RefactorRiskFlag[] = [...new Set([...hunk.riskFlags, "ambiguous_target"] as RefactorRiskFlag[])];
      return {
        ...hunk,
        line: assignment.line,
        startOffset: assignment.assignmentStart,
        endOffset: assignment.assignmentEnd,
        beforeText: assignment.assignmentText,
        afterText: assignment.assignmentText,
        confidence: Math.min(hunk.confidence, 0.5),
        riskFlags: blockedRiskFlags
      };
    });

    return {
      hunks: guardedHunks.sort((a, b) => a.filePath.localeCompare(b.filePath) || a.startOffset - b.startOffset || a.beforeText.localeCompare(b.beforeText)),
      affectedFiles: [...new Set(guardedHunks.map((x) => x.filePath))].sort((a, b) => a.localeCompare(b))
    };
  }

  if (!migration.initializerRewrite) {
    return preview;
  }

  const retainedHunks: PreviewCandidateHunk[] = [];
  const rewrittenHunks: PreviewCandidateHunk[] = [];
  const groupedAssignments = new Map<string, Array<{ hunk: PreviewCandidateHunk; assignment: InitializerAssignmentContext }>>();
  const targetMember = resolveInitializerRewriteTargetMember(migration);

  for (const hunk of preview.hunks) {
    if (inferLanguageFromPath(hunk.filePath) !== "csharp") {
      retainedHunks.push(hunk);
      continue;
    }

    let content = fileCache.get(hunk.filePath);
    if (!content) {
      content = safeReadText(assertSafeRepoFilePath(repoPath, hunk.filePath));
      fileCache.set(hunk.filePath, content);
    }

    const assignment = findInitializerMemberAssignment(content, hunk.startOffset, migration.fromSymbol);
    if (!assignment || assignment.initializer.typeName.toLowerCase() !== migration.requiredOwnerType.toLowerCase()) {
      retainedHunks.push(hunk);
      continue;
    }

    if (assignment.hasSiblingAssignments) {
      const blockedRiskFlags: RefactorRiskFlag[] = [...new Set([...hunk.riskFlags, "ambiguous_target"] as RefactorRiskFlag[])];
      rewrittenHunks.push({
        ...hunk,
        line: assignment.line,
        startOffset: assignment.assignmentStart,
        endOffset: assignment.assignmentEnd,
        beforeText: assignment.assignmentText,
        afterText: assignment.assignmentText,
        confidence: Math.min(hunk.confidence, 0.5),
        riskFlags: blockedRiskFlags
      });
      continue;
    }

    const groupKey = [
      hunk.filePath,
      String(assignment.initializer.openBraceOffset),
      migration.initializerRewrite.objectProperty,
      migration.initializerRewrite.objectType
    ].join(":");
    const list = groupedAssignments.get(groupKey) ?? [];
    list.push({ hunk, assignment });
    groupedAssignments.set(groupKey, list);
  }

  for (const entries of groupedAssignments.values()) {
    const ordered = [...entries].sort((a, b) => a.assignment.assignmentStart - b.assignment.assignmentStart);
    const first = ordered[0];
    let content = fileCache.get(first.hunk.filePath);
    if (!content) {
      content = safeReadText(assertSafeRepoFilePath(repoPath, first.hunk.filePath));
      fileCache.set(first.hunk.filePath, content);
    }

    const initializerBody = content.slice(first.assignment.initializer.openBraceOffset + 1, first.assignment.initializer.endOffset);
    const existingOwnedPropertyPattern = new RegExp(`\\b${escapeRegExp(migration.initializerRewrite.objectProperty)}\\s*=`);
    const combinedRiskFlags = [...new Set(ordered.flatMap((x) => x.hunk.riskFlags))];
    const baseConfidence = Math.min(...ordered.map((x) => x.hunk.confidence));

    if (existingOwnedPropertyPattern.test(initializerBody)) {
      const blockedRiskFlags: RefactorRiskFlag[] = [...new Set([...combinedRiskFlags, "ambiguous_target"] as RefactorRiskFlag[])];
      rewrittenHunks.push({
        ...first.hunk,
        line: first.assignment.line,
        startOffset: first.assignment.assignmentStart,
        endOffset: first.assignment.assignmentEnd,
        beforeText: first.assignment.assignmentText,
        afterText: first.assignment.assignmentText,
        confidence: Math.min(baseConfidence, 0.5),
        riskFlags: blockedRiskFlags
      });
      continue;
    }

    const memberAssignments = ordered.map(({ assignment }) => `${targetMember} = ${assignment.expressionText}`);
    const replacementText = `${first.assignment.indent}${migration.initializerRewrite.objectProperty} = new ${migration.initializerRewrite.objectType} { ${memberAssignments.join(", ")} }${first.assignment.trailingComma ? "," : ""}${first.assignment.lineEnding}`;

    rewrittenHunks.push({
      ...first.hunk,
      line: first.assignment.line,
      startOffset: first.assignment.assignmentStart,
      endOffset: first.assignment.assignmentEnd,
      beforeText: first.assignment.assignmentText,
      afterText: replacementText,
      confidence: Math.max(baseConfidence, 0.97),
      ownerType: migration.requiredOwnerType,
      symbolKind: "property",
      riskFlags: combinedRiskFlags
    });

    for (const entry of ordered.slice(1)) {
      rewrittenHunks.push({
        ...entry.hunk,
        line: entry.assignment.line,
        startOffset: entry.assignment.assignmentStart,
        endOffset: entry.assignment.assignmentEnd,
        beforeText: entry.assignment.assignmentText,
        afterText: "",
        confidence: Math.max(baseConfidence, 0.97),
        ownerType: migration.requiredOwnerType,
        symbolKind: "property",
        riskFlags: combinedRiskFlags
      });
    }
  }

  const hunks = [...retainedHunks, ...rewrittenHunks]
    .sort((a, b) => a.filePath.localeCompare(b.filePath) || a.startOffset - b.startOffset || a.beforeText.localeCompare(b.beforeText));

  return {
    hunks,
    affectedFiles: [...new Set(hunks.map((x) => x.filePath))].sort((a, b) => a.localeCompare(b))
  };
}

function countPreviewRisks(hunks: Array<{ riskFlags: RefactorRiskFlag[] }>): { ambiguous: number; crossType: number; generated: number } {
  let ambiguous = 0;
  let crossType = 0;
  let generated = 0;
  for (const hunk of hunks) {
    if (hunk.riskFlags.includes("ambiguous_target")) ambiguous += 1;
    if (hunk.riskFlags.includes("cross_type")) crossType += 1;
    if (hunk.riskFlags.includes("generated_file")) generated += 1;
  }
  return { ambiguous, crossType, generated };
}

function createPreviewDigest(repoId: string, findText: string, replaceText: string, hunks: PreviewCandidateHunk[]): string {
  const stable = JSON.stringify({
    repoId,
    findText,
    replaceText,
    hunks: hunks.map((h) => ({
      filePath: h.filePath,
      startOffset: h.startOffset,
      endOffset: h.endOffset,
      beforeText: h.beforeText,
      afterText: h.afterText,
      ownerType: h.ownerType,
      symbolKind: h.symbolKind,
      confidence: h.confidence,
      riskFlags: [...h.riskFlags].sort((a, b) => a.localeCompare(b)),
      fileHashBefore: h.fileHashBefore
    }))
  });
  return sha256(stable);
}

function issueApprovalToken(previewId: string, digest: string, expiresAt: string): string {
  const payload = Buffer.from(JSON.stringify({ previewId, digest, expiresAt })).toString("base64url");
  const secret = resolveApprovalSecret();
  const signature = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function verifyApprovalToken(token: string, previewId: string, digest: string, expiresAt: string): void {
  // Use lastIndexOf to split on the final '.' only — guards against any future format that
  // embeds dots inside the base64url payload section.
  const dotIdx = token.lastIndexOf(".");
  const payload = dotIdx > 0 ? token.slice(0, dotIdx) : "";
  const signature = dotIdx > 0 ? token.slice(dotIdx + 1) : "";
  if (!payload || !signature) {
    throw new PolicyViolationError("INVALID_APPROVAL_TOKEN", "Approval token format is invalid.");
  }
  const secret = resolveApprovalSecret();
  const expected = createHmac("sha256", secret).update(payload).digest("base64url");
  if (expected !== signature) {
    throw new PolicyViolationError("INVALID_APPROVAL_TOKEN", "Approval token signature is invalid.");
  }

  let decoded: { previewId: string; digest: string; expiresAt: string };
  try {
    decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { previewId: string; digest: string; expiresAt: string };
  } catch {
    throw new PolicyViolationError("INVALID_APPROVAL_TOKEN", "Approval token payload is invalid.");
  }

  if (decoded.previewId !== previewId || decoded.digest !== digest || decoded.expiresAt !== expiresAt) {
    throw new PolicyViolationError("APPROVAL_TOKEN_MISMATCH", "Approval token does not match the approved preview plan.");
  }

  if (Date.parse(decoded.expiresAt) < Date.now()) {
    throw new PolicyViolationError("APPROVAL_TOKEN_EXPIRED", "Approval token has expired.");
  }
}

function groupPreviewHunks(hunks: RefactorPreviewHunkRecord[]): Array<{
  filePath: string;
  hunkCount: number;
  hunks: Array<{
    hunkId: string;
    line: number;
    beforeText: string;
    afterText: string;
    confidence: number;
    riskFlags: RefactorRiskFlag[];
    ownerType: string | null;
    symbolKind: string | null;
  }>;
}> {
  const byFile = new Map<string, RefactorPreviewHunkRecord[]>();
  for (const hunk of hunks) {
    const list = byFile.get(hunk.filePath) ?? [];
    list.push(hunk);
    byFile.set(hunk.filePath, list);
  }

  return [...byFile.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([filePath, items]) => ({
      filePath,
      hunkCount: items.length,
      hunks: items.map((item) => ({
        hunkId: item.hunkId,
        line: item.line,
        beforeText: item.beforeText,
        afterText: item.afterText,
        confidence: item.confidence,
        riskFlags: item.riskFlags,
        ownerType: item.ownerType,
        symbolKind: item.symbolKind
      }))
    }));
}

function executeRefactorApplyPlan(
  repoPath: string,
  applyId: string,
  hunks: RefactorPreviewHunkRecord[],
  maxFilesPerBatch: number,
  stopOnFirstConflict: boolean,
  includeLowConfidence: boolean
): {
  changes: RefactorApplyChangeRecord[];
  appliedHunks: RefactorApplyHunkRecord[];
  lane: { highConfidenceEdits: number; lowConfidenceEdits: number; lowConfidenceSkipped: number };
} {
  const groupedByFile = new Map<string, RefactorPreviewHunkRecord[]>();
  for (const hunk of hunks) {
    const list = groupedByFile.get(hunk.filePath) ?? [];
    list.push(hunk);
    groupedByFile.set(hunk.filePath, list);
  }

  const changes: RefactorApplyChangeRecord[] = [];
  const appliedHunks: RefactorApplyHunkRecord[] = [];
  const fileEntries = [...groupedByFile.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  let stop = false;
  let highConfidenceEdits = 0;
  let lowConfidenceEdits = 0;
  let lowConfidenceSkipped = 0;

  for (let i = 0; i < fileEntries.length; i += Math.max(1, maxFilesPerBatch)) {
    if (stop) {
      break;
    }
    const chunk = fileEntries.slice(i, i + Math.max(1, maxFilesPerBatch));
    for (const [filePath, allHunks] of chunk) {
      if (stop) {
        break;
      }

      const absolute = assertSafeRepoFilePath(repoPath, filePath);
      const beforeContent = safeReadText(absolute);
      const beforeHash = sha256(beforeContent);

      const blockedHunks = allHunks.filter((h) => h.riskFlags.length > 0);
      const lowConfidenceHunks = allHunks.filter((h) => h.riskFlags.length === 0 && h.confidence < REFACTOR_LOW_CONFIDENCE_THRESHOLD);
      lowConfidenceSkipped += includeLowConfidence ? 0 : lowConfidenceHunks.length;
      const runnableHunks = allHunks.filter((h) => isApplyRunnableHunk(h, includeLowConfidence));

      if (runnableHunks.length === 0) {
        changes.push({
          applyId,
          filePath,
          replacementCount: 0,
          status: "skipped",
          reason: blockedHunks.length > 0
            ? "RISK_FLAG_BLOCKED"
            : lowConfidenceHunks.length > 0 && !includeLowConfidence
              ? "LOW_CONFIDENCE_BLOCKED"
              : "NO_EFFECTIVE_CHANGES",
          fileHashBefore: beforeHash,
          fileHashAfter: beforeHash,
          beforeContent,
          afterContent: beforeContent
        });
        continue;
      }

      if (beforeHash !== runnableHunks[0].fileHashBefore) {
        changes.push({
          applyId,
          filePath,
          replacementCount: 0,
          status: "conflict",
          reason: "FILE_CHANGED_AFTER_PREVIEW",
          fileHashBefore: beforeHash,
          fileHashAfter: null,
          beforeContent,
          afterContent: null
        });
        if (stopOnFirstConflict) {
          stop = true;
        }
        continue;
      }

      const sortedHunks = [...runnableHunks].sort((a, b) => b.startOffset - a.startOffset || b.hunkId.localeCompare(a.hunkId));
      const finalOffsetByHunkId = buildFinalOffsetMap(sortedHunks);
      let updated = beforeContent;
      let appliedCount = 0;
      let fileHighConfidenceEdits = 0;
      let fileLowConfidenceEdits = 0;
      let conflictReason: string | null = null;

      for (const hunk of sortedHunks) {
        const target = updated.slice(hunk.startOffset, hunk.endOffset);
        if (target !== hunk.beforeText) {
          conflictReason = "OFFSET_MISMATCH_DURING_APPLY";
          break;
        }
        if (inferLanguageFromPath(filePath) === "csharp" && isInvalidCsharpInitializerReplacement(hunk.replacementText)) {
          const enclosingInitializer = findEnclosingObjectInitializer(updated, hunk.startOffset);
          if (enclosingInitializer && /\s*=/.test(hunk.beforeText)) {
            conflictReason = "INVALID_CSHARP_INITIALIZER_REWRITE";
            break;
          }
        }
        updated = `${updated.slice(0, hunk.startOffset)}${hunk.replacementText}${updated.slice(hunk.endOffset)}`;
        appliedCount += 1;
        if (hunk.confidence < REFACTOR_LOW_CONFIDENCE_THRESHOLD) {
          fileLowConfidenceEdits += 1;
        } else {
          fileHighConfidenceEdits += 1;
        }
      }

      if (conflictReason) {
        changes.push({
          applyId,
          filePath,
          replacementCount: 0,
          status: "conflict",
          reason: conflictReason,
          fileHashBefore: beforeHash,
          fileHashAfter: null,
          beforeContent,
          afterContent: null
        });
        if (stopOnFirstConflict) {
          stop = true;
        }
        continue;
      }

      if (appliedCount > 0) {
        fs.writeFileSync(absolute, updated, "utf8");
        for (const hunk of sortedHunks) {
          const startOffsetApplied = finalOffsetByHunkId.get(hunk.hunkId);
          if (startOffsetApplied === undefined) {
            continue;
          }
          appliedHunks.push({
            applyId,
            filePath,
            hunkId: hunk.hunkId,
            startOffsetApplied,
            endOffsetApplied: startOffsetApplied + hunk.replacementText.length,
            beforeText: hunk.beforeText,
            afterText: hunk.replacementText
          });
        }
        highConfidenceEdits += fileHighConfidenceEdits;
        lowConfidenceEdits += fileLowConfidenceEdits;
        changes.push({
          applyId,
          filePath,
          replacementCount: appliedCount,
          status: "applied",
          reason: null,
          fileHashBefore: beforeHash,
          fileHashAfter: sha256(updated),
          beforeContent,
          afterContent: updated
        });
      } else {
        changes.push({
          applyId,
          filePath,
          replacementCount: 0,
          status: "skipped",
          reason: "NO_EFFECTIVE_CHANGES",
          fileHashBefore: beforeHash,
          fileHashAfter: beforeHash,
          beforeContent,
          afterContent: beforeContent
        });
      }
    }
  }

  return {
    changes,
    appliedHunks,
    lane: {
      highConfidenceEdits,
      lowConfidenceEdits,
      lowConfidenceSkipped
    }
  };
}

function buildFinalOffsetMap(hunks: RefactorPreviewHunkRecord[]): Map<string, number> {
  const sortedAsc = [...hunks].sort((a, b) => a.startOffset - b.startOffset || a.hunkId.localeCompare(b.hunkId));
  const offsetMap = new Map<string, number>();
  let cumulativeDelta = 0;

  for (const hunk of sortedAsc) {
    const adjustedStart = hunk.startOffset + cumulativeDelta;
    offsetMap.set(hunk.hunkId, adjustedStart);
    cumulativeDelta += hunk.replacementText.length - hunk.beforeText.length;
  }

  return offsetMap;
}

function formatChangeContextPayload(
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
  const text = profile === "compact" || profile === "nano"
    ? JSON.stringify(payload)
    : JSON.stringify(payload, null, 2);

  const ctx = toolContextStorage.getStore();
  if (ctx) {
    emitTelemetry({
      ts: new Date().toISOString(),
      toolName: ctx.toolName,
      elapsedMs: Date.now() - ctx.startedAt,
      responseBytes: Buffer.byteLength(text, "utf8"),
      resultCount: estimateResultCount(payload),
      profile,
      requestedProfile: typeof ctx.args.profile === "string" ? ctx.args.profile : null,
      compactRequested: ctx.args.compact === true,
      isError: false
    });
  }

  return {
    content: [{ type: "text", text }]
  };
}

function mapError(error: unknown, toolName: string): { code: string; message: string; requestId: string } {
  const requestId = randomUUID();

  if (error instanceof z.ZodError) {
    return {
      code: "VALIDATION_ERROR",
      message: `${toolName}: ${error.issues.map((x) => `${x.path.join(".") || "input"}: ${x.message}`).join("; ")}`,
      requestId
    };
  }

  if (error instanceof PolicyViolationError) {
    return {
      code: error.code,
      message: `${toolName}: ${error.message}`,
      requestId
    };
  }

  if (error instanceof McpError) {
    return {
      code: "MCP_ERROR",
      message: `${toolName}: ${error.message}`,
      requestId
    };
  }

  return {
    code: "INTERNAL_ERROR",
    message: `${toolName}: ${error instanceof Error ? error.message : "Unknown error"}`,
    requestId
  };
}

function assertNoLlmRuntimePolicy(): void {
  if (LLM_ENABLED) {
    throw new Error("Startup blocked: CODEBASE_INDEX_LLM_ENABLED must be false. LLM runtime invocation is prohibited by policy.");
  }
}

function assertRefactorApprovalPolicy(): void {
  if (REFACTOR_STRICT_APPROVAL && REFACTOR_APPROVAL_SECRET.trim().length === 0) {
    throw new Error("Startup blocked: CODEBASE_INDEX_REFACTOR_APPROVAL_SECRET is required when CODEBASE_INDEX_REFACTOR_STRICT_APPROVAL=true.");
  }
}

function resolveApprovalSecret(): string {
  if (REFACTOR_APPROVAL_SECRET.trim().length > 0) {
    return REFACTOR_APPROVAL_SECRET;
  }
  if (REFACTOR_STRICT_APPROVAL) {
    throw new PolicyViolationError(
      "APPROVAL_SECRET_REQUIRED",
      "Approval secret is required in strict approval mode. Set CODEBASE_INDEX_REFACTOR_APPROVAL_SECRET."
    );
  }
  return "dev-insecure-secret";
}

function mapPreviewStatusFromApplyStatus(status: RefactorApplyRecord["status"]): RefactorPreviewRecord["status"] {
  if (status === "applied") {
    return "applied";
  }
  if (status === "partial") {
    return "apply_partial";
  }
  return "apply_failed";
}

function deriveApplyStatus(changes: RefactorApplyChangeRecord[]): RefactorApplyRecord["status"] {
  const hasApplied = changes.some((x) => x.status === "applied");
  if (!hasApplied) {
    return "failed";
  }
  const hasNonApplied = changes.some((x) => x.status !== "applied");
  if (hasNonApplied) {
    return "partial";
  }
  return "applied";
}

function noLlmAudit(): { decisionSource: "rule_engine"; llmInvolved: false; approvalMode: "strict" | "local-fallback" } {
  return {
    decisionSource: "rule_engine",
    llmInvolved: false,
    approvalMode: REFACTOR_STRICT_APPROVAL ? "strict" : "local-fallback"
  };
}

function numberFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }

  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    return fallback;
  }

  return Math.floor(value);
}

function ratioFromEnv(raw: string | undefined, fallback: number): number {
  if (!raw) {
    return fallback;
  }

  const value = Number(raw);
  if (!Number.isFinite(value)) {
    return fallback;
  }

  return Math.max(0, Math.min(1, value));
}

function asArgsRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function estimateResultCount(payload: unknown): number | null {
  if (Array.isArray(payload)) {
    return payload.length;
  }

  if (!payload || typeof payload !== "object") {
    return null;
  }

  const obj = payload as Record<string, unknown>;
  if (typeof obj.count === "number") {
    return obj.count;
  }

  const arrayKeys = [
    "symbols",
    "candidates",
    "files",
    "edges",
    "callers",
    "callees",
    "imports",
    "importsBy",
    "importedByFiles",
    "matchedSymbols"
  ];

  for (const key of arrayKeys) {
    const value = obj[key];
    if (Array.isArray(value)) {
      return value.length;
    }
  }

  return null;
}

function emitTelemetry(event: ToolTelemetryEvent): void {
  if (!TELEMETRY_ENABLED) {
    return;
  }

  if (Math.random() > TELEMETRY_SAMPLE_RATE) {
    return;
  }

  process.stderr.write(`[tool-telemetry] ${JSON.stringify(event)}\n`);
}

function traverseDependencyGraph(repoId: string, symbolId: string, depth: number, limit: number) {
  const all: ReturnType<GraphStore["getDependencies"]> = [];
  const visited = new Set<string>();
  let frontier = [symbolId];

  for (let level = 0; level < depth && all.length < limit && frontier.length > 0; level += 1) {
    const nextFrontier: string[] = [];
    for (const current of frontier) {
      if (all.length >= limit) {
        break;
      }

      const edges = store.getDependencies(repoId, current, limit - all.length);
      for (const edge of edges) {
        const key = `${edge.fromId}:${edge.toId}:${edge.type}`;
        if (visited.has(key)) {
          continue;
        }
        visited.add(key);
        all.push(edge);
        nextFrontier.push(edge.toId);
      }
    }
    frontier = nextFrontier;
  }

  return all;
}

function traverseCallGraph(
  repoId: string,
  symbolId: string,
  direction: CallChainDirection,
  depth: number,
  limit: number
) {
  const all: ReturnType<GraphStore["getCallEdges"]> = [];
  const visited = new Set<string>();
  let frontier = [symbolId];

  for (let level = 0; level < depth && all.length < limit && frontier.length > 0; level += 1) {
    const nextFrontier: string[] = [];
    for (const current of frontier) {
      if (all.length >= limit) {
        break;
      }

      const edges = store.getCallEdges(repoId, current, direction, limit - all.length);
      for (const edge of edges) {
        const key = `${edge.fromId}:${edge.toId}:${edge.type}`;
        if (visited.has(key)) {
          continue;
        }
        visited.add(key);
        all.push(edge);
        nextFrontier.push(direction === "callees" ? edge.toId : edge.fromId);
      }
    }
    frontier = nextFrontier;
  }

  return all;
}

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
  const effectiveResolveImplementsInPost = mode !== "full" && postPolicy.resolveImplementsInPost;
  process.stderr.write(
    `[index-policy] repoId=${repoId} profile=${performanceProfile} source=${profileDecision.source} reason=${profileDecision.reason} fileCount=${String(profileDecision.fileCount)} symbolCount=${String(profileDecision.symbolCount)} maxUnresolvedRows=${String(postPolicy.maxUnresolvedRows)} resolveTypeRefs=${String(postPolicy.resolveTypeRefs)} resolveImplementsInPost=${String(postPolicy.resolveImplementsInPost)} effectiveResolveImplementsInPost=${String(effectiveResolveImplementsInPost)}\n`
  );

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
    parseWorkers: PARSE_WORKERS,
    parseJobTimeoutMs: PARSE_JOB_TIMEOUT_MS
  });

  process.stderr.write(`[index-post] repoId=${repoId} rebuilding FTS indexes...\n`);
  try { store.rebuildFts(); } catch { /* non-fatal */ }
  await yieldToEventLoop();
  if (docsEnabled) {
    process.stderr.write(`[index-post] repoId=${repoId} rebuilding docs FTS...\n`);
    try { store.rebuildDocsFts(); } catch { /* non-fatal */ }
    await yieldToEventLoop();
  }

  process.stderr.write(`[index-post] repoId=${repoId} resolving cross-repo links...\n`);
  const crossStats = safeCrossRepoResolve(repoId);
  await yieldToEventLoop();

  process.stderr.write(`[index-post] repoId=${repoId} resolving call edges...\n`);
  const callEdgesResolved = (() => { try { return store.resolveCallEdges(repoId, postPolicy.maxUnresolvedRows); } catch { return 0; } })();
  await yieldToEventLoop();

  process.stderr.write(`[index-post] repoId=${repoId} resolving import edges...\n`);
  const importEdgesResolved = (() => { try { return store.resolveImportEdges(repoId, postPolicy.maxUnresolvedRows); } catch { return 0; } })();
  await yieldToEventLoop();

  if (postPolicy.resolveTypeRefs) {
    process.stderr.write(`[index-post] repoId=${repoId} resolving type references...\n`);
    (() => { try { store.resolveTypeRefEdges(repoId, postPolicy.maxUnresolvedRows); } catch { /* non-fatal */ } })();
  } else {
    process.stderr.write(`[index-post-skip] repoId=${repoId} skipping type reference resolution by policy\n`);
  }
  await yieldToEventLoop();

  if (postPolicy.resolveTypeRefs) {
    process.stderr.write(`[index-post] repoId=${repoId} resolving property references...\n`);
    (() => { try { store.resolvePropertyEdges(repoId, postPolicy.maxUnresolvedRows); } catch { /* non-fatal */ } })();
  } else {
    process.stderr.write(`[index-post-skip] repoId=${repoId} skipping property reference resolution by policy\n`);
  }
  await yieldToEventLoop();

  const shouldResolveImplementsInPost = effectiveResolveImplementsInPost;
  if (shouldResolveImplementsInPost) {
    process.stderr.write(`[index-post] repoId=${repoId} resolving interface implementations...\n`);
    try { store.resolveImplementsEdges(repoId); } catch { /* non-fatal */ }
  } else {
    process.stderr.write(`[index-post-skip] repoId=${repoId} skipping interface implementation resolution in post-phase\n`);
  }
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
    unresolvedLowConfidence: crossStats.unresolvedByReason.low_confidence
  };
  store.recordRun(fullSummary);
  const recordElapsed = Date.now() - recordStart;
  process.stderr.write(`[index-post] repoId=${repoId} recorded run metadata in ${recordElapsed}ms\n`);
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

function hasWorkingTreeChanges(repoPath: string): boolean | null {
  try {
    const lines = runGitLines(repoPath, ["status", "--porcelain", "--untracked-files=all"]);
    return lines.length > 0;
  } catch {
    return null;
  }
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

function parsePerformanceProfileEnv(raw: string | undefined): PerformanceProfile | "auto" {
  const value = (raw ?? "auto").trim().toLowerCase();
  if (value === "standard" || value === "off") {
    return "standard";
  }
  if (value === "large" || value === "balanced") {
    return "large";
  }
  if (value === "very-large" || value === "aggressive") {
    return "very-large";
  }
  return "auto";
}

function resolvePostPhasePolicy(profile: PerformanceProfile): {
  maxUnresolvedRows: number;
  resolveTypeRefs: boolean;
  resolveImplementsInPost: boolean;
} {
  const configuredMaxRows = nonNegativeNumberFromEnv("CODEBASE_INDEX_MAX_UNRESOLVED_RESOLVE_ROWS");
  const configuredResolveTypeRefs = parseOptionalBooleanEnv(process.env.CODEBASE_INDEX_POST_RESOLVE_TYPE_REFS);

  if (profile === "very-large") {
    return {
      maxUnresolvedRows: configuredMaxRows ?? 50_000,
      resolveTypeRefs: configuredResolveTypeRefs ?? false,
      resolveImplementsInPost: false
    };
  }

  if (profile === "large") {
    return {
      maxUnresolvedRows: configuredMaxRows ?? 120_000,
      resolveTypeRefs: configuredResolveTypeRefs ?? true,
      resolveImplementsInPost: true
    };
  }

  return {
    maxUnresolvedRows: configuredMaxRows ?? 0,
    resolveTypeRefs: configuredResolveTypeRefs ?? true,
    resolveImplementsInPost: true
  };
}

function nonNegativeNumberFromEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) {
    return undefined;
  }

  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    return undefined;
  }

  return Math.floor(value);
}

function parseOptionalBooleanEnv(raw: string | undefined): boolean | undefined {
  if (raw === undefined) {
    return undefined;
  }
  return parseBooleanEnv(raw, false);
}

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

  if (WATCH_ACTIVE_ONLY && activeWatchRepoId && activeWatchRepoId !== repoId) {
    clearWatchInactivityTimer(activeWatchRepoId);
    await watchManager.stop(activeWatchRepoId);
  }

  const currentStatus = watchManager.getStatus(repoId);
  let result: { started: boolean; message: string };
  if (currentStatus.length === 0) {
    result = watchManager.start(repoId, repoPath);
  } else {
    result = { started: false, message: `watch already active for repoId '${repoId}'` };
  }

  activeWatchRepoId = repoId;
  armWatchInactivityTimer(repoId);
  if (result.started) {
    process.stderr.write(`[watch-activate] repoId=${repoId} reason=${reason}\n`);
  }
  return result;
}

function armWatchInactivityTimer(repoId: string): void {
  clearWatchInactivityTimer(repoId);
  const timer = setTimeout(() => {
    const current = activeWatchRepoId;
    if (WATCH_ACTIVE_ONLY && current === repoId) {
      activeWatchRepoId = null;
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
