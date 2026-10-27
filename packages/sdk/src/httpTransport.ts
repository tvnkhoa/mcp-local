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
 * A session ends one of five ways: the client DELETEs it; it sits idle past the timeout; the
 * client process exits (its pid, resolved once from the loopback socket, is no longer alive — a
 * killed client never sends DELETE); it is the least recently used when the cap is hit and has been
 * idle a few minutes; or the server shuts down. Ending one never touches the process's shutdown
 * hooks: a client going away is not the server going away.
 */

import { execFile } from "node:child_process";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";

import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

import type { Logger } from "@mcp/core";

import { fileHttpSessionStore } from "./httpSessionStore.js";

/** The only address this transport binds. Not configurable, by design. */
export const HTTP_LOOPBACK_HOST = "127.0.0.1";
/** The one path served. Anything else is 404. */
export const HTTP_MCP_PATH = "/mcp";

const MIN_TOKEN_CHARS = 32;
const DEFAULT_MAX_SESSIONS = 32;
const DEFAULT_SESSION_IDLE_MS = 8 * 60 * 60 * 1000;
/** A full server evicts its least recently used session only if it has been quiet this long. */
const DEFAULT_EVICT_MIN_IDLE_MS = 5 * 60 * 1000;
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
  /**
   * Concurrent client sessions. At the cap, the least recently used session is evicted if it has
   * been idle `evictMinIdleMs`; otherwise one more is refused with 503. Default 32.
   */
  readonly maxSessions?: number;
  /** A session with no request for this long is closed. Default 8 h. */
  readonly sessionIdleMs?: number;
  /** Minimum idle time before a session may be evicted to make room. Default 5 min. */
  readonly evictMinIdleMs?: number;
  /** Reaper period. Default min(60 s, idle / 2), at least 1 s. */
  readonly reapIntervalMs?: number;
  /**
   * Which pid owns the client end of a loopback connection (`remotePort` -> `serverPort`), or null
   * when unknown. Default: `netstat` on win32, null elsewhere. A pid that is later found dead closes
   * its session. Risk, accepted: a pid reused within a session's life keeps it until idle or eviction.
   */
  readonly resolveClientPid?: (remotePort: number, serverPort: number) => Promise<number | null>;
  readonly maxBodyBytes?: number;
  /**
   * MCP-ISSUE-103: where to keep `session id → sha256(bearer)` across restarts (see `httpSessionStore.ts`). Set, a
   * request whose session id this process does not know is re-adopted iff its bearer hashes to the one
   * recorded when that id was initialized; otherwise it is a 404 as before. Unset: no re-adoption.
   */
  readonly sessionStoreFile?: string;
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
  /** Owner of the client socket at initialize; null while unresolved or when unknown. */
  clientPid: number | null;
  /** MCP-ISSUE-103: when this session's store record was last refreshed (throttled, see `STORE_TOUCH_EVERY_MS`). */
  storeTouchedAt?: number;
}

/** A busy session refreshes its store record at most this often, so a crash (no shutdown) loses at most this much. */
const STORE_TOUCH_EVERY_MS = 5 * 60 * 1000;

/** Pid of the row `127.0.0.1:<remotePort>` -> `127.0.0.1:<serverPort>` ESTABLISHED in `netstat -ano -p TCP` output. */
export function parseNetstatClientPid(output: string, remotePort: number, serverPort: number): number | null {
  const local = `${HTTP_LOOPBACK_HOST}:${String(remotePort)}`;
  const foreign = `${HTTP_LOOPBACK_HOST}:${String(serverPort)}`;
  for (const line of output.split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length >= 5 && cols[0] === "TCP" && cols[1] === local && cols[2] === foreign && cols[3] === "ESTABLISHED") {
      const pid = Number(cols[4]);
      return Number.isInteger(pid) && pid > 0 ? pid : null;
    }
  }
  return null;
}

function resolveClientPidViaNetstat(remotePort: number, serverPort: number): Promise<number | null> {
  if (process.platform !== "win32") return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile("netstat", ["-ano", "-p", "TCP"], { windowsHide: true, timeout: 10_000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
      resolve(error === null ? parseNetstatClientPid(stdout, remotePort, serverPort) : null);
    });
  });
}

