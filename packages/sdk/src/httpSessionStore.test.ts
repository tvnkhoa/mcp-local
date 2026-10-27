import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { fileHttpSessionStore } from "./httpSessionStore.js";

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
