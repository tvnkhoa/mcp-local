import process from "node:process";
import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { execFileSync } from "node:child_process";
import os from "node:os";

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
import type { CallChainDirection, IndexRunSummary, ResolutionStats } from "./types.js";

const dbPath = process.env.CODEBASE_INDEX_DB_PATH ?? "./codebase-index.db";
const allowedRoots = parseAllowedRoots(process.env.CODEBASE_INDEX_ALLOWED_ROOTS);

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
        description: "Check server availability and latest indexing run metadata.",
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

        const allowlistCheck = validateAllowedTables(readOnlyCheck.sanitizedSql, new Set(["repositories", "files", "symbols", "edges", "index_runs", "routes", "cross_repo_deps"]));
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
  const staleness = repoId ? getRepoStaleness(repoId) : null;
  return asText({
    status: "ok",
    serverVersion: process.env.npm_package_version ?? "unknown",
    dbPath,
    allowedRootCount: allowedRoots.length,
    docsLane: {
      docsIndexingEnabled: DOCS_INDEXING_ENABLED,
      docsToolsEnabled: DOCS_TOOLS_ENABLED
    },
    latestRun: repoId ? store.getLatestRun(repoId) : null,
    staleness
  });
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
