/**
 * One heavy check at a time on this machine (row V-C, 2026-10-27).
 *
 * Why this exists. Several Claude sessions share one machine, and each runs its own gate. On
 * 2026-10-27 two gates ran side by side and the latency assertions flaked under the load —
 * `test:freshness-worker` measured 277 ms against a 250 ms bound ("a trivial tool answers in
 * < 250 ms") — and each flake cost a re-run of a ~10 minute suite. The checks are not wrong; they
 * were never meant to share the CPU with another copy of themselves.
 *
 * The lock is a file, `~/.claude/locks/heavy-check.lock`, holding `{pid, startedAt, token, cmd, cwd}`.
 * A second caller waits (prints the holder once, then polls) up to a timeout and fails with exit 75.
 * A holder whose pid is gone, or which has held the lock longer than any real run takes, is broken:
 * Node cannot read another process's start time portably, so the age cap is the guard against a
 * reused pid.
 *
 * Nesting. `verify:all` → `test:servers` → codebase-index `run-tests.mjs` each take the lock. The
 * holder exports its token as `MCP_HEAVY_LOCK_TOKEN`; a child whose inherited token matches the file
 * is already inside the lock and does not wait for itself.
 *
 * CI never takes it: `CI=true` (set by GitHub Actions) or `--no-lock` skips the lock entirely.
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

/** EX_TEMPFAIL: the check did not run, try again later — not a test failure. */
export const LOCK_TIMEOUT_EXIT = 75;
export const DEFAULT_TIMEOUT_MS = 30 * 60_000;
/** Longer than any real run (`verify:all` is ~10 min); a holder older than this is a reused pid. */
export const STALE_AFTER_MS = 3 * 60 * 60_000;
const POLL_MS = 2_000;

export class HeavyLockTimeoutError extends Error {
  constructor(message) {
    super(message);
    this.code = "HEAVY_LOCK_TIMEOUT";
  }
}

export function heavyLockPath(env = process.env) {
  return env.MCP_HEAVY_LOCK_PATH || path.join(os.homedir(), ".claude", "locks", "heavy-check.lock");
}

