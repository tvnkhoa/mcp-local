/**
 * MCP-ISSUE-112 (IX-2) — `index_repository` as a server-side job.
 *
 * Problem it removes: the run executed inside the tool call, on the server thread. A wec.aria worktree (~3300 files)
 * outlived the client's 120 s call ceiling twice; the transport dropped the call ("response lost") and the run, if it
 * finished at all, reported to nobody. A second caller meanwhile met "database is locked" (MCP-ISSUE-111).
 *
 * Design:
 * - `enqueue` returns a job at once (`runId`, `state: "queued"`); the caller polls `get(runId)` (tool `index_status`)
 *   or passes `wait` to block a bounded time. The job belongs to the server, not to the request: a client that
 *   disconnects cancels nothing.
 * - One job runs at a time per server (`pump`), and its run goes through the caller-supplied `execute` — in the server,
 *   the freshness gate's DB-wide queue and the refresh worker thread — so it never runs on the server thread and never
 *   beside another writer of this process.
 * - A job does not START while free RAM is under `minFreeRamMb` (one machine, shared RAM — owner, 3 Nov): it stays
 *   `queued` with the reason, and the queue looks again every `ramRecheckMs`.
 * - The run id the job returns is the run's own id in `index_runs` (passed into the run), so `health_check` and
 *   `index_status` name the same run. Finished jobs are kept (last `keepFinished`) for later polls; an unknown id is
 *   answered from `index_runs` by the caller.
 */

import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";

import { samePath } from "../git/gitHelpers.js";
import { DEFAULT_STALE_RUN_MS, liveRunMarkers, readRepairNeeded } from "../../middleware/freshness.js";

import type { SeedRequest, SeedResult } from "../../repositories/seedStore.js";
import type { IndexMode, IndexRunResult } from "../../types/index.js";

export type IndexJobState = "queued" | "running" | "ok" | "failed";

export type IndexJobRequest = {
  repoId: string;
  repoPath: string;
  mode: IndexMode;
  docsEnabled: boolean;
  maxFiles: number;
  batchSize: number;
  /** Who asked, for the status line ("index_repository", "register_worktree"). */
  source: string;
  /** IX-9: register_worktree's parent repoId — seed this repo from the parent's index when the preconditions hold. */
  seedFrom?: string;
};

export type IndexJobProgress = { phase: string; progress?: number; total?: number; fallbackReason?: string };

export type IndexJob = {
  runId: string;
  repoId: string;
  repoPath: string;
  mode: IndexMode;
  source: string;
  state: IndexJobState;
  queuedAt: string;
  startedAt?: string;
  finishedAt?: string;
  /** Set on the answer to a request that joined a job already queued or running for its repo (it ran no new one). */
  coalesced?: boolean;
  /** While queued: why it has not started (another run ahead, or free RAM below the floor). */
  waitingFor?: string;
  phase?: string;
  progress?: number;
  total?: number;
  /** The run's summary once it ended ok (or the run's own `failed` status). */
  result?: IndexRunResult;
  error?: string;
  /** When the run-timeout clock started (the first `control.started()`; a later call never moves it). */
  runStartedAt?: string;
  /** IX-9: why a job asked to seed ran a full index instead (never a silent wrong seed). */
  fallbackReason?: string;
};

/**
 * Review follow-up C: the executor says when the run actually starts (it may first wait in the DB-wide queue behind a
 * gate refresh) — the run timeout counts from there — and must not start a run for a job already failed.
 */
export type IndexJobControl = {
  /** Call once, right before the run starts in the worker: the run timeout starts now. */
  started: () => void;
  /** True once the job has failed (timed out): the executor must not start its run. */
  cancelled: () => boolean;
};

export type IndexJobExecutor = (
  job: Readonly<IndexJob>,
  request: IndexJobRequest,
  onProgress: (progress: IndexJobProgress) => void,
  control: IndexJobControl
) => Promise<IndexRunResult>;

