// Detect installed code agents and read/write their MCP server config.
// Generalized from codebase-index-mcp/scripts/setup.mjs (was hardcoded to one server).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readJsonc } from "./jsonc.mjs";
import { ok, warn, err, info } from "./log.mjs";

// Returns [{ name, type, configPath }] for every agent config found on this machine.
// type ∈ "claude-code" | "claude" | "vscode" | "opencode"
export function detectAgents() {
  const home = os.homedir();
  const appData = process.env.APPDATA || path.join(home, "AppData", "Roaming");
  const detected = [];

  // Claude Code — MCP servers live in ~/.claude.json (state), not settings.json.
  const ccState = path.join(home, ".claude.json");
  const ccSettings = path.join(home, ".claude", "settings.json");
  if (fs.existsSync(ccState) || fs.existsSync(ccSettings)) {
    detected.push({ name: "Claude Code", type: "claude-code", configPath: ccState });
  }

  for (const p of [
    path.join(appData, "Claude", "claude_desktop_config.json"),
    path.join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json"),
    path.join(home, ".config", "Claude", "claude_desktop_config.json"),
  ]) {
    if (fs.existsSync(p)) { detected.push({ name: "Claude Desktop", type: "claude", configPath: p }); break; }
  }

  for (const p of [
    path.join(appData, "Code", "User", "settings.json"),
    path.join(home, "Library", "Application Support", "Code", "User", "settings.json"),
    path.join(home, ".config", "Code", "User", "settings.json"),
  ]) {
    if (fs.existsSync(p)) { detected.push({ name: "VS Code", type: "vscode", configPath: p }); break; }
  }

  for (const p of [
    path.join(home, ".config", "opencode", "opencode.json"),
    path.join(home, ".config", "opencode", "opencode.jsonc"),
    path.join(appData, "opencode", "opencode.json"),
  ]) {
    if (fs.existsSync(p)) { detected.push({ name: "OpenCode", type: "opencode", configPath: p }); break; }
  }

  return detected;
}

// One backup per config file per process — a run that writes the same file for
// several servers must not spawn a fresh 56KB backup on every write.
const backedUp = new Set();

function backup(configPath) {
  if (!fs.existsSync(configPath)) return null;
  if (backedUp.has(configPath)) return null;
  const b = `${configPath}.backup.${Date.now()}`;
  fs.copyFileSync(configPath, b);
  backedUp.add(configPath);
  return b;
}

function loadConfig(configPath) {
  if (!fs.existsSync(configPath)) return {};
  return readJsonc(configPath); // throws on unrecoverable syntax error
}

// Write { command, args, env } for `key` into one agent config file.
// mcpConfig: { command:"node", args:[absPath], env:{...} }
export function configureAgent(agent, key, mcpConfig) {
  let existing;
  try {
    existing = loadConfig(agent.configPath);
  } catch (parseErr) {
    warn(`Cannot parse ${agent.configPath}: ${parseErr.message}`);
    warn(`Skipping ${agent.name} — fix the JSON syntax error manually first`);
    return false;
  }

  const merged = { ...existing };

  if (agent.type === "claude" || agent.type === "claude-code") {
    merged.mcpServers = { ...(merged.mcpServers ?? {}), [key]: mcpConfig };
  } else if (agent.type === "opencode") {
    merged.mcp = {
      ...(merged.mcp ?? {}),
      [key]: {
        type: "local",
        command: [mcpConfig.command, ...mcpConfig.args],
        enabled: true,
        environment: mcpConfig.env,
      },
    };
    if (!merged.$schema) merged.$schema = "https://opencode.ai/config.json";
  } else if (agent.type === "vscode") {
    const flat = merged["mcp.servers"] ?? {};
    const nested = merged.mcp?.servers ?? {};
    delete merged["mcp.servers"];
    merged.mcp = { ...(merged.mcp ?? {}), servers: { ...flat, ...nested, [key]: mcpConfig } };
  } else {
    warn(`${agent.name}: unknown agent type '${agent.type}' — skipped`);
    return false;
  }

  const b = backup(agent.configPath);
  if (b) info(`Backup: ${b}`);
  fs.mkdirSync(path.dirname(agent.configPath), { recursive: true });
  fs.writeFileSync(agent.configPath, JSON.stringify(merged, null, 2), "utf-8");
  ok(`Configured ${agent.name}`);
  return true;
}

