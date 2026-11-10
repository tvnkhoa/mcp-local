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
 * client process exits (its pid, resolved from the loopback socket, is no longer alive — a
 * killed client never sends DELETE); it is the least recently used when the cap is hit and has been
 * idle a few minutes; or the server shuts down. Ending one never touches the process's shutdown
 * hooks: a client going away is not the server going away.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";

import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

import type { Logger } from "@mcp/core";

import { HTTP_LOOPBACK_HOST, createIdentityLookup, resolveClientPidViaNetstat, resolveProcessStartTime } from "./httpClientIdentity.js";
import { fileHttpSessionStore } from "./httpSessionStore.js";

export { HTTP_LOOPBACK_HOST, clientIdentityOf, parseNetstatClientPid, resolveProcessStartTime } from "./httpClientIdentity.js";

/** The one path served. Anything else is 404. */
export const HTTP_MCP_PATH = "/mcp";

const MIN_TOKEN_CHARS = 32;
const DEFAULT_MAX_SESSIONS = 32;
const DEFAULT_SESSION_IDLE_MS = 8 * 60 * 60 * 1000;
/** A full server evicts its least recently used session only if it has been quiet this long. */
const DEFAULT_EVICT_MIN_IDLE_MS = 5 * 60 * 1000;
const DEFAULT_MAX_BODY_BYTES = 4 * 1024 * 1024;
/**
 * MCP-ISSUE-115: how long an idle keep-alive socket stays open. Node's default is 5 s, inside the window in which
 * a client reuses a pooled socket, so a request written as the server closes it fails with ECONNRESET (measured:
 * a keep-alive client reusing after 6 s idle). Above every client's reuse window; loopback, so an idle socket is cheap.
 */
export const DEFAULT_KEEP_ALIVE_TIMEOUT_MS = 65_000;
/** Time to receive a request's headers; Node requires it above `keepAliveTimeout`, or a reused socket can be cut. */
const HEADERS_TIMEOUT_MARGIN_MS = 5_000;
/**
 * Time to RECEIVE a whole request (headers + body), not to answer it: a tool call that runs for minutes is not cut
 * by it. Bodies are capped at 4 MiB over loopback, so one minute is generous; it is set rather than left to the
 * Node default so the bound is visible here.
 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

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
  /**
   * MCP-ISSUE-108: when a live process started, as an opaque string, or null when it cannot be read. Paired with
   * the client pid it names the client process across a server restart (a reused pid has another start time).
   * Default: {@link resolveProcessStartTime}.
   */
  readonly resolveProcessStartTime?: (pid: number) => Promise<string | null>;
  /**
   * MCP-ISSUE-110 (3): a session whose identity resolved null re-resolves it from the socket of its next request
   * that asks for it (an ownership tool call) — at once the first time, then at most once per this many ms, so a
   * client that cannot be resolved does not spawn netstat/PowerShell on every call. Default 30 s.
   */
  readonly identityRetryMs?: number;
  readonly maxBodyBytes?: number;
  /** MCP-ISSUE-115: idle keep-alive socket lifetime. Default {@link DEFAULT_KEEP_ALIVE_TIMEOUT_MS}. */
  readonly keepAliveTimeoutMs?: number;
  /**
   * MCP-ISSUE-115: time to receive a whole request (not to answer it). Default {@link DEFAULT_REQUEST_TIMEOUT_MS}; 0
   * disables it; a value below the headers timeout (keep-alive + 5 s) is raised to it.
   */
  readonly requestTimeoutMs?: number;
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
  /**
   * MCP-ISSUE-108: the stable identity of the client process behind a session — pid, its start time and the
   * bearer — or undefined when any part cannot be resolved (the caller then falls back to the session id).
   */
  clientIdentity(sessionId: string): Promise<string | undefined>;
  close(): Promise<void>;
}

interface Session {
  readonly transport: StreamableHTTPServerTransport;
  readonly server: Server;
  lastSeen: number;
  /** Owner of the client socket at initialize (or at the last re-resolution); null while unresolved or when unknown. */
  clientPid: number | null;
  /** MCP-ISSUE-108: see {@link HttpTransportHandle.clientIdentity}; null when unresolvable. Replaced by a re-resolution. */
  identity: Promise<string | null>;
  /** The presented bearer's sha256 (hex), part of the identity. */
  readonly bearer: string | null;
  /** MCP-ISSUE-110 (3): the client port of this session's latest request — a re-resolution's fallback outside a request. */
  lastRemotePort: number | undefined;
  /** MCP-ISSUE-110 (3): no re-resolution before this `performance.now()` (0: the first one may run at once). */
  nextIdentityRetryAt: number;
  /** MCP-ISSUE-110 (3): a re-resolution is in flight; callers arriving now share it. */
  identityRetrying?: boolean;
  /** MCP-ISSUE-103: when this session's store record was last refreshed (throttled, see `STORE_TOUCH_EVERY_MS`). */
  storeTouchedAt?: number;
}