export type IndexJobQueueOptions = {
  execute: IndexJobExecutor;
  /** Free RAM floor in MB below which a job does not start (`CODEBASE_INDEX_MIN_FREE_RAM_MB`). 0 disables it. */
  minFreeRamMb: number;
  /** Injected for tests; default `os.freemem()` in MB. */
  freeRamMb?: () => number;
  ramRecheckMs?: number;
  keepFinished?: number;
  now?: () => number;
  /**
   * A run still going after this many ms fails its job (`CODEBASE_INDEX_RUN_TIMEOUT_MS`); 0 = no limit. Without it a
   * hung run held the job `running` and — through the DB-wide queue — every later run, forever.
   */
  runTimeoutMs?: number;
  /** Called once when a run timed out, to stop it (the server terminates the worker, which rejects the run). */
  onRunTimeout?: (job: Readonly<IndexJob>) => void;
  /** IX-A: the gate's and the watcher's refresh runs in flight, for `index_status` (`refreshRuns`). */
  refreshes?: RefreshRuns;
};

export const DEFAULT_MIN_FREE_RAM_MB = 8192;
/** Generous on purpose: the largest measured full run (wec.aria, ~3300 files) took ~100 s. */
export const DEFAULT_RUN_TIMEOUT_MS = 30 * 60_000;
/** `wait: true` blocks at most this long, then answers with the job as it stands (IX-2: under the 120 s client ceiling). */
export const MAX_WAIT_MS = 100_000;

/**
 * Review follow-up A: a queued or running job answers a new request only when it runs the same thing — same repo and
 * path, same docs setting and file cap, and the same mode or a full one. Any other difference queues a job of its own.
 */
export function coversRequest(existing: IndexJobRequest, next: IndexJobRequest): boolean {
  return (
    existing.repoId === next.repoId &&
    sameRepoPath(existing.repoPath, next.repoPath) &&
    existing.docsEnabled === next.docsEnabled &&
    existing.maxFiles === next.maxFiles &&
    (existing.mode === next.mode || existing.mode === "full")
  );
}

/** Two spellings of one folder: resolved, forward slashes, no trailing slash, case-insensitive on Windows. */
export function sameRepoPath(a: string, b: string): boolean {
  const norm = (p: string): string => path.resolve(p).replace(/\\/g, "/").replace(/\/+$/, "");
  return samePath(norm(a), norm(b));
}

/**
 * Review F1: run `fn` through a queue (`enqueue`, the DB-wide one) but wait for its turn at most `waitMs`. If the
 * turn has not come by then, the call rejects with `onGiveUp()` and `fn` is skipped when its turn comes; once `fn`
 * has started it is waited for (it is short: a purge). Keeps a tool call under the client's call ceiling instead of
 * waiting behind a run for up to CODEBASE_INDEX_RUN_TIMEOUT_MS.
 */
