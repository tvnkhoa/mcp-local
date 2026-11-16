/**
 * Children of a gate runner die with it, and nothing else does (row P1, 2026-11-16).
 *
 * `run-tests.mjs` and `run-servers.mjs` used to run each script with `spawnSync`: the event loop was
 * blocked for the whole child, so nothing in the runner could react to being stopped. Measured on
 * Windows (P1 evidence): killing the SHELL above the runner — the way a tool call is stopped — left the
 * runner, its harness children and the heavy lock running (rows #10 and #13); a hard kill of the runner
 * itself is not reliably cleaned up by libuv's job object either (one probe: the registered cmd.exe died,
 * its npm/node subtree lived on). This module:
 *
 * 1. spawns each child asynchronously and registers it while it runs (`tracker.run`);
 * 2. on SIGINT / SIGTERM / SIGBREAK / SIGHUP kills every registered child's tree, then exits 130 — the
 *    `exit` listeners then run, the heavy lock's release among them;
 * 3. on `exit` kills whatever is still registered (a runner that throws or calls `process.exit`);
 * 4. stops when orphaned: it reads its ancestors once (heavyLock.mjs `readOwnLineage`, up to the Claude
 *    session process) and polls them; when one alive at start is gone, the runner was stopped from above,
 *    so it kills its children's trees and exits 130. A reused ancestor pid passes for alive — the
 *    conservative side. `MCP_HEAVY_LOCK_LINEAGE=off` turns this off with the lock's own lineage read;
 * 5. starts a watchdog: a small separate node process holding a stdin pipe from the runner. A hard kill
 *    (`taskkill /F`, TerminateProcess, SIGKILL) runs no handler in the runner, so only another process
 *    can clean up: when the pipe closes and the pid file is still there, the watchdog kills the trees of
 *    the children last registered, removes the runner's heavy-lock holder file when it still names the
 *    runner's token, and exits. After a normal exit the pid file is gone and it exits killing nothing.
 *
 * **No kill reaches a process that is not provably ours** (`planKills`). Nothing is found by name and no
 * kill walks the tree for us (`taskkill /T` follows parent pids with no identity check, and an orphan's
 * parent pid can name a process long dead). One process-table read (pid, ppid, start time), then:
 * - a registered root still in the table is ours only if it started between its spawn time and the last
 *   time it was seen registered (± `START_SLACK_MS`); otherwise its pid was reused and it, and everything
 *   under it, is left alone;
 * - a registered root that is gone (the job object or a crash took it): its direct children count only if
 *   they started after its spawn and before the deadline (the moment the runner was found gone);
 * - below a verified process, a child counts when its parent pid names it and it started no earlier.
 * Every verified pid is killed by itself (`taskkill /F /PID …`, an argv array; POSIX: SIGKILL). When the
 * table cannot be read, the runner kills only the root through its own ChildProcess handle (which cannot
 * name a reused pid: the handle is held until it exits) and the watchdog kills nothing.
 */

import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { readOwnLineage } from "./heavyLock.mjs";

const SELF = fileURLToPath(import.meta.url);
const WATCH_FLAG = "--watch-runner";
export const WATCH_POLL_MS = 250;
export const ORPHAN_POLL_MS = 1000;
/** Start times disagree by up to this much between clocks (`ps lstart`, /proc btime: 1 s resolution). */
export const START_SLACK_MS = 1000;
export const SIGNALS = ["SIGINT", "SIGTERM", "SIGBREAK", "SIGHUP"];

const WIN_TABLE =
  "Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate | " +
  "ForEach-Object { '{0} {1} {2}' -f $_.ProcessId,$_.ParentProcessId,$(if($_.CreationDate){([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds()}else{''}) }";

/** Every process as `[{pid, ppid, start}]` (start in epoch ms or null), read synchronously; `null` when unreadable. */
export function readTableSync(platform = process.platform) {
  const r =
    platform === "win32"
      ? spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", WIN_TABLE], { encoding: "utf8", windowsHide: true, timeout: 20_000, maxBuffer: 16 * 1024 * 1024 })
      : spawnSync("ps", ["-A", "-o", "pid=,ppid=,lstart="], { encoding: "utf8", timeout: 20_000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, LC_ALL: "C" } });
  if (r.status !== 0 || typeof r.stdout !== "string") return null;
  const rows = [];
  for (const line of r.stdout.split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(\d+)\s*(.*)$/.exec(line);
    if (m === null) continue;
    const rest = m[3].trim();
    const start = rest === "" ? null : /^\d+$/.test(rest) ? Number(rest) : Date.parse(rest);
    rows.push({ pid: Number(m[1]), ppid: Number(m[2]), start: Number.isFinite(start) ? start : null });
  }
  return rows.length > 0 ? rows : null;
}

/**
 * The pids to kill, parents first: the verified trees of `roots` (`[{pid, spawnedAt, lastSeen}]`) in
 * `table`. `deadline`: no process started after it counts as the child of a root that is gone.
 */
