/**
 * Children of a gate runner die with it (row P1, 2026-11-16).
 *
 * `run-tests.mjs` and `run-servers.mjs` used to run each script with `spawnSync`: the event loop was
 * blocked for the whole child, so nothing in the runner could react to being stopped. Measured on
 * Windows (P1 evidence): a hard kill of the runner itself already takes its whole tree down (libuv puts
 * every child in a kill-on-close job object), but stopping the run the way a tool call is stopped —
 * killing the SHELL above the runner — left the runner, its harness children and the heavy lock all
 * running (rows #10 and #13). This module:
 *
 * 1. spawns each child asynchronously and records its pid while it runs (`tracker.run`);
 * 2. on SIGINT / SIGTERM / SIGBREAK / SIGHUP kills every recorded child TREE, then exits 130 — the
 *    `exit` listeners then run, the heavy lock's release among them;
 * 3. on `exit` kills whatever is still recorded (a runner that throws or calls `process.exit`);
 * 3b. stops when orphaned: it reads its ancestors once (heavyLock.mjs `readOwnLineage`, up to the Claude
 *    session process) and polls them; when one alive at start is gone, the runner was stopped from above,
 *    so it kills its child trees and exits 130 (the heavy lock is released by its `exit` listener).
 *    A reused pid passes for alive — the conservative side: the run then goes on as before.
 *    `MCP_HEAVY_LOCK_LINEAGE=off` (no lineage read) turns this off with the lock's own lineage;
 * 4. starts a watchdog: a small separate node process that polls the runner's pid. A hard kill
 *    (`taskkill /F`, TerminateProcess, SIGKILL) runs no handler in the runner at all, so only another
 *    process can clean up (on POSIX each child leads its own process group and would outlive the runner;
 *    on Windows the job object has already killed the tree, and the watchdog clears the lock file). When the runner is gone the watchdog kills the trees of the pids the runner
 *    last registered — read from a pid file the runner rewrites on each spawn and exit, never found by
 *    name — removes the runner's heavy-lock holder file when it still names the runner's token, and
 *    exits. When the runner exits normally it deletes the pid file, and the watchdog exits on its next
 *    poll without killing anything.
 *
 * A tree is killed with `taskkill /PID <pid> /T /F` (argv array, no shell) on Windows; elsewhere each
 * child leads its own process group (`detached`) and the group gets SIGKILL.
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
export const SIGNALS = ["SIGINT", "SIGTERM", "SIGBREAK", "SIGHUP"];

/** `[command, args]` that kills the process tree rooted at `pid` — exported for the test. */
export function treeKillCommand(pid, platform = process.platform) {
  return platform === "win32" ? ["taskkill", ["/PID", String(pid), "/T", "/F"]] : null;
}

/** Kill the process tree rooted at `pid`; true when the kill was issued without an error. */
export function killTree(pid, platform = process.platform) {
  const cmd = treeKillCommand(pid, platform);
  if (cmd !== null) {
    const r = spawnSync(cmd[0], cmd[1], { stdio: "ignore", windowsHide: true });
    return r.status === 0;
  }
  try {
    process.kill(-pid, "SIGKILL");
    return true;
  } catch {
    try {
      process.kill(pid, "SIGKILL");
      return true;
    } catch {
      return false;
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
  const live = new Map(); // pid -> ChildProcess
  const pidFile = path.join(os.tmpdir(), `mcp-children-${name}-${String(process.pid)}-${crypto.randomBytes(4).toString("hex")}.json`);
  let lock = null;
  let closed = false;

  const writePids = () => {
    if (closed) return;
    const body = JSON.stringify({ runner: process.pid, pids: [...live.keys()], lock });
    try {
      fs.writeFileSync(`${pidFile}.tmp`, body);
      fs.renameSync(`${pidFile}.tmp`, pidFile);
    } catch {
      // the in-process handlers still cover a soft stop
    }
  };

  const killAll = () => {
    for (const pid of [...live.keys()]) {
      killTree(pid);
      live.delete(pid);
    }
  };

  const onExit = () => {
    killAll();
    closed = true;
    fs.rmSync(pidFile, { force: true });
    fs.rmSync(`${pidFile}.tmp`, { force: true });
  };
  const onSignal = (signal) => {
    console.error(`\n${name}: ${signal} — killing ${String(live.size)} child process tree(s)`);
    killAll();
    process.exit(130);
  };
  process.on("exit", onExit);
  for (const signal of SIGNALS) {
    try {
      process.on(signal, onSignal);
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
          console.error(`
${name}: ancestor pid ${String(gone.pid)} (${String(gone.name)}) is gone — stopped from above; killing ${String(live.size)} child process tree(s)`);
          killAll();
          process.exit(130);
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
        // stdin is a pipe from the runner: it closes the moment the runner dies, however it dies, so the
        // watchdog does not depend on the runner pid alone (a pid can be reused).
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
        let child;
        try {
          child = spawn(command, args, {
            cwd,
            shell,
            stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
            windowsHide: true,
            detached: process.platform !== "win32"
          });
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
        if (child.pid !== undefined) {
          live.set(child.pid, child);
          writePids();
        }
        let done = false;
        const finish = (result) => {
          if (done) return;
          done = true;
          if (child.pid !== undefined) live.delete(child.pid);
          writePids();
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
      for (const pid of last?.pids ?? []) if (Number.isInteger(pid) && pid > 0) killTree(pid);
      clearLock(last?.lock ?? null);
      fs.rmSync(pidFile, { force: true });
      process.exit(0);
    }
    await new Promise((r) => setTimeout(r, WATCH_POLL_MS));
  }
}

if (process.argv[2] === WATCH_FLAG && path.resolve(process.argv[1] ?? "") === SELF) {
  await watchRunner(process.argv.slice(3));
}