function readRaw(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function parseHolder(raw) {
  try {
    const holder = JSON.parse(raw);
    return holder !== null && typeof holder === "object" ? holder : null;
  } catch {
    return null;
  }
}

/** `kill(pid, 0)` sends nothing: it throws ESRCH for a dead pid and EPERM for a live one we may not signal. */
export function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

/** Why the holder may be broken, or `null` while it is a live, plausible run. */
export function staleReason(holder, now = Date.now()) {
  if (holder === null) return "the lock file is unreadable";
  if (!isPidAlive(holder.pid)) return `pid ${String(holder.pid)} is gone`;
  const started = Date.parse(holder.startedAt);
  if (!Number.isFinite(started)) return "the lock file has no start time";
  if (now - started > STALE_AFTER_MS) return `held for more than ${String(STALE_AFTER_MS / 3_600_000)} h (pid reused?)`;
  return null;
}

export function describeHolder(holder) {
  if (holder === null) return "an unreadable holder";
  return `pid ${String(holder.pid)} (${String(holder.cmd)}) in ${String(holder.cwd)}, since ${String(holder.startedAt)}`;
}

/**
 * Create the lock with its content already in place: write a private temp file, then hard-link it to
 * the lock path. `link` fails with EEXIST when the lock exists, so creation is atomic and a reader
 * never sees a half-written file.
 */
function tryCreate(file, content) {
  const tmp = `${file}.${String(process.pid)}.${randomUUID()}.tmp`;
  fs.writeFileSync(tmp, content);
  try {
    fs.linkSync(tmp, file);
    return true;
  } catch (error) {
    if (error.code === "EEXIST") return false;
    throw error;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/**
 * Remove the lock judged stale — and only that one. Two waiters can judge the same file stale; a
 * compare-then-unlink lets the slower one delete the faster one's NEW lock (two holders). A rename is
 * atomic, so exactly one waiter moves any given file aside; the mover then checks that what it moved
 * is what it judged, and if it moved a live lock instead it links it back (`link` fails rather than
 * overwrite, so a third waiter's lock is never clobbered either).
 */
export function breakStale(file, judged, log) {
  const aside = `${file}.${String(process.pid)}.${randomUUID()}.stale`;
  try {
    fs.renameSync(file, aside);
  } catch (error) {
    if (error.code === "ENOENT") return; // another waiter broke it first
    throw error;
  }
  try {
    if (readRaw(aside) === judged) return;
    try {
      fs.linkSync(aside, file);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      log(`heavy-check lock: could not restore a live lock moved aside (${describeHolder(parseHolder(readRaw(aside) ?? ""))})`);
    }
  } finally {
    fs.rmSync(aside, { force: true });
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Take the machine-wide heavy-check lock, waiting while a live holder has it.
 *
 * Resolves `{ acquired: true, release }` or `{ acquired: false, reason }` when the lock is skipped
 * (CI, `--no-lock`, already held by a parent). Rejects with `HeavyLockTimeoutError` after
 * `timeoutMs`. `env` receives `MCP_HEAVY_LOCK_TOKEN` so children spawned with it inherit the hold.
 */
export async function acquireHeavyLock({
  cmd,
  cwd = process.cwd(),
  env = process.env,
  noLock = false,
  timeoutMs,
  pollMs = POLL_MS,
  log = (line) => console.error(line)
} = {}) {
  if (noLock) return { acquired: false, reason: "--no-lock" };
  if (env.CI === "true") return { acquired: false, reason: "CI=true" };

  const file = heavyLockPath(env);
  const inherited = env.MCP_HEAVY_LOCK_TOKEN;
  if (inherited) {
    const holder = parseHolder(readRaw(file) ?? "");
    if (holder?.token === inherited) return { acquired: false, reason: `held by parent pid ${String(holder.pid)}` };
  }

  const limit = timeoutMs ?? (Number(env.MCP_HEAVY_LOCK_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const token = randomUUID();
  const content = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), token, cmd, cwd });
  const deadline = Date.now() + limit;
  let announced = null;

  while (!tryCreate(file, content)) {
    const raw = readRaw(file);
    if (raw === null) continue;
    const holder = parseHolder(raw);
    const stale = staleReason(holder);
    if (stale !== null) {
      log(`heavy-check lock: breaking ${describeHolder(holder)} — ${stale}`);
      breakStale(file, raw, log);
      continue;
    }
    if (Date.now() >= deadline) {
      throw new HeavyLockTimeoutError(
        `heavy-check lock still held after ${String(Math.round(limit / 1000))} s by ${describeHolder(holder)} ` +
          `(${file}). Wait for it, or set MCP_HEAVY_LOCK_TIMEOUT_MS; --no-lock skips the lock.`
      );
    }
    if (announced !== holder.token) {
      log(
        `heavy-check lock held by ${describeHolder(holder)}; waiting up to ` +
          `${limit >= 60_000 ? `${String(Math.round(limit / 60_000))} min` : `${String(Math.round(limit / 1000))} s`} (MCP_HEAVY_LOCK_TIMEOUT_MS) …`
      );
      announced = holder.token;
    }
    await sleep(Math.max(1, Math.min(pollMs, deadline - Date.now())));
  }

  env.MCP_HEAVY_LOCK_TOKEN = token;
  let released = false;
  const onSignal = () => {
    release();
    process.exit(130);
  };
  function release() {
    if (released) return;
    released = true;
    process.off("exit", release);
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    if (parseHolder(readRaw(file) ?? "")?.token === token) fs.rmSync(file, { force: true });
    if (env.MCP_HEAVY_LOCK_TOKEN === token) delete env.MCP_HEAVY_LOCK_TOKEN;
  }
  process.on("exit", release);
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  return { acquired: true, path: file, token, release };
}

/** For a CLI entry point: take the lock, or print why not and exit 75 on timeout. */
export async function holdHeavyLockOrExit(options) {
  try {
    const lock = await acquireHeavyLock(options);
    // Said so a CI log shows why nothing waited; a nested run inside its parent's hold stays quiet.
    if (!lock.acquired && !lock.reason.startsWith("held by parent")) console.error(`heavy-check lock skipped: ${lock.reason}`);
    return lock;
  } catch (error) {
    if (!(error instanceof HeavyLockTimeoutError)) throw error;
    console.error(error.message);
    process.exit(LOCK_TIMEOUT_EXIT);
  }
}
