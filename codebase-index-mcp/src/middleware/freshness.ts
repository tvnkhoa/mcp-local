/**
 * R1 (wec.aria adoption plan, release B) — the index is never silently stale.
 *
 * Measured before this existed: wec.aria's index was 463 commits behind HEAD with no watcher, and
 * every read tool answered from it with `coverage: "high"` and a `staleWarning` side field nobody
 * reads. Agents went back to grep. Watchers are off by design (active-repo policy, several sessions
 * per worktree), so freshness has to come from the query itself.
 *
 * Before a read tool runs, `ensureFresh` compares HEAD and the working tree with what was last
 * indexed. If they differ it starts the EXISTING incremental machinery — `incremental` when HEAD
 * moved, `dirty` when only the working tree did — and waits up to a budget. A run that outlives the
 * budget is NOT aborted: it keeps going in the background and the next query reuses it (an 8 Oct
 * incremental run of wec.aria took 50 s; abort-on-budget would never catch up). The answer given
 * meanwhile carries a `freshness` block and a lowered `coverage` — see `applyFreshness`.
 *
 * One refresh per repo at a time: in this process by a shared promise, across processes (several
 * Claude sessions share one worktree and one index DB) by a lock file beside the DB.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import { parseStatusPorcelainV2 } from "../services/git/gitHelpers.js";
import type { IndexMode, IndexRunResult } from "../types/index.js";

export type FreshnessState = "fresh" | "refreshed" | "refreshing" | "stale";

export type FreshnessNote = {
  state: FreshnessState;
  /** What the gate ran, or found running. */
  mode?: "full" | "incremental" | "dirty";
  elapsedMs?: number;
  runId?: string;
  /** Why the answer may not reflect the current tree. Absent when `state` is fresh/refreshed. */
  reason?: string;
  /**
   * MCP-ISSUE-101 F2: dirty paths the gate gave up on — unreadable on several consecutive checks, so they no
   * longer force a run. The index holds an older copy of each (or none); the answer says so.
   */
  unreadable?: string[];
};

export type RepoTreeState = {
  /** Full HEAD sha, or null outside git. */
  head: string | null;
  /** Repo-relative paths changed in the working tree (staged, unstaged, untracked). */
  dirty: readonly string[];
};

export type FreshnessGateOptions = {
  enabled: boolean;
  budgetMs: number;
  /** Directory for cross-process lock files — the index DB's directory. */
  lockDir: string;
  getRepoPath: (repoId: string) => string | null;
  /** Commit the latest recorded run indexed, or null. */
  getIndexedCommit: (repoId: string) => string | null;
  /** May be async (release I1b: the server reads git without blocking its event loop). */
  readTree: (repoPath: string) => RepoTreeState | Promise<RepoTreeState>;
  /**
   * `dirtyPaths` (release K3, P1): the tree the gate just read, handed to a dirty run so it does not read
   * git again. The same porcelain-v2 read the run would make, so the run indexes exactly what the gate
   * keys freshness and the dirty ledger on.
   */
  run: (repoId: string, repoPath: string, mode: IndexMode, dirtyPaths?: readonly string[]) => Promise<IndexRunResult>;
  /**
   * Why this process must not refresh the repo at all, or null. Release F: a server still running an
   * older build refreshed over a newer build's index (several processes share one DB).
   */
  refuseRefresh?: (repoId: string) => string | null;
  /**
   * MCP-ISSUE-101: the serialized {@link TreeKey} the index's latest run covered (`index_runs.tree_key`), shared
   * by every process on the DB. Absent: the gate keeps the key in memory, for this process only.
   */
  getCoveredKey?: (repoId: string) => string | null;
  /** MCP-ISSUE-101: persist the key a successful run covered, on that run's record. Best-effort. */
  recordCoveredKey?: (repoId: string, runId: string, key: string) => void;
  /** A dirty file larger than this is keyed by its size, not hashed: the index never reads it (its size cap is lower). */
  hashMaxBytes?: number;
  /**
   * F4: forget the stored content hash of these files, so the next scoped run re-extracts them (and therefore
   * resolves). Without it a dead dirty run is repaired by a full run.
   */
  invalidateFileHashes?: (repoId: string, paths: readonly string[]) => void;
  /** F2: a path unreadable on this many consecutive checks stops forcing runs (default {@link DEFAULT_UNREADABLE_CHECKS}). */
  unreadableChecks?: number;
  /** Tag a finished run as query-triggered, for `health_check`. Best-effort. */
  markTriggered?: (runId: string) => void;
  /**
   * Release J: record paths the next dirty run must re-index although git no longer lists them (the
   * same set the refactor engine fills after a rollback; the run clears it when it succeeds). Without
   * it, a vanished ledger path falls back to an `incremental` run.
   */
  markPendingReindex?: (repoId: string, paths: string[]) => void;
  /**
   * How long a tree check is reused before git is asked again. Default 0: a reused "fresh" verdict
   * served a deleted file's symbols silently for its whole lifetime (R1, release B.1). Only the
   * "another process is refreshing" note is cached, for 1 s, so a busy caller does not hammer git.
   */
  checkTtlMs?: number;
  /** A lock older than this, or held by a dead pid, is broken. */
  staleLockMs?: number;
  /**
   * MCP-ISSUE-101 part 5: a run marker (see `serialize`) older than this counts as left by a crashed run even
   * when its pid is alive (pid reuse). Default 6 h; a dead pid is never counted.
   */
  staleRunMs?: number;
  /**
   * MCP-ISSUE-101 part 5: the `index_version` of the repo's latest successful FULL run, and this build's. Only a
   * full run re-resolves every file, so a scoped run after a version bump does not count. When they differ, a
   * "fresh" or "refreshed" answer is downgraded to "refreshing" with the reason.
   */
  getFullRunVersion?: (repoId: string) => string | null;
  buildVersion?: string;
  now?: () => number;
};

