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
  DEFAULT_ORPHAN_MINUTES,
  formatHeavyLockStatus,
  heavyLockOrphanFile,
  killCommand,
  orphanMinutes,
  heavyLockPipeName,
  heavyLockStatus,
  heavyLockWaitersDir,
  lineageOf,
  isPidAlive,
  LOCK_ORPHANED_EXIT,
  LOCK_TIMEOUT_EXIT,
  PID_START_TOLERANCE_MS,
  readPidStart,
  registerWaiter,
  STALE_AFTER_MS,
  TICKET_STALE_MS
} from "./heavyLock.mjs";

/**
 * The machine-wide heavy-check lock (row V-C; an OS-owned name since row 9). Every case uses its own
 * lock file through MCP_HEAVY_LOCK_PATH — which also names its own pipe — and a clean env, so a run
 * inside a real `verify:*` hold (which exports MCP_HEAVY_LOCK_TOKEN) or under CI=true tests the lock
 * rather than skipping it. The file-scheme cases pass `scheme: "file"`; it is the lock on macOS only.
 * The clean env switches the lineage read off (MCP_HEAVY_LOCK_LINEAGE=off: ~3 s of PowerShell per hold
 * on Windows); the lineage cases stub it, and the end-to-end case reads the real process table.
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
  // No real sessions registry: a test names its own (MCP_HEAVY_LOCK_SESSIONS_FILE / sessionsFile).
  const env = { ...process.env, MCP_HEAVY_LOCK_PATH: lockPath, MCP_HEAVY_LOCK_LINEAGE: "off", MCP_HEAVY_LOCK_SAMPLE: "off", MCP_HEAVY_LOCK_SESSIONS_FILE: `${lockPath}.no-sessions.jsonl` };
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
  const left = fs.readdirSync(path.dirname(lockPath)).filter((name) => name !== "heavy-check.lock.waiters");
  assert.deepEqual(left, ["heavy-check.lock.journal"], "the last holder removes the file");
  assert.deepEqual(fs.readdirSync(heavyLockWaitersDir(lockPath)), [], "every waiter unregistered");
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

// ---- visible and orphan-safe (row H-1): waiters, lineage, status ----

test("lineageOf walks up to the Claude session process and stops at a reused parent pid", () => {
  const table = [
    { pid: 10, ppid: 9, name: "node.exe", start: 5_000 },
    { pid: 9, ppid: 8, name: "bash.exe", start: 4_000 },
    { pid: 8, ppid: 7, name: "claude.exe", start: 3_000 },
    { pid: 7, ppid: 6, name: "WindowsTerminal.exe", start: 1_000 },
    { pid: 20, ppid: 21, name: "node.exe", start: 5_000 },
    { pid: 21, ppid: 1, name: "cmd.exe", start: 60_000 }
  ];
  assert.deepEqual(lineageOf(10, table).map((a) => a.pid), [9, 8], "stops after claude.exe");
  assert.deepEqual(lineageOf(20, table), [], "pid 21 started after its 'child': the real parent is gone");
  assert.deepEqual(lineageOf(99, table), []);
});

test("a waiter registers while it waits and unregisters when it stops; status lists it", async () => {
  const lockPath = tempLock();
  const held = await acquireHeavyLock({ cmd: "holder", env: cleanEnv(lockPath), log: quiet });
  const dir = heavyLockWaitersDir(lockPath);
  let seen;
  const waiting = acquireHeavyLock({
    cmd: "queued run",
    cwd: "/queued",
    env: cleanEnv(lockPath),
    timeoutMs: 1_500,
    pollMs: 20,
    readLineage: async () => [],
    log: () => (seen ??= heavyLockStatus({ env: cleanEnv(lockPath), readTable: async () => null }))
  });
  await assert.rejects(waiting, (error) => error.code === "HEAVY_LOCK_TIMEOUT");
  const status = await seen;
  assert.equal(status.waiters.length, 1);
  assert.equal(status.waiters[0].pid, process.pid);
  assert.equal(status.waiters[0].cmd, "queued run");
  assert.equal(status.waiters[0].cwd, "/queued");
  assert.ok(Number.isFinite(Date.parse(status.waiters[0].since)));
  assert.equal(status.holder.cmd, "holder");
  assert.deepEqual(fs.readdirSync(dir), [], "the entry is gone once the wait ended");
  held.release();
});

test("a waiter entry of a dead pid is ignored and removed by status", async () => {
  const lockPath = tempLock();
  const dir = heavyLockWaitersDir(lockPath);
  fs.mkdirSync(dir);
  const dead = deadPid();
  fs.writeFileSync(path.join(dir, `${String(dead)}-x.json`), JSON.stringify({ pid: dead, cmd: "gone", since: new Date().toISOString() }));
  fs.writeFileSync(path.join(dir, "junk.json"), "{not json");
  const status = await heavyLockStatus({ env: cleanEnv(lockPath), readTable: async () => null });
  assert.deepEqual(status.waiters, []);
  assert.equal(status.cleaned, 2);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test("status shape: holder with a recorded lineage, one ancestor reused → ancestor gone, not orphan; no lineage → parent from the table", async () => {
  const lockPath = tempLock();
  const now = Date.now();
  writeHolder(lockPath, {
    pid: process.pid,
    ppid: 501,
    startedAt: new Date(now).toISOString(),
    lineage: [
      { pid: 501, name: "node.exe", start: now - 10_000 },
      { pid: 502, name: "bash.exe", start: now - 20_000 },
      { pid: 503, name: "claude.exe", start: now - 30_000 }
    ]
  });
  const table = [
    { pid: process.pid, ppid: 501, name: "node.exe", start: now - 5_000 },
    { pid: 501, ppid: 502, name: "node.exe", start: now - 10_000 },
    { pid: 502, ppid: 503, name: "notepad.exe", start: now - 1_000 }, // pid reused after bash died
    { pid: 503, ppid: 1, name: "claude.exe", start: now - 30_000 }
  ];
  const status = await heavyLockStatus({ env: cleanEnv(lockPath), readTable: async () => table });
  assert.deepEqual(Object.keys(status).sort(), ["cleaned", "holder", "nameHeld", "orphanMinutes", "path", "pipe", "processTable", "waiters"]);
  assert.equal(status.path, lockPath);
  assert.equal(status.processTable, true);
  if (PIPE) assert.equal(status.nameHeld, false, "a left-over file with the name free");
  const h = status.holder;
  assert.deepEqual(Object.keys(h).sort(), ["alive", "ancestorGone", "ancestors", "cmd", "cwd", "goneAncestors", "killHint", "orphan", "orphanSince", "parentAlive", "pid", "ppid", "repo", "session", "since"]);
  assert.equal(h.alive, true);
  assert.equal(h.parentAlive, true);
  assert.equal(h.ancestorGone, true);
  assert.equal(h.orphan, false, "the session (503) lives: one link gone is not an orphan (H-3)");
  assert.equal(h.orphanSince, null);
  assert.equal(h.killHint, null);
  assert.deepEqual(h.goneAncestors, [502]);
  assert.deepEqual(h.ancestors.map((a) => a.alive), [true, false, true]);
  const text = formatHeavyLockStatus(status);
  assert.match(text, new RegExp(`holder: pid ${String(process.pid)} \\[alive, launcher gone \\(session alive\\)\\]`));
  assert.match(text, /502 bash\.exe \(gone\)/);
  assert.match(text, /waiters: none/);

  // An older writer's holder: no ppid, no lineage — the live table answers for the parent.
  writeHolder(lockPath, { pid: process.pid, startedAt: new Date(now).toISOString() });
  const old = await heavyLockStatus({ env: cleanEnv(lockPath), readTable: async () => table });
  assert.equal(old.holder.ppid, 501);
  assert.equal(old.holder.orphan, false);
  const reparented = table.map((row) => (row.pid === 501 ? { ...row, start: now } : row));
  assert.equal((await heavyLockStatus({ env: cleanEnv(lockPath), readTable: async () => reparented })).holder.orphan, true, "parent pid reused");
});

test("a waiter whose launching process dies stops waiting instead of taking the lock later", async (t) => {
  const lockPath = tempLock();
  const held = await acquireHeavyLock({ cmd: "holder", env: cleanEnv(lockPath), log: quiet });
  const launcher = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
  t.after(() => isPidAlive(launcher.pid) && hardKill(launcher.pid));
  let announce;
  const announced = new Promise((resolve) => (announce = resolve));
  const waiting = acquireHeavyLock({
    cmd: "orphan-to-be",
    env: cleanEnv(lockPath),
    timeoutMs: 20_000,
    pollMs: 50,
    readLineage: async () => [{ pid: launcher.pid, name: "bash.exe", start: null }],
    log: () => announce()
  });
  await announced;
  assert.equal(fs.readdirSync(heavyLockWaitersDir(lockPath)).length, 1);
  hardKill(launcher.pid);
  await assert.rejects(waiting, (error) => error.code === "HEAVY_LOCK_ORPHANED" && error.message.includes(String(launcher.pid)));
  assert.deepEqual(fs.readdirSync(heavyLockWaitersDir(lockPath)), []);
  assert.equal(JSON.parse(fs.readFileSync(lockPath, "utf8")).token, held.token, "the holder was not disturbed");
  held.release();
});

test("end to end: a holder whose launching parent is killed shows ancestor gone, not orphan (its session lives); nothing is killed", async (t) => {
  // Real process table (one PowerShell read per lineage/status on Windows). The holder is detached so
  // it outlives its parent (on Windows libuv puts other children in a kill-on-close job).
  const lockPath = tempLock();
  const out = `${lockPath}.holder`;
  const env = { ...cleanEnv(lockPath), MCP_HEAVY_LOCK_LINEAGE: "on" };
  const holderScript = `
    const { acquireHeavyLock } = await import(${JSON.stringify(MODULE)});
    const { writeFileSync } = await import("node:fs");
    await acquireHeavyLock({ cmd: "orphan-holder", log: () => {} });
    writeFileSync(${JSON.stringify(out)}, String(process.pid));
    setInterval(() => {}, 60000);
  `;
  const parentScript = `
    const { spawn } = require("node:child_process");
    spawn(process.execPath, ["--input-type=module", "-e", ${JSON.stringify(holderScript)}], { stdio: "ignore", detached: true }).unref();
    setInterval(() => {}, 60000);
  `;
  const parent = spawn(process.execPath, ["-e", parentScript], { env, stdio: "ignore" });
  let holderPid = null;
  t.after(() => {
    if (isPidAlive(parent.pid)) hardKill(parent.pid);
    if (holderPid !== null && isPidAlive(holderPid)) hardKill(holderPid);
  });
  const deadline = Date.now() + 30_000;
  while (!fs.existsSync(out)) {
    assert.ok(Date.now() < deadline, "the holder never took the lock");
    await new Promise((r) => setTimeout(r, 100));
  }
  holderPid = Number(fs.readFileSync(out, "utf8"));
  const before = await heavyLockStatus({ env });
  assert.equal(before.holder.pid, holderPid);
  assert.equal(before.holder.ancestors[0].pid, parent.pid, "the parent is the first recorded ancestor");
  assert.equal(before.holder.orphan, false);
  if (PIPE) assert.equal(before.nameHeld, true);

  hardKill(parent.pid);
  await new Promise((resolve) => (parent.exitCode !== null ? resolve() : parent.once("exit", resolve)));
  const after = await heavyLockStatus({ env });
  assert.equal(after.holder.pid, holderPid);
  assert.equal(after.holder.alive, true, "status kills nothing");
  assert.equal(after.holder.ancestorGone, true);
  assert.equal(after.holder.orphan, false, "the test runner and the session above it live");
  assert.ok(after.holder.orphanSince, "launcher gone (session alive) is flagged too (H-3)");
  assert.equal(after.holder.killHint, null, "default N = 10 min: no hint yet");
  assert.equal(after.holder.parentAlive, false);
  assert.ok(after.holder.goneAncestors.includes(parent.pid));
  assert.equal(isPidAlive(holderPid), true);
});

test("an ancestor already gone when the wait begins (a spawn-and-exit wrapper) does not end the wait", async () => {
  const lockPath = tempLock();
  const held = await acquireHeavyLock({ cmd: "holder", env: cleanEnv(lockPath), log: quiet });
  await assert.rejects(
    acquireHeavyLock({
      cmd: "launched by a wrapper",
      env: cleanEnv(lockPath),
      timeoutMs: 400,
      pollMs: 20,
      readLineage: async () => [{ pid: deadPid(), name: "cmd.exe", start: null }],
      log: quiet
    }),
    (error) => error.code === "HEAVY_LOCK_TIMEOUT"
  );
  held.release();
});

test("a CLI waiter whose ancestor dies while it waits exits 76, not the timeout's 75", async (t) => {
  const lockPath = tempLock();
  const held = await acquireHeavyLock({ cmd: "holder", env: cleanEnv(lockPath), log: quiet });
  const launcher = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
  t.after(() => isPidAlive(launcher.pid) && hardKill(launcher.pid));
  const script = `
    const { holdHeavyLockOrExit } = await import(${JSON.stringify(MODULE)});
    await holdHeavyLockOrExit({ cmd: "cli waiter", pollMs: 50, timeoutMs: 20000, readLineage: async () => [{ pid: ${String(launcher.pid)}, name: "bash.exe", start: null }] });
    process.exit(0);
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { env: cleanEnv(lockPath), stdio: ["ignore", "ignore", "pipe"] });
  let err = "";
  child.stderr.on("data", (chunk) => (err += chunk));
  const exited = new Promise((resolve) => child.on("exit", resolve));
  const dir = heavyLockWaitersDir(lockPath);
  const deadline = Date.now() + 15_000;
  while (!(fs.existsSync(dir) && fs.readdirSync(dir).some((n) => n.endsWith(".json")))) {
    assert.ok(Date.now() < deadline, "the CLI waiter never registered");
    await new Promise((r) => setTimeout(r, 25));
  }
  hardKill(launcher.pid);
  assert.equal(await exited, LOCK_ORPHANED_EXIT, err);
  assert.notEqual(LOCK_ORPHANED_EXIT, LOCK_TIMEOUT_EXIT);
  assert.ok(err.includes(`ancestor pid ${String(launcher.pid)} (bash.exe)`), err);
  held.release();
});

test("a waiter entry is written aside then renamed: no temp file is left, and status ignores one in flight", async () => {
  const lockPath = tempLock();
  const held = await acquireHeavyLock({ cmd: "holder", env: cleanEnv(lockPath), log: quiet });
  const dir = heavyLockWaitersDir(lockPath);
  let listed;
  await assert.rejects(
    acquireHeavyLock({ cmd: "w", env: cleanEnv(lockPath), timeoutMs: 300, pollMs: 20, readLineage: async () => [], log: () => (listed ??= fs.readdirSync(dir)) }),
    (error) => error.code === "HEAVY_LOCK_TIMEOUT"
  );
  assert.equal(listed.length, 1);
  assert.match(listed[0], /^t\d{12}\.json$/);
  const inFlight = path.join(dir, `${String(process.pid)}-y.json.z.tmp`);
  fs.writeFileSync(inFlight, '{"pid":');
  const status = await heavyLockStatus({ env: cleanEnv(lockPath), readTable: async () => null });
  assert.equal(status.cleaned, 0);
  assert.deepEqual(status.waiters, []);
  assert.equal(fs.existsSync(inFlight), true, "a half-written entry is never read nor deleted");
  held.release();
});

// ---- orphaned holder: whole chain gone, first sighting kept, kill hint after N minutes (row H-3) ----

/** Hold the lock in this process, then rewrite the holder file (same token) with `extra` fields. */
async function holdWith(lockPath, extra, envExtra = {}) {
  const env = { ...cleanEnv(lockPath), ...envExtra };
  const held = await acquireHeavyLock({ cmd: "h3 holder", env, log: quiet });
  const written = JSON.parse(fs.readFileSync(lockPath, "utf8"));
  fs.writeFileSync(lockPath, JSON.stringify({ ...written, ...extra }));
  return { held, env, token: written.token };
}