export function planKills({ roots, table, deadline, slack = START_SLACK_MS }) {
  const byPid = new Map(table.map((row) => [row.pid, row]));
  const kids = new Map();
  for (const row of table) kids.set(row.ppid, [...(kids.get(row.ppid) ?? []), row]);
  const ok = (n) => Number.isFinite(n);
  const verified = [];
  const seen = new Set();
  const take = (row) => {
    if (seen.has(row.pid) || row.pid === process.pid) return;
    seen.add(row.pid);
    verified.push(row);
  };
  for (const root of roots) {
    if (!Number.isInteger(root?.pid) || root.pid <= 0 || !ok(root.spawnedAt)) continue;
    const row = byPid.get(root.pid);
    if (row !== undefined) {
      const lastSeen = ok(root.lastSeen) ? root.lastSeen : deadline;
      if (ok(row.start) && row.start >= root.spawnedAt - slack && row.start <= lastSeen + slack) take(row);
      continue; // a pid now held by a process that started outside the window was reused: leave its tree alone
    }
    for (const child of kids.get(root.pid) ?? []) {
      if (ok(child.start) && child.start >= root.spawnedAt - slack && child.start <= deadline) take(child);
    }
  }
  for (let i = 0; i < verified.length; i++) {
    const parent = verified[i];
    for (const child of kids.get(parent.pid) ?? []) {
      if (ok(child.start) && ok(parent.start) && child.start >= parent.start) take(child);
    }
  }
  return verified.map((row) => row.pid);
}

/** `[command, args]` that force-kills exactly `pids` on Windows (no /T), or null elsewhere — exported for the test. */
export function killCommand(pids, platform = process.platform) {
  return platform === "win32" ? ["taskkill", ["/F", ...pids.flatMap((pid) => ["/PID", String(pid)])]] : null;
}

/** Kill each of `pids` by itself. */
export function killPids(pids, platform = process.platform) {
  if (pids.length === 0) return;
  const cmd = killCommand(pids, platform);
  if (cmd !== null) {
    spawnSync(cmd[0], cmd[1], { stdio: "ignore", windowsHide: true });
    return;
  }
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
}

export function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

/**
 * The runner's tracker. Create it BEFORE taking the heavy lock: its signal listeners must run first
 * (the lock's own SIGINT/SIGTERM listener exits the process, and would leave the children running).
 * `name` labels the pid file. `watchdog: false` skips the watchdog; `stopWhenOrphaned: false` skips the
 * ancestor watch (both for tests of the tracker alone). `readLineage` is injectable for tests.
 */