const LOCK_PREFIX = "refresh-";

/** The folder beside the index DB that holds refresh locks and dirty-run ledgers (created on demand). */
export function freshnessStateDir(dbPath: string): string {
  const dir = path.join(path.dirname(path.resolve(dbPath)), ".codebase-index-state");
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    // Unwritable: lock and ledger writes fail soft, and the gate degrades to "refreshing" notes.
  }
  return dir;
}

export function lockFileFor(lockDir: string, repoId: string): string {
  return path.join(lockDir, `${LOCK_PREFIX}${repoId.replace(/[^\w.-]/g, "_")}.lock`);
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** `wx` create; on EEXIST break the lock only if its holder is dead or it is older than `staleMs`. */
export function tryAcquireLock(file: string, staleMs: number, now: number): boolean {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(file, JSON.stringify({ pid: process.pid, at: now }), { flag: "wx" });
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") return false;
      let holder: { pid?: number; at?: number } = {};
      try {
        holder = JSON.parse(fs.readFileSync(file, "utf8")) as { pid?: number; at?: number };
      } catch {
        // Unreadable: written mid-crash. Treat as stale.
      }
      const dead = typeof holder.pid === "number" && holder.pid !== process.pid && !pidAlive(holder.pid);
      const old = typeof holder.at !== "number" || now - holder.at > staleMs;
      if (!dead && !old) return false;
      try {
        fs.unlinkSync(file);
      } catch {
        return false;
      }
    }
  }
  return false;
}

/**
 * MCP-ISSUE-101 part 5: one marker file per index run in progress, written by `serialize` in whichever process
 * runs it (gate refresh, index_repository, watcher) and removed when the run ends. A full run commits in
 * batches and resolves edges only after the last one, so while a marker is live another process's query
 * reads a partly re-written index — it must not be told "fresh".
 */
function runMarkerPrefix(repoId: string): string {
  return `running-${repoId.replace(/[^\w.-]/g, "_")}-`;
}

/**
 * A marker's file name is `<prefix><pid>-<seq>.json`. Matching on the prefix alone let repo `a` see the markers of
 * `a-b` (`running-a-b-…` starts with `running-a-`) and answer `refreshing` for another repo's run; the tail must be
 * exactly two numbers. A marker written by this build also names its repoId, which settles two ids that sanitize
 * to the same string; one written before that (no repoId) is matched on its name alone.
 */
function isRunMarkerName(prefix: string, name: string): boolean {
  return name.startsWith(prefix) && /^\d+-\d+\.json$/.test(name.slice(prefix.length));
}

function markerNamesOtherRepo(file: string, repoId: string): boolean {
  try {
    const m = JSON.parse(fs.readFileSync(file, "utf8")) as { repoId?: unknown };
    return typeof m.repoId === "string" && m.repoId !== repoId;
  } catch {
    return false;
  }
}

let runMarkerSeq = 0;

function writeRunMarker(lockDir: string, repoId: string, at: number, mode?: IndexMode, paths?: readonly string[]): string | null {
  const file = path.join(lockDir, `${runMarkerPrefix(repoId)}${String(process.pid)}-${String(++runMarkerSeq)}.json`);
  try {
    // A dirty run's paths ride along (bounded) so a repair after its death can re-extract exactly those files.
    const recorded = mode === "dirty" && paths && paths.length <= MAX_MARKER_PATHS ? { paths: [...paths] } : {};
    fs.writeFileSync(file, JSON.stringify({ pid: process.pid, at, repoId, ...(mode && { mode }), ...recorded }));
    return file;
  } catch {
    return null; // unwritable state dir: the gate degrades as it does for locks
  }
}

function removeRunMarker(file: string | null): void {
  if (!file) return;
  try {
    fs.unlinkSync(file);
  } catch {
    // already gone
  }
}

/**
 * MCP-ISSUE-101 F4: a run that died mid-way (its pid is gone, its marker is still there) left the index part-written:
 * a full or incremental run commits files in batches and resolves edges only at the end, and a file whose hash was
 * stored is skipped by the next scoped run, which then finds nothing re-extracted and skips the resolve passes too.
 * HEAD still equals the last ok run's commit, so without this the gate answers "fresh". The sweep of a dead marker
 * that names its mode leaves this file; the gate answers "refreshing" and starts a FULL run (an incremental one
 * cannot be shown to repair a run killed in the resolve phase), and a successful full run clears it.
 */
export type RepairNeeded = {
  /** The most thorough mode of the dead runs: full > incremental > dirty. */
  mode: IndexMode;
  pid: number;
  at: number;
  /** Repairs the gate has started for this flag; a repair that is killed or fails leaves the flag and this count. */
  attempts?: number;
  /** A dead `dirty` run's paths (when the marker recorded them): the repair re-extracts exactly these. */
  paths?: string[];
};

/** A marker records at most this many paths; a bigger dirty run is repaired as a full one. */
export const MAX_MARKER_PATHS = 2000;
/** After this many repairs that failed or were killed, the gate stops starting runs and answers stale. */
export const MAX_REPAIR_ATTEMPTS = 2;

const MODE_RANK: Record<string, number> = { full: 3, incremental: 2, dirty: 1 };

function repairFileFor(lockDir: string, repoId: string): string {
  return path.join(lockDir, `repair-${repoId.replace(/[^\w.-]/g, "_")}.json`);
}

function writeRepair(lockDir: string, repoId: string, info: RepairNeeded): void {
  try {
    fs.writeFileSync(repairFileFor(lockDir, repoId), JSON.stringify({ ...info, repoId }));
  } catch {
    // Best-effort: without it the gate answers as it did before this existed.
  }
}