test("orphanMinutes: default 10, fractions allowed, junk falls back", () => {
  assert.equal(orphanMinutes({}), DEFAULT_ORPHAN_MINUTES);
  assert.equal(DEFAULT_ORPHAN_MINUTES, 10);
  assert.equal(orphanMinutes({ MCP_HEAVY_LOCK_ORPHAN_MINUTES: "0.5" }), 0.5);
  assert.equal(orphanMinutes({ MCP_HEAVY_LOCK_ORPHAN_MINUTES: "0" }), 0);
  assert.equal(orphanMinutes({ MCP_HEAVY_LOCK_ORPHAN_MINUTES: "-1" }), 10);
  assert.equal(orphanMinutes({ MCP_HEAVY_LOCK_ORPHAN_MINUTES: "soon" }), 10);
  assert.equal(killCommand(1234, "win32"), "taskkill /PID 1234 /T /F");
});

test("status: a live holder whose whole recorded chain is gone is ORPHAN; orphanSince is kept; the taskkill line comes after N minutes; nothing is killed", { skip: noPipe }, async () => {
  const lockPath = tempLock();
  const t0 = Date.parse("2026-11-04T10:00:00.000Z");
  const lineage = [
    { pid: 601, name: "bash.exe", start: t0 - 10_000 },
    { pid: 602, name: "claude.exe", start: t0 - 20_000 }
  ];
  const { held, env, token } = await holdWith(lockPath, { ppid: 601, lineage }, { MCP_HEAVY_LOCK_ORPHAN_MINUTES: "0.5" });
  const me = { pid: process.pid, ppid: 601, name: "node.exe", start: t0 - 5_000 };
  const allGone = async () => [me];
  const sessionLives = async () => [me, { pid: 602, ppid: 1, name: "claude.exe", start: t0 - 20_000 }];
  const allAlive = async () => [me, { pid: 601, ppid: 602, name: "bash.exe", start: t0 - 10_000 }, { pid: 602, ppid: 1, name: "claude.exe", start: t0 - 20_000 }];

  // All alive: nothing recorded.
  const fine = await heavyLockStatus({ env, readTable: allAlive, now: t0 - 1_000 });
  assert.equal(fine.holder.ancestorGone, false);
  assert.equal(fine.holder.orphanSince, null);
  assert.equal(fs.existsSync(heavyLockOrphanFile(lockPath)), false);

  // The shell gone, the session alive (both 4 Nov incidents): flagged "launcher gone", sighting recorded.
  const partial = await heavyLockStatus({ env, readTable: sessionLives, now: t0 });
  assert.equal(partial.nameHeld, true);
  assert.equal(partial.holder.ancestorGone, true);
  assert.equal(partial.holder.orphan, false);
  assert.equal(partial.holder.orphanSince, new Date(t0).toISOString());
  assert.equal(partial.holder.killHint, null);
  assert.deepEqual(JSON.parse(fs.readFileSync(heavyLockOrphanFile(lockPath), "utf8")), { token, pid: process.pid, since: new Date(t0).toISOString() });
  const partialText = formatHeavyLockStatus(partial);
  assert.match(partialText, /\[alive, launcher gone \(session alive\)\]/);
  assert.match(partialText, /flagged launcher gone \(session alive\) since 2026-11-04T10:00:00\.000Z/);
  assert.doesNotMatch(partialText, /taskkill/);

  // Then the whole chain goes: ORPHAN, and the first sighting is kept.
  const first = await heavyLockStatus({ env, readTable: allGone, now: t0 + 1_000 });
  assert.equal(first.holder.orphan, true);
  assert.equal(first.holder.orphanSince, new Date(t0).toISOString());
  assert.equal(first.holder.killHint, null);
  const firstText = formatHeavyLockStatus(first);
  assert.match(firstText, /\[alive, ORPHAN\]/);
  assert.match(firstText, /flagged ORPHAN \(whole session chain gone\) since 2026-11-04T10:00:00\.000Z/);

  // 29 s later (N = 0.5 min): still no hint, and the first sighting is kept.
  const early = await heavyLockStatus({ env, readTable: allGone, now: t0 + 29_000 });
  assert.equal(early.holder.orphanSince, new Date(t0).toISOString());
  assert.equal(early.holder.killHint, null);

  // 31 s later: the exact command, on its own line, with the rule beneath it.
  const due = await heavyLockStatus({ env, readTable: allGone, now: t0 + 31_000 });
  assert.equal(due.holder.killHint, killCommand(process.pid));
  const lines = formatHeavyLockStatus(due).split("\n");
  const at = lines.indexOf(killCommand(process.pid));
  assert.ok(at > 0, lines.join("\n"));
  if (process.platform === "win32") assert.equal(lines[at], `taskkill /PID ${String(process.pid)} /T /F`);
  assert.match(lines[at + 1], /a leader runs it only on the owner's yes/);
  assert.equal(isPidAlive(process.pid), true);
  assert.equal(JSON.parse(fs.readFileSync(lockPath, "utf8")).token, token, "the lock was not freed");

  // The holder changes: the old sighting is dropped and the new holder starts its own clock.
  fs.writeFileSync(lockPath, JSON.stringify({ ...JSON.parse(fs.readFileSync(lockPath, "utf8")), token: "next-holder" }));
  const changed = await heavyLockStatus({ env, readTable: allGone, now: t0 + 40_000 });
  assert.equal(changed.holder.orphanSince, new Date(t0 + 40_000).toISOString());
  assert.equal(changed.holder.killHint, null);
  assert.equal(JSON.parse(fs.readFileSync(heavyLockOrphanFile(lockPath), "utf8")).token, "next-holder");

  // A holder no longer flagged clears it; so do its release and a free lock.
  await heavyLockStatus({ env, readTable: allAlive, now: t0 + 50_000 });
  assert.equal(fs.existsSync(heavyLockOrphanFile(lockPath)), false);
  fs.writeFileSync(lockPath, JSON.stringify({ ...JSON.parse(fs.readFileSync(lockPath, "utf8")), token }));
  await heavyLockStatus({ env, readTable: allGone, now: t0 + 60_000 });
  assert.equal(fs.existsSync(heavyLockOrphanFile(lockPath)), true);
  held.release();
  assert.equal(fs.existsSync(heavyLockOrphanFile(lockPath)), false, "release clears its own sighting");
  fs.writeFileSync(heavyLockOrphanFile(lockPath), JSON.stringify({ token: "gone", pid: 1, since: new Date(t0).toISOString() }));
  const free = await heavyLockStatus({ env, readTable: allGone, now: t0 + 70_000 });
  assert.equal(free.holder, null);
  assert.equal(fs.existsSync(heavyLockOrphanFile(lockPath)), false, "a free lock clears a left-over sighting");
});

test("a waiter seeing an orphaned holder records the sighting and, after N minutes, names the taskkill command in its waiting line", async () => {
  const lockPath = tempLock();
  const lineage = [
    { pid: deadPid(), name: "bash.exe", start: null },
    { pid: deadPid(), name: "claude.exe", start: null }
  ];
  const { held, token } = await holdWith(lockPath, { lineage });
  const logged = [];
  await assert.rejects(
    acquireHeavyLock({
      cmd: "w",
      env: { ...cleanEnv(lockPath), MCP_HEAVY_LOCK_ORPHAN_MINUTES: "0" },
      timeoutMs: 400,
      pollMs: 20,
      readLineage: async () => [],
      log: (line) => logged.push(line)
    }),
    (error) => error.code === "HEAVY_LOCK_TIMEOUT"
  );
  const text = logged.join("\n");
  assert.match(text, /^heavy-check lock held by pid \d+ \(h3 holder\)/);
  assert.ok(text.includes(killCommand(process.pid)), text);
  assert.match(text, /a leader runs it only on the owner's yes/);
  assert.equal(JSON.parse(fs.readFileSync(heavyLockOrphanFile(lockPath), "utf8")).token, token);
  assert.equal(JSON.parse(fs.readFileSync(lockPath, "utf8")).token, token, "the waiter neither freed nor took the lock");

  // Default N (10 min): the waiter records the sighting but prints no command yet.
  const quietLog = [];
  fs.rmSync(heavyLockOrphanFile(lockPath), { force: true });
  await assert.rejects(
    acquireHeavyLock({ cmd: "w2", env: cleanEnv(lockPath), timeoutMs: 300, pollMs: 20, readLineage: async () => [], log: (l) => quietLog.push(l) }),
    (error) => error.code === "HEAVY_LOCK_TIMEOUT"
  );
  assert.doesNotMatch(quietLog.join("\n"), /taskkill|kill -KILL/);
  assert.equal(fs.existsSync(heavyLockOrphanFile(lockPath)), true);
  held.release();
});

/**
 * Real process table. A grandparent (stands for the session) spawns a parent (stands for the shell),
 * which spawns a detached holder; the holder records only those two ancestors — the chain the test
 * can kill (the real one would end at this session's claude.exe). `kill` names which to hard-kill.
 */
async function realChain(t, kill) {
  const lockPath = tempLock();
  const out = `${lockPath}.holder`;
  const env = { ...cleanEnv(lockPath), MCP_HEAVY_LOCK_LINEAGE: "on", MCP_HEAVY_LOCK_ORPHAN_MINUTES: "0" };
  const holderScript = `
    const { acquireHeavyLock, readOwnLineage } = await import(${JSON.stringify(MODULE)});
    const { writeFileSync } = await import("node:fs");
    await acquireHeavyLock({ cmd: "orphan-holder-h3", log: () => {}, readLineage: async () => (await readOwnLineage({})).slice(0, 2) });
    writeFileSync(${JSON.stringify(out)}, String(process.pid));
    setInterval(() => {}, 60000);
  `;
  const parentScript = `
    const { spawn } = require("node:child_process");
    spawn(process.execPath, ["--input-type=module", "-e", ${JSON.stringify(holderScript)}], { stdio: "ignore", detached: true }).unref();
    setInterval(() => {}, 60000);
  `;
  const grandScript = `
    const { spawn } = require("node:child_process");
    spawn(process.execPath, ["-e", ${JSON.stringify(parentScript)}], { stdio: "ignore" });
    setInterval(() => {}, 60000);
  `;
  const grand = spawn(process.execPath, ["-e", grandScript], { env, stdio: "ignore" });
  const ids = { holder: null, parent: null, grand: grand.pid };
  t.after(() => {
    for (const pid of [ids.grand, ids.parent, ids.holder]) if (pid !== null && isPidAlive(pid)) hardKill(pid);
  });
  const deadline = Date.now() + 30_000;
  while (!fs.existsSync(out)) {
    assert.ok(Date.now() < deadline, "the holder never took the lock");
    await new Promise((r) => setTimeout(r, 100));
  }
  ids.holder = Number(fs.readFileSync(out, "utf8"));
  const before = await heavyLockStatus({ env });
  assert.equal(before.holder.pid, ids.holder);
  assert.equal(before.holder.ancestors.length, 2);
  assert.equal(before.holder.ancestors[1].pid, grand.pid, "parent, then grandparent");
  ids.parent = before.holder.ancestors[0].pid;
  assert.equal(before.holder.ancestorGone, false);
  assert.equal(before.holder.orphanSince, null);
  assert.equal(before.holder.killHint, null);

  for (const which of kill) hardKill(ids[which]);
  const until = Date.now() + 10_000;
  while (kill.some((which) => isPidAlive(ids[which]))) {
    assert.ok(Date.now() < until, `${kill.join("+")} did not die`);
    await new Promise((r) => setTimeout(r, 50));
  }
  return { env, ids, after: await heavyLockStatus({ env }) };
}

test("end to end: the shell killed, the session alive (both 4 Nov incidents) → launcher gone, flagged, taskkill line; nothing is killed", async (t) => {
  const { ids, after } = await realChain(t, ["parent"]);
  assert.equal(after.holder.pid, ids.holder);
  assert.equal(after.holder.alive, true);
  assert.equal(after.holder.ancestorGone, true);
  assert.equal(after.holder.orphan, false, "the session (grandparent) lives");
  assert.deepEqual(after.holder.goneAncestors, [ids.parent]);
  assert.ok(after.holder.orphanSince);
  assert.equal(after.holder.killHint, killCommand(ids.holder));
  const text = formatHeavyLockStatus(after);
  assert.match(text, /\[alive, launcher gone \(session alive\)\]/);
  assert.ok(text.split("\n").includes(killCommand(ids.holder)), text);
  if (PIPE) assert.equal(after.nameHeld, true, "the lock is still held: nothing reclaimed");
  assert.equal(isPidAlive(ids.holder), true, "status kills nothing");
  assert.equal(isPidAlive(ids.grand), true, "nor the session");
});

test("end to end: a holder whose whole recorded chain is killed is ORPHAN with the taskkill line; the holder lives on", async (t) => {
  const { ids, after } = await realChain(t, ["parent", "grand"]);
  assert.equal(after.holder.pid, ids.holder);
  assert.equal(after.holder.alive, true);
  assert.equal(after.holder.orphan, true);
  assert.ok(after.holder.orphanSince);
  assert.equal(after.holder.killHint, killCommand(ids.holder));
  if (PIPE) assert.equal(after.nameHeld, true, "the lock is still held: nothing reclaimed");
  assert.match(formatHeavyLockStatus(after), /\[alive, ORPHAN\]/);
  assert.ok(formatHeavyLockStatus(after).split("\n").includes(killCommand(ids.holder)));
  assert.equal(isPidAlive(ids.holder), true, "status kills nothing");
});

// ---- first come, first served (row H-2): tickets ----

const isTicket = (name) => /^t\d{12}\.json$/.test(name);
const tickets = (lockPath) => (fs.existsSync(heavyLockWaitersDir(lockPath)) ? fs.readdirSync(heavyLockWaitersDir(lockPath)).filter(isTicket).sort() : []);

async function until(predicate, what, ms = 20_000) {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, `timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** A child that waits for the lock polling every `pollMs`, appends "enter <name>" once it holds it, and releases. */
function queueInChild(lockPath, journal, name, pollMs, scheme) {
  const script = `
    const { acquireHeavyLock } = await import(${JSON.stringify(MODULE)});
    const { appendFileSync } = await import("node:fs");
    const lock = await acquireHeavyLock({ cmd: ${JSON.stringify(name)}, pollMs: ${String(pollMs)}, timeoutMs: 120000, scheme: ${JSON.stringify(scheme)}, readStart: async () => null, log: () => {} });
    appendFileSync(${JSON.stringify(journal)}, "enter ${name}\\n");
    await new Promise((r) => setTimeout(r, 50));
    lock.release();
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { env: cleanEnv(lockPath), stdio: ["ignore", "ignore", "pipe"] });
  let err = "";
  child.stderr.on("data", (chunk) => (err += chunk));
  const done = new Promise((resolve, reject) => child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${name} exit ${String(code)}: ${err}`)))));
  return Object.assign(done, { child });
}

for (const scheme of [undefined, "file"]) {
  test(`FIFO${scheme ? " (file scheme)" : ""}: A, B, C arrive in that order and acquire in that order though C polls 60x faster; status lists them by ticket`, { skip: scheme === undefined ? noPipe : false }, async (t) => {
    // Its own lock path (so its own pipe name and waiters dir); every child and the hold end with the
    // test, pass or fail, so nothing it started can hold or queue on any later test's lock.
    const lockPath = tempLock();
    const journal = `${lockPath}.journal`;
    const held = await acquireHeavyLock({ cmd: "holder", env: cleanEnv(lockPath), scheme, log: quiet });
    const runs = [];
    t.after(() => {
      held.release();
      for (const run of runs) if (run.child.exitCode === null && isPidAlive(run.child.pid)) hardKill(run.child.pid);
    });
    for (const [name, pollMs] of [["A", 300], ["B", 300], ["C", 5]]) {
      const before = tickets(lockPath).length;
      runs.push(queueInChild(lockPath, journal, name, pollMs, scheme));
      // Generous under machine load: a child's node start-up is all that is measured here.
      await until(() => tickets(lockPath).length === before + 1, `${name}'s ticket`, 60_000);
    }
    const status = await heavyLockStatus({ env: cleanEnv(lockPath), readTable: async () => null });
    assert.deepEqual(status.waiters.map((w) => [w.position, w.cmd]), [[1, "A"], [2, "B"], [3, "C"]]);
    assert.deepEqual(status.waiters.map((w) => w.ticket), [...status.waiters.map((w) => w.ticket)].sort((a, b) => a - b));
    const text = formatHeavyLockStatus(status);
    assert.match(text, /waiters \(3, in ticket order — first come, first served\):/);
    assert.match(text, /#1 ticket \d+: pid \d+/);
    // Let C poll a while against the held lock before freeing it.
    await new Promise((r) => setTimeout(r, 200));
    held.release();
    await Promise.all(runs);
    assert.deepEqual(fs.readFileSync(journal, "utf8").trim().split("\n"), ["enter A", "enter B", "enter C"]);
    assert.deepEqual(tickets(lockPath), [], "every ticket removed once its caller held the lock");
  });
}

