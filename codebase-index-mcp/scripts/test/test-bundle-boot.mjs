/**
 * test-bundle-boot.mjs — boot the SERVED entry, dist/bundle/index.js, over stdio.
 *
 * Until now a deploy was the only test of the bundle (scripts/bundle.mjs; the deploy runs it). A bundle can
 * compile and still fail to load: an external dropped from EXTERNAL, a worker URL that no longer sits beside
 * its client, a native addon resolved from the wrong place. This harness starts it the way a client does
 * and checks:
 *   1. initialize handshake (serverInfo.version present)
 *   2. tools/list — same tool names as dist/index.js (the unbundled entry)
 *   3. health_check (one cheap read call), version equals the handshake version
 *   4. native modules (better-sqlite3, sqlite-vec) load, resolved from the bundle's own folder
 *   5. clean shutdown (client.close())
 *   6. a deliberately broken bundle (a temp copy with an external renamed) FAILS this same check
 *
 * Scratch only: a temp db, a temp ALLOWED_ROOTS, stdio transport (no port). Never the live db or served process.
 * Needs `npm run build` (dist/ + dist/bundle/). A missing bundle is built; a missing dist/ is an error.
 *
 *   node scripts/test/test-bundle-boot.mjs                      # the full harness
 *   node scripts/test/test-bundle-boot.mjs --bundle-dir <dir>   # boot one bundle folder, exit non-zero on failure
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { makeTempDir } from "./_fixtures.mjs";
import { attachServerStderr } from "./_serverStderr.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const DIST = path.join(ROOT, "dist");
const DEFAULT_BUNDLE = path.join(DIST, "bundle");
const BOOT_TIMEOUT_MS = 60_000;

function withTimeout(promise, ms, what) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Scratch env: no inherited CODEBASE_INDEX_* (live db path, ports, flags) leaks in. */
function scratchEnv(scratchDir) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || key.startsWith("CODEBASE_INDEX_")) continue;
    env[key] = value;
  }
  env.CODEBASE_INDEX_ALLOWED_ROOTS = scratchDir;
  env.CODEBASE_INDEX_DB_PATH = path.join(scratchDir, "bundle-boot.db");
  env.CODEBASE_INDEX_WATCH_AUTO_START_ENABLED = "false";
  return env;
}

/** Start `entry` over stdio, handshake, list tools, call health_check, close. Throws on any failure. */
async function bootEntry(entry, label) {
  const scratchDir = makeTempDir("cbi-bundle-boot-");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    cwd: scratchDir,
    env: scratchEnv(scratchDir),
    stderr: "pipe"
  });
  const client = new Client({ name: "codebase-index-bundle-boot-test", version: "0.1.0" });
  attachServerStderr(transport, label);
  try {
    await withTimeout(client.connect(transport), BOOT_TIMEOUT_MS, `${label}: initialize handshake`);
    const wireVersion = client.getServerVersion()?.version;
    if (!wireVersion) throw new Error(`${label}: initialize returned no serverInfo.version`);

    const { tools } = await withTimeout(client.listTools(), BOOT_TIMEOUT_MS, `${label}: tools/list`);
    const toolNames = tools.map((tool) => tool.name).sort();

    const health = await withTimeout(
      client.callTool({ name: "health_check", arguments: { repoId: "bundle-boot-scratch" } }),
      BOOT_TIMEOUT_MS,
      `${label}: health_check`
    );
    const text = health?.content?.find((item) => item.type === "text")?.text;
    if (health?.isError || !text) throw new Error(`${label}: health_check failed: ${text ?? "no text content"}`);
    const healthVersion = JSON.parse(text).serverVersion;
    if (healthVersion !== wireVersion) {
      throw new Error(`${label}: health_check serverVersion (${healthVersion}) != handshake version (${wireVersion})`);
    }
    return { wireVersion, toolNames };
  } finally {
    // close() ends stdin and terminates the child; a hung close must not hang the harness.
    await withTimeout(client.close(), 15_000, `${label}: shutdown`).catch(() => transport.close().catch(() => {}));
  }
}

