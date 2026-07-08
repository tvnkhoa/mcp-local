#!/usr/bin/env node

/**
 * Update one (or all) MCP server(s) in place: rebuild → regenerate & reinstall
 * the skill → verify the server starts. Does NOT change any env you already
 * configured in your agent config.
 *
 * Usage:
 *   node scripts/update-mcp.mjs --server observe-mcp
 *   node scripts/update-mcp.mjs --all
 */

import { execSync } from "node:child_process";
import { serverDirPath, serverEntryPath } from "./lib/manifest.mjs";
import { detectAgents, readServerEntry } from "./lib/agents.mjs";
import { installSkill } from "./lib/skills.mjs";
import { verifyServer } from "./lib/verify.mjs";
import { parseArgs, resolveServers } from "./lib/cli.mjs";
import { banner, section, ok, warn, err, info, step } from "./lib/log.mjs";

const ARGS = parseArgs(process.argv.slice(2), { all: ["--all"] });

// Recover the env the server was configured with, so verify uses real values.
function existingEnv(agents, key) {
  for (const agent of agents) {
    const e = readServerEntry(agent, key);
    if (e) return e.env || e.environment || {};
  }
  return {};
}

async function main() {
  banner("MCP Update");
  const agents = detectAgents();
  const servers = resolveServers(ARGS.servers, { all: ARGS.all });

  for (const server of servers) {
    section(`Updating ${server.displayName} (${server.key})`);
    const dir = serverDirPath(server);
    try {
      info("Rebuilding...");
      execSync("npm run build", { cwd: dir, stdio: "inherit" });
      for (const guard of server.build.guards) {
        info(`Guard: npm run ${guard}`);
        execSync(`npm run ${guard}`, { cwd: dir, stdio: "inherit" });
      }
      ok("Rebuilt");

      installSkill(server, agents);

      const env = existingEnv(agents, server.key);
      const res = await verifyServer(serverEntryPath(server), env);
      res.ok ? ok(`Verified (${res.message})`) : warn(`Verify inconclusive: ${res.message}`);
    } catch (e) {
      err(`${server.key}: update failed — ${e.message}`);
    }
  }

  section("Done");
  ok("Update complete. Restart your code agent(s) so rebuilt servers + skills reload.");
}

main().catch((e) => { err("Update crashed"); console.error(e); process.exit(1); });
