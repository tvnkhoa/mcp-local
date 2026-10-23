import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Logger } from "@mcp/core";
import { createNullLogger, ok } from "@mcp/core";
import { z } from "zod";

import { createMcpServer } from "./createServer.js";
import { annotations, defineTool } from "./defineTool.js";
import { asText } from "./responses.js";
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

/** An http server whose `whoami` answers with the CallContext's clientSessionId. */
async function startServer(extra: { maxSessions?: number } = {}, log: Logger = logger) {
  const handle = createMcpServer({
    name: "http-test",
    version: "0.0.1",
    tools: [whoami],
    logger: log,
    protectStdout: false,
    handleSignals: false,
    transport: { kind: "http", port: 0, token: TOKEN, ...extra },
    wrapCall: async (context, next) =>
      context.toolName === "whoami" ? asText({ session: context.clientSessionId ?? null }, "compact") : next()
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
    assert.deepEqual(tools.tools.map((t) => t.name), ["whoami"]);
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