/** Merge a dead run into the flag: the more thorough mode wins, the attempts of earlier repairs are kept. */
function markRepairNeeded(lockDir: string, repoId: string, dead: { mode: IndexMode; pid: number; at: number; paths?: string[] }): void {
  const prev = readRepairNeeded(lockDir, repoId);
  const mode = prev && (MODE_RANK[prev.mode] ?? 0) > (MODE_RANK[dead.mode] ?? 0) ? prev.mode : dead.mode;
  // A dirty repair re-extracts the union of the dead runs' paths; one dead run without paths makes it a full repair.
  const paths =
    mode === "dirty" && dead.paths && (!prev || (prev.mode === "dirty" && prev.paths))
      ? [...new Set([...(prev?.paths ?? []), ...dead.paths])].sort()
      : undefined;
  writeRepair(lockDir, repoId, {
    mode: mode === "dirty" && !paths ? "full" : mode,
    pid: dead.pid,
    at: dead.at,
    ...(prev?.attempts && { attempts: prev.attempts }),
    ...(paths && paths.length <= MAX_MARKER_PATHS * 4 && { paths })
  });
}

/** The gate is about to start a repair run: count it first, so a repair that is killed still counts. */
function bumpRepairAttempts(lockDir: string, repoId: string, repair: RepairNeeded): void {
  writeRepair(lockDir, repoId, { ...repair, attempts: (repair.attempts ?? 0) + 1 });
}

export function readRepairNeeded(lockDir: string, repoId: string): RepairNeeded | null {
  try {
    const m = JSON.parse(fs.readFileSync(repairFileFor(lockDir, repoId), "utf8")) as Partial<RepairNeeded> & { repoId?: string };
    if (typeof m.repoId === "string" && m.repoId !== repoId) return null;
    if (typeof m.mode !== "string" || typeof m.pid !== "number" || typeof m.at !== "number") return null;
    return {
      mode: m.mode,
      pid: m.pid,
      at: m.at,
      ...(typeof m.attempts === "number" && { attempts: m.attempts }),
      ...(Array.isArray(m.paths) && { paths: m.paths.filter((p): p is string => typeof p === "string") })
    };
  } catch {
    return null;
  }
}

export function clearRepairNeeded(lockDir: string, repoId: string): void {
  try {
    fs.unlinkSync(repairFileFor(lockDir, repoId));
  } catch {
    // already gone
  }
}

/** The live run markers for a repo: pid alive and younger than `staleMs`. Dead or stale ones are removed. */
export function liveRunMarkers(lockDir: string, repoId: string, staleMs: number, now: number): Array<{ pid: number; at: number }> {
  const prefix = runMarkerPrefix(repoId);
  let names: string[];
  try {
    names = fs.readdirSync(lockDir).filter((n) => isRunMarkerName(prefix, n));
  } catch {
    return [];
  }
  const live: Array<{ pid: number; at: number }> = [];
  for (const name of names) {
    const file = path.join(lockDir, name);
    if (markerNamesOtherRepo(file, repoId)) continue;
    let m: { pid?: number; at?: number; mode?: IndexMode; paths?: unknown } = {};
    try {
      m = JSON.parse(fs.readFileSync(file, "utf8")) as typeof m;
    } catch {
      continue; // being written, or just removed
    }
    if (typeof m.pid === "number" && typeof m.at === "number" && pidAlive(m.pid) && now - m.at <= staleMs) {
      live.push({ pid: m.pid, at: m.at });
    } else {
      // F4: a holder that died mid-run left the index part-written; so may one that outlived `staleMs` and dies
      // later, so an expired marker is remembered too (a marker of an older build names no mode: skipped).
      if (typeof m.pid === "number" && typeof m.mode === "string") {
        const paths = Array.isArray(m.paths) ? m.paths.filter((p): p is string => typeof p === "string") : undefined;
        markRepairNeeded(lockDir, repoId, { mode: m.mode, pid: m.pid, at: typeof m.at === "number" ? m.at : 0, ...(paths && { paths }) });
      }
      removeRunMarker(file);
    }
  }
  return live;
}

/** Default age past which a run marker counts as left by a crashed run (see `FreshnessGateOptions.staleRunMs`). */
export const DEFAULT_STALE_RUN_MS = 6 * 60 * 60_000;

/**
 * MCP-ISSUE-105: delete the state files of one repo — dirty ledger, repair flag, run markers. The refresh lock is
 * NOT removed here: the caller holds it (`tryAcquireLock`) and releases it itself, and a lock someone else holds
 * is never ours to unlink. A marker
 * is matched on its exact `<pid>-<seq>.json` tail, so a repo whose id extends this one's is left alone.
 * Returns the file names removed.
 */
export function removeRepoStateFiles(lockDir: string, repoId: string): string[] {
  const prefix = runMarkerPrefix(repoId);
  const isMarker = (name: string): boolean => isRunMarkerName(prefix, name) && !markerNamesOtherRepo(path.join(lockDir, name), repoId);
  const exact = new Set([path.basename(ledgerFileFor(lockDir, repoId)), path.basename(repairFileFor(lockDir, repoId))]);
  let names: string[];
  try {
    names = fs.readdirSync(lockDir);
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const name of names) {
    if (!exact.has(name) && !isMarker(name)) continue;
    try {
      fs.unlinkSync(path.join(lockDir, name));
      removed.push(name);
    } catch {
      // already gone
    }
  }
  return removed.sort();
}

export function releaseLock(file: string): void {
  try {
    const holder = JSON.parse(fs.readFileSync(file, "utf8")) as { pid?: number };
    if (holder.pid === process.pid) fs.unlinkSync(file);
  } catch {
    // Already gone, or someone else's: nothing to release.
  }
}

