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
  /** While queued: why it has not started (another run ahead, or free RAM below the floor). */
  waitingFor?: string;
  phase?: string;
  progress?: number;
  total?: number;
  /** The run's summary once it ended ok (or the run's own `failed` status). */
  result?: IndexRunResult;
  error?: string;
};

export type IndexJobExecutor = (
  job: Readonly<IndexJob>,
  request: IndexJobRequest,
  onProgress: (progress: IndexJobProgress) => void
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
};

export const DEFAULT_MIN_FREE_RAM_MB = 8192;
/** `wait: true` blocks at most this long, then answers with the job as it stands (IX-2: under the 120 s client ceiling). */
export const MAX_WAIT_MS = 100_000;

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

  /** Queue a run; it starts when the queue is free and RAM allows. Returns a snapshot of the job. */
  enqueue(request: IndexJobRequest): IndexJob {
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
    void this.options
      .execute(job, request, (p) => {
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
      })
      .then(
        (result) => {
          job.result = result;
          job.state = result.status === "failed" || result.status === "cancelled" ? "failed" : "ok";
          if (job.state === "failed") job.error = `the run ended ${String(result.status)}`;
        },
        (error: unknown) => {
          job.state = "failed";
          job.error = error instanceof Error ? error.message : String(error);
        }
      )
      .finally(() => {
        job.finishedAt = new Date(this.now()).toISOString();
        delete job.phase;
        this.running = null;
        this.requests.delete(nextId);
        for (const done of this.waiters.get(nextId) ?? []) done();
        this.waiters.delete(nextId);
        this.listeners.delete(nextId);
        this.trim();
        this.pump();
      });
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
