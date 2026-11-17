/**
 * MCP-ISSUE-132 — the server thread's side of the vector-search worker (`vectorSearchWorker.ts`).
 *
 * `search_symbols` pads a name query that FTS answers with fewer than three rows with vector near-neighbours. The
 * KNN behind it is a brute-force scan that took 0.3-2.9 s on the server thread; here it is posted to a worker
 * thread with its own read-only connection, and the call waits for the answer at most `waitMs`.
 *
 * - **Budget.** A late answer is not waited for: the call resolves `{ skipped: "budget" }` and the response says the
 *   padding was skipped (never silently). The worker finishes the scan anyway and the answer is memoized, so the next
 *   identical query is answered at once.
 * - **Memo (MCP-ISSUE-136).** Answers are memoized HERE, on the server thread, keyed like vectorStore's own memo
 *   (repo, k, text) and bounded by {@link MEMO_MAX}: a memoized query never reaches a worker, whichever lane scanned
 *   it. `invalidate()` clears it, and an answer to a request posted before the last invalidation is not stored.
 * - **Queue bound.** At most {@link MAX_PENDING} searches are outstanding — a budget-timed-out one counts until the
 *   worker answers it, since it still occupies the worker — and beyond that a call resolves
 *   `{ skipped: "queue" }` at once instead of piling scans behind each other.
 * - **Lanes (MCP-ISSUE-136).** A worker scans one request at a time, so a search posted behind another one's scan
 *   waited for it: after a run landed (memo cleared), the big repo's rescan held a small repo's search for the whole
 *   budget. An idle worker takes each request; with every worker busy a second one is spawned, at most
 *   {@link MAX_WORKERS}. The memo is shared, so a second lane's cold memo costs no rescan of a known query.
 * - **Lifetime.** Spawned lazily on the first padded query; every worker is terminated after {@link IDLE_EXIT_MS}
 *   without a request (the next query spawns a fresh one), and on server shutdown.
 * - **Invalidation.** `invalidate()` (from `onRunLanded` / `onPurged`) clears every worker's KNN memo.
 */

import { Worker } from "node:worker_threads";

import type { VectorSearchMessage, VectorSearchRequest } from "./vectorSearchWorker.js";

/** How long a padded `search_symbols` waits for its neighbours. Generous: an idle machine answers in ≪ 1 s. */
export const DEFAULT_PADDING_WAIT_MS = 2_000;
export const MAX_PENDING = 4;
/** Worker lanes: one for the usual case, a second so one repo's slow scan never queues another repo's search. */
export const MAX_WORKERS = 2;
export const IDLE_EXIT_MS = 5 * 60_000;
/** Memoized answers kept on the server thread; the oldest is dropped past this. */
export const MEMO_MAX = 1_000;

export type VectorRow = { symbolId: string; distance: number };
export type VectorSearchOutcome = { rows: VectorRow[] } | { skipped: "budget" | "queue" | "worker-error" };

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

type Pending = {
  settle: (o: VectorSearchOutcome) => void;
  timer: NodeJS.Timeout | null;
  worker: VectorWorkerLike;
  key: string;
  generation: number;
};

const memoKey = (repoId: string, k: number, text: string): string => `${repoId}\u0000${String(k)}\u0000${text}`;

export class VectorSearchWorkerClient {
  /** Live workers, at most {@link MAX_WORKERS}. The first idle one is taken, so a repeated query usually meets its memo. */
  private readonly workers: VectorWorkerLike[] = [];
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly memo = new Map<string, VectorRow[]>();
  /** Bumped by `invalidate()`: an answer to a request of an older generation is delivered but never memoized. */
  private generation = 0;
  private idleTimer: NodeJS.Timeout | null = null;
  private disposed = false;

  constructor(
    private readonly dbPath: string,
    private readonly opts: { spawn?: SpawnVectorWorker; idleExitMs?: number } = {}
  ) {}

  /**
   * Outstanding searches, INCLUDING ones whose caller already got `budget`: a late request is still queued or running
   * in a (serial) worker, so counting it is what keeps MAX_PENDING a bound on the scans piled up there.
   */
  get pendingCount(): number {
    return this.pending.size;
  }

  get isRunning(): boolean {
    return this.workers.length > 0;
  }

  get workerCount(): number {
    return this.workers.length;
  }