test("tickets: arrivals get distinct, increasing numbers; a new arrival goes above the highest present", () => {
  const lockPath = tempLock();
  const ws = Array.from({ length: 12 }, (_, i) => registerWaiter(lockPath, { token: `t${String(i)}`, cmd: "w", cwd: "/" }));
  assert.deepEqual(ws.map((w) => w.ticket), Array.from({ length: 12 }, (_, i) => i + 1));
  assert.equal(ws[11].ahead(), 11);
  ws[0].unregister();
  ws[5].unregister();
  assert.equal(ws[11].ahead(), 9);
  const late = registerWaiter(lockPath, { token: "late", cmd: "w", cwd: "/" });
  assert.equal(late.ticket, 13, "above the highest present");
  for (const w of [...ws, late]) w.unregister();
  assert.deepEqual(tickets(lockPath), []);
});

/** Plant a ticket ahead of every real one: number 1, from `record`, touched `ageMs` ago. */
function plantTicket(lockPath, record, ageMs = 0) {
  const dir = heavyLockWaitersDir(lockPath);
  fs.mkdirSync(dir, { recursive: true });
  const full = path.join(dir, "t000000000001.json");
  fs.writeFileSync(full, JSON.stringify({ token: "planted", cmd: "planted", cwd: "/", since: new Date().toISOString(), pollMs: 2_000, ticket: 1, ...record }));
  if (ageMs > 0) {
    const at = new Date(Date.now() - ageMs);
    fs.utimesSync(full, at, at);
  }
  return full;
}