/**
 * Which paths the index holds from the WORKING TREE rather than from HEAD — the dirty-run ledger.
 *
 * A dirty-mode run re-indexes only what is dirty now. A file indexed while dirty and then deleted or
 * reverted is never dirty again, so no dirty run looks at it, and its symbols stay in the graph as
 * current (wec.aria acceptance of release B: an untracked probe file, deleted, was still found with
 * coverage "high"). The ledger remembers those paths beside the indexed HEAD; when one of them is no
 * longer dirty, the gate hands it to the next dirty run as a pending re-index (`markPendingReindex`):
 * the run removes a path gone from disk and re-extracts a reverted one. Until release J that was an
 * `incremental` run — a whole-repo re-hash, 3-6 s on wec.aria to remove one file.
 *
 * Kept as a file beside the index DB, not in memory, so every server process sharing the DB — one per
 * Claude session — sees the paths another one indexed.
 */
export type DirtyLedger = { head: string; paths: string[] };

function ledgerFileFor(lockDir: string, repoId: string): string {
  return path.join(lockDir, `dirty-${repoId.replace(/[^\w.-]/g, "_")}.json`);
}

export function readDirtyLedger(lockDir: string, repoId: string): DirtyLedger | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(ledgerFileFor(lockDir, repoId), "utf8")) as DirtyLedger;
    return typeof parsed.head === "string" && Array.isArray(parsed.paths) ? parsed : null;
  } catch {
    return null;
  }
}

function writeDirtyLedger(lockDir: string, repoId: string, ledger: DirtyLedger): void {
  try {
    fs.writeFileSync(ledgerFileFor(lockDir, repoId), JSON.stringify(ledger));
  } catch {
    // Best-effort: a missing ledger costs at most one extra incremental run later.
  }
}

const sameCommit = (a: string, b: string): boolean => a.startsWith(b) || b.startsWith(a);

/** Ledger paths that are no longer dirty at this HEAD: indexed from a working tree that is gone. */
export function vanishedDirtyPaths(ledger: DirtyLedger | null, head: string, dirty: readonly string[]): string[] {
  if (!ledger || !sameCommit(ledger.head, head)) return [];
  const now = new Set(dirty);
  return ledger.paths.filter((p) => !now.has(p));
}

/**
 * Update the ledger after ANY index run (the gate's or index_repository's). A `dirty` run adds the
 * paths it indexed; `incremental`/`full` read every file from disk, so afterwards the index holds
 * the working tree for exactly the paths that are dirty now.
 */
export function recordDirtyLedger(
  lockDir: string,
  repoId: string,
  mode: IndexMode,
  tree: RepoTreeState,
  /**
   * The run also re-indexed the ledger paths that were no longer dirty: they leave the ledger. `true` for all of
   * them; a list (MCP-ISSUE-101: the paths a watcher or index_repository dirty run re-read) for those only.
   */
  clearedVanished: boolean | readonly string[] = false
): void {
  if (!tree.head) return;
  const prev = readDirtyLedger(lockDir, repoId);
  const reread = new Set(Array.isArray(clearedVanished) ? clearedVanished : []);
  const paths =
    mode === "dirty" && clearedVanished !== true && prev && sameCommit(prev.head, tree.head)
      ? [...new Set([...prev.paths.filter((p) => !reread.has(p)), ...tree.dirty])]
      : [...tree.dirty];
  writeDirtyLedger(lockDir, repoId, { head: tree.head, paths: paths.sort() });
}

/**
 * MCP-ISSUE-101: the tree identity a run covers — HEAD plus a content hash of each dirty file (`deleted` when it is
 * gone, `dir` for a directory entry, {@link UNREADABLE} when it could not be read). Only the dirty files are hashed: a clean file's content is HEAD's. Before this the key was each dirty
 * file's size and mtime, held in memory, so a touch re-ran the refresh and no other process could reuse it; on
 * wec.aria every query on a dirty tree paid a ~7.4 s dirty run.
 */
export type TreeKey = { head: string; files: Record<string, string> };

/** Above any index size cap: a file the index skips is keyed by its size (crossing the cap changes the size). */
export const DEFAULT_HASH_MAX_BYTES = 32 * 1024 * 1024;

/**
 * A file that could not be read (EMFILE, EACCES, a lock): never equal to anything, so the key vouches for nothing
 * about it. Only ENOENT / ENOTDIR mean `deleted`.
 */
export const UNREADABLE = "unreadable";
/**
 * MCP-ISSUE-101 F2: what the gate keys a path that stayed {@link UNREADABLE} for {@link DEFAULT_UNREADABLE_CHECKS}
 * consecutive checks. Stable, so the covered key matches it and the path stops forcing a dirty run that cannot
 * index it; the first readable hash differs from it, so recovery is noticed.
 */
export const UNREADABLE_CAPPED = "unreadable-capped";
export const DEFAULT_UNREADABLE_CHECKS = 3;
const execFileAsync = promisify(execFile);
const HASH_CONCURRENCY = 16;
const HASH_CACHE_MAX = 4096;

/**
 * Hashes reused while a file's (size, mtime, ctime) is unchanged, in this process. ctime is part of the identity:
 * a write moves it even when the mtime is set back (`utimes` moves it too), so a same-size, same-mtime edit is
 * still re-hashed.
 */
const hashCache = new Map<string, { stamp: string; hash: string }>();

