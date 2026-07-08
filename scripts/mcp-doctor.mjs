#!/usr/bin/env node

/**
 * Health report for every MCP server in the workspace.
 *
 * Per server, checks:
 *   [build]  dist/index.js exists
 *   [config] registered in a detected agent, args path matches the built entry
 *   [env]    required / group env keys are PRESENT (keys only — never prints values)
 *   [skill]  operational skill installed in ~/.claude/skills/<key>/
 *   [start]  server spawns and responds to `initialize`
 *
 * Usage: node scripts/mcp-doctor.mjs [--server <key>] [--skip-start]
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { serverEntryPath, evaluateEnv } from "./lib/manifest.mjs";
import { toConfigPath } from "./lib/jsonc.mjs";
import { detectAgents, readServerEntry } from "./lib/agents.mjs";
import { verifyServer } from "./lib/verify.mjs";
import { parseArgs, resolveServers } from "./lib/cli.mjs";
import { C, log, section, banner, ok, warn, err, info } from "./lib/log.mjs";

const ARGS = parseArgs(process.argv.slice(2), { skipStart: ["--skip-start"] });
const selected = () => resolveServers(ARGS.servers, { allowAllDefault: true });

const MARK = { pass: `${C.green}PASS${C.reset}`, warn: `${C.yellow}WARN${C.reset}`, fail: `${C.red}FAIL${C.reset}` };

async function checkServer(server, agents) {
  const checks = [];
  const fix = [];

  // build
  const entry = serverEntryPath(server);
  if (fs.existsSync(entry)) checks.push(["build", "pass", "dist/index.js present"]);
  else { checks.push(["build", "fail", "not built"]); fix.push(`cd ${server.dir} && npm run build`); }

  // config (across all detected agents)
  const entryNorm = toConfigPath(entry);
  let configured = null, agentName = null;
  for (const agent of agents) {
    const e = readServerEntry(agent, server.key);
    if (e) { configured = e; agentName = agent.name; break; }
  }
  if (!configured) {
    checks.push(["config", "warn", "not registered in any detected agent"]);
    fix.push(`node scripts/install-mcp.mjs --server ${server.key}`);
  } else {
    const args = configured.args || configured.command; // opencode uses command[]
    const argsStr = Array.isArray(args) ? args.join(" ") : String(args);
    // Windows paths are case-insensitive and drive-letter casing is not stable,
    // so compare case-insensitively after normalizing slashes.
    const pathMatches = argsStr.replace(/\\/g, "/").toLowerCase().includes(entryNorm.toLowerCase());
    checks.push(["config", pathMatches ? "pass" : "warn",
      pathMatches ? `registered in ${agentName}` : `registered in ${agentName} but args path differs from built entry`]);
    if (!pathMatches) fix.push(`re-run installer to fix args path for ${server.key}`);
  }

  // env (keys only, from whichever config we found — never print values).
  // Uses the same predicate as the installer (manifest.evaluateEnv).
  if (configured) {
    const envObj = configured.env || configured.environment || {};
    const presentKeys = Object.keys(envObj).filter((k) => envObj[k] !== "" && envObj[k] != null);
    const { missingRequired, unsatisfiedGroups } = evaluateEnv(server, presentKeys);
    if (missingRequired.length || unsatisfiedGroups.length) {
      const parts = [];
      if (missingRequired.length) parts.push(`missing: ${missingRequired.join(", ")}`);
      if (unsatisfiedGroups.length) parts.push(`no value for group(s): ${unsatisfiedGroups.join(", ")}`);
      checks.push(["env", "warn", parts.join("; ")]);
    } else {
      checks.push(["env", "pass", "required env keys present"]);
    }
  } else {
    checks.push(["env", "warn", "skipped (no config)"]);
  }

  // skill
  const skillPath = path.join(os.homedir(), ".claude", "skills", server.key, "SKILL.md");
  if (fs.existsSync(skillPath)) checks.push(["skill", "pass", "installed (~/.claude/skills)"]);
  else { checks.push(["skill", "warn", "not installed"]); fix.push(`node scripts/install-mcp.mjs --server ${server.key}`); }

  // start
  if (ARGS.skipStart) {
    checks.push(["start", "warn", "skipped (--skip-start)"]);
  } else if (fs.existsSync(entry)) {
    const envObj = configured ? (configured.env || configured.environment || {}) : {};
    const res = await verifyServer(entry, envObj);
    checks.push(["start", res.ok ? "pass" : "fail", res.message]);
    if (!res.ok) fix.push(`check ${server.key} env/config (see .env.example)`);
  } else {
    checks.push(["start", "fail", "no entry to start"]);
  }

  return { checks, fix };
}

async function main() {
  banner("MCP Doctor");
  const agents = detectAgents();
  if (agents.length) agents.forEach((a) => info(`Agent: ${a.name}`));
  else warn("No code agents detected — config checks will report WARN");

  const servers = selected();
  const summary = [];

  for (const server of servers) {
    section(server.displayName + `  (${server.key})`);
    const { checks, fix } = await checkServer(server, agents);
    for (const [name, status, msg] of checks) {
      const line = `  ${MARK[status]}  ${name.padEnd(7)} ${msg}`;
      log(line);
    }
    const worst = checks.some((c) => c[1] === "fail") ? "fail"
      : checks.some((c) => c[1] === "warn") ? "warn" : "pass";
    summary.push([server.key, worst]);
    if (fix.length) {
      console.log();
      log("  Suggested fixes:", C.dim);
      [...new Set(fix)].forEach((f) => log(`    • ${f}`, C.dim));
    }
  }

  section("Summary");
  for (const [key, status] of summary) log(`  ${MARK[status]}  ${key}`);
  const anyFail = summary.some((s) => s[1] === "fail");
  process.exit(anyFail ? 1 : 0);
}

main().catch((e) => { err("Doctor crashed"); console.error(e); process.exit(1); });
