#!/usr/bin/env node
/**
 * Run one npm script across every MCP server (migration-plan step S-04).
 *
 * The servers are deliberately NOT npm workspace members — they carry native
 * dependencies (`better-sqlite3`, `tree-sitter`) whose builds must not be
 * hoisted or deduplicated — so `npm run --workspaces` cannot reach them. This is
 * the equivalent, driven by `scripts/lib/manifest.mjs` so a newly registered
 * server is covered without editing anything here.
 *
 * Usage:
 *   node scripts/run-servers.mjs build
 *   node scripts/run-servers.mjs test --continue     # run all, then report
 *   node scripts/run-servers.mjs smoke --server postgres-mcp
 *   node scripts/run-servers.mjs install             # npm ci in each server
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { SERVERS } from "./lib/manifest.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const script = argv.find((arg) => !arg.startsWith("--"));
/** Keep going after a failure so one run reports every broken server, not just the first. */
const CONTINUE = argv.includes("--continue");
const only = (() => {
  const i = argv.indexOf("--server");
  return i === -1 ? null : argv[i + 1];
})();

if (script === undefined) {
  console.error("usage: node scripts/run-servers.mjs <script> [--continue] [--server <key>]");
  process.exit(2);
}

const targets = SERVERS.filter((s) => only === null || s.key === only || s.dir === only);
if (targets.length === 0) {
  console.error(`No server matched "${only}". Known: ${SERVERS.map((s) => s.key).join(", ")}`);
  process.exit(2);
}

const npm = process.platform === "win32" ? "npm.cmd" : "npm";

/** `install` is not a package script — it is `npm ci`, with a fallback. */
function argsFor(server, cwd) {
  if (script !== "install") return ["run", script];
  return fs.existsSync(path.join(cwd, "package-lock.json")) ? ["ci"] : ["install"];
}

const failures = [];
const skipped = [];
const started = Date.now();

for (const server of targets) {
  const cwd = path.join(ROOT, server.dir);
  const pkgPath = path.join(cwd, "package.json");
  if (!fs.existsSync(pkgPath)) {
    console.error(`FAIL ${server.key} — no package.json at ${server.dir}`);
    failures.push(server.key);
    if (!CONTINUE) break;
    continue;
  }

  if (script !== "install") {
    const scripts = JSON.parse(fs.readFileSync(pkgPath, "utf8")).scripts ?? {};
    if (!(script in scripts)) {
      // Reported, never silent: a missing script is the drift this exists to catch.
      console.log(`skip ${server.key.padEnd(22)} no "${script}" script`);
      skipped.push(server.key);
      continue;
    }
  }

  console.log(`\n=== ${server.key}: ${script} ===`);
  const t0 = Date.now();
  const result = spawnSync(npm, argsFor(server, cwd), {
    cwd,
    stdio: "inherit",
    shell: process.platform === "win32"
  });
  const elapsed = `${((Date.now() - t0) / 1000).toFixed(1)}s`;

  if (result.status === 0) {
    console.log(`--- ${server.key}: ${script} ok (${elapsed})`);
    continue;
  }
  console.error(`--- ${server.key}: ${script} FAILED (${elapsed})`);
  failures.push(server.key);
  if (!CONTINUE) break;
}

const total = `${((Date.now() - started) / 1000).toFixed(1)}s`;
const ran = targets.length - skipped.length;
console.log(`\n${ran - failures.length}/${ran} server(s) ok for "${script}" in ${total}`);
if (skipped.length > 0) console.log(`skipped: ${skipped.join(", ")}`);

if (failures.length > 0) {
  console.error(`failed: ${failures.join(", ")}`);
  process.exit(1);
}
