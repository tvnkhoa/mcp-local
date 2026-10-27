import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import http from "node:http";
import { test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Logger } from "@mcp/core";
import { createNullLogger, ok } from "@mcp/core";
import { z } from "zod";

import { createMcpServer } from "./createServer.js";
import type { HttpTransportOptions } from "./httpTransport.js";
import { annotations, defineTool } from "./defineTool.js";
import { asText } from "./responses.js";
import { parseNetstatClientPid, resolveProcessStartTime } from "./httpTransport.js";
import { EMPTY_OBJECT_SCHEMA } from "./schema.js";

const TOKEN = "t".repeat(40);
const logger = createNullLogger("test");

const whoami = defineTool({
  name: "whoami",
  description: "Report the client session the call arrived on.",
  input: z.object({}).strict(),
  inputSchema: EMPTY_OBJECT_SCHEMA,
  annotations: annotations.read(),
  handler: () => ok({})
});

/** MCP-ISSUE-108: a call that never asks for the client identity, so it must never wait for it. */
const quick = defineTool({
  name: "quick",
  description: "Answer without resolving the client identity.",
  input: z.object({}).strict(),
  inputSchema: EMPTY_OBJECT_SCHEMA,
  annotations: annotations.read(),
  handler: () => ok({ quick: true })
});

/** An http server whose `whoami` answers with the CallContext's clientSessionId and resolved client identity. */
async function startServer(extra: Partial<Omit<HttpTransportOptions, "port" | "token">> = {}, log: Logger = logger) {
  const handle = createMcpServer({
    name: "http-test",
    version: "0.0.1",
    tools: [whoami, quick],
    logger: log,
    protectStdout: false,
    handleSignals: false,
    transport: { kind: "http", port: 0, token: TOKEN, ...extra },
    wrapCall: async (context, next) =>
      context.toolName === "whoami"
        ? asText(
            { session: context.clientSessionId ?? null, identity: (await context.resolveClientIdentity?.()) ?? null },
            "compact"
          )
        : next()
  });
  await handle.start();
  return handle;
}

function urlOf(port: number): URL {
  return new URL(`http://127.0.0.1:${String(port)}/mcp`);
}

async function connect(port: number, token = TOKEN): Promise<Client> {
  const client = new Client({ name: "c", version: "0" });
  await client.connect(
    new StreamableHTTPClientTransport(urlOf(port), { requestInit: { headers: { authorization: `Bearer ${token}` } } })
  );
  return client;
}

/** A raw request, so the Host header can be forged (fetch will not let a caller set it). */
function rawPost(port: number, headers: Record<string, string>): Promise<number> {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "raw", version: "0" } }
  });
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: "/mcp",
        method: "POST",
        headers: {
          host: `127.0.0.1:${String(port)}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...headers
        }
      },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      }
    );
    req.on("error", reject);
    req.end(body);
  });
}

function sessionOf(result: unknown): string | null {
  const text = (result as { content: { text: string }[] }).content[0]!.text;
  return (JSON.parse(text) as { session: string | null }).session;
}

function identityOf(result: unknown): string | null {
  const text = (result as { content: { text: string }[] }).content[0]!.text;
  return (JSON.parse(text) as { identity?: string | null }).identity ?? null;
}

test("http: refuses a short token and a bad port at construction", () => {
  assert.throws(() =>
    createMcpServer({ name: "x", version: "0", tools: [], logger, transport: { kind: "http", port: 0, token: "short" } })
  );
  assert.throws(() =>
    createMcpServer({ name: "x", version: "0", tools: [], logger, transport: { kind: "http", port: 70000, token: TOKEN } })
  );
});

test("http: handshake, tools/list and a call over streamable HTTP on 127.0.0.1", async () => {
  const handle = await startServer();
  try {
    const port = handle.httpPort()!;
    assert.ok(port > 0);
    const client = await connect(port);
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map((t) => t.name), ["whoami", "quick"]);
    const session = sessionOf(await client.callTool({ name: "whoami", arguments: {} }));
    assert.match(session ?? "", /^[0-9a-f-]{36}$/);
    await client.close();
  } finally {
    await handle.stop();
  }
});

test("http: no token or a wrong one is 401; a foreign Host or Origin is 403", async () => {
  const handle = await startServer();
  try {
    const port = handle.httpPort()!;
    const bearer = { authorization: `Bearer ${TOKEN}` };
    assert.equal(await rawPost(port, {}), 401);
    assert.equal(await rawPost(port, { authorization: `Bearer ${"x".repeat(40)}` }), 401);
    assert.equal(await rawPost(port, { authorization: "Basic abc" }), 401);
    assert.equal(await rawPost(port, { ...bearer, host: "evil.example:80" }), 403);
    assert.equal(await rawPost(port, { ...bearer, host: `evil.example:${String(port)}` }), 403);
    assert.equal(await rawPost(port, { ...bearer, origin: "http://evil.example" }), 403);
    // A forged Host is refused even without a token: rebinding learns nothing.
    assert.equal(await rawPost(port, { host: "evil.example" }), 403);
    assert.equal(await rawPost(port, { ...bearer, origin: `http://localhost:${String(port)}` }), 200);
    await assert.rejects(connect(port, "y".repeat(40)));
  } finally {
    await handle.stop();
  }
});