// Remove `key` from one agent config file. Returns true if something was removed.
export function unconfigureAgent(agent, key) {
  let cfg;
  try {
    cfg = loadConfig(agent.configPath);
  } catch (e) {
    warn(`Cannot parse ${agent.configPath}: ${e.message} — skipped`);
    return false;
  }

  let changed = false;
  const drop = (obj) => {
    if (obj && typeof obj === "object" && key in obj) { delete obj[key]; changed = true; }
  };
  drop(cfg.mcpServers);
  drop(cfg.mcp?.servers);
  drop(cfg.mcp); // opencode places servers directly under .mcp
  drop(cfg["mcp.servers"]);

  if (!changed) return false;

  const b = backup(agent.configPath);
  if (b) info(`Backup: ${b}`);
  fs.writeFileSync(agent.configPath, JSON.stringify(cfg, null, 2), "utf-8");
  ok(`Removed '${key}' from ${agent.name}`);
  return true;
}

// Return the raw server entry for `key` from an agent config (or null). Read-only.
export function readServerEntry(agent, key) {
  let cfg;
  try {
    cfg = loadConfig(agent.configPath);
  } catch {
    return null;
  }
  return (
    cfg.mcpServers?.[key] ??
    cfg.mcp?.servers?.[key] ??
    cfg.mcp?.[key] ??
    cfg["mcp.servers"]?.[key] ??
    null
  );
}

/**
 * Every registration of `key` in an agent config: the canonical entry, plus any
 * environment-suffixed instance (`<key>-<suffix>`).
 *
 * One server run against several backends is a supported pattern, not a misconfiguration — the
 * same build registered twice with different credentials, e.g. `observe-mcp-ssdev_au` and
 * `observe-mcp-wecrm_au_prod`. `readServerEntry` only ever looked for the exact key, so the doctor
 * reported such a server as "not registered", skipped its env check, and then failed `start`
 * because it launched the process with no credentials at all. A healthy install read as broken.
 *
 * Returns `[{ name, entry, suffixed }]`. Callers are expected to REPORT the names they got rather
 * than collapse them to a count: a suffix match is a heuristic, and naming it is what keeps an
 * unrelated entry from being silently absorbed. That matters for the planned S-44 rename of
 * `codebase-index-local` → `codebase-index`, after which the stale old key would match as a
 * "suffixed instance" of the new one — visible if named, invisible if merely counted.
 */
export function readServerEntries(agent, key) {
  let cfg;
  try {
    cfg = loadConfig(agent.configPath);
  } catch {
    return [];
  }
  const buckets = [cfg.mcpServers, cfg.mcp?.servers, cfg.mcp, cfg["mcp.servers"]];
  const found = new Map();
  for (const bucket of buckets) {
    if (!bucket || typeof bucket !== "object") continue;
    for (const name of Object.keys(bucket)) {
      if (name !== key && !name.startsWith(`${key}-`)) continue;
      const entry = bucket[name];
      // `cfg.mcp` also holds non-server settings, so require something server-shaped.
      if (!entry || typeof entry !== "object" || (!entry.command && !entry.args)) continue;
      if (!found.has(name)) found.set(name, { name, entry, suffixed: name !== key });
    }
  }
  // Canonical key first, then suffixed instances in a stable order.
  return [...found.values()].sort((a, b) =>
    a.suffixed === b.suffixed ? a.name.localeCompare(b.name) : (a.suffixed ? 1 : -1)
  );
}
