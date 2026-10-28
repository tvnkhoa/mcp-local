import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  acquireHeavyLock,
  breakStale,
  heavyLockPipeName,
  isPidAlive,
  LOCK_TIMEOUT_EXIT,
  PID_START_TOLERANCE_MS,
  readPidStart,
  STALE_AFTER_MS
} from "./heavyLock.mjs";

/**
 * The machine-wide heavy-check lock (row V-C; an OS-owned name since row 9). Every case uses its own
 * lock file through MCP_HEAVY_LOCK_PATH — which also names its own pipe — and a clean env, so a run
 * inside a real `verify:*` hold (which exports MCP_HEAVY_LOCK_TOKEN) or under CI=true tests the lock
 * rather than skipping it. The file-scheme cases pass `scheme: "file"`; it is the lock on macOS only.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MODULE = pathToFileURL(path.join(HERE, "heavyLock.mjs")).href;
const CLI = path.join(HERE, "..", "heavy-lock.mjs");
const PIPE = heavyLockPipeName("x") !== null;
const noPipe = PIPE ? false : `no OS-owned lock name on ${process.platform}`;

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
const deadPid = () => spawnSync(process.execPath, ["-e", ""]).pid;

/** Kill without letting the process run any handler: `taskkill /F` on Windows, SIGKILL elsewhere. */
function hardKill(pid) {
  if (process.platform === "win32") spawnSync("taskkill", ["/F", "/PID", String(pid)], { windowsHide: true });
  else process.kill(pid, "SIGKILL");
}

// The one real read, started now so it overlaps every other test.
const loadedAt = Date.now();
const realRead = readPidStart(process.pid);

/**
 * A child that takes the lock, holds it, and appends "enter <pid>" / "exit <pid>" to a journal while
 * holding it. The journal orders holds by the file system, not by Date.now(): two processes' clocks can
 * disagree by a millisecond on Windows, which made a timestamp comparison flake. Its start-time reader
 * answers "unknown" (pid + age only).
 */
function holdInChild(lockPath, journal, holdMs = 400, scheme = undefined) {
  const script = `
    const { acquireHeavyLock } = await import(${JSON.stringify(MODULE)});
    const { appendFileSync, readFileSync } = await import("node:fs");
    const lock = await acquireHeavyLock({ cmd: "child", pollMs: 25, readStart: async () => null, scheme: ${JSON.stringify(scheme)}, log: () => {} });
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

/**
 * A child that takes the lock and reports `{ pid, grandchild }` once it holds it, then either sleeps
 * (`"sleep"`) or blocks its event loop in spawnSync for `blockMs` and exits (`"spawnSync"`). With
 * `grandchild`, it first spawns a long-lived node child with inherited stdio, detached: on Windows
 * libuv puts every other child in a kill-on-close job, so only a detached one can outlive the holder.
 */
function holderChild(lockPath, { mode = "sleep", blockMs = 0, grandchild = false } = {}) {
  const script = `
    const { acquireHeavyLock } = await import(${JSON.stringify(MODULE)});
    const { spawn, spawnSync } = await import("node:child_process");
    await acquireHeavyLock({ cmd: "holder-${mode}", log: () => {} });
    const g = ${String(grandchild)} ? spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "inherit", detached: true }).pid : null;
    console.log(JSON.stringify({ pid: process.pid, grandchild: g }));
    if (${JSON.stringify(mode)} === "spawnSync") {
      spawnSync(process.execPath, ["-e", "const t = Date.now(); while (Date.now() - t < ${String(blockMs)});"]);
      process.exit(0);
    }
    setInterval(() => {}, 60000);
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { env: cleanEnv(lockPath), stdio: ["ignore", "pipe", "inherit"] });
  const exited = new Promise((resolve) => child.on("exit", (code) => resolve(code)));
  const held = new Promise((resolve, reject) => {
    let out = "";
    child.stdout.on("data", (chunk) => {
      out += chunk;
      const nl = out.indexOf("\n");
      if (nl !== -1) resolve(JSON.parse(out.slice(0, nl)));
    });
    child.on("error", reject);
    exited.then((code) => reject(new Error(`holder exited ${String(code)} before holding`)));
  });
  return { held, exited };
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

