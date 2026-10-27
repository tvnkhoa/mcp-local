import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createNullLogger, ok } from "@mcp/core";
import { z } from "zod";

import { createMcpServer } from "./createServer.js";
import { annotations, defineTool } from "./defineTool.js";
import { fileHttpSessionStore } from "./httpSessionStore.js";
import { asText } from "./responses.js";
import { EMPTY_OBJECT_SCHEMA } from "./schema.js";

/**
 * MCP-ISSUE-103: session re-adoption after a restart. The end-to-end case (same bearer re-adopted and its
 * pre-restart preview applied and rolled back; a rotated bearer 404 and its apply refused) is
 * codebase-index-mcp's `test:http-transport`.
 */

test("MCP-ISSUE-103: re-adoption is pinned to the installed SDK — an upgrade that moves the private fields fails here", () => {
  // httpTransport.ts adoptSession sets `_webStandardTransport.sessionId` / `._initialized` (no public resume API).
  const require = createRequire(import.meta.url);
  // The exports map serves `package.json` as `dist/cjs/package.json` ({"type":"commonjs"}); the root one is two up.
  const nested = require.resolve("@modelcontextprotocol/sdk/package.json");
  const pkg = JSON.parse(fs.readFileSync(path.join(path.dirname(nested), "..", "..", "package.json"), "utf8")) as { name: string; version: string };
  assert.equal(pkg.name, "@modelcontextprotocol/sdk");
  assert.equal(pkg.version, "1.29.0", "re-check adoptSession against the new SDK, then update this pin");
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => "x" });
  const inner = (transport as unknown as { _webStandardTransport?: { _initialized?: unknown; sessionId?: unknown } })._webStandardTransport;
  assert.ok(inner !== undefined, "_webStandardTransport exists");
  assert.equal(typeof inner._initialized, "boolean");
  inner.sessionId = "adopted";
  assert.equal(transport.sessionId, "adopted", "the outer transport reads the inner session id");
});

test("MCP-ISSUE-103: the store keeps id → bearer digest across instances (a restart), forgets deletes and expired entries", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sdk-sessions-"));
  try {
    const file = path.join(dir, "state", "http-sessions.json");
    let now = 1_000;
    const a = fileHttpSessionStore(file, 10_000, () => now);
    a.set("s1", "ab".repeat(32));
    a.set("s2", "cd".repeat(32));
    const b = fileHttpSessionStore(file, 10_000, () => now); // the restarted process
    assert.equal(b.get("s1"), "ab".repeat(32));
    b.delete("s2");
    assert.equal(a.get("s2"), null);
    now = 20_000;
    assert.equal(b.get("s1"), null, "older than maxAge: not re-adoptable");
    if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o077, 0);
    fs.writeFileSync(file, "{ not json");
    assert.equal(fileHttpSessionStore(file, 10_000).get("s1"), null, "unreadable file → nothing to re-adopt");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("MCP-ISSUE-103 review: touch moves the age limit to the last activity", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sdk-sessions-"));
  try {
    const file = path.join(dir, "http-sessions.json");
    const H = 60 * 60 * 1000;
    let now = 0;
    const store = fileHttpSessionStore(file, 8 * H, () => now);
    store.set("s", "ab".repeat(32)); // initialized at 0
    now = 9 * H - 60_000;
    store.touch("s"); // busy until a minute ago (a shutdown)
    now = 9 * H;
    assert.equal(store.get("s"), "ab".repeat(32), "initialized 9 h ago, active a minute ago: re-adoptable");
    store.touch("unknown");
    assert.equal(store.get("unknown"), null, "touch never creates a record");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("MCP-ISSUE-103 review: a session initialized 9 h ago with a recent shutdown is re-adopted by the restarted server", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sdk-sessions-"));
  const TOKEN = "s".repeat(40);
  const file = path.join(dir, "http-sessions.json");
  const whoami = defineTool({
    name: "whoami",
    description: "The client session a call arrived on.",
    input: z.object({}).strict(),
    inputSchema: EMPTY_OBJECT_SCHEMA,
    annotations: annotations.read(),
    handler: () => ok({})
  });
  const start = async () => {
    const handle = createMcpServer({
      name: "store-test",
      version: "0.0.1",
      tools: [whoami],
      logger: createNullLogger("test"),
      protectStdout: false,
      handleSignals: false,
      transport: { kind: "http", port: 0, token: TOKEN, sessionStoreFile: file },
      wrapCall: async (context, next) =>
        context.toolName === "whoami" ? asText({ session: context.clientSessionId ?? null }, "compact") : next()
    });
    await handle.start();
    return handle;
  };
  const client = async (port: number, sessionId?: string) => {
    const c = new Client({ name: "c", version: "0" });
    const t = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${String(port)}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${TOKEN}` } },
      ...(sessionId && { sessionId })
    });
    if (sessionId) await t.start();
    else await c.connect(t);
    return { c, t };
  };
  try {
    const first = await start();
    const a = await client(first.httpPort()!);
    const sid = a.t.sessionId!;
    // Pretend it was initialized 9 h ago (past the 8 h idle limit).
    const data = JSON.parse(fs.readFileSync(file, "utf8")) as { sessions: Record<string, { at: number }> };
    data.sessions[sid]!.at = Date.now() - 9 * 60 * 60 * 1000;
    fs.writeFileSync(file, JSON.stringify(data));
    await a.c.close();
    await first.stop("shutdown");
    const after = JSON.parse(fs.readFileSync(file, "utf8")) as { sessions: Record<string, { at: number }> };
    assert.ok(Date.now() - after.sessions[sid]!.at < 60_000, "the shutdown refreshed the record");

    const second = await start();
    try {
      // A raw call on the old id, as a client that never re-initializes would make it.
      const res = await fetch(`http://127.0.0.1:${String(second.httpPort())}/mcp`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-session-id": sid,
          "mcp-protocol-version": "2025-06-18"
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "whoami", arguments: {} } })
      });
      assert.equal(res.status, 200, "re-adopted, not 404");
      assert.match(await res.text(), new RegExp(sid));
    } finally {
      await second.stop();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
