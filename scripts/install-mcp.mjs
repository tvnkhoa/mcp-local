#!/usr/bin/env node

/**
 * Unified installer for every MCP server in this workspace.
 *
 * For each selected server: install deps → build (+ guards) → detect agents →
 * prompt for env → write MCP config into each agent → generate & install the
 * native Claude Code skill → verify the server starts → smoke test.
 *
 * Usage:
 *   node scripts/install-mcp.mjs                       # all servers, interactive
 *   node scripts/install-mcp.mjs --server postgres-mcp # one server
 *   node scripts/install-mcp.mjs --yes                 # non-interactive (defaults)
 *   node scripts/install-mcp.mjs --skip-smoke          # skip smoke tests
 *   node scripts/install-mcp.mjs --skip-skill          # register MCP config only, write no skill
 *
 * Flags: --server <key> (repeatable), --yes/-y, --skip-smoke, --skip-skill/--no-skill
 *
 * Skills are installed by default: without one the agent has the tools but none of the
 * sequences or guardrails that make them usable. --skip-skill exists for operators who
 * curate ~/.claude themselves; `npm run mcp:update -- --server <key>` installs it later.
 */

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { serverDirPath, serverEntryPath, evaluateEnv } from "./lib/manifest.mjs";
import { toConfigPath } from "./lib/jsonc.mjs";
import { detectAgents, configureAgent, readServerEntry } from "./lib/agents.mjs";
import { installSkill } from "./lib/skills.mjs";
import { verifyServer } from "./lib/verify.mjs";
import { parseArgs, resolveServers } from "./lib/cli.mjs";
import { C, log, section, banner, ok, warn, err, info, step, ask } from "./lib/log.mjs";

const ARGS = parseArgs(process.argv.slice(2), {
  yes: ["--yes", "-y"],
  skipSmoke: ["--skip-smoke"],
  skipSkill: ["--skip-skill", "--no-skill"],
});

// ---- Build ----
function buildServer(server) {
  const dir = serverDirPath(server);
  if (server.build.install && !fs.existsSync(path.join(dir, "node_modules"))) {
    info("Installing npm dependencies...");
    execSync("npm install", { cwd: dir, stdio: "inherit" });
  } else {
    step("Dependencies present");
  }
  info("Building (tsc)...");
  execSync("npm run build", { cwd: dir, stdio: "inherit" });
  for (const guard of server.build.guards) {
    info(`Guard: npm run ${guard}`);
    execSync(`npm run ${guard}`, { cwd: dir, stdio: "inherit" });
  }
  ok("Build complete");
}

/**
 * What this server is configured with right now, across every detected agent.
 *
 * `configureAgent` replaces a server's entry wholesale (`[key]: mcpConfig`), so whatever
 * `collectEnv` returns IS the new env — anything omitted is deleted. Until this existed, `collectEnv`
 * built its answer purely from manifest prompts and defaults, which meant re-running `setup` silently
 * reset every tuned value an operator had set: allowed roots narrowed to the manifest default, docs
 * and telemetry flipped back off, tuning knobs dropped entirely. `mcp:doctor` could not catch it,
 * because it only asserts that required keys are *present* — and they were, at the wrong values.
 *
 * Found the hard way during the S-44 key rename, which is uninstall-then-install and so hit this on
 * every key it touched.
 */
function existingEnvFor(server, agents) {
  const merged = {};
  // Later agents win only for keys earlier ones did not set, so a value is never silently
  // downgraded by an agent that happens to be scanned later.
  for (const agent of agents) {
    const entry = readServerEntry(agent, server.key);
    const env = entry?.env ?? entry?.environment ?? null;
    if (!env) continue;
    for (const [k, v] of Object.entries(env)) {
      if (merged[k] === undefined && typeof v === "string" && v !== "") merged[k] = v;
    }
  }
  return merged;
}

