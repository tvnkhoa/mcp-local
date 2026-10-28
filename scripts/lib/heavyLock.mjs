/**
 * One heavy check at a time on this machine (row V-C, 2026-10-27).
 *
 * Why this exists. Several Claude sessions share one machine, and each runs its own gate. On
 * 2026-10-27 two gates ran side by side and the latency assertions flaked under the load —
 * `test:freshness-worker` measured 277 ms against a 250 ms bound ("a trivial tool answers in
 * < 250 ms") — and each flake cost a re-run of a ~10 minute suite. The checks are not wrong; they
 * were never meant to share the CPU with another copy of themselves.
 *
 * The lock is a name the OS owns (row 9, 2026-10-28). On Windows the holder listens on the named pipe
 * `\\.\pipe\mcp-heavy-check-<user>-<hash of the lock path>`; on Linux on the abstract unix socket of
 * the same name. A second listener gets EADDRINUSE, and the OS frees the name the moment the holder's
 * process ends — any way, `taskkill /F` included. So nothing is ever judged stale and nothing is broken:
 * the file scheme this replaced could end with two holders, because "judge stale, then break" on a plain
 * file always leaves a window between the judgement and the break. The listening handle is unref'd (it
 * does not keep the holder alive), keeps the name while the holder sits in `spawnSync` (no event loop
 * needed), and is not inherited by children (a grandchild that outlives the holder does not keep it).
 * The user is in the name because an abstract socket is shared by every user on the machine.
 *
 * The file, `~/.claude/locks/heavy-check.lock`, holding `{pid, startedAt, token, cmd, cwd}`, is then only
 * information: who to name in "waiting for …", and the token for nesting. A killed holder leaves it
 * behind; the next holder overwrites it.
 *
 * Elsewhere (macOS: a unix socket there is a file, as stale as any other) the file is still the lock: a
 * holder is broken when its pid is gone, when the process now owning that pid started after the holder
 * wrote `startedAt`, or when it has held the lock longer than any real run takes. CI never takes the
 * lock, so this path runs on developer Macs only.
 *
 * Nesting. `verify:all` → `test:servers` → codebase-index `run-tests.mjs` each take the lock. The
 * holder exports its token as `MCP_HEAVY_LOCK_TOKEN`; a child whose inherited token matches the file
 * — while the name is still held — is already inside the lock and does not wait for itself.
 *
 * A caller that cannot get the lock waits (prints the holder once, then polls) up to
 * `MCP_HEAVY_LOCK_TIMEOUT_MS` and fails with exit 75. CI never takes it: `CI=true` (set by GitHub
 * Actions) or `--no-lock` skips the lock entirely.
 */

import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";

/** EX_TEMPFAIL: the check did not run, try again later — not a test failure. */
export const LOCK_TIMEOUT_EXIT = 75;
export const DEFAULT_TIMEOUT_MS = 30 * 60_000;
/** File scheme: longer than any real run (`verify:all` is ~10 min); a holder older than this is a reused pid. */
export const STALE_AFTER_MS = 3 * 60 * 60_000;
const POLL_MS = 2_000;
/** File scheme: slack for the readers' precision (`ps` and Linux `btime` are whole seconds) when comparing a start time with `startedAt`. */
export const PID_START_TOLERANCE_MS = 3_000;
/** File scheme: how often a waiter re-reads a live holder's start time; a pid reused between reads waits at most this long. */
export const PID_RECHECK_MS = 5 * 60_000;

export class HeavyLockTimeoutError extends Error {
  constructor(message) {
    super(message);
    this.code = "HEAVY_LOCK_TIMEOUT";
  }
}

export function heavyLockPath(env = process.env) {
  return env.MCP_HEAVY_LOCK_PATH || path.join(os.homedir(), ".claude", "locks", "heavy-check.lock");
}

function userName(env) {
  let name;
  try {
    name = os.userInfo().username;
  } catch {
    name = env.USERNAME || env.USER || "";
  }
  return name.replace(/[^A-Za-z0-9_.-]/g, "_") || "user";
}

/**
 * The OS-owned name that is the lock on this platform, or `null` where the file is the lock. Derived
 * from the lock path, so a test's `MCP_HEAVY_LOCK_PATH` gets its own name.
 */
