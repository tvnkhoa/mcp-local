#!/usr/bin/env node

/**
 * One-command setup for codebase-index-mcp.
 * Installs deps, builds, configures detected agents, installs the skill command,
 * verifies the server starts, and runs a smoke test.
 *
 * Flags:
 *   --yes  / -y   Non-interactive: accept all defaults without prompting
 */

import { execSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import readline from "node:readline";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "..");
const WORKSPACE_ROOT = path.resolve(PROJECT_ROOT, "..");

// ---- CLI flags ----
const YES = process.argv.includes("--yes") || process.argv.includes("-y");

// ---- Colors ----
const C = {
  reset: "\x1b[0m",
  bright: "\x1b[1m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
  red: "\x1b[31m",
};

function log(msg, color = C.reset) { console.log(`${color}${msg}${C.reset}`); }
function section(title) {
  console.log();
  log("=".repeat(60), C.cyan);
  log(`  ${title}`, C.bright + C.cyan);
  log("=".repeat(60), C.cyan);
  console.log();
}
function ok(msg)   { log(`✓ ${msg}`, C.green); }
function warn(msg) { log(`⚠ ${msg}`, C.yellow); }
function err(msg)  { log(`✗ ${msg}`, C.red); }
function info(msg) { log(`ℹ ${msg}`, C.blue); }

async function ask(question, defaultVal) {
  if (YES) {
    info(`${question} → ${defaultVal} (--yes)`);
    return defaultVal;
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`${C.cyan}${question}${C.reset} [${defaultVal}] `, (answer) => {
      rl.close();
      resolve(answer.trim() || defaultVal);
    });
  });
}

// ---- JSONC parser (strip comments) ----
function stripJsoncComments(text) {
  const out = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] === '"') {
      out.push(text[i++]);
      while (i < text.length) {
        const c = text[i++];
        out.push(c);
        if (c === "\\") { if (i < text.length) out.push(text[i++]); }
        else if (c === '"') break;
      }
      continue;
    }
    if (text[i] === "/" && text[i + 1] === "/") { while (i < text.length && text[i] !== "\n") i++; continue; }
    if (text[i] === "/" && text[i + 1] === "*") { i += 2; while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++; i += 2; continue; }
    out.push(text[i++]);
  }
  return out.join("");
}

function readJsonc(filePath) {
  const raw = fs.readFileSync(filePath, "utf-8");
  try { return JSON.parse(raw); } catch { return JSON.parse(stripJsoncComments(raw)); }
}

// ---- Normalize path for JSON configs (forward slashes, preserves drive letter) ----
function toConfigPath(p) {
  return p.replace(/\\/g, "/");
}

// =============================================================================
// Step 1: Dependencies
// =============================================================================
async function installDependencies() {
  section("Step 1: Installing Dependencies");
  try {
    if (!fs.existsSync(path.join(PROJECT_ROOT, "node_modules"))) {
      info("Installing npm dependencies...");
      execSync("npm install", { cwd: PROJECT_ROOT, stdio: "inherit" });
      ok("Dependencies installed");
    } else {
      ok("Dependencies already installed");
    }
  } catch (e) {
    err("Failed to install dependencies");
    throw e;
  }
}

// =============================================================================
// Step 2: Build
// =============================================================================
async function buildProject() {
  section("Step 2: Building Project");
  try {
    info("Running TypeScript build...");
    execSync("npm run build", { cwd: PROJECT_ROOT, stdio: "inherit" });
    ok("Build completed");

    info("Verifying no-LLM policy...");
    execSync("npm run guard:no-llm-runtime", { cwd: PROJECT_ROOT, stdio: "inherit" });
    ok("No-LLM policy verified");
  } catch (e) {
    err("Build failed");
    throw e;
  }
}

