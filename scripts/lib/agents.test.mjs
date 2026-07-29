import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { readServerEntries, readServerEntry } from "./agents.mjs";

/**
 * `scripts/lib/` had no tests at all, which is how the bug these pin survived: `mcp:doctor`
 * reported a healthy `observe-mcp` install as FAIL because the machine intentionally registers it
 * twice — `observe-mcp-ssdev_au` and `observe-mcp-wecrm_au_prod`, one per backend — and the lookup
 * only ever matched the exact manifest key. Config read as "not registered", the env check was
 * skipped, and `start` then failed because the process launched with no credentials.
 *
 * These are pure-function tests over a temp config file. No agent, no network, no install.
 */

let tmpDir;

function agentWith(config) {
  tmpDir ??= fs.mkdtempSync(path.join(os.tmpdir(), "agents-test-"));
  const configPath = path.join(tmpDir, `cfg-${Math.abs(hash(JSON.stringify(config)))}.json`);
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf8");
  return { name: "Test Agent", type: "claude-code", configPath };
}

// Deterministic, so a rerun reuses the same file rather than depending on Math.random.
function hash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

const SERVER = { command: "node", args: ["D:/x/observe-mcp/dist/index.js"], env: { A: "1" } };

test("exact key only — one unsuffixed instance", () => {
  const agent = agentWith({ mcpServers: { "observe-mcp": SERVER } });
  const found = readServerEntries(agent, "observe-mcp");
  assert.equal(found.length, 1);
  assert.equal(found[0].name, "observe-mcp");
  assert.equal(found[0].suffixed, false);
});

test("suffixed instances only — the multi-environment case that used to read as unregistered", () => {
  const agent = agentWith({
    mcpServers: {
      "observe-mcp-wecrm_au_prod": { ...SERVER, env: { A: "prod" } },
      "observe-mcp-ssdev_au": { ...SERVER, env: { A: "dev" } }
    }
  });

  // The old exact-key lookup is what produced the false FAIL; kept here so the contrast is pinned.
  assert.equal(readServerEntry(agent, "observe-mcp"), null);

  const found = readServerEntries(agent, "observe-mcp");
  assert.equal(found.length, 2);
  assert.deepEqual(found.map((f) => f.name), ["observe-mcp-ssdev_au", "observe-mcp-wecrm_au_prod"]);
  assert.ok(found.every((f) => f.suffixed));
  // Each instance must carry its OWN env — the doctor starts them separately because of this.
  assert.equal(found[0].entry.env.A, "dev");
  assert.equal(found[1].entry.env.A, "prod");
});

test("canonical entry sorts before suffixed instances", () => {
  const agent = agentWith({
    mcpServers: { "observe-mcp-zzz": SERVER, "observe-mcp": SERVER, "observe-mcp-aaa": SERVER }
  });
  assert.deepEqual(
    readServerEntries(agent, "observe-mcp").map((f) => f.name),
    ["observe-mcp", "observe-mcp-aaa", "observe-mcp-zzz"]
  );
});

test("a hyphen is required — a name that merely starts with the key does not match", () => {
  const agent = agentWith({ mcpServers: { "observe-mcp2": SERVER, "observe-mcpX": SERVER } });
  assert.deepEqual(readServerEntries(agent, "observe-mcp"), []);
});

test("S-44: renaming to `codebase-index` makes the old key look like a suffixed instance", () => {
  // This is the interaction to remember before S-44 renames codebase-index-local ->
  // codebase-index: the stale entry matches the prefix. It is NOT filtered out, because a filter
  // would hide an orphaned registration. It is returned and named, so the doctor prints it and a
  // human can see an entry they did not expect.
  const agent = agentWith({ mcpServers: { "codebase-index-local": SERVER } });
  const found = readServerEntries(agent, "codebase-index");
  assert.equal(found.length, 1);
  assert.equal(found[0].name, "codebase-index-local");
  assert.equal(found[0].suffixed, true, "must be flagged as a suffix match, not the canonical key");
});

test("non-server-shaped values are ignored", () => {
  // `cfg.mcp` is one of the buckets searched and also holds unrelated settings, so an entry only
  // counts when it looks like a server launch.
  const agent = agentWith({
    mcp: {
      "observe-mcp-notes": "just a string",
      "observe-mcp-flag": true,
      "observe-mcp-empty": {},
      "observe-mcp-real": SERVER
    }
  });
  assert.deepEqual(readServerEntries(agent, "observe-mcp").map((f) => f.name), ["observe-mcp-real"]);
});

test("the same key in two buckets is returned once", () => {
  const agent = agentWith({
    mcpServers: { "observe-mcp": SERVER },
    mcp: { servers: { "observe-mcp": SERVER } }
  });
  assert.equal(readServerEntries(agent, "observe-mcp").length, 1);
});

test("a missing or unparseable config yields no instances rather than throwing", () => {
  assert.deepEqual(readServerEntries({ configPath: path.join(os.tmpdir(), "nope-not-here.json") }, "x"), []);

  tmpDir ??= fs.mkdtempSync(path.join(os.tmpdir(), "agents-test-"));
  const broken = path.join(tmpDir, "broken.json");
  fs.writeFileSync(broken, "{ this is not json", "utf8");
  assert.deepEqual(readServerEntries({ configPath: broken }, "x"), []);
});

test.after(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});