test("http: two clients get separate sessions over one registry, answered concurrently", async () => {
  const handle = await startServer();
  try {
    const port = handle.httpPort()!;
    const [a, b] = await Promise.all([connect(port), connect(port)]);
    const [sa, sb] = await Promise.all([
      a.callTool({ name: "whoami", arguments: {} }),
      b.callTool({ name: "whoami", arguments: {} })
    ]);
    assert.notEqual(sessionOf(sa), sessionOf(sb));
    await a.close();
    await b.close();
  } finally {
    await handle.stop();
  }
});

test("http: a client closing its session runs no shutdown hook; the cap refuses one too many", async () => {
  const handle = await startServer({ maxSessions: 1 });
  let hookRan = false;
  handle.lifecycle.onShutdown({ name: "probe", run: () => { hookRan = true; } });
  try {
    const port = handle.httpPort()!;
    const a = await connect(port);
    await assert.rejects(connect(port));
    const transport = (a as unknown as { transport: StreamableHTTPClientTransport }).transport;
    await transport.terminateSession();
    await a.close();
    assert.equal(hookRan, false);
    // The slot is free again once the first session is gone.
    const b = await connect(port);
    await b.close();
  } finally {
    await handle.stop();
  }
  assert.equal(hookRan, true);
});

test("http: an initialize refused before a session id is assigned closes its server (FX-R2)", async () => {
  const events: string[] = [];
  const capture: Logger = {
    level: "debug",
    debug: () => undefined,
    info: (message) => { events.push(message); },
    warn: () => undefined,
    error: () => undefined,
    child: () => capture
  };
  const handle = await startServer({}, capture);
  try {
    const port = handle.httpPort()!;
    // The protocol SDK refuses (406) a POST that does not accept text/event-stream — after our
    // gate, before any session id exists.
    const status = await rawPost(port, { authorization: `Bearer ${TOKEN}`, accept: "application/json" });
    assert.equal(status, 406);
    assert.ok(events.includes("http_session_abandoned"), `expected http_session_abandoned in ${events.join(", ")}`);
    assert.equal(events.includes("http_session_opened"), false);
    // The process still serves a well-formed client afterwards.
    const client = await connect(port);
    await client.close();
  } finally {
    await handle.stop();
  }
});

/** Wait until `check` holds, polling; fails the test after `ms`. */
async function until(check: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) assert.fail("condition not reached in time");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Sessions opened and not yet closed, as the transport logged them. */
function liveSessions(events: { message: string }[]): number {
  return events.filter((e) => e.message === "http_session_opened").length - events.filter((e) => e.message === "http_session_closed").length;
}

function capturingLogger(events: { message: string; fields: unknown }[]): Logger {
  const capture: Logger = {
    level: "debug",
    debug: () => undefined,
    info: (message, fields) => { events.push({ message, fields }); },
    warn: () => undefined,
    error: () => undefined,
    child: () => capture
  };
  return capture;
}

test("http: parseNetstatClientPid picks the client-side row of the loopback pair", () => {
  const out = [
    "  Proto  Local Address          Foreign Address        State           PID",
    "  TCP    127.0.0.1:3100         127.0.0.1:54321        ESTABLISHED     111",
    "  TCP    127.0.0.1:54321        127.0.0.1:3100         ESTABLISHED     222",
    "  TCP    127.0.0.1:54322        127.0.0.1:3100         TIME_WAIT       0"
  ].join("\r\n");
  assert.equal(parseNetstatClientPid(out, 54321, 3100), 222);
  assert.equal(parseNetstatClientPid(out, 54322, 3100), null);
  assert.equal(parseNetstatClientPid(out, 1, 3100), null);
});