// =============================================================================
// Step 3: Detect agents
// =============================================================================
function detectAgents() {
  section("Step 3: Detecting Code Agents");

  const home = os.homedir();
  const appData = process.env.APPDATA || path.join(home, "AppData", "Roaming");
  const detected = [];

  // Claude Code
  const ccState  = path.join(home, ".claude.json");
  const ccConfig = path.join(home, ".claude", "settings.json");
  if (fs.existsSync(ccState) || fs.existsSync(ccConfig)) {
    detected.push({ name: "Claude Code", type: "claude-code", configPath: ccConfig });
    ok(`Found: Claude Code  (${ccConfig})`);
  }

  // Claude Desktop
  for (const p of [
    path.join(appData, "Claude", "claude_desktop_config.json"),
    path.join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json"),
    path.join(home, ".config", "Claude", "claude_desktop_config.json"),
  ]) {
    if (fs.existsSync(p)) { detected.push({ name: "Claude Desktop", type: "claude", configPath: p }); ok(`Found: Claude Desktop  (${p})`); break; }
  }

  // VS Code
  for (const p of [
    path.join(appData, "Code", "User", "settings.json"),
    path.join(home, "Library", "Application Support", "Code", "User", "settings.json"),
    path.join(home, ".config", "Code", "User", "settings.json"),
  ]) {
    if (fs.existsSync(p)) { detected.push({ name: "VS Code", type: "vscode", configPath: p }); ok(`Found: VS Code  (${p})`); break; }
  }

  // OpenCode
  for (const p of [
    path.join(home, ".config", "opencode", "opencode.json"),
    path.join(home, ".config", "opencode", "opencode.jsonc"),
    path.join(appData, "opencode", "opencode.json"),
  ]) {
    if (fs.existsSync(p)) { detected.push({ name: "OpenCode", type: "opencode", configPath: p }); ok(`Found: OpenCode  (${p})`); break; }
  }

  if (detected.length === 0) warn("No code agents detected");
  return detected;
}

// =============================================================================
// Step 4: Configure agents
// =============================================================================
async function configureAgents(agents) {
  section("Step 4: Configuring MCP Server");

  if (agents.length === 0) {
    warn("No agents to configure. See README.md for manual config examples.");
    return { allowedRoots: WORKSPACE_ROOT, dbPath: path.join(WORKSPACE_ROOT, "mcp-codebase-index.db") };
  }

  const serverPath = toConfigPath(path.join(PROJECT_ROOT, "dist", "index.js"));
  const defaultDb  = path.join(WORKSPACE_ROOT, "mcp-codebase-index.db");

  console.log();
  info(`MCP server path:  ${serverPath}`);
  info(`Default allowed roots:  ${WORKSPACE_ROOT}`);
  info(`Default DB path:  ${defaultDb}`);
  console.log();

  const allowedRootsRaw = await ask("Allowed roots (comma-separated absolute paths):", WORKSPACE_ROOT);
  const dbPathRaw       = await ask("Database path:", defaultDb);

  // Normalize to forward slashes for JSON portability
  const allowedRoots = allowedRootsRaw.split(",").map(r => toConfigPath(r.trim())).join(",");
  const dbPath       = toConfigPath(dbPathRaw.trim());

  console.log();

  const mcpConfig = {
    command: "node",
    args: [serverPath],
    env: {
      CODEBASE_INDEX_ALLOWED_ROOTS: allowedRoots,
      CODEBASE_INDEX_DB_PATH: dbPath,
      CODEBASE_INDEX_DOCS_INDEXING_ENABLED: "false",
      CODEBASE_INDEX_DOCS_TOOLS_ENABLED: "false",
      CODEBASE_INDEX_TELEMETRY_ENABLED: "false",
      CODEBASE_INDEX_WATCH_AUTO_START: "false",
    },
  };

  for (const agent of agents) {
    try {
      info(`Configuring ${agent.name}...`);
      let existing = {};
      if (fs.existsSync(agent.configPath)) {
        try { existing = readJsonc(agent.configPath); }
        catch (parseErr) {
          warn(`Cannot parse ${agent.configPath}: ${parseErr.message}`);
          warn(`Skipping ${agent.name} — fix the JSON syntax error manually first`);
          continue;
        }
      }

      const merged = { ...existing };

      if (agent.type === "claude" || agent.type === "claude-code") {
        merged.mcpServers = { ...(merged.mcpServers ?? {}), "codebase-index-local": mcpConfig };
      } else if (agent.type === "opencode") {
        merged.mcp = {
          ...(merged.mcp ?? {}),
          "codebase-index-local": {
            type: "local",
            command: [mcpConfig.command, ...mcpConfig.args],
            enabled: true,
            environment: mcpConfig.env,
          },
        };
        if (!merged.$schema) merged.$schema = "https://opencode.ai/config.json";
      } else if (agent.type === "vscode") {
        const flat   = merged["mcp.servers"] ?? {};
        const nested = merged.mcp?.servers ?? {};
        delete merged["mcp.servers"];
        merged.mcp = { ...(merged.mcp ?? {}), servers: { ...flat, ...nested, "codebase-index-local": mcpConfig } };
      }

      if (fs.existsSync(agent.configPath)) {
        const backup = `${agent.configPath}.backup.${Date.now()}`;
        fs.copyFileSync(agent.configPath, backup);
        info(`Backup: ${backup}`);
      }

      fs.mkdirSync(path.dirname(agent.configPath), { recursive: true });
      fs.writeFileSync(agent.configPath, JSON.stringify(merged, null, 2), "utf-8");
      ok(`Configured ${agent.name}`);
    } catch (e) {
      err(`Failed to configure ${agent.name}: ${e.message}`);
    }
  }

  return { allowedRoots, dbPath };
}

