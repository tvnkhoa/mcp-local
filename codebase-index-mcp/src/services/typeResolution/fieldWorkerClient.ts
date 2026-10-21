/**
 * R3 exact, release I1 — the server thread's side of the type-resolution worker.
 *
 * Problem it removes: the cold program build (union TS program ~2 755 files + Vue program ~948 files
 * on wec.aria) is synchronous and took the server's event loop for 10-20 s, so every other tool call
 * waited behind the first field query.
 *
 * Design (one worker per process, spawned lazily on the first field query):
 * - The whole answer is computed in `fieldWorker.ts`; this side posts a request and waits for the
 *   serialisable `FieldAnswer`. The LanguageService LRU, its programs and the Volar plugin live in
 *   the worker's heap — the server thread never loads TypeScript.
 * - **Wait budget per call.** A call waits at most `waitMs` for its answer (the caller passes the R1
 *   query budget, `CODEBASE_INDEX_QUERY_REFRESH_BUDGET_MS`, default 5 s). When the worker has not
 *   answered by then — a cold build still running, or earlier queries ahead of it — the call returns
 *   a withheld answer (`cap_breach`, kind `building`: coverage `gap`, NO list) naming how long the
 *   build has been running. The request stays queued in the worker, so the build continues in the
 *   background and the program is warm for the next call. A late answer is dropped.
 * - **Time cap.** `CODEBASE_INDEX_TS_LS_COLD_START_MS` still bounds the answer inside the worker,
 *   exactly as before (a breach there is coverage `gap`, the program kept warm). A watchdog here
 *   terminates a worker whose current request has run {@link WATCHDOG_GRACE_MS} past that cap — the
 *   program build itself is not cancellable inside TypeScript.
 * - **Memory cap.** The worker runs with `resourceLimits.maxOldGenerationSizeMb =
 *   CODEBASE_INDEX_TS_LS_MAX_RSS_MB` (V8 terminates the worker, never the server, when its heap
 *   reaches it) and measures the same cap against its own heap between phases. Either breach answers
 *   coverage `gap` (kind `memory`) and the worker is discarded; the next field call spawns a fresh one.
 *   Every other tool keeps answering throughout: they never touch the worker.
 * - **Queue bound.** At most {@link MAX_QUEUED} requests are outstanding; beyond that a call is
 *   withheld at once instead of piling more work behind a cold build.
 *
 * Invalidation is unchanged: every request carries the repo's latest index run id, and the worker's
 * LRU refreshes a host whose run id changed.
 */

import { Worker } from "node:worker_threads";

import type { TsLsCaps } from "./caps.js";
import type { FieldAnswer, FieldPick, FieldWithheld } from "./fieldReferences.js";
import type { FieldWorkerMessage, FieldWorkerRequest } from "./fieldWorker.js";
import type { RepoProgramInput } from "./languageServiceHost.js";

export const MAX_QUEUED = 8;
/** Late answers kept for the next identical call (see `late`). */
export const MAX_LATE = 16;
/** How far past the time cap a request may run before its worker is terminated. */
export const WATCHDOG_GRACE_MS = 30_000;

const MB = 1024 * 1024;

/** The part of `Worker` the client uses — a seam for unit tests. */
export interface WorkerLike {
  postMessage(value: FieldWorkerRequest): void;
  on(event: "message", listener: (message: FieldWorkerMessage) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "exit", listener: (code: number) => void): unknown;
  terminate(): Promise<number>;
  unref?(): void;
}

export type SpawnWorker = (caps: TsLsCaps) => WorkerLike;

export type FieldQuery = { program: RepoProgramInput; field: string; pick: FieldPick; caps: TsLsCaps; waitMs: number };

/** One caller waiting on a request; several callers asking the same thing share one request. */
type Waiter = { startedAt: number; settle: ((answer: FieldAnswer) => void) | null; timer: NodeJS.Timeout | null };

type Pending = {
  id: number;
  key: string;
  field: string;
  budgetMs: number;
  waiters: Set<Waiter>;
};

/** The production spawner: `fieldWorker.js` beside this file, heap-capped at the memory cap. */
export const spawnFieldWorker: SpawnWorker = (caps) =>
  new Worker(new URL("./fieldWorker.js", import.meta.url), {
    resourceLimits: { maxOldGenerationSizeMb: Math.max(1, Math.floor(caps.maxRssMb)) }
  }) as unknown as WorkerLike;

