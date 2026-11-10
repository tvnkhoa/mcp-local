/**
 * MCP-ISSUE-108: the client process behind an HTTP session (`httpClientIdentity.ts`), end to end through the
 * transport. Moved out of `httpTransport.test.ts` (size cap).
 */
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
import { UNSUPPORTED_PLATFORM, netstatOutcome, parseNetstatClientPid, resolveProcessStartTime } from "./httpClientIdentity.js";
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

async function connect(port: number, token = TOKEN): Promise<Client> {
  const client = new Client({ name: "c", version: "0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${String(port)}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } }
    })
  );
  return client;
}

function sessionOf(result: unknown): string | null {
  const text = (result as { content: { text: string }[] }).content[0]!.text;
  return (JSON.parse(text) as { session: string | null }).session;
}

function identityOf(result: unknown): string | null {
  const text = (result as { content: { text: string }[] }).content[0]!.text;
  return (JSON.parse(text) as { identity?: string | null }).identity ?? null;
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
  // No wall clock: the start-time lookup stays pending until the test releases it, so "quick did not wait"
  // means quick answered while the lookup had not resolved at all. No real PowerShell either.
  let release: (startTime: string) => void = () => undefined;
  const lookup = new Promise<string>((resolve) => {
    release = resolve;
  });
  let resolved = false;
  const handle = await startServer({
    resolveClientPid: () => Promise.resolve(process.pid),
    resolveProcessStartTime: () => lookup.then((startTime) => ((resolved = true), startTime))
  });
  try {
    const client = await connect(handle.httpPort()!);
    const result = await client.callTool({ name: "quick", arguments: {} });
    assert.equal(result.isError, undefined);
    assert.equal(resolved, false, "quick answered while the identity lookup was still pending");
    // A call that asks waits for the lookup: still unanswered while it is pending, answered once it resolves.
    let answered = false;
    const asking = client.callTool({ name: "whoami", arguments: {} }).then((r) => ((answered = true), r));
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(answered, false, "whoami waits for the pending lookup");
    release("1000");
    const identity = identityOf(await asking);
    assert.match(identity ?? "", new RegExp(`^pid:${String(process.pid)}@1000/`));
    await client.close();
  } finally {
    release("1000");
    await handle.stop();
  }
});

// ── MCP-ISSUE-110 (3): an identity that resolved null is not null for the session's life ─────────────────

function warnCapture(events: { message: string; fields: unknown }[]): Logger {
  const capture: Logger = {
    level: "debug",
    debug: () => undefined,
    info: () => undefined,
    warn: (message, fields) => { events.push({ message, fields }); },
    error: () => undefined,
    child: () => capture
  };
  return capture;
}

test("http: MCP-ISSUE-110 (3) a pid lookup that failed at initialize is retried from the next ownership call's socket", async () => {
  // The first lookup fails as netstat did under load (timeout); every later one finds the client.
  const ports: number[] = [];
  const events: { message: string; fields: unknown }[] = [];
  const handle = await startServer(
    {
      identityRetryMs: 0,
      resolveClientPid: (remotePort) => {
        ports.push(remotePort);
        return ports.length === 1 ? Promise.reject(new Error("timeout")) : Promise.resolve(process.pid);
      },
      resolveProcessStartTime: () => Promise.resolve("1000")
    },
    warnCapture(events)
  );
  try {
    const client = await connect(handle.httpPort()!);
    const first = await client.callTool({ name: "whoami", arguments: {} });
    const second = await client.callTool({ name: "whoami", arguments: {} });
    assert.equal(sessionOf(first), sessionOf(second));
    assert.match(identityOf(first) ?? "", new RegExp(`^pid:${String(process.pid)}@1000/[0-9a-f]{16}$`), "the null identity is re-resolved");
    assert.equal(identityOf(second), identityOf(first));
    assert.equal(ports.length, 2, "once resolved, the identity is not looked up again");
    const unresolved = events.filter((e) => e.message === "http_identity_unresolved").map((e) => e.fields as Record<string, unknown>);
    assert.equal(unresolved.length, 1);
    assert.equal(unresolved[0]!["step"], "client_pid");
    assert.equal(unresolved[0]!["attempt"], "initialize");
    // At initialize the lookup may fail before the session id is assigned: then it is logged as null.
    assert.ok([null, sessionOf(first)].includes(unresolved[0]!["sessionId"] as string | null));
    assert.equal(unresolved[0]!["reason"], "timeout");
    await client.close();
  } finally {
    await handle.stop();
  }
});

