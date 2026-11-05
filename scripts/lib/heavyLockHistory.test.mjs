import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

import { acquireHeavyLock, isPidAlive } from "./heavyLock.mjs";
import { cleanStaleSamples, defaultClass, formatHistory, historyPath, readHistory, recordRun, sampleTables, samplingOff, summarizeHistory } from "./heavyLockHistory.mjs";

/** A scratch dir under the temp dir, removed after this file's tests (pass or fail). */
const scratchDirs = [];
function scratchDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of scratchDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // a child still holding it open: left behind, named heavy-lock-*
    }
  }
});


/**
 * Run history (row H-6a). Every case uses its own lock path (MCP_HEAVY_LOCK_PATH), so its own history
 * file and pipe name; the sampler cases run the real CLI with sampling on, Windows only.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, "..", "heavy-lock.mjs");
const REPO_ROOT = path.join(HERE, "..", "..");

function tempLock() {
  return path.join(scratchDir("heavy-lock-history-"), "heavy-check.lock");
}

function cleanEnv(lockPath, extra = {}) {
  const env = { ...process.env, MCP_HEAVY_LOCK_PATH: lockPath, MCP_HEAVY_LOCK_LINEAGE: "off", MCP_HEAVY_LOCK_SAMPLE: "off", MCP_HEAVY_LOCK_SESSIONS_FILE: `${lockPath}.no-sessions.jsonl`, ...extra };
  delete env.CI;
  delete env.MCP_HEAVY_LOCK_TOKEN;
  return env;
}

const noSampler = samplingOff({}) === null ? false : `no sampler: ${String(samplingOff({}))}`;

test("defaultClass: repo + command with path-like tokens cut to basenames, capped", () => {
  assert.equal(
    defaultClass("powershell.exe -NoProfile -File C:\\Users\\x\\.claude\\bin\\dotnet-build-safe.ps1 -Inner build C:/tmp/scratch/aliasprobe/aliasprobe.csproj", "ai-coding-hub"),
    "ai-coding-hub/powershell.exe -NoProfile -File dotnet-build-safe.ps1 -Inner build aliasprobe.csproj"
  );
  assert.equal(defaultClass("npm run verify:all:steps", "mcp-local"), "mcp-local/npm run verify:all:steps");
  assert.equal(defaultClass('"node" scripts/run-tests.mjs --changed 935f4dd', undefined), "unknown/node run-tests.mjs --changed 935f4dd");
  assert.equal(defaultClass("x ".repeat(200), "r").length, 160);
});

test("recordRun appends one line per run, rotates past the cap without losing a line, and readHistory reads both files, skipping torn lines", () => {
  const lockPath = tempLock();
  const env = cleanEnv(lockPath, { MCP_HEAVY_LOCK_HISTORY_MAX_BYTES: "300" });
  const file = historyPath(env);
  assert.equal(file, `${lockPath}.history.jsonl`);
  for (let i = 0; i < 6; i++) assert.equal(recordRun({ i, class: "c", pad: "x".repeat(80) }, { env }), true);
  const rotated = file.replace(/\.jsonl$/, ".1.jsonl");
  assert.ok(fs.existsSync(rotated), "rotated past 300 bytes");
  assert.ok(fs.statSync(file).size <= 300 + 200);
  fs.appendFileSync(file, '{"torn": \n');
  const rows = readHistory({ env });
  // A second rotation replaced the oldest file: the rows kept are a contiguous, ordered tail.
  const kept = rows.map((r) => r.i);
  assert.deepEqual(kept, Array.from({ length: kept.length }, (_, k) => 6 - kept.length + k));
  assert.ok(kept.length >= 3 && kept.at(-1) === 5, String(kept));
  assert.equal(recordRun({ i: 7 }, { env: cleanEnv(path.join(lockPath, "missing-dir", "x", "\0bad")) }), false, "an unwritable history never throws");
});

test("summarizeHistory: nearest-rank p50/p95/max per class, unmeasured runs counted but not in the peak, filters, heaviest first", () => {
  const rows = [
    ...Array.from({ length: 10 }, (_, k) => ({ class: "big", repo: "wec.be", peakMb: (k + 1) * 100, durationMs: (k + 1) * 1000, exit: k === 9 ? 1 : 0, at: `2026-11-05T0${String(k)}:00:00Z` })),
    { class: "big", repo: "wec.be", peakMb: null, durationMs: 500, exit: 0, at: "2026-11-04T00:00:00Z" },
    { class: "small", repo: "mcp-local", peakMb: 50, durationMs: 2000, exit: 0, at: "2026-11-05T01:00:00Z" }
  ];
  const all = summarizeHistory(rows);
  assert.deepEqual(all.map((s) => s.class), ["big", "small"]);
  const big = all[0];
  assert.deepEqual([big.runs, big.measured, big.failed], [11, 10, 1]);
  assert.deepEqual(big.peakMb, { p50: 500, p95: 1000, max: 1000 });
  assert.deepEqual(big.durationS, { p50: 5, p95: 10, max: 10 });
  assert.equal(big.last, "2026-11-05T09:00:00Z");
  assert.deepEqual(summarizeHistory(rows, { klass: "small" }).map((s) => s.class), ["small"]);
  assert.deepEqual(summarizeHistory(rows, { repo: "wec.be" }).map((s) => s.class), ["big"]);
  const text = formatHistory(all, { file: "h.jsonl" });
  assert.match(text, /^history: h\.jsonl/);
  assert.match(text, /big\n {4}500\/1000\/1000 MB · 5\/10\/10 s · 11 \(10, 1 failed\) · 2026-11-05T09:00:00Z/);
  assert.match(formatHistory([], {}), /no runs recorded/);
});

test("CLI: bad --cost / --ram-mb / a flag without its value exit 2 before taking the lock; nested and --no-lock runs record nothing", async () => {
  const lockPath = tempLock();
  for (const flags of [["--cost", "huge"], ["--ram-mb", "lots"], ["--ram-mb", "0"], ["--class"]]) {
    const r = spawnSync(process.execPath, [CLI, ...flags, "--", "node", "-e", "0"], { env: cleanEnv(lockPath), encoding: "utf8" });
    assert.equal(r.status, 2, `${flags.join(" ")}: ${r.stderr}`);
  }
  const off = spawnSync(process.execPath, [CLI, "--no-lock", "--", "node", "-e", "0"], { env: cleanEnv(lockPath), encoding: "utf8" });
  assert.equal(off.status, 0, off.stderr);
  const env = cleanEnv(lockPath);
  const outer = await acquireHeavyLock({ cmd: "outer", env, log: () => {} });
  try {
    const nested = spawnSync(process.execPath, [CLI, "--", "node", "-e", "0"], { env: { ...env }, encoding: "utf8" });
    assert.equal(nested.status, 0, nested.stderr);
  } finally {
    outer.release();
  }
  assert.deepEqual(readHistory({ env: cleanEnv(lockPath) }), []);
});

test("CLI: a run with sampling off is still recorded — class, declared cost, duration, exit — with peakMb null and the reason", () => {
  const lockPath = tempLock();
  const r = spawnSync(process.execPath, [CLI, "--class", "probe-off", "--cost", "small", "--", "node", "-e", "process.exit(4)"], { cwd: REPO_ROOT, env: cleanEnv(lockPath), encoding: "utf8" });
  assert.equal(r.status, 4, r.stderr);
  const rows = readHistory({ env: cleanEnv(lockPath) });
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.class, "probe-off");
  assert.equal(row.cost, "small");
  assert.equal(row.ramMb, null);
  assert.equal(row.exit, 4);
  assert.equal(row.peakMb, null);
  assert.equal(row.sampling.off, "MCP_HEAVY_LOCK_SAMPLE=off");
  assert.equal(row.cwd, REPO_ROOT);
  assert.ok(Number.isFinite(row.durationMs) && row.durationMs >= 0);
  assert.ok(Number.isFinite(Date.parse(row.startedAt)) && Number.isFinite(Date.parse(row.at)));
  const expectedRepo = path.basename(path.dirname(spawnSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: REPO_ROOT, encoding: "utf8" }).stdout.trim()));
  assert.equal(row.repo, expectedRepo);
});

test("CLI end to end: the whole tree's peak working set is sampled, including a detached grandchild that allocates after its parent exited; history prints it", { skip: noSampler }, async () => {
  const lockPath = tempLock();
  // A (the command) spawns B and waits 9 s. B spawns C detached and exits after 2.5 s (after the first
  // sample, so it is seen). C allocates 300 MB only at 4 s — after B is gone — and holds it 3 s.
  const c = "setTimeout(() => { globalThis.b = Buffer.alloc(300 * 1024 * 1024, 1); setTimeout(() => {}, 3000); }, 4000);";
  const b = `require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(c)}], { detached: true, stdio: "ignore" }).unref(); setTimeout(() => {}, 2500);`;
  const a = `require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(b)}], { stdio: "ignore" }); setTimeout(() => process.exit(7), 9000);`;
  const scriptFile = path.join(path.dirname(lockPath), "a.js");
  fs.writeFileSync(scriptFile, a);
  const env = cleanEnv(lockPath, { MCP_HEAVY_LOCK_SAMPLE: "on", MCP_HEAVY_LOCK_SAMPLE_MS: "250" });
  const r = spawnSync(process.execPath, [CLI, "--class", "probe", "--ram-mb", "500", "--", "node", scriptFile], { cwd: REPO_ROOT, env, encoding: "utf8", timeout: 60_000 });
  assert.equal(r.status, 7, r.stderr);
  const [row] = readHistory({ env });
  assert.equal(row.class, "probe");
  assert.equal(row.ramMb, 500);
  assert.equal(row.exit, 7);
  assert.ok(row.durationMs >= 8_000, String(row.durationMs));
  assert.equal(row.sampling.intervalMs, 250);
  assert.ok(row.sampling.samples >= 10, `samples ${String(row.sampling.samples)}`);
  assert.ok(row.sampling.firstSampleAfterMs < 6_000, `first sample after ${String(row.sampling.firstSampleAfterMs)} ms`);
  assert.ok(row.peakMb >= 300, `peak ${String(row.peakMb)} MB: the detached grandchild was not counted after its parent exited`);
  assert.ok(row.peakTop.some((p) => /^node/i.test(p.name) && p.mb >= 290), JSON.stringify(row.peakTop));
  // The sampler ends with the run: its PowerShell helper is gone too.
  const deadline = Date.now() + 10_000;
  while (isPidAlive(row.sampling.helperPid) && Date.now() < deadline) await new Promise((res) => setTimeout(res, 100));
  assert.equal(isPidAlive(row.sampling.helperPid), false, "the sampler's PowerShell outlived the run");

  const h = spawnSync(process.execPath, [CLI, "history", "--class", "probe", "--json"], { env, encoding: "utf8" });
  assert.equal(h.status, 0, h.stderr);
  const { summary } = JSON.parse(h.stdout);
  assert.equal(summary.length, 1);
  assert.equal(summary[0].peakMb.max, row.peakMb);
  const text = spawnSync(process.execPath, [CLI, "history"], { env, encoding: "utf8" }).stdout;
  assert.match(text, new RegExp(`probe\\n {4}${String(row.peakMb)}/${String(row.peakMb)}/${String(row.peakMb)} MB`));
});

// ---- H-6a review follow-ups ----

const C = 134000000000000000n; // a FILETIME in 2025, after the scripted run start
const table = (rows) => rows.map((r) => r.join(" ")).join("\n");

test("tree membership: a seen process stays in the tree when its gone parent's pid is reused by a stranger; a reused member pid leaves; a process older than the run never joins", { skip: noSampler }, () => {
  const cache = scratchDir("heavy-lock-cache-");
  const { samples } = sampleTables(
    [
      // root 100 → dotnet 200 → VBCSCompiler 300; 400 a stranger; 500 under the root but older than the run
      table([[100, 1, C, 10, "node.exe"], [200, 100, C + 1n, 1000, "dotnet.exe"], [300, 200, C + 2n, 5000, "VBCSCompiler.exe"], [400, 1, C, 7, "stranger.exe"], [500, 100, 100000000000000000n, 9, "old.exe"]]),
      // dotnet exits: VBCSCompiler's parent is gone
      table([[100, 1, C, 10, "node.exe"], [300, 200, C + 2n, 6000, "VBCSCompiler.exe"]]),
      // a stranger gets pid 200: VBCSCompiler (creation unchanged) stays, the stranger does not join
      table([[100, 1, C, 10, "node.exe"], [200, 4, C + 9n, 999, "stranger.exe"], [300, 200, C + 2n, 7000, "VBCSCompiler.exe"]]),
      // VBCSCompiler exits and its pid is reused by an unrelated process: it leaves
      table([[100, 1, C, 10, "node.exe"], [300, 4, C + 10n, 8000, "reused.exe"]])
    ],
    { root: 100, runStartMs: 1_700_000_000_000, env: { ...process.env, MCP_HEAVY_LOCK_SAMPLER_CACHE: cache } }
  );
  assert.deepEqual(
    samples.map((s) => [s.members, s.sumBytes]),
    [
      [[200, 300], 6000],
      [[300], 6000],
      [[300], 7000],
      [[], 0]
    ]
  );
});

test("helper self-heal: built once, then cached; a corrupt cached DLL is rebuilt; one that matches its sum but will not load is compiled in memory", { skip: noSampler }, () => {
  const cache = scratchDir("heavy-lock-cache-");
  const env = { ...process.env, MCP_HEAVY_LOCK_SAMPLER_CACHE: cache };
  const one = [table([[100, 1, C, 10, "node.exe"], [200, 100, C + 1n, 4096, "child.exe"]])];
  const run = () => sampleTables(one, { root: 100, runStartMs: 1_700_000_000_000, env });
  assert.equal(run().helper, "built");
  const second = run();
  assert.equal(second.helper, "cached");
  assert.deepEqual(second.samples[0].members, [200]);
  const dll = fs.readdirSync(cache).find((n) => n.endsWith(".dll") && !n.includes(".tmp"));
  assert.ok(dll, fs.readdirSync(cache).join(", "));
  fs.writeFileSync(path.join(cache, dll), "not a dll");
  const healed = run();
  assert.equal(healed.helper, "built", "a DLL that does not match its sum is rebuilt");
  assert.deepEqual(healed.samples[0].members, [200]);
  assert.equal(run().helper, "cached");
  // Both the DLL and its sum corrupted consistently: the load fails, so this run compiles in memory.
  const garbage = Buffer.from("MZ garbage");
  fs.writeFileSync(path.join(cache, dll), garbage);
  fs.writeFileSync(path.join(cache, `${dll}.sha256`), createHash("sha256").update(garbage).digest("hex").toUpperCase());
  const memory = run();
  assert.equal(memory.helper, "memory");
  assert.deepEqual(memory.samples[0].members, [200]);
});

test("cleanStaleSamples removes summary files and temps of dead pids only", () => {
  const dir = scratchDir("heavy-lock-clean-");
  const dead = spawnSync(process.execPath, ["-e", "0"]).pid;
  const names = [
    `heavy-lock-sample-${String(dead)}-0b0e7a3c-1111-4222-8333-944455556666.json`,
    `heavy-lock-sample-${String(dead)}-0b0e7a3c-1111-4222-8333-944455556666.json.5f0c2a1e-1111-4222-8333-944455556666.tmp`,
    `heavy-lock-sample-${String(process.pid)}-0b0e7a3c-1111-4222-8333-944455556666.json`,
    "heavy-lock-unrelated.json"
  ];
  for (const n of names) fs.writeFileSync(path.join(dir, n), "{}");
  assert.equal(cleanStaleSamples(dir), 2);
  assert.deepEqual(fs.readdirSync(dir).sort(), [names[2], names[3]].sort());
});
