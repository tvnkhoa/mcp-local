/**
 * MCP-ISSUE-132 — the server thread's side of the vector-search worker (`vectorSearchWorker.ts`).
 *
 * `search_symbols` pads a name query that FTS answers with fewer than three rows with vector near-neighbours. The
 * KNN behind it is a brute-force scan that took 0.3-2.9 s on the server thread; here it is posted to a worker
 * thread with its own read-only connection, and the call waits for the answer at most `waitMs`.
 *
 * - **Budget.** A late answer is not waited for: the call resolves `{ skipped: "budget" }` and the response says the
 *   padding was skipped (never silently). The worker finishes a scan it has STARTED and the answer is memoized here,
 *   so the next identical query is answered at once; a request queued behind another scan and still waiting at its
 *   deadline is dropped there unscanned (`expired`, MCP-ISSUE-135) — nobody waits for it any more. A lane's first
 *   request carries no deadline: it is always scanned, even when the worker's start-up outlasts the budget.
 * - **Lane cap (MCP-ISSUE-135).** A scan cannot be interrupted, so a lane whose current scan outlives
 *   {@link DEFAULT_LANE_CAP_MS} is retired: dropped from the lanes at once (the next search gets a fresh worker), its
 *   waiters settled `worker-error`, and the worker terminated — it stops at the end of the statement in hand instead
 *   of running the rest of the scan's widening rounds and its queue.
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
 * - **Invalidation.** `invalidate()` (from `onRunLanded` / `onPurged`) clears the memo here and every worker's KNN memo.
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
/**
 * MCP-ISSUE-135: the longest one scan may hold its lane. Measured on a 200k-vector partition (scratch, 17 Nov): one
 * lookup 2.1-4.9 s; CI's real repo 2.9 s. A scan that finishes past the budget still pays (it is memoized), so the cap
 * is about 2x the slowest measured scan, not the budget.
 */
export const DEFAULT_LANE_CAP_MS = 10_000;

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
const copyRows = (rows: readonly Readonly<VectorRow>[]): VectorRow[] => rows.map((r) => ({ ...r }));

export class VectorSearchWorkerClient {
  /** Live workers, at most {@link MAX_WORKERS}. The first idle one is taken, so a repeated query usually meets its memo. */
  private readonly workers: VectorWorkerLike[] = [];
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  /** Frozen copies: a caller never holds the stored array, and a hit hands out a fresh copy. */
  private readonly memo = new Map<string, readonly Readonly<VectorRow>[]>();
  /** Bumped by `invalidate()`: an answer to a request of an older generation is delivered but never memoized. */
  private generation = 0;
  private idleTimer: NodeJS.Timeout | null = null;
  /** Per lane: fires when the scan in hand has run {@link DEFAULT_LANE_CAP_MS}. Armed whenever a lane starts a request. */
  private readonly laneTimers = new Map<VectorWorkerLike, NodeJS.Timeout>();
  private retired = 0;
  private disposed = false;

  constructor(
    private readonly dbPath: string,
    private readonly opts: { spawn?: SpawnVectorWorker; idleExitMs?: number; laneCapMs?: number } = {}
  ) {}

  /** Lanes retired by the lane cap since construction. */
  get retiredCount(): number {
    return this.retired;
  }

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
    if (known) return Promise.resolve({ rows: copyRows(known) });
    if (this.pending.size >= MAX_PENDING) return Promise.resolve({ skipped: "queue" });
    const worker = this.pickWorker();
    // Only a request queued behind another one carries a deadline. The lane's first request is always scanned: it may
    // wait out the worker's own start-up (thread boot, DB open, sqlite-vec load — 2.5 s measured on a busy machine), and
    // dropping it then would leave a slow repo's padding never memoized.
    const queued = this.inFlight(worker) > 0;
    const id = this.nextId++;
    return new Promise<VectorSearchOutcome>((resolve) => {
      const entry: Pending = { settle: resolve, timer: null, worker, key, generation: this.generation };
      // The caller stops waiting at the budget. A scan already running finishes and its answer is memoized HERE, in
      // onMessage; a request still queued behind another scan by then is dropped in the worker (`deadline`).
      entry.timer = setTimeout(() => {
        entry.timer = null;
        entry.settle({ skipped: "budget" });
        entry.settle = () => {};
      }, waitMs);
      entry.timer.unref();
      this.pending.set(id, entry);
      worker.postMessage({ kind: "search", id, dbPath: this.dbPath, repoId, text, k, ...(queued ? { deadline: Date.now() + waitMs } : {}) });
      if (!queued) this.armLane(worker);
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
    for (const t of this.laneTimers.values()) clearTimeout(t);
    this.laneTimers.clear();
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
    // The lane finished its request in hand; the next one queued there (if any) starts now.
    this.clearLane(p.worker);
    if (this.inFlight(p.worker) > 0) this.armLane(p.worker);
    if (m.kind === "result" && p.generation === this.generation) this.remember(p.key, m.rows);
    p.settle(m.kind === "result" ? { rows: m.rows } : m.kind === "expired" ? { skipped: "budget" } : { skipped: "worker-error" });
    if (this.pending.size === 0) this.armIdle();
  }

  private remember(key: string, rows: VectorRow[]): void {
    this.memo.delete(key);
    this.memo.set(key, Object.freeze(rows.map((r) => Object.freeze({ ...r }))));
    if (this.memo.size > MEMO_MAX) this.memo.delete(this.memo.keys().next().value as string);
  }

  /** A worker that errored or exited: its own waiters settle `worker-error`; the other lane is untouched. */
  private onGone(w: VectorWorkerLike): void {
    const i = this.workers.indexOf(w);
    if (i < 0) return;
    this.workers.splice(i, 1);
    this.clearLane(w);
    this.failWhere((p) => p.worker === w);
    if (this.workers.length === 0) this.clearIdle();
    else if (this.pending.size === 0) this.armIdle();
  }

  private armLane(w: VectorWorkerLike): void {
    this.clearLane(w);
    const t = setTimeout(() => this.retireLane(w), this.opts.laneCapMs ?? DEFAULT_LANE_CAP_MS);
    t.unref();
    this.laneTimers.set(w, t);
  }

  private clearLane(w: VectorWorkerLike): void {
    const t = this.laneTimers.get(w);
    if (t) clearTimeout(t);
    this.laneTimers.delete(w);
  }

  /**
   * MCP-ISSUE-135: the lane's scan outlived the cap. Drop the lane first (so `onGone` from the coming exit is a no-op
   * and the next search spawns a fresh worker), settle its waiters, then terminate: the thread stops when the
   * statement in hand returns, never running the rest of that scan or the requests queued behind it.
   */
  private retireLane(w: VectorWorkerLike): void {
    this.laneTimers.delete(w);
    const i = this.workers.indexOf(w);
    if (i < 0) return;
    this.workers.splice(i, 1);
    this.retired++;
    this.failWhere((p) => p.worker === w);
    void w.terminate().catch(() => 0);
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