test("http: MCP-ISSUE-110 (3) a start time that failed is retried too, and names its step", async () => {
  let starts = 0;
  const events: { message: string; fields: unknown }[] = [];
  const handle = await startServer(
    {
      identityRetryMs: 0,
      resolveClientPid: () => Promise.resolve(process.pid),
      resolveProcessStartTime: () => (++starts === 1 ? Promise.resolve(null) : Promise.resolve("1000"))
    },
    warnCapture(events)
  );
  try {
    const [, identity] = await whoamiOnce(handle.httpPort()!);
    assert.match(identity ?? "", /^pid:\d+@1000\//);
    const steps = events.filter((e) => e.message === "http_identity_unresolved").map((e) => (e.fields as { step: string }).step);
    assert.deepEqual(steps, ["start_time"]);
  } finally {
    await handle.stop();
  }
});

test("http: MCP-ISSUE-110 (3) re-resolution is throttled per session — no lookup storm", async () => {
  let lookups = 0;
  const events: { message: string; fields: unknown }[] = [];
  const handle = await startServer(
    {
      identityRetryMs: 60_000,
      resolveClientPid: () => ((lookups += 1), Promise.resolve(null)),
      resolveProcessStartTime: () => Promise.resolve("1000")
    },
    warnCapture(events)
  );
  try {
    const client = await connect(handle.httpPort()!);
    // Concurrent and sequential ownership calls inside one retry window: one initialize lookup + one retry, no more.
    const results = await Promise.all(Array.from({ length: 5 }, () => client.callTool({ name: "whoami", arguments: {} })));
    results.push(await client.callTool({ name: "whoami", arguments: {} }));
    for (const result of results) assert.equal(identityOf(result), null, "still fail closed");
    assert.equal(lookups, 2);
    const attempts = events.filter((e) => e.message === "http_identity_unresolved").map((e) => (e.fields as { attempt: string }).attempt);
    assert.deepEqual(attempts, ["initialize", "retry"]);
    // A call that does not ask for the identity never triggers a lookup.
    await client.callTool({ name: "quick", arguments: {} });
    assert.equal(lookups, 2);
    await client.close();
  } finally {
    await handle.stop();
  }
});


/** A promise the test settles by hand. */
function deferred<T>(): { promise: Promise<T>; settle: (value: T) => void } {
  let settle: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolve) => (settle = resolve));
  return { promise, settle };
}

test("http: MCP-ISSUE-110 (3) concurrent callers share one in-flight re-resolution (no throttle)", async () => {
  // identityRetryMs 0: only the sharing keeps this to one retry lookup. The initialize lookup is held until all five
  // callers wait on it, so they resume together: one starts the retry, the other four must join it.
  const initial = deferred<number | null>();
  const retry = deferred<number | null>();
  let lookups = 0;
  const handle = await startServer(
    {
      identityRetryMs: 0,
      resolveClientPid: () => (++lookups === 1 ? initial.promise : retry.promise),
      resolveProcessStartTime: () => Promise.resolve("1000")
    },
    warnCapture([])
  );
  try {
    const client = await connect(handle.httpPort()!);
    const first = Array.from({ length: 5 }, () => client.callTool({ name: "whoami", arguments: {} }));
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(lookups, 1, "all five wait on the pending initialize lookup");
    initial.settle(null);
    await new Promise((resolve) => setTimeout(resolve, 100));
    // A caller arriving while the retry is still pending shares it too.
    const late = client.callTool({ name: "whoami", arguments: {} });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(lookups, 2, "initialize + exactly one retry while it is in flight");
    // The shared retry fails too: no caller that waited on it starts another (retry window 0 notwithstanding).
    retry.settle(null);
    for (const result of await Promise.all([...first, late])) assert.equal(identityOf(result), null);
    assert.equal(lookups, 2);
    await client.close();
  } finally {
    initial.settle(null);
    retry.settle(null);
    await handle.stop();
  }
});

test("http: MCP-ISSUE-110 (3) once identityRetryMs has elapsed, the next ownership call retries again", async () => {
  let lookups = 0;
  const handle = await startServer(
    { identityRetryMs: 300, resolveClientPid: () => ((lookups += 1), Promise.resolve(null)), resolveProcessStartTime: () => Promise.resolve("1000") },
    warnCapture([])
  );
  try {
    const client = await connect(handle.httpPort()!);
    const ask = () => client.callTool({ name: "whoami", arguments: {} });
    await ask();
    assert.equal(lookups, 2, "initialize + the first retry, at once");
    await ask();
    assert.equal(lookups, 2, "inside the window: none");
    await new Promise((resolve) => setTimeout(resolve, 400));
    await ask();
    assert.equal(lookups, 3, "after the window: one more");
    await client.close();
  } finally {
    await handle.stop();
  }
});

