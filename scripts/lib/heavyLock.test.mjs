import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { acquireHeavyLock, breakStale, STALE_AFTER_MS } from "./heavyLock.mjs";

/**
 * The machine-wide heavy-check lock (row V-C). Every case uses its own lock file through
 * MCP_HEAVY_LOCK_PATH and a clean env, so a run inside a real `verify:*` hold (which exports
 * MCP_HEAVY_LOCK_TOKEN) or under CI=true tests the lock rather than skipping it.
 */

const MODULE = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), "heavyLock.mjs")).href;

function tempLock() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "heavy-lock-")), "heavy-check.lock");
}

function cleanEnv(lockPath) {
  const env = { ...process.env, MCP_HEAVY_LOCK_PATH: lockPath };
  delete env.CI;
  delete env.MCP_HEAVY_LOCK_TOKEN;
  return env;
}

function writeHolder(lockPath, holder) {
  fs.writeFileSync(lockPath, JSON.stringify({ token: "other", cmd: "npm test", cwd: "/elsewhere", ...holder }));
}

const quiet = () => {};

/** A child that takes the lock, holds it, and prints when it held it and whether the file was still its own. */
function holdInChild(lockPath, holdMs = 400) {
  const script = `
    const { acquireHeavyLock } = await import(${JSON.stringify(MODULE)});
    const { readFileSync } = await import("node:fs");
    const lock = await acquireHeavyLock({ cmd: "child", pollMs: 25, log: () => {} });
    const start = Date.now();
    await new Promise((r) => setTimeout(r, ${String(holdMs)}));
    const end = Date.now();
    const mine = JSON.parse(readFileSync(process.env.MCP_HEAVY_LOCK_PATH, "utf8")).token === lock.token;
    lock.release();
    console.log(JSON.stringify({ start, end, mine }));
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], { env: cleanEnv(lockPath) });
    let out = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (out += chunk));
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve(JSON.parse(out.trim())) : reject(new Error(`child exit ${code}: ${out}`))));
  });
}

test("two processes serialise: their holds never overlap", async () => {
  const lockPath = tempLock();
  const [a, b] = await Promise.all([holdInChild(lockPath), holdInChild(lockPath)]);
  assert.ok(a.end <= b.start || b.end <= a.start, `holds overlap: ${JSON.stringify({ a, b })}`);
  assert.equal(fs.existsSync(lockPath), false, "the last holder removes the lock");
});

test("concurrent breakers of one stale lock end with exactly one holder at a time", async () => {
  const lockPath = tempLock();
  writeHolder(lockPath, { pid: spawnSync(process.execPath, ["-e", ""]).pid, startedAt: new Date().toISOString() });
  const holds = await Promise.all([1, 2, 3, 4].map(() => holdInChild(lockPath, 200)));
  for (const h of holds) assert.equal(h.mine, true, "no holder's lock was deleted or replaced under it");
  const sorted = [...holds].sort((x, y) => x.start - y.start);
  for (let i = 1; i < sorted.length; i++) {
    assert.ok(sorted[i - 1].end <= sorted[i].start, `holds overlap: ${JSON.stringify(sorted)}`);
  }
  assert.deepEqual(fs.readdirSync(path.dirname(lockPath)), [], "no lock and no moved-aside file is left behind");
});

test("a slow breaker that reaches the lock after another waiter replaced it puts the live lock back", () => {
  // The interleaving the stress test above can only hope to hit: B judged the old file stale, A broke it
  // and took the lock, and only now does B act on its stale judgement.
  const lockPath = tempLock();
  const judged = JSON.stringify({ pid: 1, startedAt: "2000-01-01T00:00:00Z", token: "dead" });
  const live = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), token: "A" });
  fs.writeFileSync(lockPath, live);
  const lines = [];
  breakStale(lockPath, judged, (l) => lines.push(l));
  assert.equal(fs.readFileSync(lockPath, "utf8"), live, "A's lock is back, byte for byte");
  assert.deepEqual(fs.readdirSync(path.dirname(lockPath)), ["heavy-check.lock"], "nothing moved aside is left");
  assert.deepEqual(lines, []);

  fs.writeFileSync(lockPath, judged);
  breakStale(lockPath, judged, quiet);
  assert.equal(fs.existsSync(lockPath), false, "the file judged stale is removed");
  breakStale(lockPath, judged, quiet); // already gone: another waiter broke it first — not an error
});

test("a holder whose pid is gone is broken", async () => {
  const lockPath = tempLock();
  const dead = spawnSync(process.execPath, ["-e", ""]).pid;
  writeHolder(lockPath, { pid: dead, startedAt: new Date().toISOString() });
  const lines = [];
  const lock = await acquireHeavyLock({ cmd: "t", env: cleanEnv(lockPath), timeoutMs: 2_000, log: (l) => lines.push(l) });
  assert.equal(lock.acquired, true);
  assert.match(lines.join("\n"), new RegExp(`breaking pid ${String(dead)} .* is gone`));
  assert.equal(JSON.parse(fs.readFileSync(lockPath, "utf8")).pid, process.pid);
  lock.release();
});

test("a live pid that has held the lock past the age cap is broken (pid reuse)", async () => {
  const lockPath = tempLock();
  writeHolder(lockPath, { pid: process.pid, startedAt: new Date(Date.now() - STALE_AFTER_MS - 60_000).toISOString() });
  const lock = await acquireHeavyLock({ cmd: "t", env: cleanEnv(lockPath), timeoutMs: 2_000, log: quiet });
  assert.equal(lock.acquired, true);
  lock.release();
});

test("a live holder makes the caller wait, then fail clearly, leaving the holder's lock alone", async () => {
  const lockPath = tempLock();
  writeHolder(lockPath, { pid: process.pid, startedAt: new Date().toISOString() });
  const lines = [];
  await assert.rejects(
    acquireHeavyLock({ cmd: "t", env: cleanEnv(lockPath), timeoutMs: 150, pollMs: 20, log: (l) => lines.push(l) }),
    (error) => error.code === "HEAVY_LOCK_TIMEOUT" && /npm test/.test(error.message)
  );
  assert.equal(lines.length, 1, "the holder is announced once, not every poll");
  assert.match(lines[0], /held by pid \d+ \(npm test\) in \/elsewhere/);
  assert.equal(JSON.parse(fs.readFileSync(lockPath, "utf8")).token, "other");
});

test("CI=true and --no-lock skip the lock and create no file", async () => {
  const lockPath = tempLock();
  const ci = await acquireHeavyLock({ cmd: "t", env: { ...cleanEnv(lockPath), CI: "true" } });
  assert.deepEqual(ci, { acquired: false, reason: "CI=true" });
  const off = await acquireHeavyLock({ cmd: "t", env: cleanEnv(lockPath), noLock: true });
  assert.deepEqual(off, { acquired: false, reason: "--no-lock" });
  assert.equal(fs.existsSync(lockPath), false);
});

test("a nested caller inside its parent's hold does not wait for itself", async () => {
  const lockPath = tempLock();
  const env = cleanEnv(lockPath);
  const outer = await acquireHeavyLock({ cmd: "verify:all", env, log: quiet });
  assert.equal(env.MCP_HEAVY_LOCK_TOKEN, outer.token, "children spawned with this env inherit the hold");
  const inner = await acquireHeavyLock({ cmd: "run-tests", env: { ...env }, timeoutMs: 100, log: quiet });
  assert.equal(inner.acquired, false);
  assert.match(inner.reason, /^held by parent pid/);
  outer.release();
  assert.equal(fs.existsSync(lockPath), false);
  assert.equal(env.MCP_HEAVY_LOCK_TOKEN, undefined);
});

test("a stale inherited token does not skip the lock", async () => {
  const lockPath = tempLock();
  const lock = await acquireHeavyLock({ cmd: "t", env: { ...cleanEnv(lockPath), MCP_HEAVY_LOCK_TOKEN: "gone" }, log: quiet });
  assert.equal(lock.acquired, true);
  lock.release();
});
