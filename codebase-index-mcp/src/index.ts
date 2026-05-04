import process from "node:process";
import { randomUUID } from "node:crypto";

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
import { assertPathAllowed, clamp, parseAllowedRoots } from "./indexGuardrails.js";
import type { CallChainDirection } from "./types.js";

const dbPath = process.env.CODEBASE_INDEX_DB_PATH ?? "./codebase-index.db";
const allowedRoots = parseAllowedRoots(process.env.CODEBASE_INDEX_ALLOWED_ROOTS);

const MAX_FILES_PER_RUN = numberFromEnv("CODEBASE_INDEX_MAX_FILES_PER_RUN", 20_000);
const MAX_RESULT_LIMIT = numberFromEnv("CODEBASE_INDEX_MAX_RESULT_LIMIT", 500);
const MAX_DEPTH = numberFromEnv("CODEBASE_INDEX_MAX_DEPTH", 5);

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
    limit: z.number().int().min(1).max(MAX_RESULT_LIMIT).default(50)
  })
  .strict();

const getFileContextSchema = z
  .object({
    repoId: z.string().min(1).max(200),
    filePath: z.string().min(1),
    limit: z.number().int().min(1).max(MAX_RESULT_LIMIT).default(200)
  })
  .strict();

const getBatchContextSchema = z
  .object({
    repoId: z.string().min(1).max(200),
    filePaths: z.array(z.string().min(1)).min(1).max(50),
    limit: z.number().int().min(1).max(MAX_RESULT_LIMIT).default(500)
  })
  .strict();

const getSymbolDetailSchema = z
  .object({
    repoId: z.string().min(1).max(200),
    symbolId: z.string().min(1).max(200),
    limit: z.number().int().min(1).max(MAX_RESULT_LIMIT).default(100)
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
        description: "Index repository files into internal graph storage (incremental by default).",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["repoId", "repoPath"],
          properties: {
            repoId: { type: "string" },
            repoPath: { type: "string" },
            mode: { type: "string", enum: ["full", "incremental"] },
            maxFiles: { type: "integer", minimum: 1, maximum: MAX_FILES_PER_RUN },
            batchSize: { type: "integer", minimum: 1, maximum: 2000 }
          }
        }
      },
      {
        name: "get_dependency_graph",
        description: "Get direct dependency edges for a symbol.",
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
        description: "Get call edges for a symbol in callers/callees direction.",
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
        description: "List symbols likely impacted by modifying a file.",
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
        description: "Fuzzy search symbols by name across all repos or a specific repo. Useful for AI context lookup.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["query"],
          properties: {
            query: { type: "string" },
            repoId: { type: "string" },
            language: { type: "string" },
            kind: { type: "string" },
            limit: { type: "integer", minimum: 1, maximum: MAX_RESULT_LIMIT }
          }
        }
      },
      {
        name: "get_file_context",
        description: "Get all symbols and edges for a file — use when AI needs context for a single file before review.",
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
        name: "get_batch_context",
        description: "Get aggregate symbols and edges for a list of file paths — use with PR diff file lists for AI impact analysis.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["repoId", "filePaths"],
          properties: {
            repoId: { type: "string" },
            filePaths: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 50 },
            limit: { type: "integer", minimum: 1, maximum: MAX_RESULT_LIMIT }
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
      }
    ]
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    switch (request.params.name) {
      case "health_check": {
        const args = healthCheckSchema.parse(request.params.arguments ?? {});
        return handleHealthCheck(args.repoId);
      }
      case "index_repository": {
        const args = indexRepositorySchema.parse(request.params.arguments ?? {});
        assertPathAllowed(args.repoPath, allowedRoots);
        const summary = await runIndexPipeline(store, {
          repoId: args.repoId,
          repoPath: args.repoPath,
          mode: args.mode,
          maxFiles: clamp(args.maxFiles, 1, MAX_FILES_PER_RUN),
          batchSize: clamp(args.batchSize, 1, 2_000)
        });

        // Post-index: rebuild FTS index and resolve cross-repo deps
        try { store.rebuildFts(); } catch { /* non-fatal */ }
        const crossRepoLinked = store.resolveUnlinkedEdges(args.repoId);

        return asText({ ...summary, crossRepoLinked });
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
        const rows = store.getModuleFlow(args.repoId, args.filePath, args.limit);
        return asText({ repoId: args.repoId, filePath: args.filePath, edges: rows });
      }
      case "find_impact_surface": {
        const args = findImpactSurfaceSchema.parse(request.params.arguments ?? {});
        const rows = store.getImpactSurface(args.repoId, args.filePath, args.limit);
        return asText({ repoId: args.repoId, filePath: args.filePath, symbols: rows });
      }
      case "list_repositories": {
        listRepositoriesSchema.parse(request.params.arguments ?? {});
        return asText(store.listRepositories());
      }
      case "search_symbols": {
        const args = searchSymbolsSchema.parse(request.params.arguments ?? {});
        const results = store.searchSymbols(
          args.query,
          args.repoId ?? null,
          args.language ?? null,
          args.kind ?? null,
          args.limit
        );
        return asText({ query: args.query, count: results.length, symbols: results });
      }
      case "get_file_context": {
        const args = getFileContextSchema.parse(request.params.arguments ?? {});
        return asText(store.getFileContext(args.repoId, args.filePath, args.limit));
      }
      case "get_batch_context": {
        const args = getBatchContextSchema.parse(request.params.arguments ?? {});
        return asText(store.getBatchContext(args.repoId, args.filePaths, args.limit));
      }
      case "get_symbol_detail": {
        const args = getSymbolDetailSchema.parse(request.params.arguments ?? {});
        return asText(store.getSymbolDetail(args.repoId, args.symbolId, args.limit));
      }
      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${request.params.name}`);
    }
  } catch (error) {
    const mapped = mapError(error, request.params.name);
    return {
      content: [{ type: "text", text: JSON.stringify(mapped, null, 2) }],
      isError: true
    } satisfies CallToolResult;
  }
});

function handleHealthCheck(repoId?: string): CallToolResult {
  return asText({
    status: "ok",
    dbPath,
    allowedRootCount: allowedRoots.length,
    latestRun: repoId ? store.getLatestRun(repoId) : null
  });
}

function asText(payload: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }]
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

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