test("a ticket ahead whose pid is dead is skipped and removed", async () => {
  const lockPath = tempLock();
  const planted = plantTicket(lockPath, { pid: deadPid() });
  const lock = await acquireHeavyLock({ cmd: "t", env: cleanEnv(lockPath), timeoutMs: 2_000, pollMs: 20, log: quiet });
  assert.equal(lock.acquired, true);
  assert.equal(fs.existsSync(planted), false);
  lock.release();
});

test("a ticket ahead whose waiter is orphaned (an ancestor alive at arrival is gone) is skipped and removed", async () => {
  const lockPath = tempLock();
  const planted = plantTicket(lockPath, { pid: process.pid, watched: [{ pid: deadPid(), name: "bash.exe", start: null }] });
  const lock = await acquireHeavyLock({ cmd: "t", env: cleanEnv(lockPath), timeoutMs: 2_000, pollMs: 20, log: quiet });
  assert.equal(lock.acquired, true);
  assert.equal(fs.existsSync(planted), false);
  lock.release();
});

test("a ticket ahead of a live pid that stopped touching it (hung, or pid reused) is skipped; a fresh one holds the caller back", async () => {
  const lockPath = tempLock();
  const silent = plantTicket(lockPath, { pid: process.pid }, TICKET_STALE_MS + 5_000);
  const lock = await acquireHeavyLock({ cmd: "t", env: cleanEnv(lockPath), timeoutMs: 2_000, pollMs: 20, log: quiet });
  assert.equal(lock.acquired, true);
  assert.equal(fs.existsSync(silent), false);
  lock.release();

  const fresh = plantTicket(lockPath, { pid: process.pid });
  await assert.rejects(
    acquireHeavyLock({ cmd: "t", env: cleanEnv(lockPath), timeoutMs: 300, pollMs: 20, log: quiet }),
    (error) => error.code === "HEAVY_LOCK_TIMEOUT"
  );
  assert.equal(fs.existsSync(lockPath), false, "the lock was free all along: the waiter held back for the ticket ahead");
  assert.deepEqual(tickets(lockPath), ["t000000000001.json"], "only the planted ticket is left");
  fs.rmSync(fresh);
});

