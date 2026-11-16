/**
 * MCP-ISSUE-132 — the server thread's side of the vector-search worker (`vectorSearchWorker.ts`).
 *
 * `search_symbols` pads a name query that FTS answers with fewer than three rows with vector near-neighbours. The
 * KNN behind it is a brute-force scan that took 0.3-2.9 s on the server thread; here it is posted to one worker
 * thread with its own read-only connection, and the call waits for the answer at most `waitMs`.
 *
 * - **Budget.** A late answer is not waited for: the call resolves `{ skipped: "budget" }` and the response says the
 *   padding was skipped (never silently). The worker finishes the scan anyway and memoizes it, so the next identical
 *   query is answered at once.
 * - **Queue bound.** At most {@link MAX_PENDING} searches are outstanding; beyond that a call resolves
 *   `{ skipped: "queue" }` at once instead of piling scans behind each other.
 * - **Lifetime.** Spawned lazily on the first padded query; terminated after {@link IDLE_EXIT_MS} without a request
 *   (the next query spawns a fresh one), and on server shutdown.
 * - **Invalidation.** `invalidate()` (from `onRunLanded` / `onPurged`) clears the worker's KNN memo.
 */

import { Worker } from "node:worker_threads";

import type { VectorSearchMessage, VectorSearchRequest } from "./vectorSearchWorker.js";

/** How long a padded `search_symbols` waits for its neighbours. Generous: an idle machine answers in ≪ 1 s. */
export const DEFAULT_PADDING_WAIT_MS = 2_000;
export const MAX_PENDING = 4;
export const IDLE_EXIT_MS = 5 * 60_000;

export type VectorRow = { symbolId: string; distance: number };
export type VectorSearchOutcome = { rows: VectorRow[] } | { skipped: "budget" | "queue" | "error" };

/** The part of `Worker` the client uses — a seam for unit tests. */
export interface VectorWorkerLike {
  postMessage(value: VectorSearchRequest): void;
  on(event: "message", listener: (message: VectorSearchMessage) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "exit", listener: (code: number) => void): unknown;
  terminate(): Promise<number>;
  unref?(): void;
}

export type SpawnVectorWorker = () => VectorWorkerLike;

/** The production spawner: `vectorSearchWorker.js` beside this file (also in `dist/bundle/`, see scripts/bundle.mjs). */
export const spawnVectorSearchWorker: SpawnVectorWorker = () =>
  new Worker(new URL("./vectorSearchWorker.js", import.meta.url)) as unknown as VectorWorkerLike;

type Pending = { settle: (o: VectorSearchOutcome) => void; timer: NodeJS.Timeout | null };

export class VectorSearchWorkerClient {
  private worker: VectorWorkerLike | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private idleTimer: NodeJS.Timeout | null = null;
  private disposed = false;

  constructor(
    private readonly dbPath: string,
    private readonly opts: { spawn?: SpawnVectorWorker; idleExitMs?: number } = {}
  ) {}

  /** Outstanding searches (answered late ones excluded). */
  get pendingCount(): number {
    return this.pending.size;
  }

  get isRunning(): boolean {
    return this.worker !== null;
  }

  search(repoId: string, text: string, k: number, waitMs = DEFAULT_PADDING_WAIT_MS): Promise<VectorSearchOutcome> {
    if (this.disposed) return Promise.resolve({ skipped: "error" });
    if (this.pending.size >= MAX_PENDING) return Promise.resolve({ skipped: "queue" });
    const worker = this.ensureWorker();
    const id = this.nextId++;
    return new Promise<VectorSearchOutcome>((resolve) => {
      const entry: Pending = { settle: resolve, timer: null };
      // The answer is dropped when it comes late; the request stays in the worker (its result is memoized there).
      entry.timer = setTimeout(() => {
        entry.timer = null;
        entry.settle({ skipped: "budget" });
        entry.settle = () => {};
      }, waitMs);
      this.pending.set(id, entry);
      worker.postMessage({ kind: "search", id, dbPath: this.dbPath, repoId, text, k });
    });
  }

  /** Clear the worker's KNN memo after a run landed through another connection. No worker: nothing is memoized. */
  invalidate(): void {
    this.worker?.postMessage({ kind: "invalidate", id: 0 });
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.clearIdle();
    const w = this.worker;
    this.worker = null;
    this.failAll();
    if (w) await w.terminate().catch(() => 0);
  }

  private ensureWorker(): VectorWorkerLike {
    this.clearIdle();
    if (this.worker) return this.worker;
    const w = (this.opts.spawn ?? spawnVectorSearchWorker)();
    w.unref?.();
    w.on("message", (m) => this.onMessage(m));
    w.on("error", () => this.onGone(w));
    w.on("exit", () => this.onGone(w));
    this.worker = w;
    return w;
  }

  private onMessage(m: VectorSearchMessage): void {
    const p = this.pending.get(m.id);
    if (!p) return;
    this.pending.delete(m.id);
    if (p.timer) clearTimeout(p.timer);
    p.settle(m.kind === "result" ? { rows: m.rows } : { skipped: "error" });
    if (this.pending.size === 0) this.armIdle();
  }

  private onGone(w: VectorWorkerLike): void {
    if (this.worker !== w) return;
    this.worker = null;
    this.clearIdle();
    this.failAll();
  }

  private failAll(): void {
    for (const p of this.pending.values()) {
      if (p.timer) clearTimeout(p.timer);
      p.settle({ skipped: "error" });
    }
    this.pending.clear();
  }

  private armIdle(): void {
    this.clearIdle();
    const t = setTimeout(() => {
      this.idleTimer = null;
      const w = this.worker;
      if (!w || this.pending.size > 0) return;
      this.worker = null;
      w.postMessage({ kind: "exit", id: 0 });
      // An exit request the worker cannot honour (stuck in a scan) is not waited for.
      setTimeout(() => void w.terminate().catch(() => 0), 5_000).unref();
    }, this.opts.idleExitMs ?? IDLE_EXIT_MS);
    t.unref();
    this.idleTimer = t;
  }

  private clearIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }
}
