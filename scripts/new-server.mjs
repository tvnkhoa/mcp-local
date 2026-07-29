#!/usr/bin/env node
/**
 * Scaffold a new MCP server from `templates/server/` (S-38).
 *
 * The concrete deliverable behind "easy scalability": adding server #5 should be one command, not
 * an exercise in copying the smallest existing server and hoping you caught every convention.
 *
 *   npm run new:server -- --key scratch
 *   npm run new:server -- --key scratch --dir scratch-mcp --display "Scratch MCP" --no-verify
 *
 * What it does NOT do, deliberately: register the server in `@mcp/manifest`. That is a separate,
 * reviewed decision, and it has an ordering constraint the scaffold cannot satisfy on its own —
 * `servers.ts` throws for a server with no generated tool list, the tool list comes from
 * `contracts/`, and a contract snapshot needs a built server. So the sequence is: scaffold, build,
 * snapshot, register, generate. The generated README spells it out.
 *
 * It also means a scaffolded-but-unregistered server cannot break `verify:all`, and deleting the
 * directory needs no cleanup anywhere else.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import url from "node:url";

import { banner, err, info, ok, section, step, warn } from "./lib/log.mjs";

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");
const TEMPLATE = path.join(ROOT, "templates", "server");

function parse(argv) {
  const out = { verify: true };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--no-verify") out.verify = false;
    else if (arg === "--force") out.force = true;
    else if (arg.startsWith("--")) {
      out[arg.slice(2)] = argv[i + 1];
      i += 1;
    }
  }
  return out;
}

const ARGS = parse(process.argv.slice(2));

if (!ARGS.key) {
  err("Missing --key.");
  info('Usage: npm run new:server -- --key scratch [--dir scratch-mcp] [--display "Scratch MCP"]');
  process.exit(2);
}

// The key becomes an MCP registration key and a directory name, and clients namespace tools with
// it (`mcp__<key>__<tool>`). Anything outside this set is user-visible breakage, not style.
const rawKey = String(ARGS.key).trim();
if (!/^[a-z][a-z0-9-]*$/.test(rawKey)) {
  err(`Invalid --key "${rawKey}": lowercase letters, digits and hyphens only, starting with a letter.`);
  process.exit(2);
}

const key = rawKey.endsWith("-mcp") ? rawKey : `${rawKey}-mcp`;
const dir = ARGS.dir ?? key;
const base = key.replace(/-mcp$/, "");
const camel = base.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase());
const pascal = camel.charAt(0).toUpperCase() + camel.slice(1);
const display = ARGS.display ?? `${pascal} MCP`;
const envPrefix = base.replace(/-/g, "_").toUpperCase();
const desc = ARGS.desc ?? `${display} server.`;

const target = path.join(ROOT, dir);

const REPLACEMENTS = [
  ["__KEY__", key],
  ["__DIR__", dir],
  ["__PASCAL__", pascal],
  ["__CAMEL__", camel],
  ["__DISPLAY__", display],
  ["__ENV_PREFIX__", envPrefix],
  ["__DESC__", desc]
];

function render(text) {
  let out = text;
  for (const [token, value] of REPLACEMENTS) out = out.replaceAll(token, value);
  return out;
}

function copyTree(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dest = path.join(to, render(entry.name));
    if (entry.isDirectory()) {
      copyTree(src, dest);
      continue;
    }
    fs.writeFileSync(dest, render(fs.readFileSync(src, "utf8")), "utf8");
  }
}

function run(command, args, cwd) {
  execFileSync(command, args, { cwd, stdio: "pipe", shell: process.platform === "win32" });
}

banner(`New server: ${key}`);

if (!fs.existsSync(TEMPLATE)) {
  err(`Template missing: ${path.relative(ROOT, TEMPLATE)}`);
  process.exit(1);
}
if (fs.existsSync(target) && ARGS.force !== true) {
  err(`${dir}/ already exists. Pass --force to overwrite, or pick another --key.`);
  process.exit(1);
}

section("Scaffold");
copyTree(TEMPLATE, target);
ok(`${dir}/ created from templates/server`);
info(`key=${key}  env prefix=${envPrefix}_*  config type=${pascal}Config`);

if (ARGS.verify === false) {
  warn("Skipped install/build/test (--no-verify).");
} else {
  // The packages resolve through `file:` links, so they must be built before the server compiles
  // against them. On a fresh clone they are not.
  section("Build platform packages");
  run("npm", ["run", "build:packages"], ROOT);
  ok("packages built");

  section("Install, build, test, smoke");
  for (const [label, args] of [
    ["npm install", ["install"]],
    ["build", ["run", "build"]],
    ["typecheck", ["run", "typecheck"]],
    ["test", ["run", "test"]],
    ["smoke", ["run", "smoke"]]
  ]) {
    step(label);
    try {
      // The scaffold's own config requires one var; supply it so `smoke` can boot unattended.
      const env = { ...process.env, [`${envPrefix}_BASE_URL`]: "https://scaffold.invalid" };
      execFileSync("npm", args, {
        cwd: target,
        stdio: "pipe",
        shell: process.platform === "win32",
        env
      });
      ok(label);
    } catch (error) {
      err(`${label} failed`);
      console.error(String(error.stdout ?? "") + String(error.stderr ?? ""));
      process.exit(1);
    }
  }
}

section("Next");
info("The server is NOT registered yet. In this order:");
console.log(`
  1. node scripts/contract-snapshot.mjs --server ${key}
       writes contracts/${key}.json  (needs the build above)

  2. add the manifest entry and env contract:
       packages/manifest/src/servers.ts          one entry, tools: toolsFor("${key}")
       packages/manifest/src/envSpecs/${camel}.ts   the env contract

  3. npm run generate:tools && npm run generate:all
       derives tools/ .env.example / README blocks

  4. node scripts/install-mcp.mjs --server ${key}
`);
info(`Then rewrite ${dir}/skill/SKILL.md — its description line is the skill's trigger.`);
ok("Done.");