test("a waiter that times out removes its ticket and the one behind it moves up and proceeds", async () => {
  const lockPath = tempLock();
  const held = await acquireHeavyLock({ cmd: "holder", env: cleanEnv(lockPath), log: quiet });
  const first = acquireHeavyLock({ cmd: "first", env: cleanEnv(lockPath), timeoutMs: 400, pollMs: 20, log: quiet });
  await until(() => tickets(lockPath).length === 1, "first's ticket");
  const second = acquireHeavyLock({ cmd: "second", env: cleanEnv(lockPath), timeoutMs: 10_000, pollMs: 20, log: quiet });
  await until(() => tickets(lockPath).length === 2, "second's ticket");
  await assert.rejects(first, (error) => error.code === "HEAVY_LOCK_TIMEOUT");
  const status = await heavyLockStatus({ env: cleanEnv(lockPath), readTable: async () => null });
  assert.deepEqual(status.waiters.map((w) => [w.position, w.cmd]), [[1, "second"]]);
  held.release();
  const lock = await second;
  assert.equal(lock.acquired, true);
  assert.deepEqual(tickets(lockPath), []);
  lock.release();
});

test("status drops a ticket whose heartbeat stopped, and shows an orphaned waiter's ticket (that waiter stops itself, exit 76)", async () => {
  const lockPath = tempLock();
  plantTicket(lockPath, { pid: process.pid }, TICKET_STALE_MS + 5_000);
  fs.writeFileSync(
    path.join(heavyLockWaitersDir(lockPath), "t000000000002.json"),
    JSON.stringify({ pid: process.pid, token: "o", cmd: "orphaned", since: new Date().toISOString(), ticket: 2, lineage: [{ pid: deadPid(), name: "bash.exe", start: null }], watched: [] })
  );
  const status = await heavyLockStatus({ env: cleanEnv(lockPath), readTable: async () => null });
  assert.equal(status.cleaned, 1);
  assert.deepEqual(status.waiters.map((w) => [w.position, w.ticket, w.cmd, w.orphan]), [[1, 2, "orphaned", true]]);
});