export class FieldWorkerClient {
  private worker: WorkerLike | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  /**
   * Answers that arrived after every caller had stopped waiting (the cold build outlived the wait
   * budget), kept for the next identical question and served once. The key includes the index run
   * id, and within one run the LanguageService answers from the same snapshots, so a kept answer is
   * the one a fresh request would compute.
   */
  private readonly late = new Map<string, FieldAnswer>();
  /** The request the worker is executing now (after its `started`), for the "still building" note. */
  private current: { id: number; repoId: string; cold: boolean; startedAt: number } | null = null;
  private watchdog: NodeJS.Timeout | null = null;
  /** Times the worker has been spawned — exposed for tests and the live check. */
  spawned = 0;
  private spawnedAt: number | null = null;

  constructor(private readonly spawn: SpawnWorker = spawnFieldWorker) {}

  ask(query: FieldQuery): Promise<FieldAnswer> {
    const started = performance.now();
    // The same question (repo, index run, field, pick, caps) already in flight: wait on that request
    // instead of queueing another — a caller polling through a cold build must not stack copies of
    // its query behind the build, each to be answered (and dropped) in turn.
    const key = JSON.stringify([query.program.repoId, query.program.repoPath, query.program.runKey, query.field, query.pick, query.caps]);
    const late = this.late.get(key);
    if (late) {
      this.late.delete(key);
      return Promise.resolve({ ...late, meta: { ...late.meta, mainHeapMb: Math.round(process.memoryUsage().heapUsed / MB), roundTripMs: Math.round(performance.now() - started) } } as FieldAnswer);
    }
    let entry = [...this.pending.values()].find((p) => p.key === key);
    if (!entry) {
      if (this.pending.size >= MAX_QUEUED) {
        return Promise.resolve(this.withheld(query.field, { kind: "building", detail: `${this.busyNote()}; ${String(this.pending.size)} other field queries are already queued` }, started));
      }
      const worker = this.ensureWorker(query.caps);
      entry = { id: this.nextId++, key, field: query.field, budgetMs: query.caps.budgetMs, waiters: new Set() };
      this.pending.set(entry.id, entry);
      worker.postMessage({ id: entry.id, program: query.program, field: query.field, pick: query.pick, caps: query.caps });
    }
    const target = entry;
    return new Promise<FieldAnswer>((resolve) => {
      const waiter: Waiter = { startedAt: started, settle: null, timer: null };
      waiter.settle = (answer) => {
        if (waiter.timer) clearTimeout(waiter.timer);
        waiter.timer = null;
        waiter.settle = null;
        target.waiters.delete(waiter);
        resolve(answer);
      };
      waiter.timer = setTimeout(() => {
        waiter.settle?.(this.withheld(query.field, { kind: "building", detail: this.busyNote() }, started));
      }, Math.max(1, query.waitMs));
      target.waiters.add(waiter);
    });
  }

  /** Terminate the worker (server shutdown, tests). Outstanding calls are answered as withheld. */
  async dispose(): Promise<void> {
    const worker = this.worker;
    this.discard({ kind: "worker", detail: "the type-resolution worker was shut down" });
    if (worker) await worker.terminate();
  }

  get outstanding(): number {
    return this.pending.size;
  }

  private ensureWorker(caps: TsLsCaps): WorkerLike {
    if (this.worker) return this.worker;
    const worker = this.spawn(caps);
    this.spawned++;
    this.spawnedAt = performance.now();
    worker.unref?.();
    worker.on("message", (message) => this.onMessage(worker, message));
    worker.on("error", (error) => this.onFailure(worker, error, caps));
    worker.on("exit", (code) => {
      if (this.worker === worker) this.onFailure(worker, new Error(`worker exited with code ${String(code)}`), caps);
    });
    this.worker = worker;
    return worker;
  }