test("http: a session whose client pid is dead is closed by the reaper; an unknown pid keeps it", async () => {
  const dead = spawnSync(process.execPath, ["-e", "0"]).pid!;
  const events: { message: string; fields: unknown }[] = [];
  const pids = [dead, null];
  const handle = await startServer(
    // No start-time lookup: a PowerShell spawn slows the handshake past the 50 ms reaper (the session would close mid-connect).
    { reapIntervalMs: 50, resolveClientPid: () => Promise.resolve(pids.shift() ?? null), resolveProcessStartTime: () => Promise.resolve(null) },
    capturingLogger(events)
  );
  try {
    const port = handle.httpPort()!;
    const gone = await connect(port);
    const kept = await connect(port);
    await until(() => events.some((e) => e.message === "http_session_closed"));
    const closed = events.filter((e) => e.message === "http_session_closed").map((e) => (e.fields as { reason: string }).reason);
    assert.deepEqual(closed, ["client_exited"]);
    // Give the reaper a few more passes: the null-pid session must survive them.
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(liveSessions(events), 1);
    assert.equal(sessionOf(await kept.callTool({ name: "whoami", arguments: {} })) !== null, true);
    await gone.close().catch(() => undefined);
    await kept.close();
  } finally {
    await handle.stop();
  }
});

test("http: a live pid keeps its session", async () => {
  const events: { message: string; fields: unknown }[] = [];
  const handle = await startServer({ reapIntervalMs: 50, resolveClientPid: () => Promise.resolve(process.pid) }, capturingLogger(events));
  try {
    const client = await connect(handle.httpPort()!);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(liveSessions(events), 1);
    await client.close();
  } finally {
    await handle.stop();
  }
});