export async function queuedWithin<T>(
  enqueue: (fn: () => Promise<T | undefined>) => Promise<T | undefined>,
  fn: () => Promise<T>,
  waitMs: number,
  onGiveUp: () => Error
): Promise<T> {
  let state: "waiting" | "started" | "abandoned" = "waiting";
  let timer: NodeJS.Timeout | undefined;
  const queued = enqueue(async () => {
    if (state === "abandoned") return undefined;
    state = "started";
    return fn();
  });
  const gaveUp = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      if (state !== "waiting") return;
      state = "abandoned";
      reject(onGiveUp());
    }, waitMs);
  });
  try {
    return (await Promise.race([queued, gaveUp])) as T;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export class IndexJobQueue {
  private readonly jobs = new Map<string, IndexJob>();
  private readonly requests = new Map<string, IndexJobRequest>();
  private readonly order: string[] = [];
  private readonly waiters = new Map<string, Array<() => void>>();
  private readonly listeners = new Map<string, Set<(progress: IndexJobProgress) => void>>();
  private running: string | null = null;
  private recheck: NodeJS.Timeout | undefined;
  private readonly freeRamMb: () => number;
  private readonly now: () => number;

  /** IX-A: the refresh runs (not jobs) this process has in flight; `index_status` lists them. */
  readonly refreshes: RefreshRuns | null;

  constructor(private readonly options: IndexJobQueueOptions) {
    this.refreshes = options.refreshes ?? null;
    this.freeRamMb = options.freeRamMb ?? (() => Math.floor(os.freemem() / (1024 * 1024)));
    this.now = options.now ?? Date.now;
  }

  /**
   * Queue a run; it starts when the queue is free and RAM allows. Returns a snapshot of the job. A request for a repo
   * that already has a job queued or running in the same mode (or a full one) joins it: the answer is that job, marked
   * `coalesced`, and no second run is queued.
   */
  enqueue(request: IndexJobRequest): IndexJob {
    const same = this.order.find((id) => {
      const j = this.jobs.get(id);
      const r = this.requests.get(id);
      return j !== undefined && r !== undefined && (j.state === "queued" || j.state === "running") && coversRequest(r, request);
    });
    if (same) return { ...this.snapshot(this.jobs.get(same)!), coalesced: true };
    const runId = randomUUID();
    const job: IndexJob = {
      runId,
      repoId: request.repoId,
      repoPath: request.repoPath,
      mode: request.mode,
      source: request.source,
      state: "queued",
      queuedAt: new Date(this.now()).toISOString()
    };
    this.jobs.set(runId, job);
    this.requests.set(runId, request);
    this.order.push(runId);
    this.pump();
    return this.snapshot(job);
  }

  get(runId: string): IndexJob | null {
    const job = this.jobs.get(runId);
    return job ? this.snapshot(job) : null;
  }

  /** The jobs not yet finished, oldest first. */
  pending(): IndexJob[] {
    return this.order.map((id) => this.jobs.get(id)).filter((j): j is IndexJob => j !== undefined && (j.state === "queued" || j.state === "running")).map((j) => this.snapshot(j));
  }

  /** Resolve when the job has finished or `timeoutMs` passed; returns the job as it stands then. */
  async wait(runId: string, timeoutMs: number): Promise<IndexJob | null> {
    const job = this.jobs.get(runId);
    if (!job) return null;
    if (job.state === "ok" || job.state === "failed") return this.snapshot(job);
    await new Promise<void>((resolve) => {
      const timer = setTimeout(done, Math.max(0, Math.min(timeoutMs, MAX_WAIT_MS)));
      function done(): void {
        clearTimeout(timer);
        resolve();
      }
      const list = this.waiters.get(runId) ?? [];
      list.push(done);
      this.waiters.set(runId, list);
    });
    return this.get(runId);
  }

  /**
   * Follow a job's progress (a `wait: true` caller with a progress token streams it). Returns the unsubscribe.
   * A listener that throws is dropped, never the run.
   */
  subscribe(runId: string, listener: (progress: IndexJobProgress) => void): () => void {
    const set = this.listeners.get(runId) ?? new Set();
    set.add(listener);
    this.listeners.set(runId, set);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(runId);
    };
  }

  /** Stop the RAM re-check timer (server shutdown, tests). Jobs already running finish. */
  dispose(): void {
    if (this.recheck) clearTimeout(this.recheck);
    this.recheck = undefined;
  }

  private pump(): void {
    if (this.running) {
      this.markWaiting(`another index run is in progress (${this.running})`);
      return;
    }
    const nextId = this.order.find((id) => this.jobs.get(id)?.state === "queued");
    if (!nextId) return;
    const floor = this.options.minFreeRamMb;
    if (floor > 0) {
      const free = this.freeRamMb();
      if (free < floor) {
        this.markWaiting(`free RAM ${String(free)} MB is below CODEBASE_INDEX_MIN_FREE_RAM_MB=${String(floor)}; the run starts when RAM frees up`);
        if (!this.recheck) {
          this.recheck = setTimeout(() => {
            this.recheck = undefined;
            this.pump();
          }, this.options.ramRecheckMs ?? 5_000);
          this.recheck.unref();
        }
        return;
      }
    }
    const job = this.jobs.get(nextId)!;
    const request = this.requests.get(nextId)!;
    this.running = nextId;
    job.state = "running";
    job.startedAt = new Date(this.now()).toISOString();
    delete job.waitingFor;
    job.phase = "starting";
    this.markWaiting(`another index run is in progress (${nextId})`);
    let settled = false;
    let timeout: NodeJS.Timeout | undefined;
    const finish = (apply: () => void): void => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      apply();
      job.finishedAt = new Date(this.now()).toISOString();
      delete job.phase;
      this.running = null;
      this.requests.delete(nextId);
      for (const done of this.waiters.get(nextId) ?? []) done();
      this.waiters.delete(nextId);
      this.listeners.delete(nextId);
      this.trim();
      this.pump();
    };
    const limit = this.options.runTimeoutMs ?? 0;
    const control: IndexJobControl = {
      cancelled: () => settled,
      started: () => {
        if (settled) return;
        job.runStartedAt ??= new Date(this.now()).toISOString();
        if (timeout || limit <= 0) return;
        timeout = setTimeout(() => {
          finish(() => {
            job.state = "failed";
            job.error = `the run was still going after CODEBASE_INDEX_RUN_TIMEOUT_MS=${String(limit)} ms; it was stopped`;
          });
          try {
            this.options.onRunTimeout?.(job);
          } catch {
            // Stopping is best-effort; the job is already failed and the queue moves on.
          }
        }, limit);
        timeout.unref();
      }
    };
    void this.options
      .execute(job, request, (p) => {
        if (settled) return;
        job.phase = p.phase;
        if (p.fallbackReason !== undefined) job.fallbackReason = p.fallbackReason;
        if (p.progress !== undefined) job.progress = p.progress;
        if (p.total !== undefined) job.total = p.total;
        for (const listener of this.listeners.get(nextId) ?? []) {
          try {
            listener(p);
          } catch {
            this.listeners.get(nextId)?.delete(listener);
          }
        }
      }, control)
      .then(
        (result) =>
          finish(() => {
            job.result = result;
            job.state = result.status === "failed" || result.status === "cancelled" ? "failed" : "ok";
            if (job.state === "failed") job.error = `the run ended ${String(result.status)}`;
          }),
        (error: unknown) =>
          finish(() => {
            job.state = "failed";
            job.error = error instanceof Error ? error.message : String(error);
          })
      );
  }

  private markWaiting(reason: string): void {
    for (const id of this.order) {
      const job = this.jobs.get(id);
      if (job?.state === "queued") job.waitingFor = reason;
    }
  }

  private trim(): void {
    const keep = this.options.keepFinished ?? 200;
    const finished = this.order.filter((id) => {
      const s = this.jobs.get(id)?.state;
      return s === "ok" || s === "failed";
    });
    for (const id of finished.slice(0, Math.max(0, finished.length - keep))) {
      this.jobs.delete(id);
      this.order.splice(this.order.indexOf(id), 1);
    }
  }

  private snapshot(job: IndexJob): IndexJob {
    return { ...job };
  }
}