// ---- Collect env values ----
async function collectEnv(server, agents) {
  const env = {};
  const existing = existingEnvFor(server, agents);
  const hasExisting = Object.keys(existing).length > 0;

  if (hasExisting) {
    info(`Found an existing configuration (${String(Object.keys(existing).length)} values) — keeping it unless you change it.`);
  }

  for (const field of server.env) {
    let value = "";
    const current = existing[field.name];
    if (field.prompt) {
      if (field.note) step(field.note);
      // The configured value is the prompt default, not the manifest default: re-running the
      // installer should not require re-typing what is already set correctly.
      value = await ask(
        field.prompt + (field.secret ? " (input stored in agent config)" : ""),
        current ?? field.default ?? "",
        ARGS.yes
      );
    } else if (current !== undefined) {
      value = current;
    } else if (field.default !== undefined) {
      value = field.default;
    }
    if (value) env[field.name] = value;
  }

  // Keys the operator set that the manifest does not declare — e.g. `PGSSLMODE` and
  // `NODE_TLS_REJECT_UNAUTHORIZED` on postgres-mcp, which are libpq's and Node's own names rather
  // than a server's. They are real configuration; dropping them on reinstall would be the same bug
  // in a form no manifest change can prevent.
  const undeclared = Object.keys(existing).filter((k) => !server.env.some((f) => f.name === k));
  for (const k of undeclared) {
    env[k] = existing[k];
  }
  if (undeclared.length > 0) {
    info(`Preserved ${String(undeclared.length)} value(s) not declared in the manifest: ${undeclared.join(", ")}`);
  }

  // Validate required fields + "at least one of" groups using the shared
  // predicate so the installer and doctor never disagree.
  const { missingRequired, unsatisfiedGroups, groupMembers } = evaluateEnv(server, Object.keys(env));
  for (const name of missingRequired) {
    warn(`Required env '${name}' is empty — the server may fail to start.`);
  }
  for (const g of unsatisfiedGroups) {
    const msg = `No value set for group '${g}' (one of: ${groupMembers(g).join(" | ")})`;
    const anyRequired = server.env.some((f) => f.group === g && f.required);
    anyRequired ? warn(msg + " — required for this server to work.") : info(msg + " — leaving unset.");
  }
  return env;
}

// ---- Install one server ----
async function installOne(server, agents) {
  banner(server.displayName);

  section("1/6  Build");
  buildServer(server);

  section("2/6  Environment");
  const env = await collectEnv(server, agents);

  section("3/6  Configure agents");
  if (agents.length === 0) {
    warn("No code agents detected — configure MCP config manually.");
    if (!ARGS.skipSkill) info("The project skill copy under .claude/skills/ is still written.");
  }
  const mcpConfig = {
    command: "node",
    args: [toConfigPath(serverEntryPath(server))],
    env,
  };
  for (const agent of agents) configureAgent(agent, server.key, mcpConfig);

  section("4/6  Install skill");
  if (ARGS.skipSkill) {
    step("Skipped (--skip-skill)");
    info(`Install it later with  npm run mcp:update -- --server ${server.key}`);
  } else {
    try {
      installSkill(server, agents);
    } catch (e) {
      err(`Skill install failed: ${e.message}`);
    }
  }

  section("5/6  Verify server starts");
  const res = await verifyServer(serverEntryPath(server), env);
  res.ok ? ok(`MCP server healthy (${res.message})`) : warn(`Verify: ${res.message}`);

  section("6/6  Smoke test");
  if (ARGS.skipSmoke) {
    step("Skipped (--skip-smoke)");
  } else if (server.smokeTest) {
    try {
      execSync(server.smokeTest, { cwd: serverDirPath(server), env: { ...process.env, ...env }, stdio: "pipe", timeout: 120_000 });
      ok("Smoke test passed");
    } catch {
      warn("Smoke test failed/timed out — may be expected without full config (check the server's scripts/smoke-test.mjs).");
    }
  } else {
    step("No smoke test defined");
  }

  return { key: server.key, verified: res.ok };
}

async function main() {
  banner("MCP Workspace — Unified Installer");
  if (ARGS.yes) info("Non-interactive mode (--yes): using defaults");
  if (ARGS.skipSkill) info("Skill install disabled (--skip-skill): MCP config only");

  const servers = resolveServers(ARGS.servers, { allowAllDefault: true });
  info(`Installing: ${servers.map((s) => s.key).join(", ")}`);
  const agents = detectAgents();
  if (agents.length) {
    for (const a of agents) ok(`Detected agent: ${a.name}  (${a.configPath})`);
  } else {
    warn("No code agents detected");
  }

  const results = [];
  for (const server of servers) {
    try {
      results.push(await installOne(server, agents));
    } catch (e) {
      err(`${server.key}: install failed — ${e.message}`);
      results.push({ key: server.key, verified: false, error: e.message });
    }
  }

  section("Summary");
  for (const r of results) {
    if (r.error) err(`${r.key}: FAILED (${r.error})`);
    else if (r.verified) ok(`${r.key}: installed + verified`);
    else warn(`${r.key}: installed (verify inconclusive — check env)`);
  }
  console.log();
  log("Next steps:", C.bright);
  log("  1. Restart your code agent(s) so the new MCP config + skills load.", C.reset);
  log("  2. Run  npm run mcp:doctor  to confirm everything is healthy.", C.reset);
  if (ARGS.skipSkill) {
    log("  3. Skills were skipped (--skip-skill) — run  npm run mcp:update -- --all  to install them.", C.reset);
  } else {
    log("  3. The AI now auto-loads each server's skill (.claude/skills/<key>/SKILL.md).", C.reset);
  }
  console.log();
}

main().catch((e) => { err("Installer crashed"); console.error(e); process.exit(1); });