test("http: at the cap the oldest session idle long enough is evicted for the new one", async () => {
  const events: { message: string; fields: unknown }[] = [];
  const handle = await startServer({ maxSessions: 2, evictMinIdleMs: 100, resolveClientPid: () => Promise.resolve(null) }, capturingLogger(events));
  try {
    const port = handle.httpPort()!;
    const a = await connect(port);
    const aSession = sessionOf(await a.callTool({ name: "whoami", arguments: {} }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    const b = await connect(port);
    await new Promise((resolve) => setTimeout(resolve, 150));
    const c = await connect(port);
    assert.equal(liveSessions(events), 2);
    const evicted = events.filter((e) => e.message === "http_session_closed").map((e) => e.fields as { sessionId: string; reason: string });
    assert.deepEqual(evicted.map((e) => e.reason), ["evicted_lru"]);
    assert.equal(evicted[0]!.sessionId, aSession);
    assert.equal(sessionOf(await c.callTool({ name: "whoami", arguments: {} })) !== null, true);
    await b.close();
    await c.close();
  } finally {
    await handle.stop();
  }
});

test("http: at the cap with every session fresh, the new one is still 503", async () => {
  const events: { message: string; fields: unknown }[] = [];
  const handle = await startServer({ maxSessions: 1, evictMinIdleMs: 60_000, resolveClientPid: () => Promise.resolve(null) }, capturingLogger(events));
  try {
    const port = handle.httpPort()!;
    const a = await connect(port);
    await assert.rejects(connect(port));
    assert.equal(liveSessions(events), 1);
    await a.close();
  } finally {
    await handle.stop();
  }
});

// ── MCP-ISSUE-108: a client's identity is its process, not its session ─────────────────────────────────

/** Ask once over a fresh session: [session id, identity]. */
async function whoamiOnce(port: number, token = TOKEN): Promise<[string | null, string | null]> {
  const client = await connect(port, token);
  try {
    const result = await client.callTool({ name: "whoami", arguments: {} });
    return [sessionOf(result), identityOf(result)];
  } finally {
    await client.close();
  }
}

test("http: a new session from the same client process after a restart has the same identity", async () => {
  const opts = { resolveClientPid: () => Promise.resolve(process.pid), resolveProcessStartTime: () => Promise.resolve("1000") };
  let handle = await startServer(opts);
  const [sessionA, identityA] = await whoamiOnce(handle.httpPort()!);
  await handle.stop();
  handle = await startServer(opts);
  try {
    // No old session id is sent: the client re-initializes, as Claude Code does after a restart.
    const [sessionB, identityB] = await whoamiOnce(handle.httpPort()!);
    assert.notEqual(sessionB, sessionA);
    assert.equal(typeof identityA, "string");
    assert.equal(identityB, identityA);
    assert.match(identityA!, new RegExp(`^pid:${String(process.pid)}@1000/[0-9a-f]{16}$`));
  } finally {
    await handle.stop();
  }
});

test("http: another client process, a reused pid (new start time) and another bearer each get another identity", async () => {
  const base = await startServer({ resolveClientPid: () => Promise.resolve(process.pid), resolveProcessStartTime: () => Promise.resolve("1000") });
  const [, mine] = await whoamiOnce(base.httpPort()!);
  await base.stop();
  // process.ppid is a second live process: a peer client.
  const peer = await startServer({ resolveClientPid: () => Promise.resolve(process.ppid), resolveProcessStartTime: () => Promise.resolve("1000") });
  const [, other] = await whoamiOnce(peer.httpPort()!);
  await peer.stop();
  const reused = await startServer({ resolveClientPid: () => Promise.resolve(process.pid), resolveProcessStartTime: () => Promise.resolve("2000") });
  const [, reborn] = await whoamiOnce(reused.httpPort()!);
  await reused.stop();
  const otherToken = "u".repeat(40);
  const rotated = createMcpServer({
    name: "http-test", version: "0.0.1", tools: [whoami], logger, protectStdout: false, handleSignals: false,
    transport: {
      kind: "http", port: 0, token: otherToken,
      resolveClientPid: () => Promise.resolve(process.pid), resolveProcessStartTime: () => Promise.resolve("1000")
    },
    wrapCall: async (context, next) =>
      context.toolName === "whoami"
        ? asText({ session: null, identity: (await context.resolveClientIdentity?.()) ?? null }, "compact")
        : next()
  });
  await rotated.start();
  const [, rebeared] = await whoamiOnce(rotated.httpPort()!, otherToken);
  await rotated.stop();
  for (const identity of [other, reborn, rebeared]) {
    assert.equal(typeof identity, "string");
    assert.notEqual(identity, mine);
  }
});

test("http: an unresolvable pid or start time leaves no identity (fail closed to the session id)", async () => {
  for (const opts of [
    { resolveClientPid: () => Promise.resolve(null), resolveProcessStartTime: () => Promise.resolve("1000") },
    { resolveClientPid: () => Promise.resolve(process.pid), resolveProcessStartTime: () => Promise.resolve(null) },
    { resolveClientPid: () => Promise.reject(new Error("netstat")), resolveProcessStartTime: () => Promise.resolve("1000") },
    { resolveClientPid: () => Promise.resolve(process.pid), resolveProcessStartTime: () => Promise.reject(new Error("ps")) }
  ]) {
    const handle = await startServer(opts);
    try {
      const [session, identity] = await whoamiOnce(handle.httpPort()!);
      assert.equal(identity, null);
      assert.equal(typeof session, "string");
    } finally {
      await handle.stop();
    }
  }
});

test("http: a client whose process has exited has no identity", async () => {
  const dead = spawnSync(process.execPath, ["-e", "0"]).pid!;
  const handle = await startServer({ resolveClientPid: () => Promise.resolve(dead), resolveProcessStartTime: () => Promise.resolve("1000") });
  try {
    assert.equal((await whoamiOnce(handle.httpPort()!))[1], null);
  } finally {
    await handle.stop();
  }
});

test("http: resolveProcessStartTime reads this process's start time and refuses a bad pid", async () => {
  const mine = await resolveProcessStartTime(process.pid);
  if (process.platform === "win32" || process.platform === "linux") {
    assert.match(mine ?? "", /^\d+$/);
    assert.equal(await resolveProcessStartTime(process.pid), mine);
  }
  assert.equal(await resolveProcessStartTime(0), null);
  assert.equal(await resolveProcessStartTime(-1), null);
});

test("http: a call that does not ask for the client identity never waits for a slow lookup", async () => {
  const slowMs = 2500;
  const handle = await startServer({
    resolveClientPid: () => Promise.resolve(process.pid),
    resolveProcessStartTime: () => new Promise((resolve) => setTimeout(() => resolve("1000"), slowMs))
  });
  try {
    const client = await connect(handle.httpPort()!);
    const started = Date.now();
    const result = await client.callTool({ name: "quick", arguments: {} });
    const quickMs = Date.now() - started;
    assert.equal(result.isError, undefined);
    assert.ok(quickMs < 1000, `quick took ${String(quickMs)} ms`);
    // The identity is still there for a call that asks: it waits for the lookup, then answers.
    const identity = identityOf(await client.callTool({ name: "whoami", arguments: {} }));
    assert.ok(Date.now() - started >= slowMs - 200);
    assert.match(identity ?? "", new RegExp(`^pid:${String(process.pid)}@1000/`));
    await client.close();
  } finally {
    await handle.stop();
  }
});
