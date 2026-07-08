#!/usr/bin/env node

/**
 * Remove one (or all) MCP server(s) from every detected agent config and delete
 * the installed skill. Config files are backed up before editing.
 * Does NOT delete source or dist/.
 *
 * Usage:
 *   node scripts/uninstall-mcp.mjs --server postgres-mcp
 *   node scripts/uninstall-mcp.mjs --all
 */

import { detectAgents, unconfigureAgent } from "./lib/agents.mjs";
import { removeSkill } from "./lib/skills.mjs";
import { parseArgs, resolveServers } from "./lib/cli.mjs";
import { banner, section, ok, warn, err, info } from "./lib/log.mjs";

const ARGS = parseArgs(process.argv.slice(2), { all: ["--all"] });

function main() {
  banner("MCP Uninstall");
  const agents = detectAgents();
  const servers = resolveServers(ARGS.servers, { all: ARGS.all });

  for (const server of servers) {
    section(`Removing ${server.displayName} (${server.key})`);
    let removedFromAny = false;
    for (const agent of agents) {
      if (unconfigureAgent(agent, server.key)) removedFromAny = true;
    }
    if (!removedFromAny) warn("Not present in any detected agent config");
    removeSkill(server.key, agents);
  }

  section("Done");
  ok("Uninstall complete. Restart your code agent(s) so the change takes effect.");
  info("Source and dist/ were left untouched.");
}

main();
