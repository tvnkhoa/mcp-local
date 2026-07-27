#!/usr/bin/env node

/**
 * Tests that the SHIPPING config-merge logic (scripts/lib/agents.mjs
 * `configureAgent`) generates correct MCP configurations for each agent type.
 *
 * This imports and exercises the real function against throwaway temp config
 * files — it does NOT re-implement the merge logic, so a regression in
 * `configureAgent` fails this test instead of silently passing.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { configureAgent } from "../../../scripts/lib/agents.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SERVER_PATH = path.join(__dirname, "..", "dist", "index.js");
const KEY = "codebase-index-local";

console.log("Testing setup script configuration generation (real configureAgent)...\n");

const MOCK_ENV = {
  CODEBASE_INDEX_ALLOWED_ROOTS: "/test/repo",
  CODEBASE_INDEX_DB_PATH: "/test/index.db",
  CODEBASE_INDEX_DOCS_INDEXING_ENABLED: "false",
  CODEBASE_INDEX_DOCS_TOOLS_ENABLED: "false",
  CODEBASE_INDEX_TELEMETRY_ENABLED: "false",
  CODEBASE_INDEX_WATCH_AUTO_START: "false",
};

const BASE_SERVER = { command: "node", args: [SERVER_PATH], env: MOCK_ENV };

// Run configureAgent against a temp file seeded with `existing`, return the
// merged config it wrote. Cleans up temp + backup files afterward.
let counter = 0;
function buildConfig(agentType, existingConfig = {}) {
  const tmp = path.join(os.tmpdir(), `mcp-setup-test-${process.pid}-${counter++}.json`);
  const created = [tmp];
  try {
    if (existingConfig && Object.keys(existingConfig).length) {
      fs.writeFileSync(tmp, JSON.stringify(existingConfig, null, 2), "utf-8");
    }
    const agent = { name: `test-${agentType}`, type: agentType, configPath: tmp };
    const okFlag = configureAgent(agent, KEY, BASE_SERVER);
    if (!okFlag) throw new Error(`configureAgent returned false for type '${agentType}'`);
    // Track the backup configureAgent may have created so we can clean it up.
    for (const f of fs.readdirSync(os.tmpdir())) {
      if (f.startsWith(path.basename(tmp) + ".backup.")) created.push(path.join(os.tmpdir(), f));
    }
    return JSON.parse(fs.readFileSync(tmp, "utf-8"));
  } finally {
    for (const f of created) { try { fs.rmSync(f, { force: true }); } catch {} }
  }
}

// ---------------------------------------------------------------------------
// Test cases
// ---------------------------------------------------------------------------
const tests = [
  {
    name: "Claude Code — correct shape",
    agentType: "claude-code",
    check(config) {
      const server = config?.mcpServers?.[KEY];
      assert(server, "mcpServers[codebase-index-local] should exist");
      assert(server.command === "node", 'command should be "node"');
      assert(Array.isArray(server.args), "args should be an array");
      assert(server.env?.CODEBASE_INDEX_ALLOWED_ROOTS, "env.CODEBASE_INDEX_ALLOWED_ROOTS should be set");
      assert(!server.environment, 'should use "env", not "environment"');
      assert(server.env?.CODEBASE_INDEX_TELEMETRY_ENABLED === "false", "telemetry should default to false");
    },
  },
  {
    name: "Claude Desktop — correct shape",
    agentType: "claude",
    check(config) {
      const server = config?.mcpServers?.[KEY];
      assert(server, "mcpServers[codebase-index-local] should exist");
      assert(server.command === "node", 'command should be "node"');
      assert(Array.isArray(server.args), "args should be an array");
      assert(server.env?.CODEBASE_INDEX_ALLOWED_ROOTS, "env.CODEBASE_INDEX_ALLOWED_ROOTS should be set");
    },
  },
  {
    name: "VS Code — correct nested shape",
    agentType: "vscode",
    check(config) {
      assert(!config["mcp.servers"], 'flat "mcp.servers" key must not exist (VS Code needs nested format)');
      const server = config?.mcp?.servers?.[KEY];
      assert(server, "mcp.servers[codebase-index-local] should exist");
      assert(server.command === "node", 'command should be "node"');
      assert(Array.isArray(server.args), "args should be an array");
      assert(server.env?.CODEBASE_INDEX_ALLOWED_ROOTS, "env should be set");
    },
  },
  {
    name: "OpenCode — correct shape",
    agentType: "opencode",
    check(config) {
      const server = config?.mcp?.[KEY];
      assert(server, "mcp[codebase-index-local] should exist");
      assert(server.type === "local", 'type should be "local"');
      assert(Array.isArray(server.command), "command should be an array");
      assert(server.command[0] === "node", 'command[0] should be "node"');
      assert(server.command.length >= 2, "command array should have at least 2 elements");
      assert(server.enabled === true, "enabled should be true");
      assert(server.environment, 'should use "environment" key');
      assert(!server.env, 'should NOT have "env" key (OpenCode uses "environment")');
      assert(server.environment?.CODEBASE_INDEX_ALLOWED_ROOTS, "environment.CODEBASE_INDEX_ALLOWED_ROOTS should be set");
      assert(config.$schema === "https://opencode.ai/config.json", "$schema should be set");
    },
  },
  {
    name: "Claude Code — merges with existing config",
    agentType: "claude-code",
    existing: { "editor.fontSize": 14, mcpServers: { "other-server": { command: "other" } } },
    check(config) {
      assert(config["editor.fontSize"] === 14, "existing settings should be preserved");
      assert(config.mcpServers["other-server"], "existing mcpServers entries should be preserved");
      assert(config.mcpServers[KEY], "new server should be added");
    },
  },
  {
    name: "VS Code — migrates flat key and preserves other servers",
    agentType: "vscode",
    existing: { "mcp.servers": { "old-server": { command: "other", args: [] } }, "editor.tabSize": 2 },
    check(config) {
      assert(config["editor.tabSize"] === 2, "existing settings should be preserved");
      assert(!config["mcp.servers"], 'flat "mcp.servers" key should be removed after migration');
      assert(config.mcp?.servers?.["old-server"], "old server should be migrated to nested format");
      assert(config.mcp?.servers?.[KEY], "new server should be added");
    },
  },
  {
    name: "VS Code — merges with existing nested mcp.servers",
    agentType: "vscode",
    existing: { mcp: { servers: { "existing-server": { command: "other", args: [] } } }, "editor.tabSize": 2 },
    check(config) {
      assert(config["editor.tabSize"] === 2, "existing settings should be preserved");
      assert(config.mcp?.servers?.["existing-server"], "existing nested server should be preserved");
      assert(config.mcp?.servers?.[KEY], "new server should be added");
    },
  },
  {
    name: "OpenCode — merges with existing mcp entries",
    agentType: "opencode",
    existing: { mcp: { "other-server": { type: "local", command: ["other"], enabled: true, environment: {} } } },
    check(config) {
      assert(config.mcp["other-server"], "existing mcp entries should be preserved");
      assert(config.mcp[KEY], "new server should be added");
    },
  },
];

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------
function assert(condition, message) {
  if (!condition) throw new Error(message);
}

let passed = 0;
let failed = 0;
const failures = [];

for (const test of tests) {
  process.stdout.write(`Testing ${test.name}... `);
  try {
    const config = buildConfig(test.agentType, test.existing ?? {});
    test.check(config);
    console.log("✅ PASSED");
    passed++;
  } catch (err) {
    console.log("❌ FAILED");
    console.log(`   ${err.message}`);
    failures.push({ name: test.name, error: err.message });
    failed++;
  }
}

console.log();
console.log("=".repeat(60));
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log("=".repeat(60));

if (failed > 0) {
  console.log("\nFailed tests:");
  for (const f of failures) console.log(`  ✗ ${f.name}: ${f.error}`);
  process.exit(1);
} else {
  console.log("\n✅ All tests passed!");
  process.exit(0);
}