// ---- the deploy copy (row H-5): what other repos run ----

test("deploy: a self-contained copy under a scratch deploy root runs status and a command from a foreign cwd, importing nothing outside it", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "heavy-lock-deploy-"));
  // --allow-dirty: this runs from the working tree, which may hold uncommitted edits while developing;
  // the dirty refusal itself is tested on a scratch repo below.
  const deploy = (args = []) => spawnSync(process.execPath, [CLI, "deploy", "--deploy-root", root, "--json", "--allow-dirty", ...args], { encoding: "utf8" });
  const first = deploy();
  assert.equal(first.status, 0, first.stderr);
  const record = JSON.parse(first.stdout);
  assert.equal(record.key, "heavy-lock");
  assert.equal(record.n, 1);
  assert.deepEqual(record.files, ["heavy-lock.mjs", "lib/deploy.mjs", "lib/heavyLock.mjs", "lib/heavyLockHistory.mjs"]);
  assert.deepEqual(record.pruneSkipped, []);
  const keyDir = path.join(root, "heavy-lock");
  assert.equal(record.stable, path.join(keyDir, "heavy-lock.mjs"));
  assert.equal(fs.readFileSync(record.stable, "utf8"), fs.readFileSync(path.join(HERE, "heavyLockEntry.mjs"), "utf8"), "the stable entry is lib/heavyLockEntry.mjs, verbatim");
  assert.equal(JSON.parse(fs.readFileSync(path.join(keyDir, "current.json"), "utf8")).entry, record.entry);
  assert.match(record.hash, /^[0-9a-f]{64}$/);

  // Every module the copy loads is a builtin or a file inside the deploy root: traced by a resolve hook
  // that lives outside both, run from a cwd outside both.
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "heavy-lock-cwd-"));
  const hook = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "heavy-lock-hook-")), "trace.mjs");
  const trace = path.join(elsewhere, "trace.txt");
  fs.writeFileSync(
    hook,
    'import { registerHooks } from "node:module";\nimport { appendFileSync } from "node:fs";\n' +
      "registerHooks({ resolve(specifier, context, next) { const r = next(specifier, context); appendFileSync(process.env.HL_TRACE, r.url + '\\n'); return r; } });\n"
  );
  const lockPath = tempLock();
  const run = (args) =>
    spawnSync(process.execPath, ["--import", pathToFileURL(hook).href, record.stable, ...args], { cwd: elsewhere, env: { ...cleanEnv(lockPath), HL_TRACE: trace }, encoding: "utf8" });
  const status = run(["status", "--json"]);
  assert.equal(status.status, 0, status.stderr);
  assert.equal(JSON.parse(status.stdout).path, lockPath);
  // "node" from PATH: on Windows the CLI runs the command through a shell, which splits an unquoted path with spaces.
  const command = run(["--", "node", "-e", "process.exit(3)"]);
  assert.equal(command.status, 3, command.stderr);
  const urls = fs.readFileSync(trace, "utf8").trim().split("\n");
  const inside = pathToFileURL(root).href.toLowerCase();
  const strays = urls.filter((u) => !u.startsWith("node:") && !u.toLowerCase().startsWith(inside));
  assert.deepEqual(strays, [], "imports resolved outside the deploy root");
  assert.ok(urls.some((u) => u.endsWith(`/${record.entry}`)), "the stable entry ran the current copy");
  assert.ok(urls.some((u) => u.endsWith("/scripts/lib/heavyLock.mjs")));

  // A deployed copy refuses to deploy itself; three more deploys keep the newest three.
  const self = spawnSync(process.execPath, [path.join(record.dir, "scripts", "heavy-lock.mjs"), "deploy", "--deploy-root", root], { encoding: "utf8" });
  assert.equal(self.status, 1);
  assert.match(self.stderr, /deployed copy/);
  let last;
  for (let i = 0; i < 3; i++) last = JSON.parse(deploy().stdout);
  assert.equal(last.n, 4);
  assert.equal(JSON.parse(fs.readFileSync(path.join(keyDir, "current.json"), "utf8")).n, 4);
  const kept = fs.readdirSync(keyDir).filter((n) => /-\d+$/.test(n)).map((n) => Number(/-(\d+)$/.exec(n)[1])).sort();
  assert.deepEqual(kept, [2, 3, 4]);
  assert.equal(run(["status"]).status, 0, "the stable entry follows current.json");
});

// ---- H-2 review follow-ups ----

