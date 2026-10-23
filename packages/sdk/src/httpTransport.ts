/**
 * Streamable-HTTP transport: one long-running process serving many clients.
 *
 * Opt-in (stdio stays the default) and loopback only. What this file adds on top of the protocol
 * SDK's `StreamableHTTPServerTransport` is the part a shared local process needs before it may
 * listen at all:
 *
 *   - **Bind 127.0.0.1, never anything else.** The host is not an option: a non-loopback bind
 *     would hand the index (and its refactor write path) to the network.
 *   - **Host and Origin allow-list** — DNS-rebinding protection. A page in the browser can make a
 *     request to 127.0.0.1, but not with a `Host` naming it, nor without an `Origin` naming its own
 *     site. Either mismatch is refused with 403 before the token is even looked at.
 *   - **A bearer token on every request** — 401 without it. Compared as digests, so neither the
 *     content nor the length of the token leaks through timing.
 *   - **One protocol `Server` per client session.** The tool registry and everything behind it are
 *     shared; the protocol state (initialize handshake, pending requests, notifications) is not.
 *
 * Sessions end on DELETE, on an idle timeout, or at shutdown. Ending one never touches the
 * process's shutdown hooks: a client going away is not the server going away.
 */

import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";

import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

import type { Logger } from "@mcp/core";

/** The only address this transport binds. Not configurable, by design. */
export const HTTP_LOOPBACK_HOST = "127.0.0.1";
/** The one path served. Anything else is 404. */
export const HTTP_MCP_PATH = "/mcp";

const MIN_TOKEN_CHARS = 32;
const DEFAULT_MAX_SESSIONS = 32;
const DEFAULT_SESSION_IDLE_MS = 8 * 60 * 60 * 1000;
const DEFAULT_MAX_BODY_BYTES = 4 * 1024 * 1024;

export interface HttpTransportOptions {
  /** TCP port on 127.0.0.1. 0 picks a free one (tests); read it back from `port()`. */
  readonly port: number;
  /** Bearer token every request must carry. At least 32 characters. */
  readonly token: string;
  /**
   * Origins allowed besides the server's own (`http://127.0.0.1:<port>`, `http://localhost:<port>`).
   * A request with no `Origin` header (every non-browser client) is not affected.
   */
  readonly allowedOrigins?: readonly string[];
  /** Concurrent client sessions; one more is refused with 503. Default 32. */
  readonly maxSessions?: number;
  /** A session with no request for this long is closed. Default 8 h. */
  readonly sessionIdleMs?: number;
  readonly maxBodyBytes?: number;
}

export interface HttpTransportHandle {
  port(): number;
  sessionCount(): number;
  close(): Promise<void>;
}

interface Session {
  readonly transport: StreamableHTTPServerTransport;
  readonly server: Server;
  lastSeen: number;
}

/** Refuse a configuration that would listen unsafely, before anything binds. */
export function validateHttpTransportOptions(options: HttpTransportOptions): void {
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) {
    throw new Error(`http transport: port must be an integer 0-65535, got ${String(options.port)}`);
  }
  if (typeof options.token !== "string" || options.token.length < MIN_TOKEN_CHARS) {
    throw new Error(`http transport: a bearer token of at least ${String(MIN_TOKEN_CHARS)} characters is required`);
  }
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function sendJsonRpcError(res: http.ServerResponse, status: number, code: number, message: string, headers: Record<string, string> = {}): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }));
}

