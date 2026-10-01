#!/usr/bin/env node

/**
 * Update one (or all) MCP server(s) in place: rebuild → re-point an already-registered
 * entry at this checkout → regenerate & reinstall the skill → verify the server starts.
 * Does NOT change any env you already configured in your agent config, and does not
 * register a server that is not registered (that is `mcp:install`).
 *
 * Usage:
 *   node scripts/update-mcp.mjs --server observe-mcp
 *   node scripts/update-mcp.mjs --all
 */

import { execSync } from "node:child_process";
import path from "node:path";
import { WORKSPACE_ROOT, serverDirPath, serverEntryPath } from "./lib/manifest.mjs";
import { toConfigPath } from "./lib/jsonc.mjs";
import { detectAgents, readServerEntries, refreshServerPath } from "./lib/agents.mjs";
import { installSkill } from "./lib/skills.mjs";
import { verifyServer } from "./lib/verify.mjs";
import { parseArgs, resolveServers } from "./lib/cli.mjs";
import { banner, section, ok, warn, err, info, step } from "./lib/log.mjs";

const ARGS = parseArgs(process.argv.slice(2), { all: ["--all"] });

// Recover the env the server was configured with, so verify uses real values.
//
// Falls back to the first environment-suffixed instance when the canonical key is not registered:
// a server run against several backends (`<key>-<suffix>`) has no entry under the bare key, and
// verifying it with an empty env would fail on missing credentials rather than on anything real.
// Any instance's credentials are enough here, because this only needs the server to start.
function existingEnv(agents, key) {
  for (const agent of agents) {
    const found = readServerEntries(agent, key);
    if (found.length) return found[0].entry.env || found[0].entry.environment || {};
  }
  return {};
}

/**
 * Re-point registrations whose launch path is this server's entry in an older checkout (P4e).
 *
 * Only install used to write `args`, so moving the workspace left every agent launching a
 * `dist/index.js` that no longer existed — and `update`, the command you run after a move, did not
 * fix it. This rewrites that one path element and nothing else: env is not read, not merged and
 * not re-prompted, so a tuned or credential-bearing entry survives byte-for-byte apart from it.
 */
function refreshRegistrations(server, agents) {
  const entry = toConfigPath(serverEntryPath(server));
  const suffix = toConfigPath(path.relative(WORKSPACE_ROOT, serverEntryPath(server)));
  for (const agent of agents) {
    const names = refreshServerPath(agent, server.key, entry, suffix);
    if (names.length) ok(`${agent.name}: re-pointed ${names.join(", ")} at ${entry}`);
  }
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

      refreshRegistrations(server, agents);
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
