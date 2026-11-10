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

import { DEFAULT_RETIRE_GRACE_MS, SHUTDOWN_RETIRE_GRACE_MS } from "../extractors/extractionWorkerPool.js";

import type { IndexMode, IndexRunResult } from "../../types/index.js";
import type { RunBookkeeping } from "../../middleware/freshness.js";
import type { IndexRunnerLimits, RunIndexAndResolve } from "./indexRunner.js";
import type { RefreshWorkerMessage, RefreshWorkerRequest } from "./refreshWorker.js";
import type { SeedRequest, SeedResult } from "../../repositories/seedStore.js";

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
  /** Server-thread follow-up after a purge (cache invalidation). Errors are swallowed. */
  onPurged?: (repoId: string) => void;
  /** MCP-ISSUE-123: how long `abortRun` waits for the worker to exit on request before terminating it. */
  abortGraceMs?: number;
  /** MCP-ISSUE-123 re-review E: the same for `dispose` (server shutdown); default `DEFAULT_DISPOSE_GRACE_MS` (35 s). */
  disposeGraceMs?: number;
};

/**
 * MCP-ISSUE-123 (review #2): how long the client waits for the worker's exit before terminating it. Its `exit` waits for
 * the parse pool's retired workers, which may take up to the pool's own retire grace; terminating the refresh worker
 * sooner tears its nested parse workers down mid-parse — the 0xC0000409 this whole path exists to avoid. So the
 * fallback comes only after that bound, plus a margin for the run's last batch to record itself cancelled.
 */
export const EXIT_MARGIN_MS = 30_000;
export const DEFAULT_ABORT_GRACE_MS = DEFAULT_RETIRE_GRACE_MS + EXIT_MARGIN_MS;
/**
 * MCP-ISSUE-123 re-review E: server shutdown is bounded. `dispose` sends `exit` with `shutdown`: the worker's parse pool
 * terminates a parse worker still in its job after `SHUTDOWN_RETIRE_GRACE_MS` (20 s), and the worker exits by
 * `SHUTDOWN_WORKER_EXIT_MS` (25 s) even if its aborted run has not settled; this client terminates it only after
 * `DEFAULT_DISPOSE_GRACE_MS` (35 s). It was the 5.5 min abort grace. `abortRun` (a normal run) keeps that.
 */
export const SHUTDOWN_WORKER_EXIT_MS = SHUTDOWN_RETIRE_GRACE_MS + 5_000;
export const DEFAULT_DISPOSE_GRACE_MS = SHUTDOWN_WORKER_EXIT_MS + 10_000;