/** Signal 0 only probes: ESRCH means gone, EPERM means alive but not ours. */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code === "EPERM";
  }
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
  const evictMinIdleMs = options.evictMinIdleMs ?? DEFAULT_EVICT_MIN_IDLE_MS;
  const resolveClientPid = options.resolveClientPid ?? resolveClientPidViaNetstat;
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

  const store = options.sessionStoreFile ? fileHttpSessionStore(options.sessionStoreFile, idleMs) : null;
  /** The presented bearer's sha256, hex: what a session is bound to. */
  const bearerDigestHex = (header: string | undefined): string | null => {
    const match = /^Bearer\s+(.+)$/i.exec(header ?? "");
    return match === null ? null : digest(match[1]!.trim()).toString("hex");
  };

  const closeSession = async (sessionId: string, reason: string): Promise<void> => {
    const session = sessions.get(sessionId);
    if (session === undefined) return;
    sessions.delete(sessionId);
    // A shutdown keeps the record: the restarted process re-adopts the session for the same bearer.
    // On shutdown it is refreshed (`at` = now), so the age limit runs from the session's last activity.
    if (reason === "shutdown") store?.touch(sessionId);
    else store?.delete(sessionId);
    logger.info("http_session_closed", { sessionId, reason, sessions: sessions.size });
    await session.server.close().catch(() => undefined);
  };

  const openSession = async (req: http.IncomingMessage, res: http.ServerResponse, body: unknown): Promise<void> => {
    const server = buildServer();
    // Started before the handshake while the socket is surely open; never awaited by the response path.
    const remotePort = req.socket.remotePort;
    const pidLookup: Promise<number | null> =
      remotePort === undefined ? Promise.resolve(null) : resolveClientPid(remotePort, boundPort).catch(() => null);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sessionId) => {
        sessions.set(sessionId, { transport, server, lastSeen: Date.now(), clientPid: null, storeTouchedAt: Date.now() });
        const bearer = bearerDigestHex(req.headers.authorization);
        if (bearer !== null) store?.set(sessionId, bearer);
        logger.info("http_session_opened", { sessionId, sessions: sessions.size });
      }
    });
    // Set before connect: Protocol.connect chains whatever onclose is already there.
    transport.onclose = () => {
      const sessionId = transport.sessionId;
      if (sessionId !== undefined && sessions.has(sessionId)) {
        sessions.delete(sessionId);
        store?.delete(sessionId);
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
    if (sessionId === undefined || !sessions.has(sessionId)) {
      await abandon("initialize_refused");
      return;
    }
    void pidLookup.then((pid) => {
      const session = sessions.get(sessionId);
      if (session !== undefined) session.clientPid = pid;
    });
  };

  /**
   * MCP-ISSUE-103: a session id this process does not know (it was opened before a restart), re-adopted only
   * for the bearer recorded when it was initialized. The SDK (1.29.0) has no public resume API: the transport
   * is marked initialized under the old id through its private fields, which `httpSessionStore.test.ts` pins to
   * the installed SDK version so an upgrade that moves them fails loudly. Anything unexpected → undefined (404).
   */
  const adoptSession = async (sessionId: string, req: http.IncomingMessage): Promise<Session | undefined> => {
    const recorded = store?.get(sessionId) ?? null;
    const presented = bearerDigestHex(req.headers.authorization);
    if (recorded === null || presented === null || recorded.length !== presented.length) return undefined;
    if (!timingSafeEqual(Buffer.from(recorded, "hex"), Buffer.from(presented, "hex"))) {
      logger.info("http_session_adopt_refused", { sessionId, reason: "bearer_mismatch" });
      return undefined;
    }
    if (sessions.size >= maxSessions) return undefined;
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => sessionId });
    const inner = (transport as unknown as { _webStandardTransport?: { sessionId?: string; _initialized?: unknown } })._webStandardTransport;
    if (inner === undefined || typeof inner._initialized !== "boolean") {
      logger.warn("http_session_adopt_unsupported", { sessionId });
      await server.close().catch(() => undefined);
      return undefined;
    }
    inner.sessionId = sessionId;
    inner._initialized = true;
    transport.onclose = () => {
      if (sessions.get(sessionId)?.transport === transport) {
        sessions.delete(sessionId);
        store?.delete(sessionId);
        logger.info("http_session_closed", { sessionId, reason: "transport_closed", sessions: sessions.size });
      }
    };
    await server.connect(transport);
    const session: Session = { transport, server, lastSeen: Date.now(), clientPid: null };
    sessions.set(sessionId, session);
    store?.touch(sessionId);
    session.storeTouchedAt = Date.now();
    logger.info("http_session_adopted", { sessionId, sessions: sessions.size });
    return session;
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
      const session = sessions.get(sessionId) ?? (await adoptSession(sessionId, req));
      if (session === undefined) {
        // The spec's answer to an unknown or expired session: the client re-initializes.
        sendJsonRpcError(res, 404, -32001, "Session not found");
        return;
      }
      session.lastSeen = Date.now();
      if (store && session.lastSeen - (session.storeTouchedAt ?? 0) >= STORE_TOUCH_EVERY_MS) {
        session.storeTouchedAt = session.lastSeen;
        store.touch(sessionId);
      }
      await session.transport.handleRequest(req, res, body);
      if (req.method === "DELETE") await closeSession(sessionId, "client_delete");
      return;
    }

    if (req.method === "POST" && isInitializeRequest(body)) {
      if (sessions.size >= maxSessions) {
        let oldestId: string | undefined;
        let oldestSeen = Infinity;
        for (const [id, session] of sessions) {
          if (session.lastSeen < oldestSeen) {
            oldestSeen = session.lastSeen;
            oldestId = id;
          }
        }
        if (oldestId === undefined || Date.now() - oldestSeen < evictMinIdleMs) {
          sendJsonRpcError(res, 503, -32000, `Too many sessions (max ${String(maxSessions)})`);
          return;
        }
        await closeSession(oldestId, "evicted_lru");
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
      else if (session.clientPid !== null && !pidAlive(session.clientPid)) void closeSession(sessionId, "client_exited");
    }
  }, options.reapIntervalMs ?? Math.min(60_000, Math.max(1_000, Math.floor(idleMs / 2))));
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
