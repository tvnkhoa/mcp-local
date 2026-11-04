/**
 * R1, release I1b — the server thread's side of the refresh worker.
 *
 * Problem it removes: the freshness gate ran its refresh on the server thread. A 4-file dirty run on
 * wec.aria took 27.7 s (resolve 23.3 s, FTS rebuild 4.9 s) and blocked the event loop for up to
 * 8 032 ms at a stretch (13 blocks over 250 ms), so a read tool's 5 s budget meant nothing: the
 * timer that ends the budget could not fire, and a query on ANOTHER repo waited behind the run.
 *
 * Design (one worker per process, warmed at server start — `warm` — or spawned by the first refresh,
 * kept for the process's life):
 * - `run` has the runner's signature, so the gate is handed this instead of the in-process runner.
 *   The worker opens its own `GraphStore` on the same DB file and runs `createIndexRunner` there —
 *   the same run, newer-build guard included. The server thread keeps its own connection for reads.
 * - Runs never overlap per repo: the gate's `serialize` still wraps every call, exactly as before.
 * - **Crash.** A worker `error` or `exit` rejects every outstanding run (the gate reports "the refresh
 *   run failed" and releases its lock) and drops the worker; the next refresh spawns a fresh one.
 * - `onRunLanded` runs on the server thread after each successful run, for the in-process caches that
 *   a run in another connection cannot clear (the vector search memo).
 *
 * MCP-ISSUE-112: `index_repository` (a job, see indexJobs.ts) and the watcher run here too, so every index write of
 * the process is this worker's. A run handed `onProgress` gets the worker's `progress` messages; a run handed
 * `runId` is recorded under it.
 */

import { Worker } from "node:worker_threads";

import type { IndexMode, IndexRunResult } from "../../types/index.js";
import type { RunBookkeeping } from "../../middleware/freshness.js";
import type { IndexRunnerLimits, RunIndexAndResolve } from "./indexRunner.js";
import type { RefreshWorkerMessage, RefreshWorkerRequest } from "./refreshWorker.js";

/** The part of `Worker` the client uses — a seam for unit tests. */
export interface RefreshWorkerLike {
  postMessage(value: RefreshWorkerRequest): void;
  on(event: "message", listener: (message: RefreshWorkerMessage) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "exit", listener: (code: number) => void): unknown;
  terminate(): Promise<number>;
  unref?(): void;
}

export type SpawnRefreshWorker = () => RefreshWorkerLike;

/** The production spawner: `refreshWorker.js` beside this file. */
export const spawnRefreshWorker: SpawnRefreshWorker = () =>
  new Worker(new URL("./refreshWorker.js", import.meta.url)) as unknown as RefreshWorkerLike;

export type RefreshWorkerClientOptions = {
  dbPath: string;
  limits: IndexRunnerLimits;
  spawn?: SpawnRefreshWorker;
  /** Server-thread follow-up after a run landed (cache invalidation). Errors are swallowed. */
  onRunLanded?: (repoId: string, result: IndexRunResult) => void;
};

type Pending = {
  repoId: string;
  /** The index job's runId, when the run is one (review follow-up C: `abortRun` targets it). */
  runId?: string;
  resolve: (result: IndexRunResult) => void;
  reject: (error: Error) => void;
  onProgress?: (progress: number, total: number | undefined, message: string) => void;
};

export class RefreshWorkerClient {
  private worker: RefreshWorkerLike | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly spawn: SpawnRefreshWorker;
  /** Times the worker has been spawned — exposed for tests. */
  spawned = 0;

  constructor(private readonly options: RefreshWorkerClientOptions) {
    this.spawn = options.spawn ?? spawnRefreshWorker;
  }

  /** Same signature as the in-process runner, so the gate cannot tell the difference. */
  readonly run: RunIndexAndResolve = (repoId, repoPath, mode, docsEnabled, maxFiles, batchSize, extras) =>
    this.request(repoId, repoPath, mode, docsEnabled, maxFiles, batchSize, extras?.knownDirtyPaths, extras?.bookkeeping, extras?.runId, extras?.onProgress);

  /**
   * Spawn the worker and have it open its connection and load the indexer now, so the first refresh
   * does not spend its query budget on that (a cold worker took seconds before its run could start).
   * Called once at server start when R1 is on. Best-effort.
   */
  warm(): void {
    try {
      const worker = this.ensureWorker();
      worker.postMessage({ kind: "warm", id: 0, dbPath: this.options.dbPath, limits: this.options.limits, repoId: "", repoPath: "", mode: "dirty", docsEnabled: false, maxFiles: 0, batchSize: 0 });
    } catch {
      // The first run spawns it, or reports why it cannot.
    }
  }

