import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { acquireHeavyLock, breakStale, PID_START_TOLERANCE_MS, readPidStart, STALE_AFTER_MS } from "./heavyLock.mjs";

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

// The one real read (PowerShell on Windows, ~2.5 s), started now so it overlaps every other test.
const loadedAt = Date.now();
const realRead = readPidStart(process.pid);

/**
 * A child that takes the lock, holds it, and appends "enter <pid>" / "exit <pid>" to a journal while
 * holding it. The journal orders holds by the file system, not by Date.now(): two processes' clocks can
 * disagree by a millisecond on Windows, which made a timestamp comparison flake. Its start-time reader
 * answers "unknown" (pid + age only): the real one spawns PowerShell on Windows, ~2.5 s per waiter.
 */
function holdInChild(lockPath, journal, holdMs = 400) {
  const script = `
    const { acquireHeavyLock } = await import(${JSON.stringify(MODULE)});
    const { appendFileSync, readFileSync } = await import("node:fs");
    const lock = await acquireHeavyLock({ cmd: "child", pollMs: 25, readStart: async () => null, log: () => {} });
    appendFileSync(${JSON.stringify(journal)}, "enter " + process.pid + "\\n");
    await new Promise((r) => setTimeout(r, ${String(holdMs)}));
    const mine = JSON.parse(readFileSync(process.env.MCP_HEAVY_LOCK_PATH, "utf8")).token === lock.token;
    appendFileSync(${JSON.stringify(journal)}, "exit " + process.pid + "\\n");
    lock.release();
    console.log(JSON.stringify({ mine }));
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

/** Each enter is followed by the same pid's exit before anyone else enters. */
function assertSerial(journal, holders) {
  const lines = fs.readFileSync(journal, "utf8").trim().split("\n");
  assert.equal(lines.length, holders * 2, lines.join(" | "));
  for (let i = 0; i < lines.length; i += 2) {
    const [verb, pid] = lines[i].split(" ");
    assert.ok(verb === "enter" && lines[i + 1] === `exit ${pid}`, `holds overlap: ${lines.join(" | ")}`);
  }
}

test("two processes serialise: their holds never overlap", async () => {
  const lockPath = tempLock();
  const journal = `${lockPath}.journal`;
  await Promise.all([holdInChild(lockPath, journal), holdInChild(lockPath, journal)]);
  assertSerial(journal, 2);
  assert.equal(fs.existsSync(lockPath), false, "the last holder removes the lock");
});

test("concurrent breakers of one stale lock end with exactly one holder at a time", async () => {
  const lockPath = tempLock();
  const journal = `${lockPath}.journal`;
  writeHolder(lockPath, { pid: spawnSync(process.execPath, ["-e", ""]).pid, startedAt: new Date().toISOString() });
  const holds = await Promise.all([1, 2, 3, 4].map(() => holdInChild(lockPath, journal, 200)));
  for (const h of holds) assert.equal(h.mine, true, "no holder's lock was deleted or replaced under it");
  assertSerial(journal, 4);
  assert.deepEqual(fs.readdirSync(path.dirname(lockPath)), ["heavy-check.lock.journal"], "no lock and no moved-aside file is left behind");
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

test("a live pid whose process started after the lock was taken is broken (pid reused)", async () => {
  // process.pid is alive, but the process owning it started a minute after the holder wrote the lock.
  const lockPath = tempLock();
  const startedAt = Date.now() - 120_000;
  writeHolder(lockPath, { pid: process.pid, startedAt: new Date(startedAt).toISOString() });
  const lines = [];
  const readStart = async () => startedAt + 60_000;
  const lock = await acquireHeavyLock({ cmd: "t", env: cleanEnv(lockPath), timeoutMs: 2_000, readStart, log: (l) => lines.push(l) });
  assert.equal(lock.acquired, true);
  assert.match(lines.join("\n"), new RegExp(`breaking pid ${String(process.pid)} .* was reused`));
  assert.equal(JSON.parse(fs.readFileSync(lockPath, "utf8")).token, lock.token);
  lock.release();
});

test("a live holder that started long before it took the lock (a long sleep) is held; its start is read once, not per poll", async () => {
  const lockPath = tempLock();
  const startedAt = Date.now();
  writeHolder(lockPath, { pid: process.pid, startedAt: new Date(startedAt).toISOString() });
  let reads = 0;
  const readStart = async () => (reads++, startedAt - 8 * 3_600_000);
  await assert.rejects(
    acquireHeavyLock({ cmd: "t", env: cleanEnv(lockPath), timeoutMs: 200, pollMs: 20, readStart, log: quiet }),
    (error) => error.code === "HEAVY_LOCK_TIMEOUT"
  );
  assert.equal(reads, 1);
  assert.equal(JSON.parse(fs.readFileSync(lockPath, "utf8")).token, "other");
});

test("an unreadable start time falls back to the age cap", async () => {
  const readStart = async () => null;
  const fresh = tempLock();
  writeHolder(fresh, { pid: process.pid, startedAt: new Date().toISOString() });
  await assert.rejects(
    acquireHeavyLock({ cmd: "t", env: cleanEnv(fresh), timeoutMs: 100, pollMs: 20, readStart, log: quiet }),
    (error) => error.code === "HEAVY_LOCK_TIMEOUT"
  );
  assert.equal(JSON.parse(fs.readFileSync(fresh, "utf8")).token, "other", "held while younger than the cap");

  const old = tempLock();
  writeHolder(old, { pid: process.pid, startedAt: new Date(Date.now() - STALE_AFTER_MS - 60_000).toISOString() });
  const lines = [];
  const lock = await acquireHeavyLock({ cmd: "t", env: cleanEnv(old), timeoutMs: 2_000, readStart, log: (l) => lines.push(l) });
  assert.equal(lock.acquired, true);
  assert.match(lines.join("\n"), /held for more than 3 h/);
  lock.release();
});

test("a live holder makes the caller wait, then fail clearly, leaving the holder's lock alone", async () => {
  const lockPath = tempLock();
  writeHolder(lockPath, { pid: process.pid, startedAt: new Date().toISOString() });
  const lines = [];
  const readStart = async () => Date.now() - 60_000;
  await assert.rejects(
    acquireHeavyLock({ cmd: "t", env: cleanEnv(lockPath), timeoutMs: 150, pollMs: 20, readStart, log: (l) => lines.push(l) }),
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

test("the platform reader reads this process's start time: before this file loaded, and recent", async () => {
  const read = await realRead;
  assert.ok(Number.isFinite(read), `no start time read on ${process.platform}`);
  assert.ok(read <= loadedAt + PID_START_TOLERANCE_MS, `read ${new Date(read).toISOString()} is after load ${new Date(loadedAt).toISOString()}`);
  assert.ok(loadedAt - read < 60_000, `read ${new Date(read).toISOString()} is not this test process`);
});
