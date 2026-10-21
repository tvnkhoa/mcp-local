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
 * Explicit `index_repository` and the watcher still run on the server thread: they report progress
 * through the request, and the acceptance this exists for is about query-triggered refreshes.
 */

import { Worker } from "node:worker_threads";

import type { IndexMode, IndexRunResult } from "../../types/index.js";
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

type Pending = { repoId: string; resolve: (result: IndexRunResult) => void; reject: (error: Error) => void };

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
  readonly run: RunIndexAndResolve = (repoId, repoPath, mode, docsEnabled, maxFiles, batchSize) =>
    this.request(repoId, repoPath, mode, docsEnabled, maxFiles, batchSize);

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
    batchSize: number
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
      this.pending.set(id, { repoId, resolve, reject });
      worker.postMessage({ kind: "run", id, dbPath: this.options.dbPath, limits: this.options.limits, repoId, repoPath, mode, docsEnabled, maxFiles, batchSize });
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
