#!/usr/bin/env node

/**
 * Remove one (or all) MCP server(s) from every detected agent config and delete
 * the installed skill. Config files are backed up before editing.
 * Does NOT delete source or dist/.
 *
 * Usage:
 *   node scripts/uninstall-mcp.mjs --server postgres-mcp
 *   node scripts/uninstall-mcp.mjs --all
 *   node scripts/uninstall-mcp.mjs --key codebase-index-local     # a key the manifest no longer has
 */

import { detectAgents, unconfigureAgent } from "./lib/agents.mjs";
import { removeSkill } from "./lib/skills.mjs";
import { parseArgs, resolveServers } from "./lib/cli.mjs";
import { banner, section, ok, warn, err, info } from "./lib/log.mjs";

const ARGS = parseArgs(process.argv.slice(2), { all: ["--all"] });

/**
 * Raw keys to remove, bypassing manifest resolution.
 *
 * `--server` resolves through `@mcp/manifest`, which is right for a normal uninstall and useless
 * for the one case that needs it most: a key that was *renamed*. S-44 changed
 * `codebase-index-local` to `codebase-index`, and at that moment `--server codebase-index-local`
 * started failing with "Unknown server" — so the tool could not clean up after its own rename, and
 * the old entry would have been left registered alongside the new one. Two entries pointing at the
 * same build means two processes on one SQLite database.
 *
 * Deliberately a separate flag rather than a fallback for an unrecognised `--server`: silently
 * accepting any string would turn a typo into a no-op that reports success.
 */
function rawKeys(argv) {
  const keys = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--key" && argv[i + 1]) {
      keys.push(argv[i + 1]);
      i += 1;
    }
  }
  return keys;
}

function main() {
  banner("MCP Uninstall");
  const agents = detectAgents();
  const keys = rawKeys(process.argv.slice(2));

  for (const key of keys) {
    section(`Removing stale key '${key}' (not resolved through the manifest)`);
    let removedFromAny = false;
    for (const agent of agents) {
      if (unconfigureAgent(agent, key)) removedFromAny = true;
    }
    if (!removedFromAny) warn(`'${key}' was not present in any detected agent config`);
    removeSkill(key, agents);
  }

  // Only resolve servers when a --server/--all was actually given, so `--key` alone does not
  // trip the "no target" error.
  if (keys.length === 0 || ARGS.servers.length > 0 || ARGS.all) {
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
  }

  section("Done");
  ok("Uninstall complete. Restart your code agent(s) so the change takes effect.");
  info("Source and dist/ were left untouched.");
}

main();
