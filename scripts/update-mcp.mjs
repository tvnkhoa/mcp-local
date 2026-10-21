#!/usr/bin/env node

/**
 * Update one (or all) MCP server(s) in place: rebuild → re-point an already-registered
 * entry at this checkout → regenerate & reinstall the skill → verify the server starts.
 * Does not change any env VALUE you configured, and does not register a server that is not
 * registered (that is `mcp:install`). It does rename a deprecated env KEY to its canonical name,
 * moving the value across unread (docs/reference/conventions.md, env-var naming).
 *
 * Placement is kept, never chosen: registrations are refreshed where they are (user scope, Claude
 * Code local scope, a repo's .mcp.json) and the skill is re-rendered where it is installed. A skill
 * moved into a repo's .claude/skills/ is NOT put back into ~/.claude/skills/. Only when no skill is
 * installed anywhere does update write one, at the placement `mcp:install` would default to.
 *
 * Usage:
 *   node scripts/update-mcp.mjs --server observe-mcp
 *   node scripts/update-mcp.mjs --all
 *   Flags: --skip-build (use the dist/ already there), --repo <path> (also look in this repo)
 */

import { execSync } from "node:child_process";
import path from "node:path";
import { WORKSPACE_ROOT, deprecatedEnvInUse, serverDirPath, serverEntryPath } from "./lib/manifest.mjs";
import { toConfigPath } from "./lib/jsonc.mjs";
import {
  detectAgents, projectMcpJson, readLocalEntries, readServerEntries, refreshServerPath, renameEnvKeys,
} from "./lib/agents.mjs";
import { installSkill } from "./lib/skills.mjs";
import { candidateRepos, findPlacements, planPlacement, repoBoundValue } from "./lib/placement.mjs";
import { verifyServer } from "./lib/verify.mjs";
import { parseArgs, resolveServers } from "./lib/cli.mjs";
import { banner, section, ok, warn, err, info, step } from "./lib/log.mjs";

const ARGS = parseArgs(process.argv.slice(2), { all: ["--all"], skipBuild: ["--skip-build"] }, { repo: ["--repo"] });

/**
 * Every config target that may hold a registration of `server`, with how to search it:
 * each agent's root buckets, Claude Code's per-project buckets, and each candidate repo's .mcp.json.
 */
function registrationTargets(server, agents) {
  const targets = agents.map((agent) => ({ agent, opts: {} }));
  const cc = agents.find((a) => a.type === "claude-code");
  if (cc) targets.push({ agent: cc, opts: { local: true } });
  for (const repo of candidateRepos(server, agents, ARGS.repo ? [ARGS.repo] : [])) {
    const agent = projectMcpJson(repo);
    if (readServerEntries(agent, server.key).length) targets.push({ agent, opts: {} });
  }
  return targets;
}

// Recover the env the server was configured with, so verify uses real values.
//
// Falls back to the first environment-suffixed instance when the canonical key is not registered:
// a server run against several backends (`<key>-<suffix>`) has no entry under the bare key, and
// verifying it with an empty env would fail on missing credentials rather than on anything real.
// Any instance's credentials are enough here, because this only needs the server to start.
function existingEnv(agents, server) {
  const key = server.key;
  for (const agent of agents) {
    const found = readServerEntries(agent, key);
    if (found.length) return found[0].entry.env || found[0].entry.environment || {};
  }
  // A server registered only at local or project scope.
  const cc = agents.find((a) => a.type === "claude-code");
  const local = cc ? readLocalEntries(cc, key) : [];
  if (local.length) return local[0].entry.env || {};
  for (const { agent } of registrationTargets(server, agents)) {
    const found = readServerEntries(agent, key);
    if (found.length) return found[0].entry.env || {};
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
  for (const { agent, opts } of registrationTargets(server, agents)) {
    const names = refreshServerPath(agent, server.key, entry, suffix, opts);
    if (names.length) ok(`${agent.name}${opts.local ? " (local scope)" : ""}: re-pointed ${names.join(", ")} at ${entry}`);
  }
}

/**
 * Rename deprecated env keys in this server's registrations. A former name keeps working at
 * runtime, so nothing forces the edit — which is why the doctor warns and this does it. Values are
 * moved, never read for display; a canonical key that is already set wins and the old one goes.
 */
function migrateEnvNames(server, agents) {
  for (const { agent, opts } of registrationTargets(server, agents)) {
    for (const { name, renamed } of renameEnvKeys(agent, server.key, (keys) => deprecatedEnvInUse(server, keys), opts)) {
      ok(`${agent.name}: ${name} env renamed: ${renamed.map((r) => `${r.legacy} → ${r.canonical}`).join(", ")}`);
    }
  }
}

/**
 * Re-render the skill exactly where it is installed. Nothing is moved: a project copy stays in its
 * repo, and a user-tier copy is written only if one exists already — or, when the skill is not
 * installed anywhere, at the placement `mcp:install` would default to (never a guessed repo).
 */
function refreshSkill(server, agents) {
  const repos = candidateRepos(server, agents, ARGS.repo ? [ARGS.repo] : []);
  const existing = findPlacements(server, { agents, repos });
  const project = existing.skills.filter((s) => s.scope === "project");
  const user = existing.skills.filter((s) => s.scope === "user");
  for (const s of project) installSkill(server, agents, { skill: "project", repo: s.repo });
  if (user.length) installSkill(server, agents, { skill: "user" });
  if (project.length || user.length) return;

  const envRepo = repoBoundValue(server, existing.registrations.map((r) => r.entry));
  const plan = planPlacement(server, { existing, envRepo, cwd: null });
  if (plan.skill === "user") {
    installSkill(server, agents, { skill: "user" });
  } else if (plan.repo) {
    info(`No skill installed — writing it into ${toConfigPath(plan.repo)}/.claude/skills/, where ${server.key} is registered.`);
    installSkill(server, agents, { skill: "project", repo: plan.repo });
  } else {
    info(`No skill installed and no repo known for ${server.key} — install it with  node scripts/install-mcp.mjs --server ${server.key} --skill project --repo <path>`);
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
      if (ARGS.skipBuild) {
        step("Build skipped (--skip-build)");
      } else {
        info("Rebuilding...");
        execSync("npm run build", { cwd: dir, stdio: "inherit" });
        for (const guard of server.build.guards) {
          info(`Guard: npm run ${guard}`);
          execSync(`npm run ${guard}`, { cwd: dir, stdio: "inherit" });
        }
        ok("Rebuilt");
      }

      refreshRegistrations(server, agents);
      migrateEnvNames(server, agents);
      refreshSkill(server, agents);

      const env = existingEnv(agents, server);
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
