import process from "node:process";
import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ErrorCode,
  type CallToolResult
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { GraphStore } from "./graphStore.js";
import { runIndexPipeline } from "./indexPipeline.js";
import {
  assertPathAllowed,
  clamp,
  parseAllowedRoots,
  parseAutoWatchRepos,
  parseBooleanEnv,
  parseWatchConfigFromEnv
} from "./indexGuardrails.js";
import { WatchManager } from "./watchManager.js";
import type { CallChainDirection, IndexRunSummary, ResolutionStats } from "./types.js";

const dbPath = process.env.CODEBASE_INDEX_DB_PATH ?? "./codebase-index.db";
const allowedRoots = parseAllowedRoots(process.env.CODEBASE_INDEX_ALLOWED_ROOTS);

const MAX_FILES_PER_RUN = numberFromEnv("CODEBASE_INDEX_MAX_FILES_PER_RUN", 20_000);
const MAX_RESULT_LIMIT = numberFromEnv("CODEBASE_INDEX_MAX_RESULT_LIMIT", 500);
const MAX_DEPTH = numberFromEnv("CODEBASE_INDEX_MAX_DEPTH", 5);
const WATCH_AUTO_START = parseBooleanEnv(process.env.CODEBASE_INDEX_WATCH_AUTO_START, true);
const WATCH_DISABLED = parseBooleanEnv(process.env.CODEBASE_INDEX_WATCH_DISABLE, false);
const AUTO_WATCH_REPOS = parseAutoWatchRepos(process.env.CODEBASE_INDEX_AUTO_WATCH_REPOS);
const watchConfig = parseWatchConfigFromEnv(process.env);
const TELEMETRY_ENABLED = parseBooleanEnv(process.env.CODEBASE_INDEX_TELEMETRY_ENABLED, false);
const TELEMETRY_SAMPLE_RATE = ratioFromEnv(process.env.CODEBASE_INDEX_TELEMETRY_SAMPLE_RATE, 1);
const DOCS_INDEXING_ENABLED = parseBooleanEnv(process.env.CODEBASE_INDEX_DOCS_INDEXING_ENABLED, false);
const DOCS_TOOLS_ENABLED = parseBooleanEnv(process.env.CODEBASE_INDEX_DOCS_TOOLS_ENABLED, false);
type ResponseProfile = "compact" | "standard" | "verbose";
const responseProfileSchema = z.enum(["compact", "standard", "verbose"]);

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
    maxFiles: z.number().int().min(1).max(MAX_FILES_PER_RUN).default(5_000),
    batchSize: z.number().int().min(1).max(2_000).default(200)
  })
  .strict();

const getDependencyGraphSchema = z
  .object({
    repoId: z.string().min(1).max(200),
    symbolId: z.string().min(1).max(200),
    depth: z.number().int().min(1).max(MAX_DEPTH).default(1),
    limit: z.number().int().min(1).max(MAX_RESULT_LIMIT).default(100)
  })
  .strict();

const getCallChainSchema = z
  .object({
    repoId: z.string().min(1).max(200),
    symbolId: z.string().min(1).max(200),
    direction: z.enum(["callers", "callees"]).default("callees"),
    depth: z.number().int().min(1).max(MAX_DEPTH).default(1),
    limit: z.number().int().min(1).max(MAX_RESULT_LIMIT).default(100)
  })
  .strict();

const getModuleFlowSchema = z
  .object({
    repoId: z.string().min(1).max(200),
    filePath: z.string().min(1),
    limit: z.number().int().min(1).max(MAX_RESULT_LIMIT).default(100)
  })
  .strict();

const findImpactSurfaceSchema = z
  .object({
    repoId: z.string().min(1).max(200),
    filePath: z.string().min(1),
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
    limit: z.number().int().min(1).max(MAX_RESULT_LIMIT).default(50),
    compact: z.boolean().default(false),
    profile: responseProfileSchema.default("standard")
  })
  .strict();

const getFileContextSchema = z
  .object({
    repoId: z.string().min(1).max(200),
    filePath: z.string().min(1),
    limit: z.number().int().min(1).max(MAX_RESULT_LIMIT).default(200),
    compact: z.boolean().default(false),
    profile: responseProfileSchema.default("standard")
  })
  .strict();