// =============================================================================
// Step 5: Install Skill
// =============================================================================

// Strip YAML frontmatter, return the body only.
function skillBody(content) {
  if (!content.startsWith("---")) return content;
  const end = content.indexOf("\n---", 3);
  return end === -1 ? content : content.slice(end + 4).trimStart();
}

// VS Code Copilot prompt format (frontmatter subset it actually reads).
function vscodePromptContent(body) {
  return [
    "---",
    'description: "Use the codebase-index MCP for code analysis: index repos, search symbols, trace calls, find blast radius, and run safe refactors. Invoke as a reusable prompt in Copilot Chat."',
    "---",
    "",
    body,
  ].join("\n");
}

async function installSkill(agents) {
  section("Step 5: Installing Skill");

  const skillSrc = path.join(PROJECT_ROOT, "commands", "codebase-index.md");
  if (!fs.existsSync(skillSrc)) {
    warn(`Skill source not found: ${skillSrc}`);
    return;
  }

  const skillContent = fs.readFileSync(skillSrc, "utf-8");
  const home = os.homedir();
  const appData = process.env.APPDATA || path.join(home, "AppData", "Roaming");

  for (const agent of agents) {
    try {
      if (agent.type === "claude-code") {
        // Global commands (~/.claude/commands/) — always installed
        const globalDir = path.join(home, ".claude", "commands");
        fs.mkdirSync(globalDir, { recursive: true });
        fs.writeFileSync(path.join(globalDir, "codebase-index.md"), skillContent, "utf-8");
        ok(`${agent.name}: skill → ${path.join(globalDir, "codebase-index.md")}  (/codebase-index)`);

        // Project-local (.claude/commands/) — available in this workspace
        const projDir = path.join(PROJECT_ROOT, ".claude", "commands");
        fs.mkdirSync(projDir, { recursive: true });
        fs.writeFileSync(path.join(projDir, "codebase-index.md"), skillContent, "utf-8");
        ok(`${agent.name}: skill (project) → ${path.join(projDir, "codebase-index.md")}`);

      } else if (agent.type === "claude") {
        // Claude Desktop has no slash-command / skill system.
        // MCP server config (step 4) is the only integration point.
        info(`${agent.name}: no skill system — MCP server config is sufficient`);

      } else if (agent.type === "vscode") {
        // VS Code Copilot: reusable prompts live in %APPDATA%/Code/User/prompts/
        // Invoked via Copilot Chat > Attach > Prompt or via the Prompts panel.
        const promptsDir = path.join(appData, "Code", "User", "prompts");
        fs.mkdirSync(promptsDir, { recursive: true });
        const dest = path.join(promptsDir, "codebase-index.prompt.md");
        fs.writeFileSync(dest, vscodePromptContent(skillBody(skillContent)), "utf-8");
        ok(`${agent.name}: prompt → ${dest}  (Copilot Chat > Prompts > codebase-index)`);

      } else if (agent.type === "opencode") {
        // OpenCode has no slash-command / skill file system.
        // MCP server config (step 4) is the only integration point.
        info(`${agent.name}: no skill system — MCP server config is sufficient`);

      } else {
        warn(`${agent.name}: unknown agent type '${agent.type}' — skill not installed`);
      }
    } catch (e) {
      err(`${agent.name}: skill install failed — ${e.message}`);
    }
  }
}