test("heartbeat: only ENOENT re-queues; an EPERM keeps the one ticket it has", () => {
  const lockPath = tempLock();
  let fail = null;
  const w = registerWaiter(lockPath, { token: "hb", cmd: "w", cwd: "/", touch: (p, at) => (fail ? (() => { throw fail; })() : fs.utimesSync(p, at, at)) });
  assert.equal(w.ticket, 1);
  fail = Object.assign(new Error("busy"), { code: "EPERM" });
  w.heartbeat();
  assert.equal(w.ticket, 1);
  assert.deepEqual(tickets(lockPath), ["t000000000001.json"], "no second ticket queued behind itself");
  const other = registerWaiter(lockPath, { token: "o", cmd: "w", cwd: "/" });
  fs.rmSync(w.entry);
  fail = Object.assign(new Error("gone"), { code: "ENOENT" });
  w.heartbeat();
  assert.equal(w.ticket, 3, "gone: queued again at the back");
  assert.deepEqual(tickets(lockPath), ["t000000000002.json", "t000000000003.json"]);
  w.unregister();
  other.unregister();
});

test("ahead(): a dead ticket that cannot be removed (EPERM) counts as ahead for that poll, and nothing throws", () => {
  const lockPath = tempLock();
  const planted = plantTicket(lockPath, { pid: deadPid() });
  let blocked = true;
  const w = registerWaiter(lockPath, {
    token: "rm",
    cmd: "w",
    cwd: "/",
    remove: (p) => {
      if (blocked) throw Object.assign(new Error("busy"), { code: "EPERM" });
      fs.rmSync(p, { force: true });
    }
  });
  assert.equal(w.ahead(), 1);
  assert.equal(fs.existsSync(planted), true);
  blocked = false;
  assert.equal(w.ahead(), 0);
  assert.equal(fs.existsSync(planted), false);
  w.unregister();
});

test("ahead(): a waiter whose own ticket was removed (judged silent) takes a new one at the back", () => {
  const lockPath = tempLock();
  const w1 = registerWaiter(lockPath, { token: "1", cmd: "w", cwd: "/" });
  const w2 = registerWaiter(lockPath, { token: "2", cmd: "w", cwd: "/" });
  fs.rmSync(w1.entry);
  assert.equal(w1.ahead(), 1, "behind w2 now");
  assert.equal(w1.ticket, 3);
  assert.equal(w2.ahead(), 0);
  w1.unregister();
  w2.unregister();
});

test("the ticket is taken before the lineage read: a slow read keeps its place, and the lineage is written into the ticket", async () => {
  const lockPath = tempLock();
  const held = await acquireHeavyLock({ cmd: "holder", env: cleanEnv(lockPath), log: quiet });
  const ancestor = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
  try {
    let finishRead;
    const slowRead = new Promise((resolve) => (finishRead = resolve));
    const order = [];
    const slow = acquireHeavyLock({ cmd: "slow-lineage", env: cleanEnv(lockPath), timeoutMs: 10_000, pollMs: 20, readLineage: () => slowRead, log: quiet }).then((l) => (order.push("slow"), l.release()));
    await until(() => tickets(lockPath).length === 1, "the slow caller's ticket, before its lineage read ends");
    const fast = acquireHeavyLock({ cmd: "fast-lineage", env: cleanEnv(lockPath), timeoutMs: 10_000, pollMs: 5, readLineage: async () => [], log: quiet }).then((l) => (order.push("fast"), l.release()));
    await until(() => tickets(lockPath).length === 2, "the fast caller's ticket");
    finishRead([{ pid: ancestor.pid, name: "bash.exe", start: null }]);
    await until(() => JSON.parse(fs.readFileSync(path.join(heavyLockWaitersDir(lockPath), "t000000000001.json"), "utf8")).watched?.length === 1, "the lineage written into the ticket");
    const first = JSON.parse(fs.readFileSync(path.join(heavyLockWaitersDir(lockPath), "t000000000001.json"), "utf8"));
    assert.equal(first.cmd, "slow-lineage");
    assert.deepEqual(first.lineage.map((a) => a.pid), [ancestor.pid]);
    held.release();
    await Promise.all([slow, fast]);
    assert.deepEqual(order, ["slow", "fast"]);
  } finally {
    hardKill(ancestor.pid);
  }
});

test("SIGINT or SIGTERM while waiting removes the ticket and exits 130", async () => {
  const lockPath = tempLock();
  const script = `
    const { registerWaiter } = await import(${JSON.stringify(MODULE)});
    registerWaiter(process.env.MCP_HEAVY_LOCK_PATH, { token: "sig", cmd: "w", cwd: "/" });
    process.emit(process.argv[1]);
    setTimeout(() => process.exit(0), 5000);
  `;
  for (const signal of ["SIGINT", "SIGTERM"]) {
    const run = spawnSync(process.execPath, ["--input-type=module", "-e", script, signal], { env: cleanEnv(lockPath), encoding: "utf8" });
    assert.equal(run.status, 130, run.stderr);
    assert.deepEqual(tickets(lockPath), [], `${signal}: no ticket left`);
  }
});

// ---- whose lock is it: repo and Claude session per holder and waiter (owner, 5 Nov) ----

test("status names each holder's and waiter's repo (git common dir) and Claude session (registry row of the claude pid); unknown otherwise", async () => {
  const lockPath = tempLock();
  const repoDir = path.join(HERE, "..", "..");
  const common = spawnSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: repoDir, encoding: "utf8" }).stdout.trim();
  const expectedRepo = path.basename(common) === ".git" ? path.basename(path.dirname(common)) : path.basename(common);
  const t0 = Date.now() - 600_000;
  writeHolder(lockPath, {
    pid: process.pid,
    cwd: repoDir,
    startedAt: new Date(t0 + 60_000).toISOString(),
    lineage: [
      { pid: 801, name: "bash.exe", start: t0 + 1_000 },
      { pid: 800, name: "claude.exe", start: t0 }
    ]
  });
  const sessionsFile = `${lockPath}.sessions.jsonl`;
  const row = (session, pid, at) => JSON.stringify({ session, repo: "x", pid, at: new Date(at).toISOString() });
  fs.writeFileSync(
    sessionsFile,
    [row("reused-pid-earlier-owner", 800, t0 - 3_600_000), row("s-older", 800, t0 + 500), row("s-holder", 800, t0 + 2_000), "{broken", row("other", 900, t0 + 2_000)].join("\n") + "\n"
  );
  // A trim moved part of the registry aside: its rows count too.
  fs.writeFileSync(`${sessionsFile}.4242.trimming`, row("s-waiter", 950, t0 + 3_000) + "\n");
  const dir = heavyLockWaitersDir(lockPath);
  fs.mkdirSync(dir, { recursive: true });
  const other = fs.mkdtempSync(path.join(os.tmpdir(), "heavy-lock-nogit-"));
  fs.writeFileSync(
    path.join(dir, "t000000000001.json"),
    JSON.stringify({ pid: process.pid, token: "w1", cmd: "w1", cwd: repoDir, since: new Date().toISOString(), ticket: 1, pollMs: 2_000, lineage: [{ pid: 950, name: "claude", start: t0 }] })
  );
  fs.writeFileSync(
    path.join(dir, "t000000000002.json"),
    JSON.stringify({ pid: process.pid, token: "w2", cmd: "w2", cwd: other, since: new Date().toISOString(), ticket: 2, pollMs: 2_000, lineage: [{ pid: 951, name: "bash.exe", start: t0 }] })
  );
  const status = await heavyLockStatus({ env: cleanEnv(lockPath), readTable: async () => null, sessionsFile });
  assert.equal(status.holder.repo, expectedRepo);
  assert.equal(status.holder.session, "s-holder", "newest row of the claude pid written after it started");
  assert.deepEqual(status.waiters.map((w) => [w.cmd, w.repo, w.session]), [["w1", expectedRepo, "s-waiter"], ["w2", "unknown", "unknown"]]);
  const text = formatHeavyLockStatus(status);
  assert.ok(text.includes(`repo: ${expectedRepo} · session: s-holder`), text);
  assert.ok(text.includes("repo: unknown · session: unknown"), text);

  // No registry at all, and a holder without a recorded claude ancestor: unknown, nothing thrown.
  writeHolder(lockPath, { pid: process.pid, cwd: other, startedAt: new Date().toISOString(), lineage: [] });
  const bare = await heavyLockStatus({ env: cleanEnv(lockPath), readTable: async () => null, sessionsFile: path.join(other, "missing.jsonl") });
  assert.equal(bare.holder.session, "unknown");
  assert.equal(bare.holder.repo, "unknown");
});

