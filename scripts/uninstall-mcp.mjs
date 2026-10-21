#!/usr/bin/env node

/**
 * Remove one (or all) MCP server(s) from every scope it is registered in and delete the installed
 * skill. Config files are backed up before editing (a repo's .mcp.json is not: git is its history).
 * Does NOT delete source or dist/.
 *
 * Scopes (see scripts/install-mcp.mjs): `user` — every detected agent's config plus the user-tier
 * skill (~/.claude/skills/<key>/ and the workspace copy); `local` — Claude Code's
 * projects["<repo>"] entries; `project` — <repo>/.mcp.json. A skill in <repo>/.claude/skills/<key>/
 * goes with `local` and `project`. Without --scope, all three.
 *
 * Usage:
 *   node scripts/uninstall-mcp.mjs --server postgres-mcp
 *   node scripts/uninstall-mcp.mjs --all
 *   node scripts/uninstall-mcp.mjs --server board-mcp --scope local --repo D:/x/wec.aria
 *   node scripts/uninstall-mcp.mjs --key codebase-index-local     # a key the manifest no longer has
 *
 * Flags: --server <key> | --all | --key <raw key>, --scope user|local|project, --repo <path>
 * (limit local/project removal to one repo; default: every repo Claude Code knows of).
 */

import path from "node:path";
import { detectAgents, projectMcpJson, unconfigureAgent, unconfigureLocal } from "./lib/agents.mjs";
import { removeSkill } from "./lib/skills.mjs";
import { SCOPES, candidateRepos, isWorkspaceCheckout } from "./lib/placement.mjs";
import { parseArgs, resolveServers } from "./lib/cli.mjs";
import { banner, section, ok, warn, err, info } from "./lib/log.mjs";

const ARGS = parseArgs(process.argv.slice(2), { all: ["--all"] }, { scope: ["--scope"], repo: ["--repo"] });

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

/**
 * Remove `key` from the selected scopes. `server` is the manifest entry when there is one (it
 * names the repo-bound env var used to find the repo); a raw `--key` has none.
 */
function removeEverywhere(key, server, agents, scopes) {
  let removedFromAny = false;
  const repos = ARGS.repo
    ? [path.resolve(ARGS.repo)]
    : candidateRepos(server ?? { key }, agents);

  if (scopes.includes("user")) {
    for (const agent of agents) {
      if (unconfigureAgent(agent, key)) removedFromAny = true;
    }
    removeSkill(key, agents, { scopes: ["user"] });
  }
  if (scopes.includes("local")) {
    const cc = agents.find((a) => a.type === "claude-code");
    if (cc && unconfigureLocal(cc, key, ARGS.repo ? path.resolve(ARGS.repo) : null).length) removedFromAny = true;
  }
  if (scopes.includes("project")) {
    for (const repo of repos) {
      if (unconfigureAgent(projectMcpJson(repo), key)) {
        removedFromAny = true;
        info(`  ${path.join(repo, ".mcp.json")} changed — if that repo commits it, commit the change there.`);
      }
    }
  }
  if (scopes.includes("local") || scopes.includes("project")) {
    // A workspace checkout's .claude/skills/ is the user tier's copy, handled with `user` above.
    removeSkill(key, agents, { scopes: ["project"], repos: repos.filter((r) => !isWorkspaceCheckout(r)) });
  }
  if (!removedFromAny) warn(`'${key}' was not registered in the selected scope(s): ${scopes.join(", ")}`);
}

function main() {
  banner("MCP Uninstall");
  if (ARGS.scope && !SCOPES.includes(ARGS.scope)) {
    err(`--scope must be one of: ${SCOPES.join(", ")}`);
    process.exit(1);
  }
  const scopes = ARGS.scope ? [ARGS.scope] : SCOPES;
  const agents = detectAgents();
  const keys = rawKeys(process.argv.slice(2));

  for (const key of keys) {
    section(`Removing stale key '${key}' (not resolved through the manifest)`);
    removeEverywhere(key, null, agents, scopes);
  }

  // Only resolve servers when a --server/--all was actually given, so `--key` alone does not
  // trip the "no target" error.
  if (keys.length === 0 || ARGS.servers.length > 0 || ARGS.all) {
    const servers = resolveServers(ARGS.servers, { all: ARGS.all });
    for (const server of servers) {
      section(`Removing ${server.displayName} (${server.key})`);
      removeEverywhere(server.key, server, agents, scopes);
    }
  }

  section("Done");
  ok("Uninstall complete. Restart your code agent(s) so the change takes effect.");
  info("Source and dist/ were left untouched.");
}

main();
