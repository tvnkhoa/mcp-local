import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import process from "node:process";

import { WebSocketServer, type WebSocket } from "ws";
import { z } from "zod";

import { GraphStore } from "./graphStore.js";
import { assertPathAllowed, clamp, parseAllowedRoots } from "./indexGuardrails.js";
import { runIndexPipeline } from "./indexPipeline.js";
import type { CallChainDirection, IndexProgressSnapshot } from "./types.js";

const dbPath = process.env.CODEBASE_INDEX_DB_PATH ?? "./codebase-index.db";
const allowedRoots = parseAllowedRoots(process.env.CODEBASE_INDEX_ALLOWED_ROOTS);
const host = process.env.CODEBASE_INDEX_HTTP_HOST ?? "127.0.0.1";
const port = numberFromEnv("CODEBASE_INDEX_HTTP_PORT", 4310);
const apiKey = process.env.CODEBASE_INDEX_HTTP_API_KEY?.trim() || null;

const MAX_FILES_PER_RUN = numberFromEnv("CODEBASE_INDEX_MAX_FILES_PER_RUN", 20_000);
const MAX_RESULT_LIMIT = numberFromEnv("CODEBASE_INDEX_MAX_RESULT_LIMIT", 500);
const MAX_DEPTH = numberFromEnv("CODEBASE_INDEX_MAX_DEPTH", 5);

const indexRepositorySchema = z
  .object({
    repoId: z.string().min(1).max(200),
    repoPath: z.string().min(1),
    mode: z.enum(["full", "incremental"]).default("incremental"),
    maxFiles: z.number().int().min(1).max(MAX_FILES_PER_RUN).default(5_000),
    batchSize: z.number().int().min(1).max(2_000).default(200)
  })
  .strict();

const resolveNodesSchema = z
  .object({
    repoId: z.string().min(1).max(200),
    symbolIds: z.array(z.string().min(1).max(400)).max(MAX_RESULT_LIMIT)
  })
  .strict();

const graphViewKindSchema = z.enum(["module-flow", "dependency", "call-chain"]);
const cancelIndexSchema = z
  .object({
    repoId: z.string().min(1).max(200)
  })
  .strict();

const store = new GraphStore(dbPath);
const progressByRepoId = new Map<string, IndexProgressSnapshot>();
const activeControllers = new Map<string, AbortController>();
const wsClientsByRepoId = new Map<string, Set<WebSocket>>();