// ── IX-9: seed a worktree from its parent's index ─────────────────────────────

export type SeedRequestLike = SeedRequest;
export type SeedResultLike = SeedResult;

export type SeedAncestryLike =
  | { ok: true; parentSha: string; childSha: string }
  | { ok: false; fallbackReason: string; parentSha: string | null; childSha: string | null };

export type SeedStepDeps = {
  /** The parent's indexed commit (its base run's `commit_sha`), or null when it has none. */
  parentIndexedSha: (parentRepoId: string) => string | null;
  /** True when the child already holds an index: a re-registration runs its normal incremental, no seed. */
  childHasIndex: (childRepoId: string) => boolean;
  /** `checkSeedAncestry` from gitHelpers in the server; injected for tests. */
  ancestry: (childRepoPath: string, parentIndexedSha: string | null) => SeedAncestryLike | Promise<SeedAncestryLike>;
  /**
   * Review H1/M3: why the parent cannot be seeded from right now, or null — a run of the parent in progress in any
   * process on this DB (its batches may be half-committed), or parent runs the seed cannot vouch for. Checked first.
   */
  parentRefusal?: (parentRepoId: string) => string | null;
  /** `seedFromParent` on the writer's connection (the refresh worker in the server); throws or rejects with SeedError{code}, rolled back. */
  seed: (req: SeedRequestLike) => SeedResultLike | Promise<SeedResultLike>;
  /** Runs the index in the given mode (the executor's normal run). */
  run: (mode: IndexMode) => Promise<IndexRunResult>;
  /** Drops the child's rows (per-repo, no global FTS rebuild) before a full run after a failed seeded run. */
  purgeChild?: (childRepoId: string) => void | Promise<void>;
  onProgress: (progress: IndexJobProgress) => void;
};