test("the lock name is per user and per lock path; macOS has none", () => {
  const user = os.userInfo().username.replace(/[^A-Za-z0-9_.-]/g, "_");
  const win = heavyLockPipeName("/a/heavy-check.lock", { platform: "win32" });
  assert.match(win, new RegExp(`^\\\\\\\\\\.\\\\pipe\\\\mcp-heavy-check-${user}-[0-9a-f]{16}$`));
  assert.equal(heavyLockPipeName("/a/heavy-check.lock", { platform: "linux" }), `\0${win.slice(9)}`);
  assert.notEqual(heavyLockPipeName("/b/heavy-check.lock", { platform: "win32" }), win);
  assert.equal(heavyLockPipeName("/a/heavy-check.lock", { platform: "darwin" }), null);
});

test("six processes contend for the name: exactly one holds at any instant", { skip: noPipe }, async () => {
  const lockPath = tempLock();
  const journal = `${lockPath}.journal`;
  const holds = await Promise.all([1, 2, 3, 4, 5, 6].map(() => holdInChild(lockPath, journal, 100)));
  for (const h of holds) assert.equal(h.mine, true, "no holder's file was replaced under it");
  assertSerial(journal, 6);
  assert.deepEqual(fs.readdirSync(path.dirname(lockPath)), ["heavy-check.lock.journal"], "the last holder removes the file");
});

test("a holder killed with taskkill /F (SIGKILL) frees the name at once, though its grandchild lives on", { skip: noPipe }, async (t) => {
  const lockPath = tempLock();
  const holder = holderChild(lockPath, { grandchild: true });
  const { pid, grandchild } = await holder.held;
  t.after(() => isPidAlive(grandchild) && hardKill(grandchild));
  const pollMs = 250;
  const lines = [];
  let announce;
  const announced = new Promise((resolve) => (announce = resolve));
  const waiting = acquireHeavyLock({ cmd: "waiter", env: cleanEnv(lockPath), timeoutMs: 20_000, pollMs, log: (l) => (lines.push(l), announce()) });
  await announced;
  assert.match(lines[0], new RegExp(`held by pid ${String(pid)} \\(holder-sleep\\)`));
  hardKill(pid);
  const killedAt = Date.now();
  await holder.exited;
  const lock = await waiting;
  const waited = Date.now() - killedAt;
  assert.equal(lock.acquired, true);
  assert.ok(waited <= pollMs + 750, `acquired ${String(waited)} ms after the kill, more than one poll (${String(pollMs)} ms)`);
  assert.equal(isPidAlive(grandchild), true, "the grandchild outlived the holder, and did not keep the lock");
  assert.equal(JSON.parse(fs.readFileSync(lockPath, "utf8")).token, lock.token, "the dead holder's file was overwritten");
  lock.release();
});

test("a holder blocked in spawnSync keeps the name until it exits", { skip: noPipe }, async () => {
  const lockPath = tempLock();
  const holder = holderChild(lockPath, { mode: "spawnSync", blockMs: 1_000 });
  const { pid } = await holder.held;
  await assert.rejects(
    acquireHeavyLock({ cmd: "t", env: cleanEnv(lockPath), timeoutMs: 600, pollMs: 50, log: quiet }),
    (error) => error.code === "HEAVY_LOCK_TIMEOUT" && error.message.includes(`pid ${String(pid)} (holder-spawnSync)`)
  );
  assert.equal(await holder.exited, 0);
  const lock = await acquireHeavyLock({ cmd: "t", env: cleanEnv(lockPath), timeoutMs: 2_000, pollMs: 50, log: quiet });
  assert.equal(lock.acquired, true);
  lock.release();
});