async function hashFile(abs: string, maxBytes: number): Promise<string> {
  try {
    const st = await fs.promises.stat(abs);
    if (!st.isFile()) return "dir";
    if (st.size > maxBytes) return `size:${String(st.size)}`;
    const stamp = `${String(st.size)}:${String(st.mtimeMs)}:${String(st.ctimeMs)}`;
    const cached = hashCache.get(abs);
    if (cached?.stamp === stamp) return cached.hash;
    const hash = createHash("sha256").update(await fs.promises.readFile(abs)).digest("hex").slice(0, 32);
    if (hashCache.size >= HASH_CACHE_MAX) hashCache.clear();
    hashCache.set(abs, { stamp, hash });
    return hash;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR" ? "deleted" : UNREADABLE;
  }
}

/** A dirty directory entry that holds its own `.git` is a submodule: its HEAD plus its own dirty files. */
const SUBMODULE_GIT_TIMEOUT_MS = 15_000;
const MAX_SUBMODULE_DEPTH = 3;

async function gitOut(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-c", "core.quotePath=false", ...args], {
    cwd,
    timeout: SUBMODULE_GIT_TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true
  });
  return stdout;
}

/** Null when `abs` is not a submodule (no `.git` inside); {@link UNREADABLE} when git cannot be read there. */
async function readSubmodule(abs: string): Promise<{ key: string; dirty: string[] } | null> {
  try {
    await fs.promises.stat(path.join(abs, ".git"));
  } catch {
    return null;
  }
  try {
    const head = (await gitOut(abs, ["rev-parse", "HEAD"])).trim();
    const status = parseStatusPorcelainV2(await gitOut(abs, ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"]));
    return { key: `submodule:${head}`, dirty: status.dirty };
  } catch {
    return { key: UNREADABLE, dirty: [] };
  }
}

async function keyEntry(abs: string, maxBytes: number): Promise<{ hash: string; dirty?: string[] }> {
  try {
    if ((await fs.promises.stat(abs)).isDirectory()) {
      const sub = await readSubmodule(abs);
      return sub ? { hash: sub.key, dirty: sub.dirty } : { hash: "dir" };
    }
  } catch {
    // gone or unreadable: hashFile classifies it
  }
  return { hash: await hashFile(abs, maxBytes) };
}

/**
 * MCP-ISSUE-101 F3. A dirty directory entry git reports (with `--untracked-files=all` only a submodule can be one)
 * used to be keyed as the constant `dir`, so a change inside a dirty submodule never moved the key and was never
 * seen. The indexer walks a submodule's files like any other, so the entry is keyed by the submodule's HEAD and
 * EXPANDED into the files that are dirty inside it (`sub/x.ts`, each content-hashed like a file of the repo): a
 * change in the submodule's working tree moves the key and hands the dirty run its files. A submodule that moved to
 * another commit is seen as a changed key but its changed files are not known without a diff, so that case is
 * left to an incremental run (registry, MCP-ISSUE-101 F3).
 */
export async function computeTreeKey(repoPath: string, tree: RepoTreeState, maxBytes = DEFAULT_HASH_MAX_BYTES): Promise<TreeKey> {
  const files: Record<string, string> = {};
  let queue = [...new Set(tree.dirty)].sort();
  for (let depth = 0; queue.length > 0 && depth <= MAX_SUBMODULE_DEPTH; depth++) {
    const entries = new Array<{ hash: string; dirty?: string[] }>(queue.length);
    let next = 0;
    const level = queue;
    const worker = async (): Promise<void> => {
      while (next < level.length) {
        const i = next++;
        entries[i] = await keyEntry(path.join(repoPath, level[i] as string), maxBytes);
      }
    };
    await Promise.all(Array.from({ length: Math.min(HASH_CONCURRENCY, level.length) }, worker));
    const more: string[] = [];
    level.forEach((rel, i) => {
      const entry = entries[i] as { hash: string; dirty?: string[] };
      files[rel] = entry.hash;
      for (const d of entry.dirty ?? []) more.push(`${rel.replace(/\/+$/, "")}/${d}`);
    });
    queue = [...new Set(more)].filter((p) => !(p in files)).sort();
  }
  const sorted = Object.fromEntries(Object.keys(files).sort().map((rel) => [rel, files[rel] as string]));
  return { head: tree.head ?? "nogit", files: sorted };
}

export function serializeTreeKey(key: TreeKey): string {
  return JSON.stringify(key);
}

export function parseTreeKey(raw: string | null | undefined): TreeKey | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as TreeKey;
    return typeof parsed.head === "string" && parsed.files && typeof parsed.files === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * The paths whose indexed content may differ from the tree: dirty files new or changed since `covered`, and covered
 * files that are no longer dirty (reverted or deleted). Null when `covered` is at another HEAD (or absent): then
 * every dirty file is in question.
 */
export function pathsChangedSince(covered: TreeKey | null, current: TreeKey): string[] | null {
  if (!covered || !sameCommit(covered.head, current.head)) return null;
  const out = Object.keys(current.files).filter((p) => current.files[p] === UNREADABLE || covered.files[p] !== current.files[p]);
  for (const p of Object.keys(covered.files)) if (!(p in current.files)) out.push(p);
  return out.sort();
}

/**
 * MCP-ISSUE-101: what a watcher batch runs. A `dirty` run over the batch's paths plus every dirty file the covered
 * key does not vouch for — but only at the HEAD the index holds: when HEAD moved since the indexed commit, or the
 * key is at another HEAD, files changed between the two commits are in neither list (a `git pull` with no watcher
 * running), so the run is `incremental`. A batch that dropped events, or a tree outside git, is `incremental` too.
 */
export function watcherRunPlan(
  batch: { changed: readonly string[]; deleted: readonly string[]; overflowed: boolean },
  key: TreeKey | null,
  covered: TreeKey | null,
  indexedCommit: string | null
): { mode: "incremental" } | { mode: "dirty"; paths: string[] } {
  if (batch.overflowed || !key || !indexedCommit || !sameCommit(key.head, indexedCommit)) return { mode: "incremental" };
  if (covered && !sameCommit(covered.head, key.head)) return { mode: "incremental" };
  const unvouched = pathsChangedSince(covered, key) ?? Object.keys(key.files);
  return { mode: "dirty", paths: [...new Set([...batch.changed, ...batch.deleted, ...unvouched])].sort() };
}

export type FreshnessGate = {
  ensureFresh: (repoId: string) => Promise<FreshnessNote>;
  /** Wraps any index run so runs for one repo in this process never overlap. */
  serialize: <T>(repoId: string, fn: () => Promise<T>, mode?: IndexMode, paths?: readonly string[]) => Promise<T>;
};

export function createFreshnessGate(opts: FreshnessGateOptions): FreshnessGate {
  const now = opts.now ?? Date.now;
  const checkTtlMs = opts.checkTtlMs ?? 0;
  const staleLockMs = opts.staleLockMs ?? 15 * 60_000;
  const staleRunMs = opts.staleRunMs ?? DEFAULT_STALE_RUN_MS;
  const hashMaxBytes = opts.hashMaxBytes ?? DEFAULT_HASH_MAX_BYTES;
  const unreadableChecks = opts.unreadableChecks ?? DEFAULT_UNREADABLE_CHECKS;
  /** F2: per repo, how many consecutive checks each path was unreadable; and the paths now capped. */
  const unreadableStreaks = new Map<string, Map<string, number>>();
  const cappedPaths = new Map<string, string[]>();
  /** Swap the key's long-unreadable paths for {@link UNREADABLE_CAPPED} (in place); a readable path resets its count. */
  const capUnreadable = (repoId: string, key: TreeKey): void => {
    const prev = unreadableStreaks.get(repoId);
    const streaks = new Map<string, number>();
    const capped: string[] = [];
    for (const [p, h] of Object.entries(key.files)) {
      if (h !== UNREADABLE) continue;
      const n = (prev?.get(p) ?? 0) + 1;
      streaks.set(p, n);
      if (n >= unreadableChecks) {
        key.files[p] = UNREADABLE_CAPPED;
        capped.push(p);
      }
    }
    unreadableStreaks.set(repoId, streaks);
    cappedPaths.set(repoId, capped.sort());
  };
  /** Without `getCoveredKey`: the key each repo's last completed refresh in THIS process covered. */
  const coveredKey = new Map<string, string>();
  const readCovered = (repoId: string): TreeKey | null => {
    try {
      return parseTreeKey(opts.getCoveredKey ? opts.getCoveredKey(repoId) : coveredKey.get(repoId));
    } catch {
      return null;
    }
  };
  const lastCheck = new Map<string, { at: number; note: FreshnessNote }>();
  type Flight = { mode: "full" | "incremental" | "dirty"; startedAt: number; promise: Promise<IndexRunResult | null>; cleanup?: number };
  const inflight = new Map<string, Flight>();
  const runChain = new Map<string, Promise<unknown>>();

  const serialize = <T>(repoId: string, fn: () => Promise<T>, mode?: IndexMode, paths?: readonly string[]): Promise<T> => {
    const prev = runChain.get(repoId) ?? Promise.resolve();
    // MCP-ISSUE-101 part 5: every run says it is running, for the gates of every process on this DB.
    const marked = async (): Promise<T> => {
      const marker = writeRunMarker(opts.lockDir, repoId, now(), mode, paths);
      try {
        const result = await fn();
        // F4: a full run that finished owes the index nothing any more.
        const status = (result as { status?: unknown } | null | undefined)?.status;
        if (mode === "full" && status !== "failed" && status !== "cancelled") clearRepairNeeded(opts.lockDir, repoId);
        return result;
      } finally {
        removeRunMarker(marker);
      }
    };
    const next = prev.then(marked, marked);
    runChain.set(repoId, next.catch(() => undefined));
    return next;
  };

  const waitBudget = async (
    repoId: string,
    flight: Flight
  ): Promise<FreshnessNote> => {
    // The budget runs from the RUN's start, not this call's: a call that joins a run already past its
    // budget answers at once. Measured live: every call during a 20 s refresh waited another 5 s.
    const started = flight.startedAt;
    // A spent budget answers at once. Racing a 0 ms timer is not enough: the run starts in a
    // microtask and its first stretch can finish before the timers phase, so a zero budget waited.
    const remaining = opts.budgetMs - (now() - started);
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<"timeout">((resolve) => {
      if (remaining <= 0) resolve("timeout");
      else timer = setTimeout(() => resolve("timeout"), remaining);
    });
    const outcome = remaining <= 0 ? "timeout" : await Promise.race([flight.promise, timeout]);
    if (timer) clearTimeout(timer);
    if (outcome === "timeout") {
      return {
        state: "refreshing",
        mode: flight.mode,
        elapsedMs: now() - started,
        reason:
          `${flight.mode === "incremental" ? "an" : "a"} ${flight.mode} re-index is still running after the ${String(opts.budgetMs)} ms query budget` +
          (flight.cleanup ? ` (${String(flight.cleanup)} file(s) indexed from an earlier working tree were deleted or reverted since)` : "") +
          "; it continues in the background and a later query will use it. This answer comes from the previous index."
      };
    }
    if (outcome === null) {
      return { state: "stale", mode: flight.mode, reason: "the refresh run failed; this answer comes from the previous index." };
    }
    // MCP-ISSUE-101: a run that ended failed or cancelled (superseded) covered nothing; say so, never "refreshed".
    if (outcome.status === "failed" || outcome.status === "cancelled") {
      return { state: "stale", mode: flight.mode, runId: outcome.runId, reason: `the refresh run ended ${outcome.status}; this answer comes from the previous index.` };
    }
    lastCheck.delete(repoId);
    return { state: "refreshed", mode: flight.mode, elapsedMs: now() - started, runId: outcome.runId };
  };

  /** MCP-ISSUE-101 part 5: an index built before this build's resolution rules is not current, whatever the tree says. */
  const versionWarning = (repoId: string): string | null => {
    if (!opts.getFullRunVersion || !opts.buildVersion) return null;
    let indexed: string | null;
    try {
      indexed = opts.getFullRunVersion(repoId);
    } catch {
      return null;
    }
    if (!indexed || indexed === opts.buildVersion) return null;
    return `this repo's index was last fully built by ${indexed}; this server runs ${opts.buildVersion}, which resolves edges differently. Answers can differ from a current index until index_repository runs with mode "full".`;
  };

  const ensureFresh = async (repoId: string): Promise<FreshnessNote> => {
    if (!opts.enabled) return { state: "fresh" };
    const checked = await ensureFreshTree(repoId);
    const capped = cappedPaths.get(repoId) ?? [];
    const note: FreshnessNote = capped.length > 0 ? { ...checked, unreadable: capped } : checked;
    const warning = versionWarning(repoId);
    if (!warning) return note;
    if (note.state === "fresh" || note.state === "refreshed") return { ...note, state: "refreshing", reason: warning };
    return { ...note, reason: `${note.reason ?? ""} Also: ${warning}`.trim() };
  };

  const ensureFreshTree = async (repoId: string): Promise<FreshnessNote> => {
    const started = now();

    const running = inflight.get(repoId);
    if (running) return waitBudget(repoId, running);

    // MCP-ISSUE-101 part 5: a run of this repo in any process (index_repository, a watcher, another gate).
    const markers = liveRunMarkers(opts.lockDir, repoId, staleRunMs, started);
    if (markers.length > 0) {
      const oldest = Math.min(...markers.map((m) => m.at));
      return {
        state: "refreshing",
        elapsedMs: started - oldest,
        reason:
          `an index run of this repo is in progress (pid ${markers.map((m) => String(m.pid)).join(", ")}, for ${String(Math.round((started - oldest) / 1000))} s); ` +
          "until it ends, this answer comes from a partly re-written index — files it has re-extracted lack their resolved edges until its resolve phase."
      };
    }

    // F4: a run that died mid-way (see RepairNeeded) leaves the index part-written whatever HEAD and the tree say.
    const repair = readRepairNeeded(opts.lockDir, repoId);
    if (repair && (repair.attempts ?? 0) >= MAX_REPAIR_ATTEMPTS) {
      // The repair was started this many times and each was killed or failed: another run would only repeat it.
      return {
        state: "stale",
        mode: repair.mode,
        reason: `the index was left part-written by a ${repair.mode} run that died, and the repair failed ${String(repair.attempts)} times; run index_repository mode full. This answer comes from a part-written index.`
      };
    }
    const cached = lastCheck.get(repoId);
    if (!repair && cached && started - cached.at < (cached.note.state === "fresh" ? checkTtlMs : Math.max(checkTtlMs, 1_000))) return cached.note;

    const repoPath = opts.getRepoPath(repoId);
    if (!repoPath) return { state: "fresh" };

    let tree: RepoTreeState;
    try {
      tree = await opts.readTree(repoPath);
    } catch {
      return { state: "fresh" }; // not a git repo: nothing to compare against
    }
    if (!tree.head) return { state: "fresh" };
    const key = await computeTreeKey(repoPath, tree, hashMaxBytes);
    capUnreadable(repoId, key);
    // The tree read and the hashing may have yielded: a concurrent call for this repo can have started a run meanwhile.
    const startedMeanwhile = inflight.get(repoId);
    if (startedMeanwhile) return waitBudget(repoId, startedMeanwhile);

    // F3: a submodule entry is expanded into its own dirty files (see computeTreeKey); the entry itself is not a file.
    const isSubmoduleEntry = (p: string): boolean => key.files[p] === "dir" || (key.files[p] ?? "").startsWith("submodule:");
    const dirtyNow = Object.keys(key.files).filter((p) => !isSubmoduleEntry(p));
    const treeNow: RepoTreeState = { head: tree.head, dirty: dirtyNow };
    const indexed = opts.getIndexedCommit(repoId);
    const headMoved = !indexed || !sameCommit(tree.head, indexed);
    const vanished = headMoved ? [] : vanishedDirtyPaths(readDirtyLedger(opts.lockDir, repoId), tree.head, dirtyNow);
    const changed = headMoved ? null : pathsChangedSince(readCovered(repoId), key);
    if (!repair && !headMoved && vanished.length === 0 && (Object.keys(key.files).length === 0 || changed?.length === 0)) {
      const note: FreshnessNote = { state: "fresh" };
      lastCheck.set(repoId, { at: started, note });
      return note;
    }

    // A deleted or reverted file that was indexed while dirty is not dirty any more, so git alone would
    // never show it to a dirty run again. It is handed over as a pending re-index; with no way to do
    // that, an incremental run (re-hash everything, prune the gone) clears it.
    const cleanupByDirty = vanished.length > 0 && opts.markPendingReindex !== undefined;
    // F3: a submodule that moved to another commit changed files nobody listed; only a full re-hash finds them.
    const submoduleMoved = (changed ?? []).some((p) => (key.files[p] ?? "").startsWith("submodule:"));
    const scopedMode: "incremental" | "dirty" = headMoved || submoduleMoved || (vanished.length > 0 && !cleanupByDirty) ? "incremental" : "dirty";
    // A dead FULL or INCREMENTAL run is repaired by a full one. A dead DIRTY run touched only the paths its marker
    // recorded: those are re-extracted by a scoped run once their stored hashes are cleared (a hash-equal file is
    // skipped, and a scoped run that re-extracts nothing skips the resolve passes too). No paths, or no way to
    // clear the hashes, is a full repair.
    const dirtyRepair = repair?.mode === "dirty" && repair.paths !== undefined && opts.invalidateFileHashes !== undefined ? repair.paths : null;
    const mode: "full" | "incremental" | "dirty" = repair && !dirtyRepair ? "full" : scopedMode;
    const refusal = opts.refuseRefresh?.(repoId) ?? null;
    if (refusal) {
      const note: FreshnessNote = { state: "stale", mode, reason: `${refusal} This answer comes from the index as that build wrote it.` };
      lastCheck.set(repoId, { at: started, note });
      return note;
    }
    const lockFile = lockFileFor(opts.lockDir, repoId);
    if (!tryAcquireLock(lockFile, staleLockMs, started)) {
      const note: FreshnessNote = {
        state: "refreshing",
        mode,
        reason: "another server process is refreshing this repo's index; this answer comes from the previous index."
      };
      lastCheck.set(repoId, { at: started, note });
      return note;
    }

    // MCP-ISSUE-101: only the files whose content the covered key does not vouch for (all dirty files without one).
    const runPaths =
      mode === "dirty" ? [...new Set([...(changed?.filter((p) => !isSubmoduleEntry(p)) ?? dirtyNow), ...(dirtyRepair ?? [])])].sort() : undefined;
    if (repair) bumpRepairAttempts(opts.lockDir, repoId, repair);
    const promise = serialize(repoId, () => {
      if (cleanupByDirty) opts.markPendingReindex?.(repoId, vanished);
      if (dirtyRepair) opts.invalidateFileHashes?.(repoId, dirtyRepair);
      return opts.run(repoId, repoPath, mode, runPaths);
    }, mode, runPaths)
      .then((result) => {
        if (result.status === "failed" || result.status === "cancelled") return result;
        if (repair) clearRepairNeeded(opts.lockDir, repoId);
        const serialized = serializeTreeKey(key);
        coveredKey.set(repoId, serialized);
        try {
          opts.recordCoveredKey?.(repoId, result.runId, serialized);
        } catch {
          // Best-effort: the next check runs again, it never answers stale.
        }
        recordDirtyLedger(opts.lockDir, repoId, mode, treeNow, cleanupByDirty);
        try {
          opts.markTriggered?.(result.runId);
        } catch {
          // Best-effort tag; the run itself stands.
        }
        return result;
      })
      .catch(() => null)
      .finally(() => {
        releaseLock(lockFile);
        inflight.delete(repoId);
        lastCheck.delete(repoId);
      });
    const flight: Flight = { mode, startedAt: started, promise, ...(vanished.length > 0 && { cleanup: vanished.length }) };
    inflight.set(repoId, flight);
    return waitBudget(repoId, flight);
  };

  return { ensureFresh, serialize };
}

/**
 * Fold a freshness note into a tool payload: add the `freshness` block when the answer is not
 * known-current, and never let `coverage` say `high` about a tree it has not seen.
 */
export function applyFreshness(payload: unknown, note: FreshnessNote | undefined): unknown {
  if (!note || !payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
  if (note.state === "fresh") {
    // F2: the tree is as current as the gate can make it, but a path it could not read is not in the index.
    if (!note.unreadable?.length) return payload;
    const out: Record<string, unknown> = { ...(payload as Record<string, unknown>), freshness: note };
    const gap = `${String(note.unreadable.length)} changed file(s) could not be read for indexing (${note.unreadable.slice(0, 3).join(", ")}${note.unreadable.length > 3 ? ", ..." : ""}); the index holds an older copy or none`;
    const coverage = out.coverage;
    if (coverage && typeof coverage === "object" && !Array.isArray(coverage)) {
      const c = coverage as { knownGaps?: unknown };
      out.coverage = { ...c, knownGaps: [...(Array.isArray(c.knownGaps) ? (c.knownGaps as unknown[]) : []), gap] };
    }
    return out;
  }
  const out: Record<string, unknown> = { ...(payload as Record<string, unknown>), freshness: note };
  if (note.state === "refreshed") return out;
  const coverage = out.coverage;
  // R3 exact: the TypeScript LanguageService reads every file from disk, so the reads and writes ARE
  // current; only which files are in its program comes from the index. The note is scoped to that
  // part and kept out of `coverage`, where "previous index" would contradict `exact`.
  const typed = coverage && typeof coverage === "object" && !Array.isArray(coverage) && (coverage as { engine?: unknown }).engine === "typescript-language-service";
  if (typed || out.engine === "typescript-language-service") {
    const reason = (note.reason ?? note.state).replace(/[;.]?\s*this answer comes from the previous index\.?/i, "").trim();
    out.freshness = {
      ...note,
      reason,
      appliesTo: "index-derived parts only: which TS/JS files are in the TypeScript program (the indexed file list; a file added since the last run is missing). The sites themselves are read from the files on disk and are current."
    };
    return out;
  }
  const gap = `index not current: ${note.reason ?? note.state}`;
  if (coverage === "high") out.coverage = "medium";
  else if (coverage && typeof coverage === "object" && !Array.isArray(coverage)) {
    const c = coverage as { confidence?: string; knownGaps?: unknown };
    out.coverage = {
      ...c,
      confidence: c.confidence === "high" ? "medium" : c.confidence,
      knownGaps: [...(Array.isArray(c.knownGaps) ? (c.knownGaps as unknown[]) : []), gap]
    };
  }
  return out;
}
