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
  readTree: (repoPath: string) => RepoTreeState;
  run: (repoId: string, repoPath: string, mode: IndexMode) => Promise<IndexRunResult>;
  /**
   * Why this process must not refresh the repo at all, or null. Release F: a server still running an
   * older build refreshed over a newer build's index (several processes share one DB).
   */
  refuseRefresh?: (repoId: string) => string | null;
  /** Tag a finished run as query-triggered, for `health_check`. Best-effort. */
  markTriggered?: (runId: string) => void;
  /**
   * How long a tree check is reused before git is asked again. Default 0: a reused "fresh" verdict
   * served a deleted file's symbols silently for its whole lifetime (R1, release B.1). Only the
   * "another process is refreshing" note is cached, for 1 s, so a busy caller does not hammer git.
   */
  checkTtlMs?: number;
  /** A lock older than this, or held by a dead pid, is broken. */
  staleLockMs?: number;
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
 * longer dirty, the gate runs `incremental` instead, which re-hashes every file and prunes the gone.
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
export function recordDirtyLedger(lockDir: string, repoId: string, mode: IndexMode, tree: RepoTreeState): void {
  if (!tree.head) return;
  const prev = readDirtyLedger(lockDir, repoId);
  const paths =
    mode === "dirty" && prev && sameCommit(prev.head, tree.head) ? [...new Set([...prev.paths, ...tree.dirty])] : [...tree.dirty];
  writeDirtyLedger(lockDir, repoId, { head: tree.head, paths: paths.sort() });
}

/** The tree identity a refresh covers: HEAD plus each dirty file's size and mtime. */
function treeKey(repoPath: string, tree: RepoTreeState): string {
  const parts = [...tree.dirty].sort().map((rel) => {
    try {
      const st = fs.statSync(path.join(repoPath, rel));
      return `${rel}:${String(st.size)}:${String(st.mtimeMs)}`;
    } catch {
      return `${rel}:deleted`;
    }
  });
  return `${tree.head ?? "nogit"}|${parts.join(",")}`;
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
  /** Tree key each repo's last completed refresh covered. */
  const coveredKey = new Map<string, string>();
  const lastCheck = new Map<string, { at: number; note: FreshnessNote }>();
  type Flight = { mode: "incremental" | "dirty"; startedAt: number; promise: Promise<IndexRunResult | null>; cleanup?: number };
  const inflight = new Map<string, Flight>();
  const runChain = new Map<string, Promise<unknown>>();

  const serialize = <T>(repoId: string, fn: () => Promise<T>): Promise<T> => {
    const prev = runChain.get(repoId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
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
    lastCheck.delete(repoId);
    return { state: "refreshed", mode: flight.mode, elapsedMs: now() - started, runId: outcome.runId };
  };

  const ensureFresh = async (repoId: string): Promise<FreshnessNote> => {
    if (!opts.enabled) return { state: "fresh" };
    const started = now();

    const running = inflight.get(repoId);
    if (running) return waitBudget(repoId, running);

    const cached = lastCheck.get(repoId);
    if (cached && started - cached.at < (cached.note.state === "fresh" ? checkTtlMs : Math.max(checkTtlMs, 1_000))) return cached.note;

    const repoPath = opts.getRepoPath(repoId);
    if (!repoPath) return { state: "fresh" };

    let tree: RepoTreeState;
    try {
      tree = opts.readTree(repoPath);
    } catch {
      return { state: "fresh" }; // not a git repo: nothing to compare against
    }
    if (!tree.head) return { state: "fresh" };

    const indexed = opts.getIndexedCommit(repoId);
    const headMoved = !indexed || !sameCommit(tree.head, indexed);
    const vanished = headMoved ? [] : vanishedDirtyPaths(readDirtyLedger(opts.lockDir, repoId), tree.head, tree.dirty);
    const key = treeKey(repoPath, tree);
    if (!headMoved && vanished.length === 0 && (tree.dirty.length === 0 || coveredKey.get(repoId) === key)) {
      const note: FreshnessNote = { state: "fresh" };
      lastCheck.set(repoId, { at: started, note });
      return note;
    }

    // A deleted or reverted file that was indexed while dirty is not dirty any more, so dirty mode
    // would never look at it again: only an incremental run (re-hash everything, prune the gone) clears it.
    const mode: "incremental" | "dirty" = headMoved || vanished.length > 0 ? "incremental" : "dirty";
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

    const promise = serialize(repoId, () => opts.run(repoId, repoPath, mode))
      .then((result) => {
        coveredKey.set(repoId, key);
        recordDirtyLedger(opts.lockDir, repoId, mode, tree);
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
  if (!note || note.state === "fresh" || !payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
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
