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
};

export type IndexJobProgress = { phase: string; progress?: number; total?: number };

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

  constructor(private readonly options: IndexJobQueueOptions) {
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
        if (settled || timeout || limit <= 0) return;
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