const getBatchContextSchema = z
  .object({
    repoId: z.string().min(1).max(200),
    filePaths: z.array(z.string().min(1)).min(1).max(50),
    limit: z.number().int().min(1).max(MAX_RESULT_LIMIT).default(500),
    compact: z.boolean().default(false),
    profile: responseProfileSchema.default("standard")
  })
  .strict();

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
    limit: z.number().int().min(1).max(MAX_RESULT_LIMIT).default(50)
  })
  .strict();

const getChangeContextSchema = z
  .object({
    repoId: z.string().min(1).max(200),
    symbolId: z.string().min(1).max(200),
    callerDepth: z.number().int().min(1).max(MAX_DEPTH).default(2),
    calleeDepth: z.number().int().min(1).max(MAX_DEPTH).default(1),
    limit: z.number().int().min(1).max(MAX_RESULT_LIMIT).default(20),
    profile: responseProfileSchema.default("standard")
  })
  .strict();

const getFileSummarySchema = z
  .object({
    repoId: z.string().min(1).max(200),
    filePath: z.string().min(1)
  })
  .strict();

const searchDocsSchema = z
  .object({
    repoId: z.string().min(1).max(200),
    query: z.string().min(1).max(200),
    limit: z.number().int().min(1).max(MAX_RESULT_LIMIT).default(20)
  })
  .strict();

const findStaleDocsSchema = z
  .object({
    repoId: z.string().min(1).max(200),
    symbolIds: z.array(z.string().min(1).max(200)).min(1).max(100)
  })
  .strict();

const findDocCoverageSchema = z
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

const findReferencesSchema = z
  .object({
    repoId: z.string().min(1).max(200),
    symbolName: z.string().min(1).max(200),
    limit: z.number().int().min(1).max(MAX_RESULT_LIMIT).default(50)
  })
  .strict();

// New schemas (Phase 1-7 enhancements)
const getContextByNameSchema = z
  .object({
    repoId: z.string().min(1).max(200),
    name: z.string().min(1).max(200),
    limit: z.number().int().min(1).max(MAX_RESULT_LIMIT).default(20),
    profile: responseProfileSchema.default("standard")
  })
  .strict();

const getChangeContextByNameSchema = z
  .object({
    repoId: z.string().min(1).max(200),
    name: z.string().min(1).max(200),
    callerDepth: z.number().int().min(1).max(MAX_DEPTH).default(2),
    calleeDepth: z.number().int().min(1).max(MAX_DEPTH).default(1),
    limit: z.number().int().min(1).max(MAX_RESULT_LIMIT).default(20),
    profile: responseProfileSchema.default("standard")
  })
  .strict();