/** The native addons, resolved exactly as the bundle resolves its externals: from the bundle's own folder. */
function assertNativeModulesLoad(bundleDir) {
  const requireFromBundle = createRequire(path.join(bundleDir, "index.js"));
  const Database = requireFromBundle("better-sqlite3");
  const sqliteVec = requireFromBundle("sqlite-vec");
  const db = new Database(":memory:");
  try {
    sqliteVec.load(db);
    const { v } = db.prepare("SELECT vec_version() AS v").get();
    if (!v) throw new Error("sqlite-vec loaded but vec_version() is empty");
  } finally {
    db.close();
  }
}

async function bootBundle(bundleDir) {
  const entry = path.join(bundleDir, "index.js");
  if (!fs.existsSync(entry)) throw new Error(`bundle entry missing: ${entry}`);
  const result = await bootEntry(entry, "bundle");
  assertNativeModulesLoad(bundleDir);
  return result;
}

async function ensureBundle() {
  if (fs.existsSync(path.join(DEFAULT_BUNDLE, "index.js"))) return;
  if (!fs.existsSync(path.join(DIST, "index.js"))) {
    throw new Error("dist/index.js is missing — run `npm run build` first (this harness needs a build)");
  }
  const { bundle } = await import(pathToFileURL(path.join(ROOT, "scripts", "bundle.mjs")).href);
  await bundle({ quiet: true });
}

/** A copy of the bundle, beside it under dist/ (so externals still resolve), with one external renamed. */
function makeBrokenBundle() {
  const brokenDir = path.join(DIST, `bundle-broken-${process.pid}`);
  fs.rmSync(brokenDir, { recursive: true, force: true });
  fs.cpSync(DEFAULT_BUNDLE, brokenDir, { recursive: true });
  const file = path.join(brokenDir, "index.js");
  const source = fs.readFileSync(file, "utf8");
  const needle = 'from "better-sqlite3"';
  if (!source.includes(needle)) throw new Error(`cannot build the broken bundle: ${needle} not found in the bundle`);
  fs.writeFileSync(file, source.replace(needle, 'from "better-sqlite3-removed-by-test"'));
  return brokenDir;
}

function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) process.exitCode = 1;
  return ok;
}

async function main() {
  const flag = process.argv.indexOf("--bundle-dir");
  if (flag !== -1) {
    // Single-bundle mode: the unit the negative proof runs against a broken copy.
    const dir = path.resolve(process.argv[flag + 1] ?? "");
    const { toolNames } = await bootBundle(dir);
    console.log(`booted ${dir}: ${toolNames.length} tools`);
    return;
  }

  await ensureBundle();

  const bundled = await bootBundle(DEFAULT_BUNDLE);
  check("bundle boots: handshake, tools/list, health_check, clean shutdown", true, `${bundled.toolNames.length} tools, v${bundled.wireVersion}`);
  check("native modules (better-sqlite3, sqlite-vec) load from the bundle folder", true);

  const unbundled = await bootEntry(path.join(DIST, "index.js"), "dist");
  const missing = unbundled.toolNames.filter((name) => !bundled.toolNames.includes(name));
  const extra = bundled.toolNames.filter((name) => !unbundled.toolNames.includes(name));
  check(
    "bundle tools/list equals dist/index.js tools/list",
    missing.length === 0 && extra.length === 0 && bundled.toolNames.length > 0,
    `bundle ${bundled.toolNames.length}, dist ${unbundled.toolNames.length}${missing.length ? `, missing: ${missing.join(",")}` : ""}${extra.length ? `, extra: ${extra.join(",")}` : ""}`
  );

  // Negative proof: the same check, run as its own process against a broken copy, must exit non-zero.
  const brokenDir = makeBrokenBundle();
  try {
    const run = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--bundle-dir", brokenDir], {
      encoding: "utf8",
      timeout: 2 * BOOT_TIMEOUT_MS
    });
    check(
      "a broken bundle (external renamed) fails the boot check",
      run.status !== null && run.status !== 0,
      `exit ${run.status}${run.signal ? ` signal ${run.signal}` : ""}`
    );
  } finally {
    fs.rmSync(brokenDir, { recursive: true, force: true });
  }

  if (process.exitCode) throw new Error("bundle-boot: one or more checks failed");
  console.log("bundle-boot: OK");
}

main().then(
  () => process.exit(process.exitCode ?? 0),
  (error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exit(1);
  }
);