  get outstanding(): number {
    return this.pending.size;
  }

  /**
   * Review follow-up C: stop ONE hung run, the one recorded under `runId`. Answers false — and touches nothing — when
   * that run is not in the worker (not started yet, or already over). Otherwise the worker is terminated (the only way
   * to stop a synchronous SQLite stretch), the run is rejected with `reason`, and the next run spawns a fresh worker.
   * Runs reach the worker one at a time (the DB-wide queue), so no other run is in flight; one that were would be
   * rejected as "worker restarted", never left hanging.
   */
  async abortRun(runId: string, reason: string): Promise<boolean> {
    const target = [...this.pending.entries()].find(([, p]) => p.runId === runId);
    if (!target || !this.worker) return false;
    const worker = this.worker;
    const others = [...this.pending.entries()].filter(([id]) => id !== target[0]);
    this.worker = null;
    this.pending.clear();
    target[1].reject(new Error(reason));
    for (const [, p] of others) p.reject(new Error(`the refresh worker was restarted to stop timed-out run ${runId}`));
    await worker.terminate();
    return true;
  }

  /** Terminate the worker (server shutdown, tests). Outstanding runs are rejected. */
  async dispose(): Promise<void> {
    const worker = this.worker;
    this.fail(new Error("the refresh worker was shut down"));
    if (worker) await worker.terminate();
  }

  private request(
    repoId: string,
    repoPath: string,
    mode: IndexMode,
    docsEnabled: boolean,
    maxFiles: number,
    batchSize: number,
    /** Release K3 (P1): the gate's dirty set, so the worker's dirty run does not read git again. */
    dirtyPaths?: readonly string[],
    bookkeeping?: RunBookkeeping,
    runId?: string,
    onProgress?: (progress: number, total: number | undefined, message: string) => void
  ): Promise<IndexRunResult> {
    return new Promise<IndexRunResult>((resolve, reject) => {
      let worker: RefreshWorkerLike;
      try {
        worker = this.ensureWorker();
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      const id = this.nextId++;
      this.pending.set(id, { repoId, resolve, reject, ...(runId && { runId }), ...(onProgress && { onProgress }) });
      worker.postMessage({
        kind: "run",
        id,
        dbPath: this.options.dbPath,
        limits: this.options.limits,
        repoId,
        repoPath,
        mode,
        docsEnabled,
        maxFiles,
        batchSize,
        ...(dirtyPaths && { dirtyPaths: [...dirtyPaths] }),
        ...(bookkeeping && { bookkeeping }),
        ...(runId && { runId }),
        ...(onProgress && { reportProgress: true })
      });
    });
  }

  private ensureWorker(): RefreshWorkerLike {
    if (this.worker) return this.worker;
    const worker = this.spawn();
    this.spawned++;
    worker.unref?.();
    worker.on("message", (message) => this.onMessage(worker, message));
    worker.on("error", (error) => {
      if (worker === this.worker) this.fail(new Error(`the refresh worker crashed: ${error.message}`));
      void worker.terminate();
    });
    worker.on("exit", (code) => {
      if (worker === this.worker) this.fail(new Error(`the refresh worker exited with code ${String(code)}`));
    });
    this.worker = worker;
    return worker;
  }

  private onMessage(worker: RefreshWorkerLike, message: RefreshWorkerMessage): void {
    if (worker !== this.worker) return;
    const entry = this.pending.get(message.id);
    if (!entry) return;
    if (message.type === "progress") {
      try {
        entry.onProgress?.(message.progress, message.total, message.message);
      } catch {
        // A progress sink never fails the run.
      }
      return;
    }
    this.pending.delete(message.id);
    if (message.type === "error") {
      entry.reject(new Error(message.error));
      return;
    }
    try {
      this.options.onRunLanded?.(entry.repoId, message.result);
    } catch {
      // Best-effort: the run itself landed.
    }
    entry.resolve(message.result);
  }

  /** Drop the worker and reject every outstanding run. */
  private fail(error: Error): void {
    this.worker = null;
    const entries = [...this.pending.values()];
    this.pending.clear();
    for (const entry of entries) entry.reject(error);
  }
}