export type SeedStepOutcome = {
  result: IndexRunResult;
  seeded: boolean;
  seed?: SeedResultLike;
  fallbackReason?: string;
};

function seedErrorReason(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && code ? `seed_${code.toLowerCase()}` : "seed_failed";
}

function runFailed(result: IndexRunResult): boolean {
  return result.status === "failed" || result.status === "cancelled";
}

/**
 * IX-9 executor step. Without `seedFrom` (or when the child is already indexed) it is the plain run. Otherwise:
 * ancestry check → seed (phase "seed") → scoped incremental. Every refusal or failure runs full in the same job and
 * reports `fallbackReason` through progress (→ index_status): ancestry refusal, a seed error (child cleared first:
 * the store rolls the copy back, not a failed vector step after it), or an incremental that failed on top of the seed (child purged first when `purgeChild` is given).
 */
export async function runWithSeed(request: IndexJobRequest, deps: SeedStepDeps): Promise<SeedStepOutcome> {
  if (!request.seedFrom || deps.childHasIndex(request.repoId)) {
    return { result: await deps.run(request.mode), seeded: false };
  }
  const fallback = async (fallbackReason: string, purge: boolean): Promise<SeedStepOutcome> => {
    deps.onProgress({ phase: "full (seed fallback)", fallbackReason });
    if (purge) await deps.purgeChild?.(request.repoId);
    return { result: await deps.run("full"), seeded: false, fallbackReason };
  };
  const refusal = deps.parentRefusal?.(request.seedFrom) ?? null;
  if (refusal) return fallback(refusal, false);
  const ancestry = await deps.ancestry(request.repoPath, deps.parentIndexedSha(request.seedFrom));
  if (!ancestry.ok) return fallback(ancestry.fallbackReason, false);
  deps.onProgress({ phase: "seed" });
  let seed: SeedResultLike;
  try {
    seed = await deps.seed({ parentRepoId: request.seedFrom, childRepoId: request.repoId, childRepoPath: request.repoPath });
  } catch (error) {
    // The copy is rolled back, but its vector step runs after the copy commits (seedStore): clear whatever is left.
    return fallback(seedErrorReason(error), true);
  }
  deps.onProgress({ phase: "incremental (after seed)" });
  let result: IndexRunResult;
  try {
    result = await deps.run("incremental");
  } catch {
    return { ...(await fallback("incremental_after_seed_failed", true)), seed };
  }
  if (runFailed(result)) return { ...(await fallback("incremental_after_seed_failed", true)), seed };
  return { result, seeded: true, seed };
}

/**
 * IX-9 review M3 / follow-up (a): why the parent's rows may be half-written right now, from the run state every server
 * process on the DB shares (`lockDir`): a live run marker (a run between batch commits) or a repair flag (a run that
 * died mid-way — it leaves no index_runs row; `liveRunMarkers` turns its dead marker into the flag). Null when neither.
 * The worker checks it again inside the copy's IMMEDIATE transaction.
 */
export function parentRunRefusal(lockDir: string, parentRepoId: string, now: number = Date.now()): string | null {
  const live = liveRunMarkers(lockDir, parentRepoId, DEFAULT_STALE_RUN_MS, now);
  if (live.length > 0) return `parent_run_in_progress: pid ${live.map((m) => String(m.pid)).join(", ")}`;
  if (readRepairNeeded(lockDir, parentRepoId)) return "parent_needs_repair";
  return null;
}

