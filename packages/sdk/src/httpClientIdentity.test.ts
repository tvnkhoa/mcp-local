/**
 * MCP-ISSUE-108: the client process behind an HTTP session (`httpClientIdentity.ts`), end to end through the
 * transport. Moved out of `httpTransport.test.ts` (size cap).
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
import { parseNetstatClientPid, resolveProcessStartTime } from "./httpClientIdentity.js";
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
