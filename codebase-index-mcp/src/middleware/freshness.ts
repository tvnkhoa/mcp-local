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

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { IndexMode, IndexRunResult } from "../types/index.js";

export type FreshnessState = "fresh" | "refreshed" | "refreshing" | "stale";

export type FreshnessNote = {
  state: FreshnessState;
  /** What the gate ran, or found running. */
  mode?: "incremental" | "dirty";
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

function lockFileFor(lockDir: string, repoId: string): string {
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

let runMarkerSeq = 0;

function writeRunMarker(lockDir: string, repoId: string, at: number): string | null {
  const file = path.join(lockDir, `${runMarkerPrefix(repoId)}${String(process.pid)}-${String(++runMarkerSeq)}.json`);
  try {
    fs.writeFileSync(file, JSON.stringify({ pid: process.pid, at }));
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

/** The live run markers for a repo: pid alive and younger than `staleMs`. Dead or stale ones are removed. */
export function liveRunMarkers(lockDir: string, repoId: string, staleMs: number, now: number): Array<{ pid: number; at: number }> {
  const prefix = runMarkerPrefix(repoId);
  let names: string[];
  try {
    names = fs.readdirSync(lockDir).filter((n) => n.startsWith(prefix) && n.endsWith(".json"));
  } catch {
    return [];
  }
  const live: Array<{ pid: number; at: number }> = [];
  for (const name of names) {
    const file = path.join(lockDir, name);
    let m: { pid?: number; at?: number } = {};
    try {
      m = JSON.parse(fs.readFileSync(file, "utf8")) as { pid?: number; at?: number };
    } catch {
      continue; // being written, or just removed
    }
    if (typeof m.pid === "number" && typeof m.at === "number" && pidAlive(m.pid) && now - m.at <= staleMs) {
      live.push({ pid: m.pid, at: m.at });
    } else {
      removeRunMarker(file);
    }
  }
  return live;
}

/** Default age past which a run marker counts as left by a crashed run (see `FreshnessGateOptions.staleRunMs`). */
export const DEFAULT_STALE_RUN_MS = 6 * 60 * 60_000;

/**
 * MCP-ISSUE-105: delete every state file of one repo — refresh lock, dirty ledger, run markers. A marker
 * is matched on its exact `<pid>-<seq>.json` tail, so a repo whose id extends this one's is left alone.
 * Returns the file names removed.
 */
export function removeRepoStateFiles(lockDir: string, repoId: string): string[] {
  const prefix = runMarkerPrefix(repoId);
  const isMarker = (name: string): boolean => name.startsWith(prefix) && /^\d+-\d+\.json$/.test(name.slice(prefix.length));
  const exact = new Set([path.basename(lockFileFor(lockDir, repoId)), path.basename(ledgerFileFor(lockDir, repoId))]);
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

function releaseLock(file: string): void {
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

export async function computeTreeKey(repoPath: string, tree: RepoTreeState, maxBytes = DEFAULT_HASH_MAX_BYTES): Promise<TreeKey> {
  const paths = [...new Set(tree.dirty)].sort();
  const hashes = new Array<string>(paths.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < paths.length) {
      const i = next++;
      hashes[i] = await hashFile(path.join(repoPath, paths[i] as string), maxBytes);
    }
  };
  await Promise.all(Array.from({ length: Math.min(HASH_CONCURRENCY, paths.length) }, worker));
  return { head: tree.head ?? "nogit", files: Object.fromEntries(paths.map((rel, i) => [rel, hashes[i] as string])) };
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
  serialize: <T>(repoId: string, fn: () => Promise<T>) => Promise<T>;
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
  type Flight = { mode: "incremental" | "dirty"; startedAt: number; promise: Promise<IndexRunResult | null>; cleanup?: number };
  const inflight = new Map<string, Flight>();
  const runChain = new Map<string, Promise<unknown>>();

  const serialize = <T>(repoId: string, fn: () => Promise<T>): Promise<T> => {
    const prev = runChain.get(repoId) ?? Promise.resolve();
    // MCP-ISSUE-101 part 5: every run says it is running, for the gates of every process on this DB.
    const marked = async (): Promise<T> => {
      const marker = writeRunMarker(opts.lockDir, repoId, now());
      try {
        return await fn();
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

    const cached = lastCheck.get(repoId);
    if (cached && started - cached.at < (cached.note.state === "fresh" ? checkTtlMs : Math.max(checkTtlMs, 1_000))) return cached.note;

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

    const indexed = opts.getIndexedCommit(repoId);
    const headMoved = !indexed || !sameCommit(tree.head, indexed);
    const vanished = headMoved ? [] : vanishedDirtyPaths(readDirtyLedger(opts.lockDir, repoId), tree.head, tree.dirty);
    const changed = headMoved ? null : pathsChangedSince(readCovered(repoId), key);
    if (!headMoved && vanished.length === 0 && (tree.dirty.length === 0 || changed?.length === 0)) {
      const note: FreshnessNote = { state: "fresh" };
      lastCheck.set(repoId, { at: started, note });
      return note;
    }

    // A deleted or reverted file that was indexed while dirty is not dirty any more, so git alone would
    // never show it to a dirty run again. It is handed over as a pending re-index; with no way to do
    // that, an incremental run (re-hash everything, prune the gone) clears it.
    const cleanupByDirty = vanished.length > 0 && opts.markPendingReindex !== undefined;
    const mode: "incremental" | "dirty" = headMoved || (vanished.length > 0 && !cleanupByDirty) ? "incremental" : "dirty";
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

    const promise = serialize(repoId, () => {
      if (cleanupByDirty) opts.markPendingReindex?.(repoId, vanished);
      // MCP-ISSUE-101: only the files whose content the covered key does not vouch for (all dirty files without one).
      return opts.run(repoId, repoPath, mode, mode === "dirty" ? (changed ?? tree.dirty) : undefined);
    })
      .then((result) => {
        if (result.status === "failed" || result.status === "cancelled") return result;
        const serialized = serializeTreeKey(key);
        coveredKey.set(repoId, serialized);
        try {
          opts.recordCoveredKey?.(repoId, result.runId, serialized);
        } catch {
          // Best-effort: the next check runs again, it never answers stale.
        }
        recordDirtyLedger(opts.lockDir, repoId, mode, tree, cleanupByDirty);
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