  search(repoId: string, text: string, k: number, waitMs = DEFAULT_PADDING_WAIT_MS): Promise<VectorSearchOutcome> {
    if (this.disposed) return Promise.resolve({ skipped: "worker-error" });
    const key = memoKey(repoId, k, text);
    const known = this.memo.get(key);
    if (known) return Promise.resolve({ rows: known });
    if (this.pending.size >= MAX_PENDING) return Promise.resolve({ skipped: "queue" });
    const worker = this.pickWorker();
    const id = this.nextId++;
    return new Promise<VectorSearchOutcome>((resolve) => {
      const entry: Pending = { settle: resolve, timer: null, worker, key, generation: this.generation };
      // The answer is dropped when it comes late; the request stays in the worker (its result is memoized there).
      entry.timer = setTimeout(() => {
        entry.timer = null;
        entry.settle({ skipped: "budget" });
        entry.settle = () => {};
      }, waitMs);
      entry.timer.unref();
      this.pending.set(id, entry);
      worker.postMessage({ kind: "search", id, dbPath: this.dbPath, repoId, text, k });
    });
  }

  /** Clear the memo here and every worker's KNN memo after a run landed through another connection. No worker: nothing is memoized. */
  invalidate(): void {
    this.generation++;
    this.memo.clear();
    for (const w of this.workers) w.postMessage({ kind: "invalidate", id: 0 });
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.clearIdle();
    const ws = this.workers.splice(0);
    this.failWhere(() => true);
    await Promise.all(ws.map((w) => w.terminate().catch(() => 0)));
  }

  private inFlight(w: VectorWorkerLike): number {
    let n = 0;
    for (const p of this.pending.values()) if (p.worker === w) n++;
    return n;
  }

  /**
   * MCP-ISSUE-136: an idle worker takes the request (the first idle one, so the usual single query keeps one warm
   * memo); with every worker busy a new one is spawned, up to MAX_WORKERS; past that, the least busy one queues it.
   */
  private pickWorker(): VectorWorkerLike {
    this.clearIdle();
    const idle = this.workers.find((w) => this.inFlight(w) === 0);
    if (idle) return idle;
    if (this.workers.length < MAX_WORKERS) return this.spawnWorker();
    return this.workers.reduce((a, b) => (this.inFlight(b) < this.inFlight(a) ? b : a));
  }

  private spawnWorker(): VectorWorkerLike {
    const w = (this.opts.spawn ?? spawnVectorSearchWorker)();
    w.unref?.();
    w.on("message", (m) => this.onMessage(m));
    w.on("error", () => this.onGone(w));
    w.on("exit", () => this.onGone(w));
    this.workers.push(w);
    return w;
  }

  private onMessage(m: VectorSearchMessage): void {
    const p = this.pending.get(m.id);
    if (!p) return;
    this.pending.delete(m.id);
    if (p.timer) clearTimeout(p.timer);
    if (m.kind === "result" && p.generation === this.generation) this.remember(p.key, m.rows);
    p.settle(m.kind === "result" ? { rows: m.rows } : { skipped: "worker-error" });
    if (this.pending.size === 0) this.armIdle();
  }

  private remember(key: string, rows: VectorRow[]): void {
    this.memo.delete(key);
    this.memo.set(key, rows);
    if (this.memo.size > MEMO_MAX) this.memo.delete(this.memo.keys().next().value as string);
  }

  /** A worker that errored or exited: its own waiters settle `worker-error`; the other lane is untouched. */
  private onGone(w: VectorWorkerLike): void {
    const i = this.workers.indexOf(w);
    if (i < 0) return;
    this.workers.splice(i, 1);
    this.failWhere((p) => p.worker === w);
    if (this.workers.length === 0) this.clearIdle();
    else if (this.pending.size === 0) this.armIdle();
  }

  private failWhere(which: (p: Pending) => boolean): void {
    for (const [id, p] of [...this.pending]) {
      if (!which(p)) continue;
      this.pending.delete(id);
      if (p.timer) clearTimeout(p.timer);
      p.settle({ skipped: "worker-error" });
    }
  }

  private armIdle(): void {
    this.clearIdle();
    const t = setTimeout(() => {
      this.idleTimer = null;
      if (this.pending.size > 0) return;
      for (const w of this.workers.splice(0)) {
        w.postMessage({ kind: "exit", id: 0 });
        // An exit request the worker cannot honour (stuck in a scan) is not waited for.
        setTimeout(() => void w.terminate().catch(() => 0), 5_000).unref();
      }
    }, this.opts.idleExitMs ?? IDLE_EXIT_MS);
    t.unref();
    this.idleTimer = t;
  }

  private clearIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }
}