function readBody(req: http.IncomingMessage, maxBytes: number): Promise<Buffer | "too_large"> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        over = true;
        return;
      }
      if (!over) chunks.push(chunk);
    });
    req.on("end", () => resolve(over ? "too_large" : Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/**
 * Listen on 127.0.0.1:`port` and serve MCP over streamable HTTP.
 *
 * `buildServer` is called once per client session; every instance it returns must share the same
 * tool registry and services, which is the point of serving many clients from one process.
 */
export async function startHttpTransport(
  options: HttpTransportOptions,
  buildServer: () => Server,
  logger: Logger
): Promise<HttpTransportHandle> {
  validateHttpTransportOptions(options);
  const maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
  const idleMs = options.sessionIdleMs ?? DEFAULT_SESSION_IDLE_MS;
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const tokenDigest = digest(options.token);
  const sessions = new Map<string, Session>();
  let boundPort = options.port;

  const allowedHosts = (): Set<string> => new Set([`127.0.0.1:${String(boundPort)}`, `localhost:${String(boundPort)}`]);
  const allowedOrigins = (): Set<string> =>
    new Set([`http://127.0.0.1:${String(boundPort)}`, `http://localhost:${String(boundPort)}`, ...(options.allowedOrigins ?? [])]);

  const authorized = (header: string | undefined): boolean => {
    const match = /^Bearer\s+(.+)$/i.exec(header ?? "");
    return match !== null && timingSafeEqual(digest(match[1]!.trim()), tokenDigest);
  };

  const closeSession = async (sessionId: string, reason: string): Promise<void> => {
    const session = sessions.get(sessionId);
    if (session === undefined) return;
    sessions.delete(sessionId);
    logger.info("http_session_closed", { sessionId, reason, sessions: sessions.size });
    await session.server.close().catch(() => undefined);
  };

  const openSession = async (req: http.IncomingMessage, res: http.ServerResponse, body: unknown): Promise<void> => {
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sessionId) => {
        sessions.set(sessionId, { transport, server, lastSeen: Date.now() });
        logger.info("http_session_opened", { sessionId, sessions: sessions.size });
      }
    });
    // Set before connect: Protocol.connect chains whatever onclose is already there.
    transport.onclose = () => {
      const sessionId = transport.sessionId;
      if (sessionId !== undefined && sessions.has(sessionId)) {
        sessions.delete(sessionId);
        logger.info("http_session_closed", { sessionId, reason: "transport_closed", sessions: sessions.size });
      }
    };
    // An initialize refused before a session id is assigned (a bad Accept header, a malformed
    // request, a throw) leaves a server nobody can reach again: close it rather than leak it.
    const abandon = async (reason: string): Promise<void> => {
      logger.info("http_session_abandoned", { reason });
      await server.close().catch(() => undefined);
    };
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (cause) {
      await abandon("initialize_threw");
      throw cause;
    }
    const sessionId = transport.sessionId;
    if (sessionId === undefined || !sessions.has(sessionId)) await abandon("initialize_refused");
  };

  const handle = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    // DNS rebinding first: a forged Host or a foreign Origin learns nothing, not even whether a token is wanted.
    if (!allowedHosts().has((req.headers.host ?? "").toLowerCase())) {
      sendJsonRpcError(res, 403, -32000, "Forbidden: Host not allowed");
      return;
    }
    const origin = req.headers.origin;
    if (origin !== undefined && !allowedOrigins().has(origin)) {
      sendJsonRpcError(res, 403, -32000, "Forbidden: Origin not allowed");
      return;
    }
    if (!authorized(req.headers.authorization)) {
      sendJsonRpcError(res, 401, -32000, "Unauthorized", { "www-authenticate": "Bearer" });
      return;
    }
    const url = new URL(req.url ?? "/", `http://${HTTP_LOOPBACK_HOST}`);
    if (url.pathname !== HTTP_MCP_PATH) {
      sendJsonRpcError(res, 404, -32000, "Not Found");
      return;
    }

    let body: unknown;
    if (req.method === "POST") {
      const raw = await readBody(req, maxBodyBytes);
      if (raw === "too_large") {
        sendJsonRpcError(res, 413, -32000, "Payload Too Large");
        return;
      }
      try {
        body = JSON.parse(raw.toString("utf8"));
      } catch {
        sendJsonRpcError(res, 400, -32700, "Parse error");
        return;
      }
    }

    const header = req.headers["mcp-session-id"];
    const sessionId = Array.isArray(header) ? header[0] : header;
    if (sessionId !== undefined) {
      const session = sessions.get(sessionId);
      if (session === undefined) {
        // The spec's answer to an unknown or expired session: the client re-initializes.
        sendJsonRpcError(res, 404, -32001, "Session not found");
        return;
      }
      session.lastSeen = Date.now();
      await session.transport.handleRequest(req, res, body);
      if (req.method === "DELETE") await closeSession(sessionId, "client_delete");
      return;
    }

    if (req.method === "POST" && isInitializeRequest(body)) {
      if (sessions.size >= maxSessions) {
        sendJsonRpcError(res, 503, -32000, `Too many sessions (max ${String(maxSessions)})`);
        return;
      }
      await openSession(req, res, body);
      return;
    }
    sendJsonRpcError(res, 400, -32000, "Bad Request: no valid session id");
  };

  const httpServer = http.createServer((req, res) => {
    handle(req, res).catch((cause: unknown) => {
      logger.error("http_request_failed", { detail: String(cause) });
      sendJsonRpcError(res, 500, -32603, "Internal error");
    });
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(options.port, HTTP_LOOPBACK_HOST, () => {
      httpServer.off("error", reject);
      resolve();
    });
  });
  boundPort = (httpServer.address() as AddressInfo).port;

  const reaper = setInterval(() => {
    const cutoff = Date.now() - idleMs;
    for (const [sessionId, session] of sessions) {
      if (session.lastSeen < cutoff) void closeSession(sessionId, "idle");
    }
  }, Math.min(60_000, Math.max(1_000, Math.floor(idleMs / 2))));
  reaper.unref();

  return {
    port: () => boundPort,
    sessionCount: () => sessions.size,
    async close() {
      clearInterval(reaper);
      for (const sessionId of [...sessions.keys()]) await closeSession(sessionId, "shutdown");
      await new Promise<void>((resolve) => {
        httpServer.close(() => resolve());
        httpServer.closeAllConnections();
      });
    }
  };
}