export function createChildTracker({ name = "runner", watchdog = true, stopWhenOrphaned = true, readLineage = readOwnLineage } = {}) {
  const live = new Map(); // pid -> { child, spawnedAt } while the child has not exited
  const pidFile = path.join(os.tmpdir(), `mcp-children-${name}-${String(process.pid)}-${crypto.randomBytes(4).toString("hex")}.json`);
  let lock = null;
  let closed = false;

  const writePids = () => {
    if (closed) return;
    const body = JSON.stringify({ runner: process.pid, at: Date.now(), children: [...live].map(([pid, e]) => ({ pid, spawnedAt: e.spawnedAt })), lock });
    try {
      fs.writeFileSync(`${pidFile}.tmp`, body);
      fs.renameSync(`${pidFile}.tmp`, pidFile);
    } catch {
      // the in-process handlers still cover a soft stop
    }
  };

  const killAll = () => {
    // Only children that have not exited: the handle is still held (unreaped), so each pid is still ours.
    const running = [...live].filter(([, { child }]) => child.exitCode === null && child.signalCode === null);
    live.clear();
    if (running.length === 0) return;
    const now = Date.now();
    const table = readTableSync();
    if (table === null) {
      for (const [, { child }] of running) child.kill("SIGKILL");
      return;
    }
    killPids(planKills({ roots: running.map(([pid, { spawnedAt }]) => ({ pid, spawnedAt, lastSeen: now })), table, deadline: now }));
  };

  const onExit = () => {
    try {
      killAll();
    } catch {
      // never throw from an exit listener: the lock's release and the real exit code come after it
    }
    closed = true;
    for (const file of [pidFile, `${pidFile}.tmp`]) {
      try {
        fs.rmSync(file, { force: true });
      } catch {
        // EPERM / EBUSY: the watchdog finds the runner gone, kills nothing it cannot prove, removes it
      }
    }
  };
  const stop = (why) => {
    console.error(`\n${name}: ${why} — killing ${String(live.size)} child process tree(s)`);
    killAll();
    process.exit(130);
  };
  process.on("exit", onExit);
  for (const signal of SIGNALS) {
    try {
      process.on(signal, () => stop(signal));
    } catch {
      // a signal this platform does not know
    }
  }

  if (stopWhenOrphaned) {
    // Read once, in the background (a PowerShell process-table read on Windows, ~2-3 s): the first
    // child starts meanwhile. Only ancestors alive after the read are watched.
    Promise.resolve()
      .then(() => readLineage())
      .then((lineage) => {
        const watched = (Array.isArray(lineage) ? lineage : []).filter((a) => Number.isInteger(a?.pid) && isAlive(a.pid));
        if (watched.length === 0) return;
        const timer = setInterval(() => {
          const gone = watched.find((a) => !isAlive(a.pid));
          if (gone === undefined) return;
          clearInterval(timer);
          stop(`ancestor pid ${String(gone.pid)} (${String(gone.name)}) is gone, stopped from above`);
        }, ORPHAN_POLL_MS);
        timer.unref();
      })
      .catch(() => {});
  }

  writePids();
  let watcher = null;
  if (watchdog) {
    try {
      watcher = spawn(process.execPath, [SELF, WATCH_FLAG, String(process.pid), pidFile], {
        // stdin is a pipe from the runner: it closes the moment the runner dies, however it dies.
        stdio: ["pipe", "ignore", "ignore"],
        windowsHide: true,
        detached: true
      });
      watcher.on("error", () => {});
      watcher.stdin.on("error", () => {});
      watcher.stdin.unref?.();
      watcher.unref();
    } catch {
      watcher = null;
    }
  }

  return {
    pidFile,
    watcherPid: watcher?.pid,
    /** Tell the watchdog which heavy-lock holder file to clear if the runner is hard-killed. */
    setLock(heldLock) {
      lock = heldLock?.acquired ? { path: heldLock.path, token: heldLock.token } : null;
      writePids();
    },
    livePids: () => [...live.keys()],
    /**
     * spawnSync's result shape, asynchronously: `{ status, signal, stdout, stderr, error }`.
     * `capture: true` collects stdout/stderr as strings; otherwise stdio is inherited.
     */
    run(command, args, { cwd, shell = false, capture = false } = {}) {
      return new Promise((resolve) => {
        const spawnedAt = Date.now();
        let child;
        try {
          child = spawn(command, args, { cwd, shell, stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit", windowsHide: true });
        } catch (error) {
          resolve({ status: null, signal: null, stdout: null, stderr: null, error });
          return;
        }
        let stdout = "";
        let stderr = "";
        if (capture) {
          child.stdout.setEncoding("utf8").on("data", (d) => (stdout += d));
          child.stderr.setEncoding("utf8").on("data", (d) => (stderr += d));
        }
        const pid = child.pid;
        // Unregistered on `exit`, not `close` (which waits for stdio and can come much later).
        const unregister = () => {
          if (pid !== undefined && live.get(pid)?.child === child) {
            live.delete(pid);
            writePids();
          }
        };
        if (pid !== undefined) {
          live.set(pid, { child, spawnedAt });
          writePids();
        }
        child.on("exit", unregister);
        let done = false;
        const finish = (result) => {
          if (done) return;
          done = true;
          unregister();
          resolve(result);
        };
        child.on("error", (error) => finish({ status: null, signal: null, stdout: null, stderr: null, error }));
        child.on("close", (status, signal) => finish({ status, signal, stdout: capture ? stdout : null, stderr: capture ? stderr : null, error: undefined }));
      });
    }
  };
}

// ---- the watchdog process ----

function readRecord(pidFile) {
  try {
    return JSON.parse(fs.readFileSync(pidFile, "utf8"));
  } catch (error) {
    return error.code === "ENOENT" ? null : undefined;
  }
}

function clearLock(lock) {
  if (lock === null || typeof lock?.path !== "string") return;
  try {
    const holder = JSON.parse(fs.readFileSync(lock.path, "utf8"));
    if (holder?.token === lock.token) fs.rmSync(lock.path, { force: true });
  } catch {
    // gone, or not ours
  }
}

/** The watchdog's clean-up after the runner was found gone at `deadline`. Exported for the test. */
export function reapAfterRunner(record, deadline, { readTable = readTableSync, kill = killPids } = {}) {
  const roots = (record?.children ?? []).map((c) => ({ pid: c.pid, spawnedAt: c.spawnedAt, lastSeen: record.at }));
  if (roots.length > 0) {
    const table = readTable();
    if (table !== null) kill(planKills({ roots, table, deadline }));
  }
  clearLock(record?.lock ?? null);
}

async function watchRunner([runnerPid, pidFile]) {
  const runner = Number(runnerPid);
  let last = null;
  let pipeClosed = false;
  process.stdin.on("error", () => {});
  process.stdin.on("close", () => (pipeClosed = true));
  process.stdin.on("end", () => (pipeClosed = true));
  process.stdin.resume();
  for (;;) {
    const record = readRecord(pidFile);
    if (record === null) process.exit(0); // the runner exited normally and removed it
    if (record !== undefined) last = record;
    if (pipeClosed || !isAlive(runner)) {
      reapAfterRunner(last, Date.now());
      try {
        fs.rmSync(pidFile, { force: true });
      } catch {
        // left in the temp dir; nothing reads it again
      }
      process.exit(0);
    }
    await new Promise((r) => setTimeout(r, WATCH_POLL_MS));
  }
}

if (process.argv[2] === WATCH_FLAG && path.resolve(process.argv[1] ?? "") === SELF) {
  await watchRunner(process.argv.slice(3));
}