/** The executor's `parentRefusal`: the run state above, then the parent's run history (review H1). */
export function seedParentRefusal(lockDir: string, store: { seedRefusal(repoId: string): string | null }, parentRepoId: string): string | null {
  const busy = parentRunRefusal(lockDir, parentRepoId);
  if (busy) return busy;
  const reason = store.seedRefusal(parentRepoId);
  return reason ? `parent_runs_unvouched: ${reason}` : null;
}

// ── IX-A (MCP-ISSUE-126): the freshness gate's and the watcher's refresh runs ─────────────────────────────────────────

/**
 * IX-A: `CODEBASE_INDEX_REFRESH_RUN_DEADLINE_MS` default. On 11 Nov a gate-triggered dirty refresh of wec.aria ran
 * 5.0 h; it had no runId, no progress and no deadline (only index_repository jobs had `CODEBASE_INDEX_RUN_TIMEOUT_MS`),
 * and through the DB-wide queue every query waited on it. Agreed with wec.aria: 10 min.
 */
export const DEFAULT_REFRESH_RUN_DEADLINE_MS = 10 * 60_000;
export const MIN_REFRESH_RUN_DEADLINE_MS = 1_000;
export const MAX_REFRESH_RUN_DEADLINE_MS = 6 * 60 * 60_000;
/**
 * Review (2): after this many deadline stops in a row of one repo, no refresh of it starts in this process until a run
 * lands (an index_repository job, say). A repo whose full run outlasts even the full-run deadline would otherwise run a
 * doomed full run on every watcher batch, each holding the DB-wide queue for its deadline plus the abort grace.
 */
export const MAX_REFRESH_DEADLINE_STOPS = 2;

/**
 * IX-A/IX-B: what each run of this process writes into its run marker (`staleAfterMs`, see freshness.ts
 * `RunMarkerOptions`): its own deadline plus the abort grace a stopped run's worker may take to exit. Another process
 * judges the marker by that, never by its own limits (leader review (b): a 30 min job is not "dead" at a reader's 10 min).
 * - `scoped`: a dirty/incremental refresh — the refresh deadline;
 * - `full`: a full refresh (a repair, a first index) — max(deadline, the job timeout); also the gate's default
 *   (`runStaleAfterMs`), since a gate run may be full;
 * - `job`: an index job — its RUN_TIMEOUT_MS; unbounded jobs (0) keep the old 6 h judgement.
 */
export function runMarkerBounds(
  deadlineMs: number,
  runTimeoutMs: number,
  abortGraceMs: number
): { fullDeadlineMs: number; scoped: { staleAfterMs: number }; full: { staleAfterMs: number }; job: { staleAfterMs: number } } {
  const fullDeadlineMs = Math.max(deadlineMs, runTimeoutMs === 0 ? DEFAULT_RUN_TIMEOUT_MS : runTimeoutMs);
  return {
    fullDeadlineMs,
    scoped: { staleAfterMs: deadlineMs + abortGraceMs },
    full: { staleAfterMs: fullDeadlineMs + abortGraceMs },
    job: { staleAfterMs: runTimeoutMs === 0 ? DEFAULT_STALE_RUN_MS : runTimeoutMs + abortGraceMs }
  };
}

/** Who started a refresh run. */
export type RefreshRunSource = "freshness_gate" | "watcher";

/** What `index_status` lists for a refresh run in flight (`refreshRuns`), and answers for its runId. */
export type RefreshRunView = {
  runId: string;
  repoId: string;
  mode: IndexMode;
  source: RefreshRunSource;
  state: "running" | "stopping";
  startedAt: string;
  elapsedMs: number;
  deadlineMs: number;
  deadlineAt: string;
  phase?: string;
  progress?: number;
  total?: number;
  /** Set once the deadline passed: the run is being stopped (the queue frees when the worker is gone). */
  stopReason?: string;
};

type RefreshEntry = Omit<RefreshRunView, "elapsedMs" | "state"> & { startedMs: number };