type Pending = {
  repoId: string;
  /** Set for a `purge` / `clear` request: answered by a `purged` message instead of a run result. */
  onPurged?: (counts: Record<string, number>) => void;
  /** Set for a `seed` request: answered by a `seeded` message. */
  onSeeded?: (seed: SeedResult) => void;
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
  /** Workers whose 'exit' already fired (MCP-ISSUE-123: stopping one must not wait for it again). */
  private readonly exitedWorkers = new WeakSet<RefreshWorkerLike>();
  /** Workers asked to exit and not gone yet (an `abortRun`'s): `dispose` must bound them too (leader review (1)). */
  private readonly stopping = new Set<RefreshWorkerLike>();
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

  /**
   * Review follow-up 3-rest: `remove_repository`'s delete, executed by the worker on its connection — the one every
   * index write of this process goes through — so the server thread never waits on the write lock. The caller queues it
   * in the DB-wide queue like a run.
   */
  purge(repoId: string): Promise<Record<string, number>> {
    return this.deleteRows("purge", repoId);
  }

  /**
   * IX-9 (MCP-ISSUE-119): drop one repo's index rows but keep its registration, on the worker's connection, per repo
   * (no all-repo FTS rebuild) — the seeded child before its fallback full run. Queue it like a run.
   */
  clear(repoId: string): Promise<Record<string, number>> {
    return this.deleteRows("clear", repoId);
  }

  /**
   * IX-9 (MCP-ISSUE-119): `seedFromParent` on the worker's connection — the single writer — never this thread's. A
   * failure rejects with an Error carrying the SeedError `code`. Queue it like a run. `runId` (the index job's) lets
   * `abortRun` stop a hung seed as it stops a hung run.
   */
  seed(req: SeedRequest, runId?: string, lockDir?: string): Promise<SeedResult> {
    return new Promise<SeedResult>((resolve, reject) => {
      const worker = this.workerOr(reject);
      if (!worker) return;
      const id = this.nextId++;
      this.pending.set(id, { repoId: req.childRepoId, resolve: () => reject(new Error("seed answered by a run result")), reject, onSeeded: resolve, ...(runId && { runId }) });
      worker.postMessage({
        kind: "seed", id, dbPath: this.options.dbPath, limits: this.options.limits, repoId: req.childRepoId, repoPath: req.childRepoPath,
        mode: "full", docsEnabled: false, maxFiles: 0, batchSize: 0, seedFrom: req.parentRepoId, ...(lockDir && { lockDir })
      });
    });
  }

  private deleteRows(kind: "purge" | "clear", repoId: string): Promise<Record<string, number>> {
    return new Promise<Record<string, number>>((resolve, reject) => {
      const worker = this.workerOr(reject);
      if (!worker) return;
      const id = this.nextId++;
      this.pending.set(id, { repoId, resolve: () => resolve({}), reject, onPurged: resolve });
      worker.postMessage({ kind, id, dbPath: this.options.dbPath, limits: this.options.limits, repoId, repoPath: "", mode: "full", docsEnabled: false, maxFiles: 0, batchSize: 0 });
    });
  }

  private workerOr(reject: (error: Error) => void): RefreshWorkerLike | null {
    try {
      return this.ensureWorker();
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
      return null;
    }
  }

  get outstanding(): number {
    return this.pending.size;
  }

  /**
   * Review follow-up C: stop ONE hung run, the one recorded under `runId`. Answers false — and touches nothing — when
   * that run is not in the worker (not started yet, or already over). Otherwise the worker is stopped (`stopWorker`:
   * asked to exit, terminated only if it has not within `abortGraceMs` — a synchronous SQLite stretch cannot read the
   * request), the run is rejected with `reason`, and the next run spawns a fresh worker.
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
    // Review F2: the rejection releases the DB-wide queue, so it waits until the old worker is gone — rejecting first
    // let the next run start a new worker while the old one could still be writing: two writers.
    try {
      await this.stopWorker(worker, this.options.abortGraceMs ?? DEFAULT_ABORT_GRACE_MS);
    } finally {
      target[1].reject(new Error(reason));
      for (const [, p] of others) p.reject(new Error(`the refresh worker was restarted to stop timed-out run ${runId}`));
    }
    return true;
  }

  /**
   * Stop the worker (server shutdown, tests), as `abortRun` does but with `disposeGraceMs` and an `exit` marked
   * `shutdown` (re-review E: bounded, see `DEFAULT_DISPOSE_GRACE_MS`). Outstanding runs are rejected.
   */
  async dispose(): Promise<void> {
    const worker = this.worker;
    this.fail(new Error("the refresh worker was shut down"));
    // Leader review (1): a worker still being stopped by `abortRun` (already detached from `this.worker`) gets the
    // shutdown `exit` too — the worker upgrades its pending exit — and this call's 35 s fallback, not the abort's 5.5 min.
    const targets = new Set<RefreshWorkerLike>(this.stopping);
    if (worker) targets.add(worker);
    const graceMs = this.options.disposeGraceMs ?? DEFAULT_DISPOSE_GRACE_MS;
    await Promise.all([...targets].map((target) => this.stopWorker(target, graceMs, true)));
  }

  /**
   * MCP-ISSUE-123: ask the worker to exit (`exit` request: it retires its parse pool, then exits between two turns of
   * JavaScript) and resolve when it has. `terminate()` lands wherever the thread — or one of its parse workers — is, and
   * inside a tree-sitter parse that takes the whole process down (0xC0000409). It is the fallback only after `graceMs`.
   */
  private stopWorker(worker: RefreshWorkerLike, graceMs: number, shutdown = false): Promise<void> {
    return new Promise<void>((resolve) => {
      let settled = false;
      let grace: NodeJS.Timeout | undefined;
      const done = (): void => {
        if (settled) return;
        settled = true;
        if (grace) clearTimeout(grace);
        this.stopping.delete(worker);
        resolve();
      };
      if (this.exitedWorkers.has(worker)) {
        done();
        return;
      }
      this.stopping.add(worker);
      worker.on("exit", done);
      try {
        worker.postMessage({ kind: "exit", id: 0, dbPath: this.options.dbPath, limits: this.options.limits, repoId: "", repoPath: "", mode: "dirty", docsEnabled: false, maxFiles: 0, batchSize: 0, ...(shutdown && { shutdown: true }) });
      } catch {
        // The port is closed: the worker is already going; 'exit' or the grace timer settles it.
      }
      grace = setTimeout(() => {
        void worker.terminate().then(done, done);
      }, graceMs);
      // The fallback timer alone never keeps the process alive (the worker itself is unref'd).
      grace.unref?.();
    });
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
      this.exitedWorkers.add(worker);
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
    if (message.type === "purged") {
      try {
        this.options.onPurged?.(entry.repoId);
      } catch {
        // Best-effort cache drop; the rows are gone.
      }
      entry.onPurged?.(message.counts);
      return;
    }
    if (message.type === "seeded") {
      try {
        this.options.onPurged?.(entry.repoId); // the same cache drop: the child's rows changed under this thread
      } catch {
        // Best-effort cache drop.
      }
      entry.onSeeded?.(message.seed);
      return;
    }
    if (message.type === "error") {
      entry.reject(Object.assign(new Error(message.error), message.code ? { code: message.code } : {}));
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