/** MCP-ISSUE-110 (3): the client port of the HTTP request whose handling is running (its tool calls inherit it). */
const requestPort = new AsyncLocalStorage<number | undefined>();

/** A busy session refreshes its store record at most this often, so a crash (no shutdown) loses at most this much. */
const STORE_TOUCH_EVERY_MS = 5 * 60 * 1000;

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
  const startTimeOf = options.resolveProcessStartTime ?? resolveProcessStartTime;
  const identityRetryMs = options.identityRetryMs ?? 30_000;
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

  const lookupIdentity = createIdentityLookup(resolveClientPid, startTimeOf, () => boundPort, logger);

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
    const bearer = bearerDigestHex(req.headers.authorization);
    let assignedId: string | undefined;
    const { pid: pidLookup, identity } = lookupIdentity(remotePort, bearer, () => assignedId, "initialize");
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sessionId) => {
        assignedId = sessionId;
        sessions.set(sessionId, {
          transport, server, lastSeen: Date.now(), clientPid: null, identity, bearer,
          lastRemotePort: remotePort, nextIdentityRetryAt: 0, storeTouchedAt: Date.now()
        });
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
    // MCP-ISSUE-108: the adopting request's socket names the client process, as an initialize's does.
    const remotePort = req.socket.remotePort;
    const { pid: pidLookup, identity } = lookupIdentity(remotePort, presented, () => sessionId, "adopt");
    const session: Session = {
      transport, server, lastSeen: Date.now(), clientPid: null, identity, bearer: presented,
      lastRemotePort: remotePort, nextIdentityRetryAt: 0
    };
    void pidLookup.then((pid) => {
      if (sessions.get(sessionId) === session) session.clientPid = pid;
    });
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
      // MCP-ISSUE-110 (3): the socket a re-resolution looks up — this request's, open while it is being answered.
      if (req.socket.remotePort !== undefined) session.lastRemotePort = req.socket.remotePort;
      if (store && session.lastSeen - (session.storeTouchedAt ?? 0) >= STORE_TOUCH_EVERY_MS) {
        session.storeTouchedAt = session.lastSeen;
        store.touch(sessionId);
      }
      // MCP-ISSUE-110 (3): the tool handlers this request starts see its socket's port (clientIdentity re-resolves from it).
      await requestPort.run(req.socket.remotePort, () => session.transport.handleRequest(req, res, body));
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
  // MCP-ISSUE-115: set explicitly, never Node's defaults (keep-alive 5 s). `timeout` 0: an SSE stream may sit quiet.
  const keepAliveTimeoutMs = options.keepAliveTimeoutMs ?? DEFAULT_KEEP_ALIVE_TIMEOUT_MS;
  httpServer.keepAliveTimeout = keepAliveTimeoutMs;
  httpServer.headersTimeout = keepAliveTimeoutMs + HEADERS_TIMEOUT_MARGIN_MS;
  // 0 disables it (Node's meaning); any other value is raised to headersTimeout, which Node requires it not to undercut.
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  httpServer.requestTimeout = requestTimeoutMs === 0 ? 0 : Math.max(requestTimeoutMs, httpServer.headersTimeout);
  httpServer.timeout = 0;

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
    async clientIdentity(sessionId) {
      const session = sessions.get(sessionId);
      if (session === undefined) return undefined;
      // The socket of the request asking now (it is open while that request is answered); else the session's latest.
      const callerPort = requestPort.getStore() ?? session.lastRemotePort;
      const current = session.identity;
      // A caller arriving while a re-resolution is in flight shares it.
      const sharing = session.identityRetrying;
      let identity = await current.catch(() => null);
      if (identity === null && !sharing && sessions.get(sessionId) === session) {
        if (session.identity !== current) {
          // A re-resolution started while this caller waited: share it rather than start another.
          identity = await session.identity.catch(() => null);
        } else if (performance.now() >= session.nextIdentityRetryAt) {
          // MCP-ISSUE-110 (3): null is not for life — look again from the socket of the ownership call in flight.
          // Monotonic clock: a wall-clock step back must not stall the next retry.
          session.nextIdentityRetryAt = performance.now() + identityRetryMs;
          const retry = lookupIdentity(callerPort, session.bearer, () => sessionId, "retry");
          session.identity = retry.identity;
          session.identityRetrying = true;
          void retry.pid.then((pid) => {
            if (pid !== null && sessions.get(sessionId) === session) session.clientPid = pid;
          });
          identity = await retry.identity.catch(() => null);
          session.identityRetrying = false;
        }
      }
      // A client that has exited no longer owns anything; its pid may be about to be reused.
      if (identity === null || (session.clientPid !== null && !pidAlive(session.clientPid))) return undefined;
      return identity;
    },
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