export type RefreshRunRequest<T> = {
  repoId: string;
  mode: IndexMode;
  source: RefreshRunSource;
  /** Run it under `runId` with this progress sink; `mode` may differ from the request (a pending repair: full). */
  execute: (runId: string, mode: IndexMode, onProgress: (progress: number, total: number | undefined, message: string) => void, escalatedBecause?: string) => Promise<T>;
  /** This run's deadline instead of the registry's (tests). */
  deadlineMs?: number;
  /** Stop the run recorded under `runId` (the refresh worker's `abortRun`); resolves once the worker is gone. */
  abort: (runId: string, reason: string) => Promise<boolean>;
};

/**
 * IX-A: the refresh runs this process has in flight — the gate's and the watcher's, which are not index jobs — each
 * with a runId (its `index_runs` id), progress and a deadline. Past the deadline the run is stopped through the refresh
 * worker (MCP-ISSUE-123 plumbing: the run aborts at its next batch boundary and records itself `cancelled` with no
 * commit and the deadline as its reason; a worker that does not exit in its grace is terminated), its promise rejects
 * with the reason only once the worker is gone (never two writers), and the repo's next run here is `full` until one
 * lands — a run terminated mid-batch leaves no row for the runner's own "last run was aborted" escalation to read.
 */
export class RefreshRuns {
  private readonly runs = new Map<string, RefreshEntry>();
  /** repoId → why its next run must be full (a deadline stop), cleared when a full run lands. */
  private readonly repairs = new Map<string, string>();
  /** repoId → deadline stops in a row (review (2)); a run that lands clears it. */
  private readonly stops = new Map<string, number>();

  constructor(
    private readonly deadlineMs: number,
    /**
     * Review (2): the deadline of a FULL run (a repair, or a repo's first index). The scoped-run deadline would stop a big
     * repo's full run every time. The server passes max(deadline, CODEBASE_INDEX_RUN_TIMEOUT_MS).
     */
    private readonly fullDeadlineMs: number = deadlineMs,
    private readonly hooks: {
      now?: () => number;
      /**
       * Review (3): a run was stopped at its deadline (the worker is gone). The server writes the freshness gate's
       * durable repair flag here (`markRepairNeeded`), so another process — or this one after a restart — repairs the
       * part-written index too; this registry's own repair is in memory only.
       */
      onDeadlineStop?: (stopped: { repoId: string; mode: IndexMode; at: number }) => void;
      /**
       * MCP-ISSUE-130: why the repo's next run must be full regardless of what was asked (its index was last fully built
       * by another INDEX_VERSION), or null. Asked here, before the deadline is chosen, so a run the runner would escalate
       * gets the full-run deadline instead of being stopped at the scoped one.
       */
      mustRunFull?: (repoId: string) => string | null;
    } = {}
  ) {
    this.now = hooks.now ?? Date.now;
  }

  private readonly now: () => number;

  /** In-flight refresh runs, oldest first. */
  list(): RefreshRunView[] {
    return [...this.runs.values()].map((e) => this.view(e));
  }

  get(runId: string): RefreshRunView | null {
    const e = this.runs.get(runId);
    return e ? this.view(e) : null;
  }

  /** The mode a run of `repoId` must use, and why it differs (a deadline stop left the index part-written). */
  modeFor(repoId: string, mode: IndexMode): { mode: IndexMode; escalatedBecause?: string } {
    const why = this.repairs.get(repoId) ?? (mode === "full" ? null : this.versionReason(repoId));
    // A full run asked for anyway (the gate read the durable flag) still records why it is a repair.
    return why ? { mode: "full", escalatedBecause: `full (${why}; ${mode} requested)` } : { mode };
  }

  /** MCP-ISSUE-130: the hook's answer; a hook that throws decides nothing (the runner still checks for itself). */
  private versionReason(repoId: string): string | null {
    try {
      return this.hooks.mustRunFull?.(repoId) ?? null;
    } catch {
      return null;
    }
  }

  /** A run of `repoId` landed: one not failed/cancelled ends the stop count; a full one also ends the pending repair. */
  landed(repoId: string, result: { mode?: IndexMode; status?: string } | null | undefined): void {
    if (result?.status === "failed" || result?.status === "cancelled") return;
    this.stops.delete(repoId);
    if (result?.mode === "full") this.repairs.delete(repoId);
  }