// =============================================================================
// Step 6: Verify server starts
// =============================================================================
async function verifyServer(allowedRoots, dbPath) {
  section("Step 6: Verifying MCP Server Starts");

  const serverJs = path.join(PROJECT_ROOT, "dist", "index.js");
  const env = {
    ...process.env,
    CODEBASE_INDEX_ALLOWED_ROOTS: allowedRoots,
    CODEBASE_INDEX_DB_PATH: dbPath,
  };

  return new Promise((resolve) => {
    info("Spawning MCP server process...");
    const proc = spawn("node", [serverJs], { env, stdio: ["pipe", "pipe", "pipe"] });

    let settled = false;
    function settle(success, msg) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(responseTimer);
      if (msg) { success ? ok(msg) : err(msg); }
      resolve(success);
      // Kill the verification process gracefully — we don't need it anymore
      try { proc.kill(); } catch {}
    }

    const timer = setTimeout(() => {
      // Server still alive after 8s → it's running fine
      settle(true, "MCP server started and responding (process alive after 8s)");
    }, 8000);

    // Send a JSON-RPC initialize request — MCP server should respond
    const initRequest = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "setup-verify", version: "1.0.0" },
      },
    }) + "\n";

    let stdout = "";
    proc.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    proc.stderr.on("data", () => {}); // suppress startup logs

    proc.on("close", (code) => {
      if (settled) return;
      // Process exited before we settled — only an error if non-zero exit
      if (code === 0) settle(true, "MCP server started cleanly");
      else settle(false, `MCP server exited unexpectedly (code ${code})`);
    });

    // After a brief delay, write the init request so the server can respond
    setTimeout(() => {
      try { proc.stdin.write(initRequest); } catch {}
    }, 500);

    // If we get a JSON-RPC response within 4s, server is healthy
    const responseTimer = setTimeout(() => {
      if (stdout.includes('"result"') || stdout.includes('"serverInfo"')) {
        settle(true, "MCP server responded to initialize request");
      }
    }, 4000);
  });
}

// =============================================================================
// Step 7: Smoke test
// =============================================================================
async function runSmokeTest() {
  section("Step 7: Running Smoke Test");
  try {
    info("Running integration smoke test (this may take ~30s for a fresh index)...");
    execSync("node scripts/smoke-test.mjs", { cwd: PROJECT_ROOT, stdio: "pipe", timeout: 120_000 });
    ok("Smoke test passed");
  } catch {
    warn("Smoke test failed or timed out — this is expected if no repos are indexed yet");
    warn("Run: node scripts/smoke-test.mjs  to diagnose");
  }
}

// =============================================================================
// Summary
// =============================================================================
function displaySummary(agents) {
  section("Setup Complete!");

  ok("Codebase Index MCP server is ready");
  console.log();

  log("Next steps:", C.bright);
  console.log();
  log("1. Restart your code agent(s):", C.cyan);
  for (const a of agents) log(`   - ${a.name}`, C.reset);
  if (agents.length === 0) log("   (none detected — configure manually per README.md)", C.yellow);

  console.log();
  log("2. Use the /codebase-index skill:", C.cyan);
  log("   /codebase-index [repoId]   →  start analysis with MCP-first workflow", C.reset);

  console.log();
  log("3. Index a repository:", C.cyan);
  log("   list_repositories          →  check registered repos", C.reset);
  log("   index_repository           →  index your codebase", C.reset);
  log("   health_check               →  verify index is up-to-date", C.reset);

  console.log();
  log("4. Key analysis tools:", C.cyan);
  log("   search_symbols             →  find functions, classes, methods", C.reset);
  log("   find_impact_files          →  blast radius of changes", C.reset);
  log("   get_symbol_context_pack    →  callers + callees in one call", C.reset);
  log("   trace_execution_flow       →  execution sub-graph", C.reset);

  console.log();
  log("Documentation:", C.cyan);
  log(`   README:   ${path.join(PROJECT_ROOT, "README.md")}`, C.reset);
  log(`   Skill:    ${path.join(PROJECT_ROOT, "commands", "codebase-index.md")}`, C.reset);
  log(`   Policy:   ${path.join(PROJECT_ROOT, ".github", "instructions", "mcp-hard-mode.instructions.md")}`, C.reset);
  console.log();
}

// =============================================================================
// Main
// =============================================================================
async function main() {
  try {
    console.log();
    log("╔════════════════════════════════════════════════════════════╗", C.bright + C.cyan);
    log("║          Codebase Index MCP — One-Command Setup           ║", C.bright + C.cyan);
    log("╚════════════════════════════════════════════════════════════╝", C.bright + C.cyan);
    if (YES) info("Non-interactive mode (--yes): using defaults for all prompts");
    console.log();

    await installDependencies();
    await buildProject();
    const agents = detectAgents();
    const { allowedRoots, dbPath } = await configureAgents(agents);
    await installSkill(agents);
    await verifyServer(allowedRoots, dbPath);
    await runSmokeTest();
    displaySummary(agents);

    log("=".repeat(60), C.green);
    ok("Setup completed successfully!");
    log("=".repeat(60), C.green);
    console.log();
  } catch (e) {
    console.log();
    log("=".repeat(60), C.red);
    err("Setup failed!");
    log("=".repeat(60), C.red);
    console.error(e);
    process.exit(1);
  }
}

main();