const server = createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-api-key");

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }

  try {
    if (!req.url || !req.method) {
      sendJson(res, 400, { code: "BAD_REQUEST", message: "Missing request URL or method." });
      return;
    }

    if (!isAuthorized(req)) {
      sendJson(res, 401, {
        code: "UNAUTHORIZED",
        message: "Invalid API key. Set CODEBASE_INDEX_HTTP_API_KEY and send x-api-key header."
      });
      return;
    }

    const url = new URL(req.url, `http://${host}:${port}`);

    if (req.method === "GET" && url.pathname === "/health") {
      const repoId = url.searchParams.get("repoId") ?? undefined;
      sendJson(res, 200, {
        status: "ok",
        dbPath,
        allowedRootCount: allowedRoots.length,
        latestRun: repoId ? store.getLatestRun(repoId) : null
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/index") {
      const body = await readJsonBody(req);
      const args = indexRepositorySchema.parse(body);
      assertPathAllowed(args.repoPath, allowedRoots);

      if (activeControllers.has(args.repoId)) {
        sendJson(res, 409, {
          code: "INDEX_ALREADY_RUNNING",
          message: `An index run is already active for repoId=${args.repoId}. Cancel it first or wait for completion.`
        });
        return;
      }

      const controller = new AbortController();
      activeControllers.set(args.repoId, controller);

      try {
        const summary = await runIndexPipeline(store, {
          repoId: args.repoId,
          repoPath: args.repoPath,
          mode: args.mode,
          maxFiles: clamp(args.maxFiles, 1, MAX_FILES_PER_RUN),
          batchSize: clamp(args.batchSize, 1, 2_000),
          onProgress: (progress) => {
            progressByRepoId.set(args.repoId, progress);
            broadcastProgress(args.repoId, progress);
          },
          abortSignal: controller.signal
        });
        sendJson(res, 200, summary);
        return;
      } finally {
        activeControllers.delete(args.repoId);
      }
    }

    if (req.method === "GET" && url.pathname === "/index/progress") {
      const repoId = requiredText(url, "repoId");
      sendJson(res, 200, {
        repoId,
        progress: progressByRepoId.get(repoId) ?? null
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/index/cancel") {
      const body = await readJsonBody(req);
      const args = cancelIndexSchema.parse(body);
      const controller = activeControllers.get(args.repoId);
      if (!controller) {
        sendJson(res, 404, {
          code: "INDEX_NOT_RUNNING",
          message: `No active index run found for repoId=${args.repoId}.`
        });
        return;
      }

      controller.abort();
      sendJson(res, 202, {
        status: "cancelling",
        repoId: args.repoId
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/graph/module-flow") {
      const repoId = requiredText(url, "repoId");
      const filePath = requiredText(url, "filePath");
      const limit = boundedInt(url, "limit", 100, 1, MAX_RESULT_LIMIT);
      const edges = store.getModuleFlow(repoId, filePath, limit);
      sendJson(res, 200, { repoId, filePath, edges });
      return;
    }

    if (req.method === "GET" && url.pathname === "/graph/view") {
      const repoId = requiredText(url, "repoId");
      const kind = graphViewKindSchema.parse(requiredText(url, "view"));
      const limit = boundedInt(url, "limit", 100, 1, MAX_RESULT_LIMIT);

      if (kind === "module-flow") {
        const filePath = requiredText(url, "filePath");
        const edges = store.getModuleFlow(repoId, filePath, limit);
        sendJson(res, 200, {
          repoId,
          view: kind,
          root: { filePath },
          ...buildGraphPayload(repoId, edges)
        });
        return;
      }

      if (kind === "dependency") {
        const symbolId = requiredText(url, "symbolId");
        const depth = boundedInt(url, "depth", 1, 1, MAX_DEPTH);
        const edges = traverseDependencyGraph(repoId, symbolId, depth, limit);
        sendJson(res, 200, {
          repoId,
          view: kind,
          root: { symbolId, depth },
          ...buildGraphPayload(repoId, edges)
        });
        return;
      }

      const symbolId = requiredText(url, "symbolId");
      const direction = parseDirection(url.searchParams.get("direction"));
      const depth = boundedInt(url, "depth", 1, 1, MAX_DEPTH);
      const edges = traverseCallGraph(repoId, symbolId, direction, depth, limit);
      sendJson(res, 200, {
        repoId,
        view: kind,
        root: { symbolId, direction, depth },
        ...buildGraphPayload(repoId, edges)
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/graph/dependency") {
      const repoId = requiredText(url, "repoId");
      const symbolId = requiredText(url, "symbolId");
      const depth = boundedInt(url, "depth", 1, 1, MAX_DEPTH);
      const limit = boundedInt(url, "limit", 100, 1, MAX_RESULT_LIMIT);
      const edges = traverseDependencyGraph(repoId, symbolId, depth, limit);
      sendJson(res, 200, { repoId, symbolId, depth, edges });
      return;
    }

    if (req.method === "GET" && url.pathname === "/graph/call-chain") {
      const repoId = requiredText(url, "repoId");
      const symbolId = requiredText(url, "symbolId");
      const direction = parseDirection(url.searchParams.get("direction"));
      const depth = boundedInt(url, "depth", 1, 1, MAX_DEPTH);
      const limit = boundedInt(url, "limit", 100, 1, MAX_RESULT_LIMIT);
      const edges = traverseCallGraph(repoId, symbolId, direction, depth, limit);
      sendJson(res, 200, { repoId, symbolId, direction, depth, edges });
      return;
    }

    if (req.method === "GET" && url.pathname === "/graph/impact") {
      const repoId = requiredText(url, "repoId");
      const filePath = requiredText(url, "filePath");
      const limit = boundedInt(url, "limit", 100, 1, MAX_RESULT_LIMIT);
      const symbols = store.getImpactSurface(repoId, filePath, limit);
      sendJson(res, 200, { repoId, filePath, symbols });
      return;
    }

    if (req.method === "POST" && url.pathname === "/graph/resolve-nodes") {
      const body = await readJsonBody(req);
      const args = resolveNodesSchema.parse(body);
      const symbols = store.getSymbolsByIds(args.repoId, args.symbolIds);
      sendJson(res, 200, { repoId: args.repoId, symbols });
      return;
    }

    sendJson(res, 404, { code: "NOT_FOUND", message: `Unknown route: ${req.method} ${url.pathname}` });
  } catch (error) {
    sendJson(res, 400, {
      code: "REQUEST_ERROR",
      message: error instanceof Error ? error.message : "Unknown request error"
    });
  }
});

server.listen(port, host, () => {
  process.stdout.write(`codebase-index HTTP API listening at http://${host}:${String(port)}\n`);
});
const wss = new WebSocketServer({ server });

wss.on("connection", (ws, req) => {
  const url = new URL(req.url ?? "/", `http://${host}:${port}`);
  const repoId = url.searchParams.get("repoId");

  if (!repoId) {
    ws.close(1008, "Missing repoId query parameter");
    return;
  }

  // Add client to subscribers
  if (!wsClientsByRepoId.has(repoId)) {
    wsClientsByRepoId.set(repoId, new Set());
  }
  wsClientsByRepoId.get(repoId)!.add(ws);

  // Send current progress immediately
  const currentProgress = progressByRepoId.get(repoId);
  if (currentProgress) {
    ws.send(JSON.stringify({ type: "progress", data: currentProgress }));
  }

  ws.on("close", () => {
    const clients = wsClientsByRepoId.get(repoId);
    if (clients) {
      clients.delete(ws);
      if (clients.size === 0) {
        wsClientsByRepoId.delete(repoId);
      }
    }
  });

  ws.on("error", () => {
    ws.close();
  });
});

function broadcastProgress(repoId: string, progress: IndexProgressSnapshot): void {
  const clients = wsClientsByRepoId.get(repoId);
  if (!clients || clients.size === 0) {
    return;
  }

  const message = JSON.stringify({ type: "progress", data: progress });
  for (const client of clients) {
    if (client.readyState === 1) { // OPEN
      try {
        client.send(message);
      } catch {
        // Ignore send errors
      }
    }
  }
}

process.on("SIGINT", () => {
  wss.close();
  store.close();
  server.close(() => process.exit(0));
});

process.on("SIGTERM", () => {
  wss.close();
  store.close();
  server.close(() => process.exit(0));
});

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

function parseDirection(value: string | null): CallChainDirection {
  if (value === "callers" || value === "callees") {
    return value;
  }
  return "callees";
}

function buildGraphPayload(repoId: string, edges: ReturnType<GraphStore["getDependencies"]>) {
  const symbolIds = Array.from(new Set(edges.flatMap((x) => [x.fromId, x.toId])));
  const nodes = store.getSymbolsByIds(repoId, symbolIds);
  return {
    edges,
    nodes
  };
}

function requiredText(url: URL, key: string): string {
  const value = url.searchParams.get(key)?.trim();
  if (!value) {
    throw new Error(`Missing required query param: ${key}`);
  }
  return value;
}

function boundedInt(url: URL, key: string, fallback: number, min: number, max: number): number {
  const raw = url.searchParams.get(key);
  if (!raw) {
    return fallback;
  }

  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) {
    throw new Error(`Invalid integer query param: ${key}`);
  }

  return clamp(parsed, min, max);
}

function sendJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) {
    return {};
  }

  return JSON.parse(raw) as unknown;
}

function isAuthorized(req: IncomingMessage): boolean {
  if (!apiKey) {
    return true;
  }

  const header = req.headers["x-api-key"];
  const incoming = Array.isArray(header) ? header[0] : header;
  return incoming === apiKey;
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
