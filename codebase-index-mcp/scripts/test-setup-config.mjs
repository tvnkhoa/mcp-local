#!/usr/bin/env node

/**
 * Tests that setup.mjs generates correct MCP configurations for each agent type.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SERVER_PATH = path.join(__dirname, "..", "dist", "index.js");

console.log("Testing setup script configuration generation...\n");

const MOCK_ENV = {
  CODEBASE_INDEX_ALLOWED_ROOTS: "/test/repo",
  CODEBASE_INDEX_DB_PATH: "/test/index.db",
  CODEBASE_INDEX_DOCS_INDEXING_ENABLED: "false",
  CODEBASE_INDEX_DOCS_TOOLS_ENABLED: "false",
  CODEBASE_INDEX_TELEMETRY_ENABLED: "false",
  CODEBASE_INDEX_WATCH_AUTO_START: "false",
};

const BASE_SERVER = {
  command: "node",
  args: [SERVER_PATH],
  env: MOCK_ENV,
};

/**
 * Mirrors the config generation logic in setup.mjs configureAgents().
 */
function buildConfig(agentType, existingConfig = {}) {
  const merged = { ...existingConfig };

  if (agentType === "claude" || agentType === "claude-code") {
    merged.mcpServers = { ...(merged.mcpServers ?? {}), "codebase-index-local": BASE_SERVER };
  } else if (agentType === "opencode") {
    merged.mcp = {
      ...(merged.mcp ?? {}),
      "codebase-index-local": {
        type: "local",
        command: [BASE_SERVER.command, ...BASE_SERVER.args],
        enabled: true,
        environment: BASE_SERVER.env,
      },
    };
    if (!merged.$schema) {
      merged.$schema = "https://opencode.ai/config.json";
    }
  } else if (agentType === "vscode") {
    const flatServers = merged["mcp.servers"] ?? {};
    const nestedServers = merged.mcp?.servers ?? {};
    delete merged["mcp.servers"];
    merged.mcp = {
      ...(merged.mcp ?? {}),
      servers: { ...flatServers, ...nestedServers, "codebase-index-local": BASE_SERVER },
    };
  }

  return merged;
}

// ---------------------------------------------------------------------------
// Test cases
// ---------------------------------------------------------------------------
const tests = [
  {
    name: "Claude Code — correct shape",
    agentType: "claude-code",
    check(config) {
      const server = config?.mcpServers?.["codebase-index-local"];
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
      const server = config?.mcpServers?.["codebase-index-local"];
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
      const server = config?.mcp?.servers?.["codebase-index-local"];
      assert(server, 'mcp.servers[codebase-index-local] should exist');
      assert(server.command === "node", 'command should be "node"');
      assert(Array.isArray(server.args), "args should be an array");
      assert(server.env?.CODEBASE_INDEX_ALLOWED_ROOTS, "env should be set");
    },
  },
  {
    name: "OpenCode — correct shape",
    agentType: "opencode",
    check(config) {
      const server = config?.mcp?.["codebase-index-local"];
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
      assert(config.mcpServers["codebase-index-local"], "new server should be added");
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
      assert(config.mcp?.servers?.["codebase-index-local"], "new server should be added");
    },
  },
  {
    name: "VS Code — merges with existing nested mcp.servers",
    agentType: "vscode",
    existing: { mcp: { servers: { "existing-server": { command: "other", args: [] } } }, "editor.tabSize": 2 },
    check(config) {
      assert(config["editor.tabSize"] === 2, "existing settings should be preserved");
      assert(config.mcp?.servers?.["existing-server"], "existing nested server should be preserved");
      assert(config.mcp?.servers?.["codebase-index-local"], "new server should be added");
    },
  },
  {
    name: "OpenCode — merges with existing mcp entries",
    agentType: "opencode",
    existing: { mcp: { "other-server": { type: "local", command: ["other"], enabled: true, environment: {} } } },
    check(config) {
      assert(config.mcp["other-server"], "existing mcp entries should be preserved");
      assert(config.mcp["codebase-index-local"], "new server should be added");
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
  for (const f of failures) {
    console.log(`  ✗ ${f.name}: ${f.error}`);
  }
  process.exit(1);
} else {
  console.log("\n✅ All tests passed!");
  process.exit(0);
}