const getSymbolCandidatesSchema = z
  .object({
    repoId: z.string().min(1).max(200),
    name: z.string().min(1).max(200),
    limit: z.number().int().min(1).max(MAX_RESULT_LIMIT).default(20),
    profile: responseProfileSchema.default("standard")
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

const server = new Server(
  {
    name: "codebase-index-mcp",
    version: "0.1.0"
  },
  {
    capabilities: {
      tools: {}
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
  (repoId, deletedRelativePaths) => store.pruneFiles(repoId, deletedRelativePaths)
);

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
        description: "Get the IMPORTS/DEPENDS_ON dependency tree for a symbol. Use when you have a symbolId and need to see what it imports or depends on. Call search_symbols or get_context_by_name first to get the symbolId.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["repoId", "symbolId"],
          properties: {
            repoId: { type: "string" },
            symbolId: { type: "string" },
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
        name: "get_module_flow",
        description: "Get outgoing module-level flow edges for a file.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["repoId", "filePath"],
          properties: {
            repoId: { type: "string" },
            filePath: { type: "string" },
            limit: { type: "integer", minimum: 1, maximum: MAX_RESULT_LIMIT }
          }
        }
      },
      {
        name: "find_impact_surface",
        description: "List external symbols that call into a file, grouped by caller symbol. Use to see which external code depends on this file's exports. Complements find_impact_files which groups results by file instead of by symbol.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["repoId", "filePath"],
          properties: {
            repoId: { type: "string" },
            filePath: { type: "string" },
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
        description: "Fuzzy search symbols by name across all repos or a specific repo. Use profile=compact for token-saving output, standard for balanced output, verbose for debug-rich output. compact=true is still supported for backward compatibility.",
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
            limit: { type: "integer", minimum: 1, maximum: MAX_RESULT_LIMIT },
            compact: { type: "boolean" },
            profile: { type: "string", enum: ["compact", "standard", "verbose"] }
          }
        }
      },
      {
        name: "get_file_context",
        description: "Get symbols and graph edges for a file. Use profile=compact for token-saving output, standard for balanced output, verbose for debug-rich output. compact=true is still supported for backward compatibility.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["repoId", "filePath"],
          properties: {
            repoId: { type: "string" },
            filePath: { type: "string" },
            limit: { type: "integer", minimum: 1, maximum: MAX_RESULT_LIMIT },
            compact: { type: "boolean" },
            profile: { type: "string", enum: ["compact", "standard", "verbose"] }
          }
        }
      },
      {
        name: "get_batch_context",
        description: "Get aggregate symbols and edges for a list of file paths. Use profile=compact for token-saving output, standard for balanced output, verbose for debug-rich output. compact=true is still supported for backward compatibility.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["repoId", "filePaths"],
          properties: {
            repoId: { type: "string" },
            filePaths: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 50 },
            limit: { type: "integer", minimum: 1, maximum: MAX_RESULT_LIMIT },
            compact: { type: "boolean" },
            profile: { type: "string", enum: ["compact", "standard", "verbose"] }
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
        description: "Given a file path, return which other files import or call symbols defined in it. Use to understand change blast radius before refactoring.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["repoId", "filePath"],
          properties: {
            repoId: { type: "string" },
            filePath: { type: "string" },
            limit: { type: "integer", minimum: 1, maximum: MAX_RESULT_LIMIT }
          }
        }
      },
      {
        name: "get_change_context",
        description: "Get callers (BFS up to depth), callees, and type deps for a symbol. Use profile=compact to reduce payload during planning, standard for balanced output, verbose for debugging.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["repoId", "symbolId"],
          properties: {
            repoId: { type: "string" },
            symbolId: { type: "string" },
            callerDepth: { type: "integer", minimum: 1, maximum: MAX_DEPTH },
            calleeDepth: { type: "integer", minimum: 1, maximum: MAX_DEPTH },
            limit: { type: "integer", minimum: 1, maximum: MAX_RESULT_LIMIT },
            profile: { type: "string", enum: ["compact", "standard", "verbose"] }
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
        name: "search_docs",
        description: "Full-text search across indexed documentation sections (README, markdown files). Returns matching doc sections and the symbols they mention. Requires docs lane enabled.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["repoId", "query"],
          properties: {
            repoId: { type: "string" },
            query: { type: "string" },
            limit: { type: "integer", minimum: 1, maximum: MAX_RESULT_LIMIT }
          }
        }
      },
      {
        name: "find_stale_docs",
        description: "Given a list of changed symbol IDs, find documentation sections that mention those symbols and may need to be updated. Requires docs lane enabled.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["repoId", "symbolIds"],
          properties: {
            repoId: { type: "string" },
            symbolIds: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 100 }
          }
        }
      },
      {
        name: "find_doc_coverage",
        description: "Show which exported symbols in a file are mentioned in documentation and which are undocumented. Use to identify coverage gaps. Requires docs lane enabled.",
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
        name: "find_references",
        description: "Find all callers (CALLS edges) and importing files (IMPORTS edges) for a symbol by name. Does not require symbolId. Use to understand full usage of a function or class before renaming or deleting it.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["repoId", "symbolName"],
          properties: {
            repoId: { type: "string" },
            symbolName: { type: "string" },
            limit: { type: "integer", minimum: 1, maximum: MAX_RESULT_LIMIT }
          }
        }
      },
      {
        name: "get_context_by_name",
        description: "Single-call context lookup by symbol name. Use profile=compact to minimize token usage in Plan mode, standard for balanced output, verbose for debug-rich output.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["repoId", "name"],
          properties: {
            repoId: { type: "string" },
            name: { type: "string" },
            limit: { type: "integer", minimum: 1, maximum: MAX_RESULT_LIMIT },
            profile: { type: "string", enum: ["compact", "standard", "verbose"] }
          }
        }
      },
      {
        name: "get_change_context_by_name",
        description: "Get change impact context by symbol name in one call. Resolves symbolId internally, then returns callers/callees/type deps using profile=compact|standard|verbose.",
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
            profile: { type: "string", enum: ["compact", "standard", "verbose"] }
          }
        }
      },
      {
        name: "get_symbol_candidates",
        description: "Resolve ambiguous symbol names to ranked candidates with score/confidence. Use before get_context_by_name or get_change_context_by_name when a name may map to multiple symbols.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["repoId", "name"],
          properties: {
            repoId: { type: "string" },
            name: { type: "string" },
            limit: { type: "integer", minimum: 1, maximum: MAX_RESULT_LIMIT },
            profile: { type: "string", enum: ["compact", "standard", "verbose"] }
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
        description: "Find symbols with 0 incoming CALLS edges — these are publicly callable entry points not called by other code in the repo. Use to discover public API surface, HTTP endpoints, or top-level service methods. Filter by kind='method' for controllers, kind='class' for services.",
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
      switch (request.params.name) {
      case "health_check": {
        const args = healthCheckSchema.parse(request.params.arguments ?? {});
        return handleHealthCheck(args.repoId);
      }
      case "index_repository": {
        const args = indexRepositorySchema.parse(request.params.arguments ?? {});
        assertPathAllowed(args.repoPath, allowedRoots);
        const docsEnabled = resolveDocsMode(args.docsMode);
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
        const rows = traverseDependencyGraph(args.repoId, args.symbolId, args.depth, args.limit);
        return asText({ repoId: args.repoId, symbolId: args.symbolId, depth: args.depth, edges: rows });
      }
      case "get_call_chain": {
        const args = getCallChainSchema.parse(request.params.arguments ?? {});
        const direction: CallChainDirection = args.direction;
        const rows = traverseCallGraph(args.repoId, args.symbolId, direction, args.depth, args.limit);
        return asText({ repoId: args.repoId, symbolId: args.symbolId, direction, depth: args.depth, edges: rows });
      }
      case "get_module_flow": {
        const args = getModuleFlowSchema.parse(request.params.arguments ?? {});
        const result = store.getModuleFlow(args.repoId, args.filePath, args.limit);
        return asText({
          repoId: args.repoId,
          filePath: args.filePath,
          edges: result.edges,
          unresolvedCalls: result.unresolvedCalls
        });
      }
      case "find_impact_surface": {
        const args = findImpactSurfaceSchema.parse(request.params.arguments ?? {});
        const rows = store.getImpactSurface(args.repoId, args.filePath, args.limit);
        return asText({ repoId: args.repoId, filePath: args.filePath, callers: rows });
      }
      case "find_impact_files": {
        const args = findImpactFilesSchema.parse(request.params.arguments ?? {});
        const result = store.getImpactFiles(args.repoId, args.filePath, args.limit);
        return asText({ repoId: args.repoId, filePath: args.filePath, ...result });
      }
      case "get_change_context": {
        const args = getChangeContextSchema.parse(request.params.arguments ?? {});
        const profile = resolveResponseProfile(args.profile);
        const result = store.getChangeContext(args.repoId, args.symbolId, args.callerDepth, args.calleeDepth, args.limit);
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
        const results = store.searchSymbols(
          args.query,
          args.repoId ?? null,
          args.language ?? null,
          args.kind ?? null,
          args.filePath ?? null,
          args.limit
        );
        if (profile === "compact") {
          return asText({ query: args.query, count: results.length,
            symbols: results.map((s) => ({ name: s.name, kind: s.kind, filePath: s.filePath, line: s.line })) }, profile);
        }
        if (profile === "verbose") {
          return asText({
            query: args.query,
            count: results.length,
            symbols: results,
            summary: {
              repoFilter: args.repoId ?? null,
              languageFilter: args.language ?? null,
              kindFilter: args.kind ?? null,
              filePathFilter: args.filePath ?? null
            }
          }, profile);
        }
        return asText({ query: args.query, count: results.length, symbols: results }, profile);
      }
      case "get_file_context": {
        const args = getFileContextSchema.parse(request.params.arguments ?? {});
        const profile = resolveResponseProfile(args.profile, args.compact);
        const result = store.getFileContext(args.repoId, args.filePath, args.limit, profile === "compact");
        if (profile === "verbose") {
          return asText({ ...result, summary: { symbolCount: result.symbols.length, edgeCount: result.edges.length } }, profile);
        }
        return asText(result, profile);
      }
      case "get_batch_context": {
        const args = getBatchContextSchema.parse(request.params.arguments ?? {});
        const profile = resolveResponseProfile(args.profile, args.compact);
        const result = store.getBatchContext(args.repoId, args.filePaths, args.limit, profile === "compact");
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
      case "get_symbol_detail": {
        const args = getSymbolDetailSchema.parse(request.params.arguments ?? {});
        return asText(store.getSymbolDetail(args.repoId, args.symbolId, args.limit));
      }
      case "search_docs": {
        assertDocsLaneEnabled("search_docs");
        const args = searchDocsSchema.parse(request.params.arguments ?? {});
        return asText(store.searchDocs(args.repoId, args.query, args.limit));
      }
      case "find_stale_docs": {
        assertDocsLaneEnabled("find_stale_docs");
        const args = findStaleDocsSchema.parse(request.params.arguments ?? {});
        return asText(store.findStaleDocs(args.repoId, args.symbolIds));
      }
      case "find_doc_coverage": {
        assertDocsLaneEnabled("find_doc_coverage");
        const args = findDocCoverageSchema.parse(request.params.arguments ?? {});
        return asText(store.findDocCoverage(args.repoId, args.filePath));
      }
      case "watch_repo": {
        const args = watchRepoSchema.parse(request.params.arguments ?? {});
        if (args.action === "start") {
          if (WATCH_DISABLED) {
            return asText({ started: false, message: "watch mode is disabled by CODEBASE_INDEX_WATCH_DISABLE" });
          }
          if (!args.repoId) {
            throw new McpError(ErrorCode.InvalidParams, "watch_repo: repoId is required for action=start");
          }
          if (!args.repoPath) {
            throw new McpError(ErrorCode.InvalidParams, "watch_repo: repoPath is required for action=start");
          }
          assertPathAllowed(args.repoPath, allowedRoots);
          store.ensureRepository(args.repoId, args.repoPath);
          return asText(watchManager.start(args.repoId, args.repoPath));
        } else if (args.action === "stop") {
          if (!args.repoId) {
            throw new McpError(ErrorCode.InvalidParams, "watch_repo: repoId is required for action=stop");
          }
          return asText(await watchManager.stop(args.repoId));
        } else {
          return asText({
            watchDisabled: WATCH_DISABLED,
            autoStartEnabled: WATCH_AUTO_START,
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
      case "find_references": {
        const args = findReferencesSchema.parse(request.params.arguments ?? {});
        return asText(store.findReferences(args.repoId, args.symbolName, args.limit));
      }
      case "get_context_by_name": {
        const args = getContextByNameSchema.parse(request.params.arguments ?? {});
        const profile = resolveResponseProfile(args.profile);
        const result = store.getContextByName(args.repoId, args.name, args.limit);
        if (profile === "compact") {
          return asText({
            symbol: result.symbol
              ? { symbolId: result.symbol.symbolId, name: result.symbol.name, kind: result.symbol.kind, filePath: result.symbol.filePath, line: result.symbol.line }
              : null,
            callers: result.callers.map((x) => ({ callerName: x.callerName, callerFile: x.callerFile, callerLine: x.callerLine })),
            callees: result.callees.map((x) => ({ calleeName: x.calleeName, calleeFile: x.calleeFile, calleeLine: x.calleeLine })),
            importedByFiles: result.importedByFiles
          }, profile);
        }
        if (profile === "verbose") {
          return asText({
            ...result,
            summary: {
              matchCount: result.allMatchedSymbols.length,
              callerCount: result.callers.length,
              calleeCount: result.callees.length,
              importerCount: result.importedByFiles.length
            }
          }, profile);
        }
        return asText(result, profile);
      }
      case "get_change_context_by_name": {
        const args = getChangeContextByNameSchema.parse(request.params.arguments ?? {});
        const profile = resolveResponseProfile(args.profile);
        const context = store.getContextByName(args.repoId, args.name, args.limit);
        if (!context.symbol) {
          return asText({
            symbol: null,
            callers: [],
            callees: [],
            typeDeps: [],
            graphHealth: { unresolvedCalls: 0, unresolvedImports: 0, note: "symbol not found" },
            queryName: args.name
          }, profile);
        }
        const result = store.getChangeContext(
          args.repoId,
          context.symbol.symbolId,
          args.callerDepth,
          args.calleeDepth,
          args.limit
        );
        const payload = formatChangeContextPayload(result, profile) as Record<string, unknown>;
        return asText({ ...payload, queryName: args.name }, profile);
      }
      case "get_symbol_candidates": {
        const args = getSymbolCandidatesSchema.parse(request.params.arguments ?? {});
        const profile = resolveResponseProfile(args.profile);
        const candidates = store.getSymbolCandidates(args.repoId, args.name, args.limit);
        if (profile === "compact") {
          return asText({
            name: args.name,
            count: candidates.length,
            candidates: candidates.map((x) => ({
              symbolId: x.symbolId,
              name: x.name,
              kind: x.kind,
              filePath: x.filePath,
              line: x.line,
              score: x.score,
              confidence: x.confidence
            }))
          }, profile);
        }
        if (profile === "verbose") {
          const byMatchType = candidates.reduce<Record<string, number>>((acc, item) => {
            acc[item.matchType] = (acc[item.matchType] ?? 0) + 1;
            return acc;
          }, {});
          return asText({
            name: args.name,
            count: candidates.length,
            candidates,
            summary: {
              topScore: candidates[0]?.score ?? 0,
              byMatchType
            }
          }, profile);
        }
        return asText({ name: args.name, count: candidates.length, candidates }, profile);
      }
      case "get_folder_summary": {
        const args = getFolderSummarySchema.parse(request.params.arguments ?? {});
        return asText(store.getFolderSummary(args.repoId, args.folderPath, args.maxFiles));
      }
      case "find_entry_points": {
        const args = findEntryPointsSchema.parse(request.params.arguments ?? {});
        return asText(store.findEntryPoints(args.repoId, args.filePathPrefix ?? null, args.kind ?? null, args.limit));
      }
      case "find_implementations": {
        const args = findImplementationsSchema.parse(request.params.arguments ?? {});
        return asText(store.findImplementations(args.repoId, args.interfaceName, args.limit));
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

function handleHealthCheck(repoId?: string): CallToolResult {
  return asText({
    status: "ok",
    dbPath,
    allowedRootCount: allowedRoots.length,
    docsLane: {
      docsIndexingEnabled: DOCS_INDEXING_ENABLED,
      docsToolsEnabled: DOCS_TOOLS_ENABLED
    },
    latestRun: repoId ? store.getLatestRun(repoId) : null
  });
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
  if (profile === "compact") {
    return {
      symbol: result.symbol
        ? { symbolId: result.symbol.symbolId, name: result.symbol.name, kind: result.symbol.kind, filePath: result.symbol.filePath, line: result.symbol.line }
        : null,
      callers: result.callers.map((x) => ({ fromId: x.fromId, fromName: x.fromName, fromFilePath: x.fromFilePath, distance: x.distance })),
      callees: result.callees.map((x) => ({ toId: x.toId, toName: x.toName, toFilePath: x.toFilePath })),
      typeDeps: result.typeDeps.map((x) => ({ toId: x.toId, toName: x.toName, toFilePath: x.toFilePath })),
      graphHealth: result.graphHealth
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
  const text = profile === "compact"
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
): Promise<IndexRunSummary & { crossRepoLinked?: number; callEdgesResolved?: number; importEdgesResolved?: number; mentionsResolved?: number }> {
  const summary = await runIndexPipeline(store, {
    repoId,
    repoPath,
    mode,
    includeDocs: docsEnabled,
    maxFiles,
    batchSize
  });

  try { store.rebuildFts(); } catch { /* non-fatal */ }
  if (docsEnabled) {
    try { store.rebuildDocsFts(); } catch { /* non-fatal */ }
  }

  const crossStats = safeCrossRepoResolve(repoId);
  const callEdgesResolved = (() => { try { return store.resolveCallEdges(repoId); } catch { return 0; } })();
  const importEdgesResolved = (() => { try { return store.resolveImportEdges(repoId); } catch { return 0; } })();
  try { store.resolveImplementsEdges(repoId); } catch { /* non-fatal */ }
  const mentionsResolved = docsEnabled
    ? (() => { try { return store.resolveMentions(repoId); } catch { return 0; } })()
    : 0;

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

  return fullSummary;
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

function resolveAutoWatchTargets(): { repoId: string; repoPath: string }[] {
  if (AUTO_WATCH_REPOS.length > 0) {
    return AUTO_WATCH_REPOS;
  }
  return store.listRepositories().map((r) => ({ repoId: r.repoId, repoPath: r.repoPath }));
}

function startAutoWatchers(): void {
  if (WATCH_DISABLED || !WATCH_AUTO_START) {
    return;
  }

  const targets = resolveAutoWatchTargets();
  for (const target of targets) {
    try {
      assertPathAllowed(target.repoPath, allowedRoots);
      const started = watchManager.start(target.repoId, target.repoPath);
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
  startAutoWatchers();

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