export function heavyLockPipeName(file = heavyLockPath(), { platform = process.platform, env = process.env } = {}) {
  const base = `mcp-heavy-check-${userName(env)}-${createHash("sha256").update(path.resolve(file)).digest("hex").slice(0, 16)}`;
  if (platform === "win32") return `\\\\.\\pipe\\${base}`;
  if (platform === "linux") return `\0${base}`;
  return null;
}

/** Listen on `name`: the server when this process now holds it, `null` when another holder does. */
function tryListen(name) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", (error) => (error.code === "EADDRINUSE" ? resolve(null) : reject(error)));
    server.listen(name, () => {
      server.unref();
      resolve(server);
    });
  });
}

/** Windows refuses to open a file being deleted (EPERM) while another process still has it open. */
const GOING = new Set(["ENOENT", "EPERM", "EBUSY"]);

function readRaw(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (error) {
    if (GOING.has(error.code)) return null;
    throw error;
  }
}

/** Write the holder's file, waiting out a previous holder's file still being deleted under a reader. */
function writeHolderFile(file, content) {
  for (let attempt = 0; ; attempt++) {
    try {
      fs.writeFileSync(file, content);
      return;
    } catch (error) {
      if (!GOING.has(error.code) || attempt >= 100) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
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

const execFileAsync = promisify(execFile);

/** Linux: field 22 of `/proc/<pid>/stat` is the start in clock ticks after boot (USER_HZ, 100 on every mainstream kernel). */
function readProcStart(pid) {
  const stat = fs.readFileSync(`/proc/${String(pid)}/stat`, "utf8");
  const ticks = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]);
  const btime = Number(/^btime (\d+)$/m.exec(fs.readFileSync("/proc/stat", "utf8"))?.[1]);
  return btime * 1000 + ticks * 10;
}

/**
 * File scheme: when the process that now has `pid` started, in epoch ms, or `null` when it cannot be
 * read (no such pid, access denied, or Windows — which uses the pipe, and whose only reader was a
 * ~2.5 s PowerShell start-up).
 */
export async function readPidStart(pid) {
  if (!Number.isInteger(pid) || pid <= 0 || process.platform === "win32") return null;
  try {
    if (process.platform === "linux") return readProcStart(pid);
    const { stdout } = await execFileAsync("ps", ["-o", "lstart=", "-p", String(pid)], { timeout: 5_000 });
    return Date.parse(stdout.trim());
  } catch {
    return null;
  }
}

/**
 * File scheme: why the holder may be broken, or `null` while it is a live, plausible run. `pidStarts`
 * caches the holder's OS-read start time per token as `{ at, start }`, so a waiter reads it once per
 * holder and then every `PID_RECHECK_MS`, not every poll.
 */
export async function staleReason(holder, { now = Date.now(), readStart = readPidStart, pidStarts = new Map() } = {}) {
  if (holder === null) return "the lock file is unreadable";
  if (!isPidAlive(holder.pid)) return `pid ${String(holder.pid)} is gone`;
  const started = Date.parse(holder.startedAt);
  if (!Number.isFinite(started)) return "the lock file has no start time";
  let seen = pidStarts.get(holder.token);
  if (seen === undefined || now - seen.at >= PID_RECHECK_MS) {
    seen = { at: now, start: await readStart(holder.pid) };
    pidStarts.set(holder.token, seen);
  }
  if (Number.isFinite(seen.start) && seen.start > started + PID_START_TOLERANCE_MS) {
    return `pid ${String(holder.pid)} was reused (that process started ${new Date(seen.start).toISOString()}, after the lock was taken)`;
  }
  if (now - started > STALE_AFTER_MS) return `held for more than ${String(STALE_AFTER_MS / 3_600_000)} h (pid reused?)`;
  return null;
}

export function describeHolder(holder) {
  if (holder === null) return "an unreadable holder";
  return `pid ${String(holder.pid)} (${String(holder.cmd)}) in ${String(holder.cwd)}, since ${String(holder.startedAt)}`;
}

/**
 * File scheme: create the lock with its content already in place: write a private temp file, then
 * hard-link it to the lock path. `link` fails with EEXIST when the lock exists, so creation is atomic
 * and a reader never sees a half-written file.
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
 * File scheme: remove the lock judged stale — and only that one. Two waiters can judge the same file
 * stale; a compare-then-unlink lets the slower one delete the faster one's NEW lock (two holders). A
 * rename is atomic, so exactly one waiter moves any given file aside; the mover then checks that what it
 * moved is what it judged, and if it moved a live lock instead it links it back. `link` fails rather
 * than overwrite, so a third waiter's lock is never clobbered — but then two holders remain: the window
 * the pipe scheme exists to close.
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
 * Tests only: `readStart` replaces `readPidStart`, and `scheme: "file"` forces the file scheme.
 */
export async function acquireHeavyLock({
  cmd,
  cwd = process.cwd(),
  env = process.env,
  noLock = false,
  timeoutMs,
  pollMs = POLL_MS,
  readStart = readPidStart,
  scheme,
  log = (line) => console.error(line)
} = {}) {
  if (noLock) return { acquired: false, reason: "--no-lock" };
  if (env.CI === "true") return { acquired: false, reason: "CI=true" };

  const file = heavyLockPath(env);
  const pipe = scheme === "file" ? null : heavyLockPipeName(file, { env });
  const inherited = env.MCP_HEAVY_LOCK_TOKEN;
  const insideParent = (holder) =>
    inherited && holder?.token === inherited ? { acquired: false, reason: `held by parent pid ${String(holder.pid)}` } : null;
  // The file scheme trusts the file. The pipe scheme asks the OS first (below), so a token left in a
  // killed holder's file never skips the lock.
  if (pipe === null) {
    const skip = insideParent(parseHolder(readRaw(file) ?? ""));
    if (skip !== null) return skip;
  }

  const limit = timeoutMs ?? (Number(env.MCP_HEAVY_LOCK_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const token = randomUUID();
  const content = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), token, cmd, cwd });
  const deadline = Date.now() + limit;
  let announced = null;
  const pidStarts = new Map();

  const waitOrTimeout = async (holder) => {
    if (Date.now() >= deadline) {
      throw new HeavyLockTimeoutError(
        `heavy-check lock still held after ${String(Math.round(limit / 1000))} s by ${describeHolder(holder)} ` +
          `(${file}). Wait for it, or set MCP_HEAVY_LOCK_TIMEOUT_MS; --no-lock skips the lock.`
      );
    }
    if (holder !== null && announced !== holder.token) {
      log(
        `heavy-check lock held by ${describeHolder(holder)}; waiting up to ` +
          `${limit >= 60_000 ? `${String(Math.round(limit / 60_000))} min` : `${String(Math.round(limit / 1000))} s`} (MCP_HEAVY_LOCK_TIMEOUT_MS) …`
      );
      announced = holder.token;
    }
    await sleep(Math.max(1, Math.min(pollMs, deadline - Date.now())));
  };

  let server = null;
  if (pipe !== null) {
    while ((server = await tryListen(pipe)) === null) {
      // A holder writes the file just after it takes the name, so for a moment the file may still name
      // a killed holder before it; trust only a live pid, and read the file again next poll.
      const written = parseHolder(readRaw(file) ?? "");
      const holder = written !== null && isPidAlive(written.pid) ? written : null;
      const skip = insideParent(holder);
      if (skip !== null) return skip;
      await waitOrTimeout(holder);
    }
    writeHolderFile(file, content);
  } else {
    while (!tryCreate(file, content)) {
      const raw = readRaw(file);
      if (raw === null) continue;
      const holder = parseHolder(raw);
      const stale = await staleReason(holder, { readStart, pidStarts });
      if (stale !== null) {
        // Judging may have awaited a start-time read; a lock taken meanwhile must be re-judged, not moved
        // aside — breakStale can put a moved live lock back only while no third waiter has taken the path.
        if (readRaw(file) !== raw) continue;
        log(`heavy-check lock: breaking ${describeHolder(holder)} — ${stale}`);
        breakStale(file, raw, log);
        continue;
      }
      await waitOrTimeout(holder);
    }
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
    // The file goes first, while the name is still held: no next holder can have written it yet.
    if (parseHolder(readRaw(file) ?? "")?.token === token) fs.rmSync(file, { force: true });
    server?.close();
    if (env.MCP_HEAVY_LOCK_TOKEN === token) delete env.MCP_HEAVY_LOCK_TOKEN;
  }
  process.on("exit", release);
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  return { acquired: true, path: file, pipe, token, release };
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
