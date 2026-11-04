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
 *
 * Visible and orphan-safe (row H-1, 2026-11-04). Twice on 4 Nov a stopped run kept or later took the
 * lock: TaskStop killed the shell, its node child lived on, waited, and took the lock ahead of an agreed
 * cross-repo order. So a holder or waiter records its `lineage` — its ancestors, `{pid, name, start}`,
 * up to and including the Claude session process (`claude`/`claude.exe`) or `LINEAGE_DEPTH` levels —
 * and a waiter registers itself as `<lock>.waiters/<pid>-<token>.json` while it waits, removing it when
 * it stops waiting (an entry of a dead pid is ignored and removed by `status`). A waiter whose lineage
 * has a pid that dies while it waits gives up (`HeavyLockOrphanError`, exit 76) instead of taking the
 * lock later for a session that is gone; an ancestor already gone when the wait began (a spawn-and-exit
 * wrapper) does not count. `heavyLockStatus` (CLI: `heavy-lock.mjs status`) shows the holder and every
 * waiter, with `orphan: true` when a recorded ancestor is gone. Nothing is ever killed. The holder's
 * file keeps its fields; `ppid` and `lineage` are added (other repos' wrappers read it).
 * `MCP_HEAVY_LOCK_LINEAGE=off` skips the lineage read (one process-table read: ~2–3 s of PowerShell
 * on Windows, read before the lock is taken so the holder file is written at once; a nested caller inside
 * a live hold skips it).
 *
 * Orphaned holder (row H-3, 2026-11-04). A holder is `orphan` only when its WHOLE recorded lineage is
 * gone — every ancestor up to the Claude session process (or the top one recorded); with no lineage,
 * when its parent is gone. Some ancestor gone while the session lives is `ancestorGone` ("launcher gone
 * (session alive)") — the shape of both 4 Nov incidents: TaskStop killed the shell, claude.exe lived on.
 * Either way the holder is flagged: the first time `status` or a waiter sees it flagged is kept in
 * `<lock>.orphan.json` (`{token, pid, since}`), cleared when the holder changes or frees. After
 * `MCP_HEAVY_LOCK_ORPHAN_MINUTES` (default 10, fractions allowed) status and every waiter print
 * `taskkill /PID <pid> /T /F`, which a leader runs only on the owner's yes. The tool itself kills
 * nothing and never frees a lock whose holder lives.
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
/** A waiter stopped because an ancestor alive when it began waiting died: its session is gone. */
export const LOCK_ORPHANED_EXIT = 76;
export const DEFAULT_TIMEOUT_MS = 30 * 60_000;
/** File scheme: longer than any real run (`verify:all` is ~10 min); a holder older than this is a reused pid. */
export const STALE_AFTER_MS = 3 * 60 * 60_000;
const POLL_MS = 2_000;
/** File scheme: slack for the readers' precision (`ps` and Linux `btime` are whole seconds) when comparing a start time with `startedAt`. */
export const PID_START_TOLERANCE_MS = 3_000;
/** File scheme: how often a waiter re-reads a live holder's start time; a pid reused between reads waits at most this long. */
export const PID_RECHECK_MS = 5 * 60_000;

/** Ancestors recorded at most, when no Claude session process is met first. */
export const LINEAGE_DEPTH = 8;
const LINEAGE_READ_TIMEOUT_MS = 15_000;

export class HeavyLockTimeoutError extends Error {
  constructor(message) {
    super(message);
    this.code = "HEAVY_LOCK_TIMEOUT";
  }
}

/** A waiter whose launching process is gone stops waiting rather than take the lock for nobody. */
export class HeavyLockOrphanError extends Error {
  constructor(message) {
    super(message);
    this.code = "HEAVY_LOCK_ORPHANED";
  }
}

export function heavyLockPath(env = process.env) {
  return env.MCP_HEAVY_LOCK_PATH || path.join(os.homedir(), ".claude", "locks", "heavy-check.lock");
}

/** Where waiters register: one file per waiting call, beside the lock. */
export function heavyLockWaitersDir(file = heavyLockPath()) {
  return `${file}.waiters`;
}

/** Where the first sighting of an orphaned holder is kept: `{token, pid, since}`. */
export function heavyLockOrphanFile(file = heavyLockPath()) {
  return `${file}.orphan.json`;
}

export const DEFAULT_ORPHAN_MINUTES = 10;

/** Minutes a holder stays orphaned before the kill command is printed (`MCP_HEAVY_LOCK_ORPHAN_MINUTES`). */
export function orphanMinutes(env = process.env) {
  const raw = env.MCP_HEAVY_LOCK_ORPHAN_MINUTES;
  const value = raw === undefined || raw === "" ? NaN : Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_ORPHAN_MINUTES;
}

/** The command that would end an orphaned holder and its children. Printed, never run. */
export function killCommand(pid, platform = process.platform) {
  return platform === "win32" ? `taskkill /PID ${String(pid)} /T /F` : `kill -KILL ${String(pid)}`;
}

export const KILL_RULE = "a leader runs it only on the owner's yes; this tool kills nothing";

/**
 * Record or clear the sighting of a flagged holder (orphan, or launcher gone) whose file token is
 * `token`. `orphan` here means flagged — true: keep
 * the first sighting of this holder (write one if none or another holder's); false, or no holder: clear
 * it; null (unknown): leave it. Returns `{ since, due }` (`since` an ISO string or null).
 */
export function noteOrphan(file, { token, pid, orphan }, { now = Date.now(), env = process.env } = {}) {
  const at = heavyLockOrphanFile(file);
  const seen = parseHolder(readRaw(at) ?? "");
  const mine = seen !== null && token !== undefined && token !== null && seen.token === token;
  if (token === undefined || token === null || orphan === false || (!mine && orphan !== true)) {
    if (seen !== null || fs.existsSync(at)) fs.rmSync(at, { force: true });
    return { since: null, due: false };
  }
  let since = mine ? seen.since : null;
  if (since === null && orphan === true) {
    since = new Date(now).toISOString();
    try {
      const tmp = `${at}.${String(process.pid)}.${randomUUID()}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ token, pid, since }));
      fs.renameSync(tmp, at);
    } catch {
      // information only
    }
  }
  if (orphan !== true) return { since, due: false };
  const started = Date.parse(since);
  return { since, due: Number.isFinite(started) && now - started >= orphanMinutes(env) * 60_000 };
}

/**
 * Waiter side, no process table: `{ flagged, whole }` — is any recorded ancestor gone, and is the whole
 * lineage gone (pids only, so a reused pid passes for alive — the conservative side)? Without a
 * lineage, its parent decides both; `null` when unknown.
 */
function holderOrphanByPids(holder) {
  const lineage = Array.isArray(holder.lineage) ? holder.lineage : [];
  if (lineage.length > 0) {
    const gone = lineage.filter((a) => !isPidAlive(a.pid)).length;
    return { flagged: gone > 0, whole: gone === lineage.length };
  }
  const parentGone = Number.isInteger(holder.ppid) ? !isPidAlive(holder.ppid) : null;
  return { flagged: parentGone, whole: parentGone === true };
}

/** How a flagged holder is labelled: its whole chain gone, or only its launcher. */
function flagLabel(whole) {
  return whole ? "ORPHAN (whole session chain gone)" : "launcher gone (session alive)";
}

// ---- process table and lineage ----

const WIN_TABLE_SCRIPT =
  "Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name,CreationDate | " +
  "Select-Object @{n='pid';e={$_.ProcessId}},@{n='ppid';e={$_.ParentProcessId}},@{n='name';e={$_.Name}}," +
  "@{n='start';e={if($_.CreationDate){([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds()}}} | ConvertTo-Json -Compress";

/**
 * Every process on the machine as `[{pid, ppid, name, start}]` (start in epoch ms, `null` when
 * unknown), or `null` when it cannot be read. Windows: one PowerShell CIM query; Linux: /proc;
 * elsewhere: `ps`.
 */
export async function readProcessTable() {
  try {
    if (process.platform === "win32") {
      const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", WIN_TABLE_SCRIPT], {
        timeout: LINEAGE_READ_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: 16 * 1024 * 1024
      });
      const rows = JSON.parse(stdout);
      return (Array.isArray(rows) ? rows : [rows]).map((r) => ({ pid: r.pid, ppid: r.ppid, name: String(r.name ?? ""), start: Number.isFinite(r.start) ? r.start : null }));
    }
    if (process.platform === "linux") {
      const rows = [];
      for (const entry of fs.readdirSync("/proc")) {
        if (!/^\d+$/.test(entry)) continue;
        try {
          const stat = fs.readFileSync(`/proc/${entry}/stat`, "utf8");
          const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
          rows.push({ pid: Number(entry), ppid: Number(fields[1]), name: stat.slice(stat.indexOf("(") + 1, stat.lastIndexOf(")")), start: readProcStart(Number(entry)) });
        } catch {
          // the process ended while we read
        }
      }
      return rows;
    }
    const { stdout } = await execFileAsync("ps", ["-A", "-o", "pid=,ppid=,lstart=,comm="], { timeout: LINEAGE_READ_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 });
    return stdout
      .split("\n")
      .map((line) => /^\s*(\d+)\s+(\d+)\s+(\w{3} \w{3}\s+\d+ [\d:]+ \d{4})\s+(.*)$/.exec(line))
      .filter(Boolean)
      .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), name: path.basename(m[4].trim()), start: Date.parse(m[3]) || null }));
  } catch {
    return null;
  }
}

const isSessionProcess = (name) => /^claude(\.exe)?$/i.test(name);

/**
 * The ancestors of `pid` in `table`, nearest first: `[{pid, name, start}]`, up to and including the
 * Claude session process, or `LINEAGE_DEPTH` entries. It stops at a parent that is missing or that
 * started after its child (that pid was reused: the real parent is already gone).
 */
export function lineageOf(pid, table) {
  const byPid = new Map(table.map((row) => [row.pid, row]));
  const chain = [];
  let child = byPid.get(pid);
  while (child !== undefined && chain.length < LINEAGE_DEPTH) {
    const parent = byPid.get(child.ppid);
    if (parent === undefined || parent.pid === child.pid) break;
    if (Number.isFinite(parent.start) && Number.isFinite(child.start) && parent.start > child.start + PID_START_TOLERANCE_MS) break;
    chain.push({ pid: parent.pid, name: parent.name, start: parent.start });
    if (isSessionProcess(parent.name)) break;
    child = parent;
  }
  return chain;
}

/** This process's lineage, `[]` when switched off (`MCP_HEAVY_LOCK_LINEAGE=off`) or unreadable. */
export async function readOwnLineage(env = process.env) {
  if (env.MCP_HEAVY_LOCK_LINEAGE === "off") return [];
  const table = await readProcessTable();
  return table === null ? [] : lineageOf(process.pid, table);
}

/** `readLineage()` as an array, or `[]` when it fails or takes longer than `ms`. */
function boundedLineage(readLineage, ms) {
  let timer;
  const read = Promise.resolve()
    .then(readLineage)
    .then((l) => (Array.isArray(l) ? l : []), () => []);
  const late = new Promise((resolve) => {
    timer = setTimeout(() => resolve([]), Math.max(0, ms));
    timer.unref();
  });
  return Promise.race([read, late]).finally(() => clearTimeout(timer));
}

/**
 * Is the recorded process still the one running? With a table: present and started when recorded
 * (± tolerance). Without one: its pid is alive (a reused pid then passes for alive).
 */
function recordedAlive(entry, byPid) {
  if (byPid === null) return isPidAlive(entry.pid);
  const row = byPid.get(entry.pid);
  if (row === undefined) return false;
  if (Number.isFinite(entry.start) && Number.isFinite(row.start)) return Math.abs(row.start - entry.start) <= PID_START_TOLERANCE_MS;
  return true;
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
  readLineage = () => readOwnLineage(env),
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
  const deadline = Date.now() + limit;
  // A nested caller inside a live hold skips before it pays for the lineage read: the OS says the name
  // is held (probed by connecting, never by listening) and the file names the inherited token.
  if (pipe !== null && inherited) {
    const written = parseHolder(readRaw(file) ?? "");
    if (written?.token === inherited && isPidAlive(written.pid) && (await probeName(pipe)) === true) return insideParent(written);
  }
  // Read before acquiring, so the holder file is written the moment the name is taken; bounded so the
  // read never runs past the caller's deadline.
  const lineage = await boundedLineage(readLineage, Math.min(LINEAGE_READ_TIMEOUT_MS, limit));
  const holderContent = () => JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), token, cmd, cwd, ppid: process.ppid, lineage });
  let announced = null;
  const pidStarts = new Map();
  let waiter = null;
  try {
    return await take();
  } finally {
    waiter?.unregister();
  }

  async function waitOrTimeout(holder) {
    if (waiter === null) {
      waiter = registerWaiter(file, { token, cmd, cwd, lineage });
    } else {
      // Only an ancestor alive when the wait began counts: one already gone then was a spawn-and-exit
      // wrapper (Start-Process, cmd /c start, nohup, a scheduler stub), not a session that stopped.
      const gone = waiter.watched.find((entry) => !isPidAlive(entry.pid));
      if (gone !== undefined) {
        throw new HeavyLockOrphanError(
          `heavy-check lock: stopped waiting — ancestor pid ${String(gone.pid)} (${String(gone.name)}) of this run is gone, ` +
            `so the session that started it no longer waits for it (${file}).`
        );
      }
    }
    if (Date.now() >= deadline) {
      throw new HeavyLockTimeoutError(
        `heavy-check lock still held after ${String(Math.round(limit / 1000))} s by ${describeHolder(holder)} ` +
          `(${file}). Wait for it, or set MCP_HEAVY_LOCK_TIMEOUT_MS; --no-lock skips the lock.`
      );
    }
    // A flagged holder (launcher or whole chain gone) is noted beside the lock; once flagged
    // MCP_HEAVY_LOCK_ORPHAN_MINUTES, the waiting line names the kill command (never run here).
    const flag = holder === null ? null : holderOrphanByPids(holder);
    const orphaned = holder === null ? { since: null, due: false } : noteOrphan(file, { token: holder.token, pid: holder.pid, orphan: flag.flagged }, { env });
    const key = holder === null ? null : `${String(holder.token)}|${String(orphaned.due)}`;
    if (holder !== null && announced !== key) {
      log(
        `heavy-check lock held by ${describeHolder(holder)}; waiting up to ` +
          `${limit >= 60_000 ? `${String(Math.round(limit / 60_000))} min` : `${String(Math.round(limit / 1000))} s`} (MCP_HEAVY_LOCK_TIMEOUT_MS) …` +
          (orphaned.due
            ? `\n  the holder is flagged ${flagLabel(flag.whole)} since ${String(orphaned.since)}: ${killCommand(holder.pid)}\n  ${KILL_RULE}`
            : "")
      );
      announced = key;
    }
    await sleep(Math.max(1, Math.min(pollMs, deadline - Date.now())));
  }

  async function take() {
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
      writeHolderFile(file, holderContent());
    } else {
      const content = holderContent();
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

    // A new holder: a previous holder's orphan sighting no longer applies.
    fs.rmSync(heavyLockOrphanFile(file), { force: true });
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
      if (parseHolder(readRaw(heavyLockOrphanFile(file)) ?? "")?.token === token) fs.rmSync(heavyLockOrphanFile(file), { force: true });
      server?.close();
      if (env.MCP_HEAVY_LOCK_TOKEN === token) delete env.MCP_HEAVY_LOCK_TOKEN;
    }
    process.on("exit", release);
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
    return { acquired: true, path: file, pipe, token, release };
  }
}

/** For a CLI entry point: take the lock, or print why not; exit 75 on timeout, 76 on an orphaned wait. */
export async function holdHeavyLockOrExit(options) {
  try {
    const lock = await acquireHeavyLock(options);
    // Said so a CI log shows why nothing waited; a nested run inside its parent's hold stays quiet.
    if (!lock.acquired && !lock.reason.startsWith("held by parent")) console.error(`heavy-check lock skipped: ${lock.reason}`);
    return lock;
  } catch (error) {
    if (error instanceof HeavyLockTimeoutError) {
      console.error(error.message);
      process.exit(LOCK_TIMEOUT_EXIT);
    }
    if (error instanceof HeavyLockOrphanError) {
      console.error(error.message);
      process.exit(LOCK_ORPHANED_EXIT);
    }
    throw error;
  }
}

// ---- waiters and status ----

/**
 * Register a waiting call in `<lock>.waiters/`: `{pid, ppid, token, cmd, cwd, since, lineage}`. The
 * entry goes when the wait ends (`unregister`) or the process exits; a hard-killed waiter leaves it,
 * and `heavyLockStatus` drops entries of dead pids.
 */
export function registerWaiter(file, { token, cmd, cwd, lineage = [] }) {
  const dir = heavyLockWaitersDir(file);
  const entry = path.join(dir, `${String(process.pid)}-${token}.json`);
  const record = { pid: process.pid, ppid: process.ppid, token, cmd, cwd, since: new Date().toISOString(), lineage };
  try {
    fs.mkdirSync(dir, { recursive: true });
    // Written aside, then renamed: status never reads a half-written entry (and so never deletes one).
    const tmp = `${entry}.${randomUUID()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(record));
    fs.renameSync(tmp, entry);
  } catch {
    // registration is information only: a wait never fails because it could not be shown
  }
  const unregister = () => {
    process.off("exit", unregister);
    fs.rmSync(entry, { force: true });
  };
  process.on("exit", unregister);
  return { entry, watched: lineage.filter((ancestor) => isPidAlive(ancestor.pid)), unregister };
}

/** Is the OS-owned name held? Probed by connecting (never by listening: that would take the lock). */
function probeName(name) {
  return new Promise((resolve) => {
    const socket = net.connect(name);
    const done = (held) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(held);
    };
    const timer = setTimeout(() => done(null), 2_000);
    socket.once("connect", () => done(true));
    socket.once("error", (error) => done(error.code === "ENOENT" || error.code === "ECONNREFUSED" ? false : null));
  });
}

function describeProcess(record, byPid) {
  const alive = recordedAlive({ pid: record.pid, start: null }, byPid);
  const ancestors = (Array.isArray(record.lineage) ? record.lineage : []).map((a) => ({ pid: a.pid, name: a.name, alive: recordedAlive(a, byPid) }));
  const ppid = Number.isInteger(record.ppid) ? record.ppid : (byPid?.get(record.pid)?.ppid ?? null);
  let parentAlive = null;
  if (ancestors.length > 0 && ancestors[0].pid === ppid) parentAlive = ancestors[0].alive;
  // No recorded lineage (a holder from an older writer): the live table says whether the parent is
  // still the process that started this one (present, and started before it).
  else if (ppid !== null && byPid !== null && byPid.has(record.pid)) parentAlive = lineageOf(record.pid, [...byPid.values()])[0]?.pid === ppid;
  else if (ppid !== null) parentAlive = isPidAlive(ppid);
  const gone = ancestors.filter((a) => !a.alive).map((a) => a.pid);
  const noLineage = parentAlive === null ? null : !parentAlive;
  // Orphan: the whole recorded chain up to the session is gone. One link gone is `ancestorGone` only.
  const orphan = ancestors.length > 0 ? gone.length === ancestors.length : noLineage;
  const ancestorGone = ancestors.length > 0 ? gone.length > 0 : noLineage;
  return { pid: record.pid, cmd: record.cmd ?? null, cwd: record.cwd ?? null, alive, ppid, parentAlive, ancestors, orphan, ancestorGone, goneAncestors: gone };
}

/**
 * The lock as it stands, read-only: `{ path, pipe, nameHeld, holder, waiters, cleaned }`. `holder` is
 * the file's holder (`null` when there is none) with `since`, `alive`, its parent and recorded
 * ancestors, `ancestorGone` (some recorded ancestor is gone: launcher gone), `orphan` (every recorded
 * ancestor is gone; without a lineage, the parent is gone), `orphanSince` (first sighting of either,
 * kept in `<lock>.orphan.json`) and `killHint` (the command to end it, once flagged
 * `MCP_HEAVY_LOCK_ORPHAN_MINUTES`; never run).
 * `waiters` are the live registered waiters, oldest first; entries of dead pids are removed and
 * counted in `cleaned`. The only writes: that cleanup and the orphan sighting file. `readTable` and
 * `now` are test hooks.
 */
export async function heavyLockStatus({ env = process.env, readTable = readProcessTable, platform = process.platform, now = Date.now() } = {}) {
  const file = heavyLockPath(env);
  const pipe = heavyLockPipeName(file, { platform, env });
  const [table, nameHeld] = await Promise.all([readTable(), pipe === null ? Promise.resolve(null) : probeName(pipe)]);
  const byPid = table === null ? null : new Map(table.map((row) => [row.pid, row]));

  const written = parseHolder(readRaw(file) ?? "");
  let holder = null;
  if (written !== null) {
    holder = { ...describeProcess(written, byPid), since: written.startedAt ?? null };
    // Only a live holder of a held name can be an orphan worth ending; a left-over file is nobody's.
    const live = holder.alive && nameHeld !== false;
    // Flagged: launcher gone (session alive) or whole chain gone; both get the sighting and the hint.
    const flagged = holder.orphan === true || holder.ancestorGone === true ? true : holder.ancestorGone === false ? false : null;
    const seen = noteOrphan(file, { token: written.token, pid: written.pid, orphan: live ? flagged : false }, { now, env });
    holder.orphanSince = seen.since;
    holder.killHint = seen.due ? killCommand(written.pid, platform) : null;
  } else {
    noteOrphan(file, { token: null }, { now, env });
  }

  const dir = heavyLockWaitersDir(file);
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((name) => name.endsWith(".json"));
  } catch {
    // no waiter ever registered
  }
  const waiters = [];
  let cleaned = 0;
  for (const name of names) {
    const full = path.join(dir, name);
    const record = parseHolder(readRaw(full) ?? "");
    if (record === null || !isPidAlive(record.pid)) {
      fs.rmSync(full, { force: true });
      cleaned++;
      continue;
    }
    waiters.push({ ...describeProcess(record, byPid), since: record.since ?? null });
  }
  waiters.sort((a, b) => String(a.since).localeCompare(String(b.since)));
  return { path: file, pipe, nameHeld, processTable: table !== null, orphanMinutes: orphanMinutes(env), holder, waiters, cleaned };
}

/** `heavyLockStatus` as lines for a terminal. */
export function formatHeavyLockStatus(status) {
  const who = (p) => {
    const lineageFlag =
      p.orphan === true ? "ORPHAN" : p.ancestorGone === true ? "launcher gone (session alive)" : p.orphan === false ? "parent alive" : "parent unknown";
    const flags = [p.alive ? "alive" : "DEAD", lineageFlag];
    const chain = p.ancestors.length ? ` <- ${p.ancestors.map((a) => `${String(a.pid)} ${String(a.name)}${a.alive ? "" : " (gone)"}`).join(" <- ")}` : ` <- ppid ${String(p.ppid)}`;
    return `pid ${String(p.pid)} [${flags.join(", ")}] since ${String(p.since)}\n    cmd: ${String(p.cmd)}\n    cwd: ${String(p.cwd)}\n    lineage:${chain}`;
  };
  const lines = [`lock: ${status.path}`];
  if (status.pipe !== null) lines.push(`name: ${status.pipe} — ${status.nameHeld === true ? "held" : status.nameHeld === false ? "free" : "unknown"}`);
  if (!status.processTable) lines.push("process table unreadable: liveness from pids only, start times unchecked");
  lines.push(status.holder === null ? "holder: none" : `holder: ${who(status.holder)}`);
  if (status.holder !== null && status.nameHeld === false) lines.push("    (the file is left over: the name is free, so nobody holds the lock)");
  if (status.holder?.orphanSince) {
    const label = flagLabel(status.holder.orphan === true);
    lines.push(`    flagged ${label} since ${status.holder.orphanSince} (kill hint after ${String(status.orphanMinutes)} min, MCP_HEAVY_LOCK_ORPHAN_MINUTES)`);
  }
  if (status.holder?.killHint) {
    lines.push(status.holder.killHint);
    lines.push(`    ${KILL_RULE}`);
  }
  lines.push(status.waiters.length === 0 ? "waiters: none" : `waiters (${String(status.waiters.length)}, oldest first):`);
  for (const w of status.waiters) lines.push(`  ${who(w)}`);
  if (status.cleaned > 0) lines.push(`removed ${String(status.cleaned)} entr${status.cleaned === 1 ? "y" : "ies"} of dead waiters`);
  return lines.join("\n");
}