test("a live holder makes the caller wait, then fail clearly, naming it once", async () => {
  const lockPath = tempLock();
  const held = await acquireHeavyLock({ cmd: "npm test", cwd: "/elsewhere", env: cleanEnv(lockPath), log: quiet });
  const lines = [];
  await assert.rejects(
    acquireHeavyLock({ cmd: "t", env: cleanEnv(lockPath), timeoutMs: 150, pollMs: 20, log: (l) => lines.push(l) }),
    (error) => error.code === "HEAVY_LOCK_TIMEOUT" && /npm test/.test(error.message)
  );
  assert.equal(lines.length, 1, "the holder is announced once, not every poll");
  assert.match(lines[0], /held by pid \d+ \(npm test\) in \/elsewhere/);
  assert.equal(JSON.parse(fs.readFileSync(lockPath, "utf8")).token, held.token);
  held.release();
});

test("heavy-lock.mjs exits 75 when the lock stays held past MCP_HEAVY_LOCK_TIMEOUT_MS", async () => {
  // This process holds the lock and sits in spawnSync while the CLI waits: no event loop runs here.
  const lockPath = tempLock();
  const held = await acquireHeavyLock({ cmd: "holder", env: cleanEnv(lockPath), log: quiet });
  const run = spawnSync(process.execPath, [CLI, "--", process.execPath, "-e", ""], {
    env: { ...cleanEnv(lockPath), MCP_HEAVY_LOCK_TIMEOUT_MS: "300" },
    encoding: "utf8"
  });
  held.release();
  assert.equal(run.status, LOCK_TIMEOUT_EXIT, run.stderr);
  assert.match(run.stderr, /still held after 0 s by pid \d+ \(holder\)/);
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

test("a token matching a killed holder's leftover file does not skip a free lock", { skip: noPipe }, async () => {
  // The parent was killed (its file stays behind) while its child lives on with the inherited token.
  const lockPath = tempLock();
  writeHolder(lockPath, { pid: deadPid(), startedAt: new Date().toISOString(), token: "parent" });
  const lock = await acquireHeavyLock({ cmd: "t", env: { ...cleanEnv(lockPath), MCP_HEAVY_LOCK_TOKEN: "parent" }, log: quiet });
  assert.equal(lock.acquired, true);
  lock.release();
});

// ---- the file scheme: the lock on macOS ----

test("file scheme: two processes serialise: their holds never overlap", async () => {
  const lockPath = tempLock();
  const journal = `${lockPath}.journal`;
  await Promise.all([holdInChild(lockPath, journal, 150, "file"), holdInChild(lockPath, journal, 150, "file")]);
  assertSerial(journal, 2);
  assert.equal(fs.existsSync(lockPath), false, "the last holder removes the lock");
});

test(
  "file scheme: concurrent breakers of one stale lock end with exactly one holder at a time",
  { skip: PIPE ? `${process.platform} locks by name; this race is the file scheme's known window` : false },
  async () => {
    const lockPath = tempLock();
    const journal = `${lockPath}.journal`;
    writeHolder(lockPath, { pid: deadPid(), startedAt: new Date().toISOString() });
    const holds = await Promise.all([1, 2, 3, 4].map(() => holdInChild(lockPath, journal, 200, "file")));
    for (const h of holds) assert.equal(h.mine, true, "no holder's lock was deleted or replaced under it");
    assertSerial(journal, 4);
    assert.deepEqual(fs.readdirSync(path.dirname(lockPath)), ["heavy-check.lock.journal"], "no lock and no moved-aside file is left behind");
  }
);

test("file scheme: a slow breaker that reaches the lock after another waiter replaced it puts the live lock back", () => {
  // The interleaving a stress test can only hope to hit: B judged the old file stale, A broke it and
  // took the lock, and only now does B act on its stale judgement.
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

test("file scheme: a holder whose pid is gone is broken", async () => {
  const lockPath = tempLock();
  const dead = deadPid();
  writeHolder(lockPath, { pid: dead, startedAt: new Date().toISOString() });
  const lines = [];
  const lock = await acquireHeavyLock({ cmd: "t", env: cleanEnv(lockPath), scheme: "file", timeoutMs: 2_000, log: (l) => lines.push(l) });
  assert.equal(lock.acquired, true);
  assert.match(lines.join("\n"), new RegExp(`breaking pid ${String(dead)} .* is gone`));
  assert.equal(JSON.parse(fs.readFileSync(lockPath, "utf8")).pid, process.pid);
  lock.release();
});

test("file scheme: a live pid whose process started after the lock was taken is broken (pid reused)", async () => {
  // process.pid is alive, but the process owning it started a minute after the holder wrote the lock.
  const lockPath = tempLock();
  const startedAt = Date.now() - 120_000;
  writeHolder(lockPath, { pid: process.pid, startedAt: new Date(startedAt).toISOString() });
  const lines = [];
  const readStart = async () => startedAt + 60_000;
  const lock = await acquireHeavyLock({ cmd: "t", env: cleanEnv(lockPath), scheme: "file", timeoutMs: 2_000, readStart, log: (l) => lines.push(l) });
  assert.equal(lock.acquired, true);
  assert.match(lines.join("\n"), new RegExp(`breaking pid ${String(process.pid)} .* was reused`));
  assert.equal(JSON.parse(fs.readFileSync(lockPath, "utf8")).token, lock.token);
  lock.release();
});

test("file scheme: a live holder that started long before it took the lock (a long sleep) is held; its start is read once, not per poll", async () => {
  const lockPath = tempLock();
  const startedAt = Date.now();
  writeHolder(lockPath, { pid: process.pid, startedAt: new Date(startedAt).toISOString() });
  let reads = 0;
  const readStart = async () => (reads++, startedAt - 8 * 3_600_000);
  await assert.rejects(
    acquireHeavyLock({ cmd: "t", env: cleanEnv(lockPath), scheme: "file", timeoutMs: 200, pollMs: 20, readStart, log: quiet }),
    (error) => error.code === "HEAVY_LOCK_TIMEOUT"
  );
  assert.equal(reads, 1);
  assert.equal(JSON.parse(fs.readFileSync(lockPath, "utf8")).token, "other");
});

test("file scheme: an unreadable start time falls back to the age cap", async () => {
  const readStart = async () => null;
  const fresh = tempLock();
  writeHolder(fresh, { pid: process.pid, startedAt: new Date().toISOString() });
  await assert.rejects(
    acquireHeavyLock({ cmd: "t", env: cleanEnv(fresh), scheme: "file", timeoutMs: 100, pollMs: 20, readStart, log: quiet }),
    (error) => error.code === "HEAVY_LOCK_TIMEOUT"
  );
  assert.equal(JSON.parse(fs.readFileSync(fresh, "utf8")).token, "other", "held while younger than the cap");

  const old = tempLock();
  writeHolder(old, { pid: process.pid, startedAt: new Date(Date.now() - STALE_AFTER_MS - 60_000).toISOString() });
  const lines = [];
  const lock = await acquireHeavyLock({ cmd: "t", env: cleanEnv(old), scheme: "file", timeoutMs: 2_000, readStart, log: (l) => lines.push(l) });
  assert.equal(lock.acquired, true);
  assert.match(lines.join("\n"), /held for more than 3 h/);
  lock.release();
});

test("file scheme: a nested caller trusts the file's token", async () => {
  const lockPath = tempLock();
  const env = cleanEnv(lockPath);
  const outer = await acquireHeavyLock({ cmd: "verify:all", env, scheme: "file", log: quiet });
  const inner = await acquireHeavyLock({ cmd: "run-tests", env: { ...env }, scheme: "file", timeoutMs: 100, log: quiet });
  assert.match(inner.reason, /^held by parent pid/);
  outer.release();
});

test(
  "the platform reader reads this process's start time: before this file loaded, and recent",
  { skip: process.platform === "win32" ? "Windows locks by name and reads no start time" : false },
  async () => {
    const read = await realRead;
    assert.ok(Number.isFinite(read), `no start time read on ${process.platform}`);
    assert.ok(read <= loadedAt + PID_START_TOLERANCE_MS, `read ${new Date(read).toISOString()} is after load ${new Date(loadedAt).toISOString()}`);
    assert.ok(loadedAt - read < 60_000, `read ${new Date(read).toISOString()} is not this test process`);
  }
);