  private onMessage(worker: WorkerLike, message: FieldWorkerMessage): void {
    if (worker !== this.worker) return;
    if (message.type === "started") {
      this.current = { id: message.id, repoId: message.repoId, cold: message.cold, startedAt: performance.now() };
      this.armWatchdog(worker, this.pending.get(message.id)?.budgetMs ?? 60_000);
      return;
    }
    if (this.current?.id === message.id) this.current = null;
    this.clearWatchdog();
    const entry = this.pending.get(message.id);
    this.pending.delete(message.id);
    const waiters = entry ? [...entry.waiters] : [];
    if (message.type === "error") {
      for (const w of waiters) w.settle?.(this.withheld(entry!.field, { kind: "worker", detail: message.error }, w.startedAt));
    } else {
      const answer = message.answer;
      const mainHeapMb = Math.round(process.memoryUsage().heapUsed / MB);
      for (const w of waiters) {
        w.settle?.({ ...answer, meta: { ...answer.meta, mainHeapMb, roundTripMs: Math.round(performance.now() - w.startedAt) } } as FieldAnswer);
      }
      if (waiters.length === 0 && entry && answer.status !== "cap_breach") {
        this.late.set(entry.key, answer);
        while (this.late.size > MAX_LATE) this.late.delete(this.late.keys().next().value as string);
      }
      // A memory breach discards the worker: its heap is what the cap measures, and only a fresh
      // isolate gives that memory back for certain.
      if (answer.status === "cap_breach" && answer.breach.kind === "memory") {
        this.discard({ kind: "memory", detail: `${answer.breach.detail}; the type-resolution worker was discarded and is restarted on the next call` });
        void worker.terminate();
      }
    }
  }

  private onFailure(worker: WorkerLike, error: Error, caps: TsLsCaps): void {
    if (worker !== this.worker) return;
    const oom = (error as { code?: string }).code === "ERR_WORKER_OUT_OF_MEMORY" || /out of memory|heap limit/i.test(error.message);
    this.discard(
      oom
        ? { kind: "memory", detail: `the type-resolution worker reached its heap limit (resourceLimits.maxOldGenerationSizeMb ${String(caps.maxRssMb)} MB, CODEBASE_INDEX_TS_LS_MAX_RSS_MB) and was discarded; it is restarted on the next call` }
        : { kind: "worker", detail: error.message }
    );
    void worker.terminate();
  }

  /** Drop the worker and answer every outstanding call with `reason`. */
  private discard(reason: FieldWithheld): void {
    this.worker = null;
    this.current = null;
    this.clearWatchdog();
    const entries = [...this.pending.values()];
    this.pending.clear();
    for (const entry of entries) for (const w of [...entry.waiters]) w.settle?.(this.withheld(entry.field, reason, w.startedAt));
  }

  /** One watchdog per running request: its time cap plus {@link WATCHDOG_GRACE_MS}. */
  private armWatchdog(worker: WorkerLike, budgetMs: number): void {
    this.clearWatchdog();
    const limit = budgetMs + WATCHDOG_GRACE_MS;
    this.watchdog = setTimeout(() => {
      this.watchdog = null;
      if (worker !== this.worker) return;
      this.discard({ kind: "time", detail: `the type-resolution worker ran past CODEBASE_INDEX_TS_LS_COLD_START_MS + ${String(WATCHDOG_GRACE_MS / 1000)} s on one answer and was terminated; it is restarted on the next call` });
      void worker.terminate();
    }, limit);
    this.watchdog.unref?.();
  }

  private clearWatchdog(): void {
    if (this.watchdog) clearTimeout(this.watchdog);
    this.watchdog = null;
  }

  /** What the worker is doing, for a withheld answer. */
  private busyNote(): string {
    const c = this.current;
    if (!c) {
      const since = this.spawnedAt === null ? "0.0" : seconds(performance.now() - this.spawnedAt);
      return `type program still building: the type-resolution worker is starting (loading TypeScript, ${since} s so far); the build continues in the background`;
    }
    const running = seconds(performance.now() - c.startedAt);
    return c.cold
      ? `type program still building for '${c.repoId}' (${running} s so far); the build continues in the background`
      : `the type-resolution worker is still answering an earlier field query for '${c.repoId}' (${running} s so far)`;
  }

  private withheld(field: string, reason: FieldWithheld, startedAt: number): FieldAnswer {
    const totalMs = Math.round(performance.now() - startedAt);
    return {
      status: "cap_breach",
      field,
      breach: reason,
      meta: {
        engine: "typescript-language-service",
        cold: reason.kind === "building" ? this.current?.cold ?? true : false,
        totalMs,
        roundTripMs: totalMs,
        rssMb: Math.round(process.memoryUsage().rss / MB),
        mainHeapMb: Math.round(process.memoryUsage().heapUsed / MB)
      }
    };
  }
}

function seconds(ms: number): string {
  return (ms / 1000).toFixed(1);
}

let shared: FieldWorkerClient | null = null;

/** The process's one type-resolution worker client, created on first use. */
export function getFieldWorkerClient(): FieldWorkerClient {
  shared ??= new FieldWorkerClient();
  return shared;
}
