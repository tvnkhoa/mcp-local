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
 * A server registered several times under environment-suffixed keys (`<key>-<suffix>`) is a
 * supported setup, not a misconfiguration. Every instance is named in the [config] line, and
 * [env] and [start] run once per instance, because each carries its own credentials.
 *
 * Usage: node scripts/mcp-doctor.mjs [--server <key>] [--skip-start]
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { serverDirPath, serverEntryPath, evaluateEnv, evaluateEnvValues } from "./lib/manifest.mjs";
import { staleTargets } from "./lib/generate.mjs";
import { toConfigPath } from "./lib/jsonc.mjs";
import { detectAgents, readServerEntries } from "./lib/agents.mjs";
import { verifyServer } from "./lib/verify.mjs";
import { findMissingEnvPaths } from "./lib/envPaths.mjs";
import { parseArgs, resolveServers } from "./lib/cli.mjs";
import { findStaleRunningServers } from "./lib/runningServers.mjs";
import { C, log, section, banner, ok, warn, err, info } from "./lib/log.mjs";

const ARGS = parseArgs(process.argv.slice(2), { skipStart: ["--skip-start"] });
const selected = () => resolveServers(ARGS.servers, { allowAllDefault: true });

const MARK = { pass: `${C.green}PASS${C.reset}`, warn: `${C.yellow}WARN${C.reset}`, fail: `${C.red}FAIL${C.reset}` };

/**
 * Compiled modules in `dist/` with no corresponding source file (backlog B-12).
 *
 * `tsc` does not prune. Rename or move a source file and the old `.js` stays behind, loadable and
 * importable — during S-41 that produced a probe reporting "identical" while it was running the
 * *previous* build. Three documents warn about this in prose; nothing detected it.
 *
 * A warning rather than a failure, and a warning on the doctor rather than a clean build on every
 * `npm run build`: a stale module only matters when something still imports it by path, and paying
 * a full rebuild on every compile to prevent an occasional trap is the wrong trade.
 *
 * Returns `null` when there is no `dist/` at all (the `build` check above already reports that),
 * and paths relative to `dist/`. Only `.js` is considered — `.d.ts` and `.map` orphans are
 * harmless because nothing loads them at runtime.
 */
function findOrphanedDistModules(server) {
  const serverRoot = serverDirPath(server);
  const distRoot = path.join(serverRoot, "dist");
  const srcRoot = path.join(serverRoot, "src");
  if (!fs.existsSync(distRoot) || !fs.existsSync(srcRoot)) return null;

  const orphans = [];
  const walk = (dir) => {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, item.name);
      if (item.isDirectory()) {
        walk(full);
        continue;
      }
      if (!item.name.endsWith(".js")) continue;
      const relative = path.relative(distRoot, full);
      const base = relative.slice(0, -".js".length);
      // A `.js` may come from a `.ts` or, for the odd hand-written helper, a `.js` of its own.
      const hasSource = [".ts", ".tsx", ".js"].some((ext) =>
        fs.existsSync(path.join(srcRoot, `${base}${ext}`))
      );
      if (!hasSource) orphans.push(relative.split(path.sep).join("/"));
    }
  };
  walk(distRoot);
  return orphans.sort();
}