  /** Review (6): a run stopped elsewhere (an index job past its timeout) may leave the index part-written: next run full. */
  needRepair(repoId: string, why: string): void {
    this.repairs.set(repoId, why);
  }

  async run<T extends { mode?: IndexMode; status?: string }>(request: RefreshRunRequest<T>): Promise<T> {
    const stopped = this.stops.get(request.repoId) ?? 0;
    if (stopped >= MAX_REFRESH_DEADLINE_STOPS) {
      throw new Error(
        `no refresh of ${request.repoId} starts: its last ${String(stopped)} refresh runs were stopped at their deadline; run index_repository(mode: "full") — a run that lands lifts this`
      );
    }
    const runId = randomUUID();
    const planned = this.modeFor(request.repoId, request.mode);
    const startedMs = this.now();
    const deadlineMs = request.deadlineMs ?? (planned.mode === "full" ? this.fullDeadlineMs : this.deadlineMs);
    const entry: RefreshEntry = {
      runId,
      repoId: request.repoId,
      mode: planned.mode,
      source: request.source,
      startedAt: new Date(startedMs).toISOString(),
      startedMs,
      deadlineMs,
      deadlineAt: new Date(startedMs + deadlineMs).toISOString(),
      // IX-A(2): listed with a phase from the start, as an index job is ("starting" until the worker's first progress).
      phase: "starting"
    };
    this.runs.set(runId, entry);
    const stop: { promise: Promise<boolean> | null; prevRepair?: string } = { promise: null };
    const timer = setTimeout(() => {
      const reason = `refresh run ${runId} of ${request.repoId} (${planned.mode}, ${request.source}) stopped at its deadline: CODEBASE_INDEX_REFRESH_RUN_DEADLINE_MS=${String(deadlineMs)} ms`;
      entry.stopReason = reason;
      // Set BEFORE the run's rejection frees the queue: the next run of this repo is full.
      const prev = this.repairs.get(request.repoId);
      if (prev !== undefined) stop.prevRepair = prev;
      this.repairs.set(request.repoId, `refresh run ${runId} was stopped at the ${String(deadlineMs)} ms refresh deadline`);
      stop.promise = request.abort(runId, reason).catch(() => false);
    }, deadlineMs);
    timer.unref?.();
    const onProgress = (progress: number, total: number | undefined, message: string): void => {
      entry.phase = message.replace(/^[^:]*: /, "");
      entry.progress = progress;
      if (total !== undefined) entry.total = total;
      else delete entry.total;
    };
    try {
      const result = await request.execute(runId, planned.mode, onProgress, planned.escalatedBecause);
      // The deadline fired as the run ended: the worker answered first and nothing was stopped (review (4): what was
      // pending before stays pending).
      if (stop.promise && !(await stop.promise)) this.undoStop(request.repoId, stop.prevRepair);
      this.landed(request.repoId, result);
      return result;
    } catch (error) {
      // The worker's rejection already waited for its exit; this keeps the reason and makes certain of the order.
      if (stop.promise) {
        if (await stop.promise) {
          this.stops.set(request.repoId, (this.stops.get(request.repoId) ?? 0) + 1);
          try {
            this.hooks.onDeadlineStop?.({ repoId: request.repoId, mode: planned.mode, at: startedMs });
          } catch {
            // Best-effort: the in-memory repair above still forces this process's next run full.
          }
          throw new Error(entry.stopReason);
        }
        // Review (5): nothing was stopped — the run failed on its own as the deadline fired; its error stands.
        this.undoStop(request.repoId, stop.prevRepair);
      }
      throw error;
    } finally {
      clearTimeout(timer);
      this.runs.delete(runId);
    }
  }

  private undoStop(repoId: string, prevRepair: string | undefined): void {
    if (prevRepair === undefined) this.repairs.delete(repoId);
    else this.repairs.set(repoId, prevRepair);
  }

  private view(e: RefreshEntry): RefreshRunView {
    const { startedMs, ...rest } = e;
    return { ...rest, state: e.stopReason ? "stopping" : "running", elapsedMs: this.now() - startedMs };
  }
}