// ---- deploy review follow-ups (M, L1, L3, L4) ----

test("stable entry: a broken deploy exits 78 with one line — no current.json, bad JSON, its copy pruned, a module missing", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "heavy-lock-broken-"));
  const made = spawnSync(process.execPath, [CLI, "deploy", "--deploy-root", root, "--json", "--allow-dirty"], { encoding: "utf8" });
  assert.equal(made.status, 0, made.stderr);
  const record = JSON.parse(made.stdout);
  const keyDir = path.join(root, "heavy-lock");
  const current = path.join(keyDir, "current.json");
  const good = fs.readFileSync(current, "utf8");
  const run = () => spawnSync(process.execPath, [record.stable, "status"], { env: cleanEnv(tempLock()), encoding: "utf8" });
  assert.equal(run().status, 0);
  const cases = [
    ["no current.json", () => fs.rmSync(current), /no current\.json/],
    ["bad JSON", () => fs.writeFileSync(current, "{half"), /current\.json is not JSON/],
    ["no entry", () => fs.writeFileSync(current, "{}"), /names no entry/],
    ["copy pruned", () => fs.writeFileSync(current, JSON.stringify({ ...JSON.parse(good), entry: "gone-9/scripts/heavy-lock.mjs" })), /gone-9\/scripts\/heavy-lock\.mjs is missing/],
    ["module missing", () => (fs.writeFileSync(current, good), fs.rmSync(path.join(record.dir, "scripts", "lib", "heavyLock.mjs"))), /Cannot find module/]
  ];
  for (const [what, breakIt, message] of cases) {
    breakIt();
    const r = run();
    assert.equal(r.status, 78, `${what}: ${r.stderr}`);
    assert.match(r.stderr, /^heavy-lock deploy broken: /, what);
    assert.match(r.stderr, message, what);
    assert.equal(r.stderr.trim().split("\n").length, 1, `${what}: one line, no stack`);
  }
});

test("deploy: --deploy-root without a value is a usage error (exit 2); nothing is written", () => {
  for (const args of [["--deploy-root"], ["--deploy-root", "--json"]]) {
    const r = spawnSync(process.execPath, [CLI, "deploy", ...args], { encoding: "utf8" });
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /--deploy-root needs a directory/);
  }
});

/** A scratch git repo holding a committed copy of the three deployable scripts and the entry. */
function scratchSource({ git = true } = {}) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "heavy-lock-src-"));
  for (const rel of ["heavy-lock.mjs", "lib/deploy.mjs", "lib/heavyLock.mjs", "lib/heavyLockHistory.mjs", "lib/heavyLockEntry.mjs"]) {
    const dest = path.join(repo, "scripts", ...rel.split("/"));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(HERE, "..", ...rel.split("/")), dest);
  }
  if (git) {
    const g = (...args) => assert.equal(spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: repo, encoding: "utf8" }).status, 0, args.join(" "));
    g("init", "-q");
    g("add", "scripts");
    g("commit", "-q", "-m", "scratch");
  }
  return { repo, cli: path.join(repo, "scripts", "heavy-lock.mjs") };
}

test("deploy: refuses uncommitted copied files and a tree git cannot read, unless --allow-dirty", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "heavy-lock-dirty-"));
  const deployFrom = (cli, ...extra) => spawnSync(process.execPath, [cli, "deploy", "--deploy-root", root, "--json", ...extra], { encoding: "utf8" });
  const { repo, cli } = scratchSource();
  const clean = deployFrom(cli);
  assert.equal(clean.status, 0, clean.stderr);
  assert.equal(JSON.parse(clean.stdout).dirty, false);
  fs.appendFileSync(path.join(repo, "scripts", "lib", "heavyLock.mjs"), "\n// edit\n");
  const dirty = deployFrom(cli);
  assert.equal(dirty.status, 1);
  assert.match(dirty.stderr, /uncommitted changes in the copied files/);
  assert.match(dirty.stderr, /lib\/heavyLock\.mjs/);
  const allowed = deployFrom(cli, "--allow-dirty");
  assert.equal(allowed.status, 0, allowed.stderr);
  assert.equal(JSON.parse(allowed.stdout).dirty, true);

  const nogit = scratchSource({ git: false });
  const unknown = deployFrom(nogit.cli);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /git cannot tell whether the copied files are committed/);
});

test("deploy: refuses a copy that would import anything it did not copy (bare, single-quoted, dynamic)", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "heavy-lock-foreign-"));
  // A static import of a missing module would crash the CLI before it could refuse, so those two sit
  // in a template literal (the scanner reads text; node never loads them) and the dynamic ones in a
  // function nobody calls.
  for (const [line, shown] of [
    ['const probe1 = `\nimport leftPad from "left-pad";\n`;', "left-pad"],
    ["const probe2 = `\nimport { x } from '../outside.mjs';\n`;", "../outside.mjs"],
    ['function probe3() { return import("@mcp/manifest"); }', "@mcp/manifest"],
    ["function probe4(name) { return import(name); }", "name"]
  ]) {
    const { cli } = scratchSource({ git: false });
    fs.appendFileSync(path.join(path.dirname(cli), "lib", "deploy.mjs"), `\n${line}\n`);
    const r = spawnSync(process.execPath, [cli, "deploy", "--deploy-root", root, "--allow-dirty"], { encoding: "utf8" });
    assert.equal(r.status, 1, line);
    assert.ok(r.stderr.includes(`not be self-contained: lib/deploy.mjs imports ${shown}`), `${line}: ${r.stderr}`);
  }
  assert.equal(fs.existsSync(path.join(root, "heavy-lock")), false, "a refused copy writes nothing");
});

test("ahead(): an older ticket carrying this wait's own token is removed and never waited for", () => {
  const lockPath = tempLock();
  const planted = plantTicket(lockPath, { pid: process.pid, token: "me" });
  const w = registerWaiter(lockPath, { token: "me", cmd: "w", cwd: "/" });
  assert.equal(w.ticket, 2);
  assert.equal(w.ahead(), 0);
  assert.equal(fs.existsSync(planted), false);
  w.unregister();
});