async function checkServer(server, agents) {
  const checks = [];
  const fix = [];

  // build
  const entry = serverEntryPath(server);
  if (fs.existsSync(entry)) checks.push(["build", "pass", "dist/index.js present"]);
  else { checks.push(["build", "fail", "not built"]); fix.push(`cd ${server.dir} && npm run build`); }

  // stale dist (backlog B-12)
  const orphans = findOrphanedDistModules(server);
  if (orphans === null) {
    checks.push(["dist", "warn", "skipped (no dist/ to inspect)"]);
  } else if (orphans.length === 0) {
    checks.push(["dist", "pass", "every dist/*.js has a matching source file"]);
  } else {
    const shown = orphans.slice(0, 5).join(", ");
    const more = orphans.length > 5 ? ` (+${orphans.length - 5} more)` : "";
    checks.push(["dist", "warn", `stale build output: ${shown}${more}`]);
    fix.push(`cd ${server.dir} && rm -rf dist && npm run build`);
  }

  // A live server still running an older build than dist/.
  //
  // The `start` check below spawns a fresh process, so it can only ever confirm that the build on
  // disk works — never that the process the agent is talking to shares it. That blind spot hid a
  // total indexing failure on 2026-08-03; see scripts/lib/runningServers.mjs.
  const staleProcs = findStaleRunningServers(entry, path.join(serverDirPath(server), "dist"));
  if (staleProcs === null) {
    checks.push(["running", "pass", "no build to compare, or process list unavailable"]);
  } else if (staleProcs.length === 0) {
    checks.push(["running", "pass", "no live server is older than dist/"]);
  } else {
    // Expect this after any `npm run build` / `verify:all`, which rewrites every dist file whether
    // or not its content changed — mtime is all we have, since nothing records what the running
    // process loaded. Harmless when the rebuild was a no-op; a total failure when a module moved,
    // which is why it warns rather than staying silent. Never fatal: exit code is unaffected.
    const detail = staleProcs
      .map((p) => `pid ${p.pid} (+${Math.round(p.behindMs / 60_000)} min)`)
      .join(", ");
    checks.push([
      "running",
      "warn",
      `${staleProcs.length} live server(s) started before the current build: ${detail}. ` +
        "Harmless if nothing moved; stale modules if a file was renamed or relocated."
    ]);
    fix.push(`restart the ${server.key} MCP server (/mcp in Claude Code) if you have renamed or moved a module since it started`);
  }

  // config (across all detected agents)
  //
  // A server may be registered more than once: the same build against different backends, under
  // environment-suffixed keys. Each instance carries its own credentials, so env and start are
  // checked per instance below rather than once for the server.
  const entryNorm = toConfigPath(entry);
  let instances = [];
  let agentName = null;
  for (const agent of agents) {
    const found = readServerEntries(agent, server.key);
    if (found.length) { instances = found; agentName = agent.name; break; }
  }
  if (instances.length === 0) {
    checks.push(["config", "warn", "not registered in any detected agent"]);
    fix.push(`node scripts/install-mcp.mjs --server ${server.key}`);
  } else {
    // Windows paths are case-insensitive and drive-letter casing is not stable,
    // so compare case-insensitively after normalizing slashes.
    const mismatched = instances.filter((i) => {
      const args = i.entry.args || i.entry.command; // opencode uses command[]
      const argsStr = Array.isArray(args) ? args.join(" ") : String(args);
      return !argsStr.replace(/\\/g, "/").toLowerCase().includes(entryNorm.toLowerCase());
    });
    // Instances are named, never just counted — see readServerEntries().
    const label = instances.length === 1 && !instances[0].suffixed
      ? `registered in ${agentName}`
      : `registered in ${agentName} as ${instances.map((i) => i.name).join(", ")}`;
    if (mismatched.length === 0) {
      checks.push(["config", "pass", label]);
    } else {
      checks.push(["config", "warn",
        `${label} — args path differs from built entry for: ${mismatched.map((i) => i.name).join(", ")}`]);
      fix.push(`re-run installer to fix args path for ${server.key}`);
    }
  }

  // env (keys only, from whichever config we found — never print values).
  // Uses the same predicate as the installer (manifest.evaluateEnv).
  if (instances.length === 0) {
    checks.push(["env", "warn", "skipped (no config)"]);
  } else {
    for (const inst of instances) {
      const envObj = inst.entry.env || inst.entry.environment || {};
      const presentKeys = Object.keys(envObj).filter((k) => envObj[k] !== "" && envObj[k] != null);
      const { missingRequired, unsatisfiedGroups } = evaluateEnv(server, presentKeys);
      const scope = instances.length === 1 ? "env" : `env ${inst.name}`;
      if (missingRequired.length || unsatisfiedGroups.length) {
        const parts = [];
        if (missingRequired.length) parts.push(`missing: ${missingRequired.join(", ")}`);
        if (unsatisfiedGroups.length) parts.push(`no value for group(s): ${unsatisfiedGroups.join(", ")}`);
        checks.push([scope, "warn", parts.join("; ")]);
      } else {
        checks.push([scope, "pass", "required env keys present"]);
      }

      // Presence was being treated as sufficient. It is not: a config whose keys are all correct and
      // whose VALUES are wrong passed every check here, which is how an install that narrowed
      // CODEBASE_INDEX_ALLOWED_ROOTS and switched the docs lane off was reported healthy.
      //
      // Findings name the variable and the expected shape, never the value — so this stays safe to run
      // over an entry holding tokens, and the "never prints secrets" guarantee in this file's header
      // still holds.
      const shape = evaluateEnvValues(server, envObj);
      const valueScope = instances.length === 1 ? "env values" : `env values ${inst.name}`;

      // The filesystem half, which the manifest deliberately does not do (it is imported by the
      // generators and has no fs access). In `lib/envPaths.mjs` so it is testable — a doctor check that
      // silently does nothing still prints PASS, which is the exact failure mode this work exists to fix.
      const pathProblems = findMissingEnvPaths(server, envObj);

      const allProblems = [...shape.map((f) => `${f.name}: ${f.problem}`), ...pathProblems];
      if (allProblems.length > 0) {
        checks.push([valueScope, "warn", allProblems.join("; ")]);
        fix.push(`review ${inst.name} env values (see .env.example)`);
      } else {
        checks.push([valueScope, "pass", "configured values have the expected shape"]);
      }
    }
  }

  // skill
  const skillPath = path.join(os.homedir(), ".claude", "skills", server.key, "SKILL.md");
  if (fs.existsSync(skillPath)) checks.push(["skill", "pass", "installed (~/.claude/skills)"]);
  else { checks.push(["skill", "warn", "not installed"]); fix.push(`node scripts/install-mcp.mjs --server ${server.key}`); }

  // generated (S-35/S-36) — .env.example and the README's generated blocks are rendered from the
  // manifest, so a mismatch means someone edited the output instead of the source. A warning, not
  // a failure: stale documentation does not stop the server from working, and the doctor's job is
  // to report the state of the installation rather than to gate on it.
  const owned = staleTargets().filter((t) => t.file.startsWith(serverDirPath(server) + path.sep));
  if (owned.length === 0) {
    checks.push(["generated", "pass", ".env.example + README blocks match the manifest"]);
  } else {
    const names = owned.map((t) => path.basename(t.file)).join(", ");
    checks.push(["generated", "warn", `stale: ${names}`]);
    fix.push("npm run generate:all   # then commit the result");
  }

  // start
  if (ARGS.skipStart) {
    checks.push(["start", "warn", "skipped (--skip-start)"]);
  } else if (fs.existsSync(entry)) {
    // Once per instance: a server that needs credentials starts only with the ones its own
    // registration carries, so starting it once with the first instance's env would report a
    // second, differently-credentialed instance as healthy without ever launching it.
    const toStart = instances.length ? instances : [{ name: server.key, entry: {} }];
    for (const inst of toStart) {
      const envObj = inst.entry.env || inst.entry.environment || {};
      const res = await verifyServer(entry, envObj);
      const scope = toStart.length === 1 ? "start" : `start ${inst.name}`;
      checks.push([scope, res.ok ? "pass" : "fail", res.message]);
      if (!res.ok) fix.push(`check ${inst.name} env/config (see .env.example)`);
    }
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