/** One raw JSON-RPC POST on a fresh socket: the status, the session id header, the body, and the client-side port. */
function rawCall(port: number, message: object, sessionId?: string): Promise<{ status: number; sessionId?: string; body: string; localPort: number }> {
  return new Promise((resolve, reject) => {
    let localPort = 0;
    const req = http.request(
      {
        host: "127.0.0.1", port, path: "/mcp", method: "POST", agent: false,
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${TOKEN}`,
          ...(sessionId === undefined ? {} : { "mcp-session-id": sessionId, "mcp-protocol-version": "2025-03-26" })
        }
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (body += chunk));
        res.on("end", () => {
          const id = res.headers["mcp-session-id"];
          resolve({ status: res.statusCode ?? 0, ...(typeof id === "string" ? { sessionId: id } : {}), body, localPort });
        });
      }
    );
    req.on("socket", (socket) => socket.once("connect", () => (localPort = socket.localPort ?? 0)));
    req.on("error", reject);
    req.end(JSON.stringify(message));
  });
}

test("http: MCP-ISSUE-110 (3) the retry looks up the ownership call's own socket, not the session's latest request", async () => {
  // The initialize lookup stays pending while a whoami waits on it and another request arrives on another socket;
  // then it resolves null and the whoami retries, from the whoami's socket.
  const initial = deferred<number | null>();
  const ports: number[] = [];
  const handle = await startServer({
    identityRetryMs: 0,
    resolveClientPid: (remotePort) => (ports.push(remotePort), ports.length === 1 ? initial.promise : Promise.resolve(null)),
    resolveProcessStartTime: () => Promise.resolve("1000")
  });
  try {
    const port = handle.httpPort()!;
    const init = await rawCall(port, {
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "raw", version: "0" } }
    });
    assert.equal(init.status, 200);
    const sid = init.sessionId!;
    await rawCall(port, { jsonrpc: "2.0", method: "notifications/initialized" }, sid);
    const asking = rawCall(port, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "whoami", arguments: {} } }, sid);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const other = await rawCall(port, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "quick", arguments: {} } }, sid);
    assert.equal(other.status, 200);
    initial.settle(null);
    const whoamiCall = await asking;
    assert.equal(whoamiCall.status, 200);
    assert.equal(ports.length, 2, "initialize + one retry");
    assert.notEqual(whoamiCall.localPort, other.localPort);
    assert.equal(ports[1], whoamiCall.localPort, "the retry used the ownership call's socket");
  } finally {
    initial.settle(null);
    await handle.stop();
  }
});

test("http: MCP-ISSUE-110 (3) netstat: killed at its timeout gives timeout, any other failure exec_failed, else the row", () => {
  const row = "  TCP    127.0.0.1:54321        127.0.0.1:3100         ESTABLISHED     222";
  assert.throws(() => netstatOutcome({ killed: true }, "", 54321, 3100), /^Error: timeout$/);
  assert.throws(() => netstatOutcome({ killed: false }, row, 54321, 3100), /^Error: exec_failed$/);
  assert.throws(() => netstatOutcome({}, row, 54321, 3100), /^Error: exec_failed$/);
  assert.equal(netstatOutcome(null, row, 54321, 3100), 222);
  assert.equal(netstatOutcome(null, row, 1, 3100), null);
});

test("http: MCP-ISSUE-110 (3) an unsupported platform warns once per process, then logs at debug", async () => {
  const warned: unknown[] = [];
  const debugged: unknown[] = [];
  const capture: Logger = {
    level: "debug",
    debug: (message, fields) => { if (message === "http_identity_unresolved") debugged.push(fields); },
    info: () => undefined,
    warn: (message, fields) => { if (message === "http_identity_unresolved") warned.push(fields); },
    error: () => undefined,
    child: () => capture
  };
  const handle = await startServer(
    { identityRetryMs: 0, resolveClientPid: () => Promise.reject(new Error(UNSUPPORTED_PLATFORM)), resolveProcessStartTime: () => Promise.resolve("1000") },
    capture
  );
  try {
    for (let i = 0; i < 3; i += 1) assert.equal((await whoamiOnce(handle.httpPort()!))[1], null);
    assert.equal(warned.length, 1);
    assert.equal((warned[0] as { reason: string }).reason, UNSUPPORTED_PLATFORM);
    // 3 sessions, each an initialize lookup and one retry: 6 events, the first at warn.
    assert.equal(debugged.length, 5);
  } finally {
    await handle.stop();
  }
});
