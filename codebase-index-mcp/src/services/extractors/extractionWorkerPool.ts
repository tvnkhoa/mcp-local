import { randomUUID } from "node:crypto";
import { Worker } from "node:worker_threads";

import type { ExtractInput, ExtractOutput } from "./treeSitterExtractor.js";

type PoolTask = {
  id: string;
  input: ExtractInput;
  resolve: (value: WorkerExtractResult) => void;
};

type WorkerState = {
  worker: Worker;
  busy: boolean;
  currentTaskId?: string;
  timeoutHandle?: NodeJS.Timeout;
  /** Re-review D: a timed-out job held its worker at the retire cap; the slot frees on its late answer or on the next retired exit. */
  held?: boolean;
  /** Review #5: the worker failed ('error') and is about to exit; no job is sent to it. Cleared by the respawn. */
  failed?: boolean;
  /** Review #5: the slot's worker kept exiting on its own; it is not respawned again and takes no job. */
  dead?: boolean;
  /** Review #5: when this slot's worker was respawned after exiting on its own (pruned to `RESPAWN_WINDOW_MS`). */
  respawnTimes: number[];
};

type WorkerExtractMessage =
  | { id: string; status: "ok"; output: ExtractOutput; parseMs: number }
  | { id: string; status: "timeout"; reason: "parse-timeout"; error: string }
  | { id: string; status: "error"; error: string };

export type WorkerExtractResult =
  | { status: "ok"; output: ExtractOutput; parseMs: number }
  | { status: "timeout"; reason: "parse-timeout" | "job-timeout"; error?: string }
  | { status: "error"; error: string };

/** The message that asks a worker to exit once the job it is running returns (see `extractionWorker.ts`). */
export const CLOSE_WORKER_MESSAGE = { type: "close" } as const;

/**
 * MCP-ISSUE-123: how long a retired worker may take to finish its job and exit before it is terminated anyway. A parse
 * is bounded by tree-sitter's own timeout (`CODEBASE_INDEX_PARSE_TIMEOUT_MS`, 5 s), so only a worker that is starved
 * of CPU for minutes — or hung in JavaScript, where terminate is safe — reaches this.
 */
export const DEFAULT_RETIRE_GRACE_MS = 5 * 60_000;

/**
 * MCP-ISSUE-123 review #5: a slot whose worker exits on its own is respawned, at most `MAX_RESPAWNS_PER_WINDOW` times in
 * any `RESPAWN_WINDOW_MS`. One more exit inside the window (a worker that dies at start, every time) marks the slot dead
 * instead of spawning a thread per job: the pool runs on its other slots, and with every slot dead it answers each job
 * `error` at once ("parse pool degraded") rather than leaving the run waiting. Each dead slot is reported once
 * (`onSlotDead`, default one JSON line on stderr).
 */
export const MAX_RESPAWNS_PER_WINDOW = 3;
export const RESPAWN_WINDOW_MS = 60_000;

/**
 * MCP-ISSUE-123 re-review E: the retire grace at server shutdown (`dispose({ graceMs })`, from the refresh worker's
 * `exit` request with `shutdown`). Four times tree-sitter's own parse timeout (5 s): a worker still in its job after it
 * is starved or hung, and the process is ending anyway, so the shutdown stays bounded. Every other dispose and retire
 * keeps `DEFAULT_RETIRE_GRACE_MS` — no terminate during a parse outside shutdown.
 */
export const SHUTDOWN_RETIRE_GRACE_MS = 20_000;

export type SlotDeadEvent = { slot: number; respawns: number; windowMs: number; reason: string; deadSlots: number; size: number };

export type ExtractionWorkerPoolOptions = {
  /** The worker script (a test's fixture). Default: `extractionWorker.js` beside this module. */
  workerUrl?: URL;
  retireGraceMs?: number;
  /** Review #5: where a dead slot is reported. Default: one JSON line on stderr. */
  onSlotDead?: (event: SlotDeadEvent) => void;
};

export type ExtractionWorkerPoolDisposeOptions = {
  /** Re-review E: terminate a retired worker still alive this long after its retirement (server shutdown only). */
  graceMs?: number;
};

const defaultWorkerUrl = (): URL => new URL("./extractionWorker.js", import.meta.url);

/**
 * Parse workers for an index run.
 *
 * MCP-ISSUE-123: a worker is never `terminate()`d while it may be inside a tree-sitter parse. tree-sitter 0.21's
 * native parse does not survive the worker being torn down under it: the WHOLE process exits 0xC0000409 (fast-fail,
 * nothing on stderr, no WER report) — the live server's crash of 9 Nov 10:32 during a full run under CPU starvation,
 * reproduced solo (terminate mid-parse: crash 5/5; terminate an idle or plain-JS worker: 0/240). A job that outlives
 * the timeout is answered `job-timeout` at once and its worker RETIRED: it gets no more jobs, is asked to exit, and
 * exits by itself when the job returns; a fresh worker takes its slot. Only a worker still alive after
 * `retireGraceMs` is terminated.
 */
export class ExtractionWorkerPool {
  private readonly workers: WorkerState[] = [];
  private readonly taskQueue: PoolTask[] = [];
  private readonly pendingTasks = new Map<string, PoolTask>();
  /** Retired workers not yet exited, each with the promise of its exit. */
  private readonly retiring = new Set<Promise<void>>();
  /** Workers whose 'exit' already fired: retiring one must not wait for an event that will never come. */
  private readonly exited = new WeakSet<Worker>();
  private readonly workerUrl: URL;
  private readonly retireGraceMs: number;
  private readonly onSlotDead: (event: SlotDeadEvent) => void;
  /** Running retire grace timers by worker, so a shutdown dispose can shorten the ones already started. */
  private readonly graceTimers = new Map<Worker, { started: number; timer: NodeJS.Timeout; fire: () => void }>();
  private disposed = false;

  constructor(
    private readonly size: number,
    private readonly timeoutMs: number,
    options: ExtractionWorkerPoolOptions = {}
  ) {
    this.workerUrl = options.workerUrl ?? defaultWorkerUrl();
    this.retireGraceMs = options.retireGraceMs ?? DEFAULT_RETIRE_GRACE_MS;
    this.onSlotDead =
      options.onSlotDead ??
      ((event) => {
        process.stderr.write(`${JSON.stringify({ event: "parse_pool_slot_dead", ...event })}\n`);
      });
    for (let i = 0; i < size; i += 1) {
      const state = { busy: false, respawnTimes: [] } as unknown as WorkerState;
      this.spawnInto(state);
      this.workers.push(state);
    }
  }

  /** Retired workers that have not exited yet — exposed for tests. */
  get retiringCount(): number {
    return this.retiring.size;
  }

  /** Review #5: slots whose worker kept exiting on its own and is no longer respawned. */
  get deadSlots(): number {
    return this.workers.filter((state) => state.dead).length;
  }

  /** Review #5: every slot is dead — each job is answered `error` at once. */
  get degraded(): boolean {
    return this.workers.length > 0 && this.workers.every((state) => state.dead);
  }

  extract(input: ExtractInput): Promise<WorkerExtractResult> {
    return new Promise<WorkerExtractResult>((resolve) => {
      if (this.disposed) {
        resolve({ status: "timeout", reason: "job-timeout" });
        return;
      }
      if (this.degraded) {
        resolve({ status: "error", error: this.degradedMessage() });
        return;
      }
      const task: PoolTask = {
        id: randomUUID(),
        input,
        resolve
      };
      this.taskQueue.push(task);
      this.schedule();
    });
  }

  /**
   * Answer every queued and running job `job-timeout`, then retire every worker: an idle one exits at once, a busy one
   * when its job returns (MCP-ISSUE-123: never terminated mid-parse). Resolves when all of them, and every worker
   * retired earlier, have exited.
   *
   * Re-review E: `graceMs` (server shutdown: `SHUTDOWN_RETIRE_GRACE_MS`) bounds that wait — a retired worker, one
   * retired earlier included, is terminated once it has been retiring that long. Without it, `retireGraceMs`.
   */
  async dispose(options: ExtractionWorkerPoolDisposeOptions = {}): Promise<void> {
    this.disposed = true;
    if (options.graceMs !== undefined) this.shortenGrace(options.graceMs);
    const queued = this.taskQueue.splice(0);
    for (const task of queued) {
      task.resolve({ status: "timeout", reason: "job-timeout" });
    }

    const pending = [...this.pendingTasks.values()];
    this.pendingTasks.clear();
    for (const task of pending) {
      task.resolve({ status: "timeout", reason: "job-timeout" });
    }

    for (const state of this.workers) {
      this.clearWorkerState(state);
      this.retire(state.worker, options.graceMs);
    }
    await Promise.all([...this.retiring]);
  }

  /** Re-review E: bring every running retire grace down to `graceMs` from its start (fires now if already past). */
  private shortenGrace(graceMs: number): void {
    const now = Date.now();
    for (const entry of this.graceTimers.values()) {
      clearTimeout(entry.timer);
      entry.timer = setTimeout(entry.fire, Math.max(0, entry.started + graceMs - now));
      entry.timer.unref();
    }
  }

  private spawnInto(state: WorkerState): void {
    const worker = new Worker(this.workerUrl);
    state.worker = worker;
    worker.once("exit", () => this.exited.add(worker));
    worker.on("message", (message: WorkerExtractMessage) => {
      if (state.worker === worker) this.onWorkerMessage(state, message);
    });
    worker.on("error", (error) => {
      if (state.worker !== worker) return;
      // Review #5: 'exit' follows; until then the slot takes no job (it would go to a dying worker).
      state.failed = true;
      this.onWorkerFailure(state, error instanceof Error ? error.message : String(error));
    });
    worker.on("exit", (code) => {
      // Review #5: a slot's own worker never exits unasked (retire detaches it first), so any exit here — code 0 too —
      // leaves the slot without a worker: answer its job, then respawn it (bounded) or mark it dead.
      if (state.worker !== worker) return;
      const reason = `worker exited with code ${String(code)}`;
      this.onWorkerFailure(state, reason);
      this.respawnOrBury(state, reason);
    });
  }

  /** Review #5: give the slot a fresh worker, unless it had `MAX_RESPAWNS_PER_WINDOW` already in the window. */
  private respawnOrBury(state: WorkerState, reason: string): void {
    state.failed = false;
    if (this.disposed) return;
    const now = Date.now();
    state.respawnTimes = state.respawnTimes.filter((t) => now - t < RESPAWN_WINDOW_MS);
    if (state.respawnTimes.length < MAX_RESPAWNS_PER_WINDOW) {
      state.respawnTimes.push(now);
      this.spawnInto(state);
      this.schedule();
      return;
    }
    state.dead = true;
    this.clearWorkerState(state);
    try {
      this.onSlotDead({
        slot: this.workers.indexOf(state),
        respawns: state.respawnTimes.length,
        windowMs: RESPAWN_WINDOW_MS,
        reason,
        deadSlots: this.deadSlots,
        size: this.size
      });
    } catch {
      // Reporting never breaks the pool.
    }
    if (this.degraded) {
      for (const task of this.taskQueue.splice(0)) task.resolve({ status: "error", error: this.degradedMessage() });
    }
  }

  private degradedMessage(): string {
    return `parse pool degraded: every parse worker kept exiting on its own (more than ${String(MAX_RESPAWNS_PER_WINDOW)} respawns in ${String(RESPAWN_WINDOW_MS / 1000)} s per slot)`;
  }

  /**
   * MCP-ISSUE-123: detach `worker` from the pool and ask it to exit after the job it is running. Its late answer is
   * ignored (the `state.worker === worker` guards above). Terminated only if still alive after `retireGraceMs`.
   */
  private retire(worker: Worker, graceMs: number = this.retireGraceMs): void {
    // Already gone, or already retiring (a second dispose): its grace timer is running (and was shortened, if asked).
    if (this.exited.has(worker) || this.graceTimers.has(worker)) return;
    let exited = false;
    let release!: () => void;
    const gone = new Promise<void>((resolve) => {
      release = resolve;
    });
    const done = (): void => {
      if (exited) return;
      exited = true;
      const entry = this.graceTimers.get(worker);
      if (entry) clearTimeout(entry.timer);
      this.graceTimers.delete(worker);
      this.retiring.delete(gone);
      release();
      // Re-review D: a retired worker left, so the cap has room — retire the slots held at the cap and serve the queue.
      this.releaseHeld();
    };
    worker.once("exit", done);
    // A late 'error' from a retired worker must not become an unhandled 'error' event.
    worker.on("error", () => undefined);
    this.retiring.add(gone);
    try {
      worker.postMessage(CLOSE_WORKER_MESSAGE);
    } catch {
      // Port already closed: the worker is exiting or gone; 'exit' (or the grace timer) settles it.
    }
    const fire = (): void => {
      void worker.terminate().finally(done);
    };
    const timer = setTimeout(fire, graceMs);
    timer.unref();
    this.graceTimers.set(worker, { started: Date.now(), timer, fire });
  }

  private onWorkerMessage(state: WorkerState, message: WorkerExtractMessage): void {
    if (!state.currentTaskId || state.currentTaskId !== message.id) {
      return;
    }

    const task = this.pendingTasks.get(message.id);
    this.clearWorkerState(state);

    if (!task) {
      this.schedule();
      return;
    }

    this.pendingTasks.delete(task.id);
    if (message.status === "ok") {
      task.resolve({ status: "ok", output: message.output, parseMs: message.parseMs });
    } else if (message.status === "timeout") {
      task.resolve({ status: "timeout", reason: message.reason, error: message.error });
    } else {
      task.resolve({ status: "error", error: message.error });
    }

    this.schedule();
  }

  private onWorkerFailure(state: WorkerState, reason: string): void {
    if (!state.currentTaskId) {
      return;
    }

    const task = this.pendingTasks.get(state.currentTaskId);
    this.clearWorkerState(state);

    if (task) {
      this.pendingTasks.delete(task.id);
      task.resolve({ status: "error", error: reason });
    }

    this.schedule();
  }

  /**
   * MCP-ISSUE-123 re-review D: a slot held at the retire cap keeps a worker whose job may never answer. When the cap
   * has room again, retire that worker like any timed-out one and give the slot a fresh worker; then schedule.
   */
  private releaseHeld(): void {
    if (this.disposed) return;
    for (const state of this.workers) {
      if (!state.held || state.dead || this.retiring.size >= this.size) continue;
      this.clearWorkerState(state);
      this.retire(state.worker);
      this.spawnInto(state);
    }
    this.schedule();
  }

  private clearWorkerState(state: WorkerState): void {
    state.busy = false;
    state.held = false;
    state.currentTaskId = undefined;
    if (state.timeoutHandle) {
      clearTimeout(state.timeoutHandle);
      state.timeoutHandle = undefined;
    }
  }

  private schedule(): void {
    if (this.disposed) return;
    for (const state of this.workers) {
      if (state.busy || state.failed || state.dead) {
        continue;
      }

      const task = this.taskQueue.shift();
      if (!task) {
        break;
      }

      state.busy = true;
      state.currentTaskId = task.id;
      this.pendingTasks.set(task.id, task);
      state.timeoutHandle = setTimeout(() => {
        const timedOutTask = this.pendingTasks.get(task.id);
        if (!timedOutTask) {
          return;
        }

        this.pendingTasks.delete(task.id);
        timedOutTask.resolve({ status: "timeout", reason: "job-timeout" });
        if (this.retiring.size < this.size) {
          // MCP-ISSUE-123: retire, never terminate — the job may be inside a native parse.
          this.clearWorkerState(state);
          this.retire(state.worker);
          this.spawnInto(state);
        } else {
          // MCP-ISSUE-123 review #4: at most `size` retired workers at once, or repeated timeouts under starvation add a
          // thread each (each living up to the retire grace). At the cap the slot keeps its worker and stays busy; the
          // job's late answer finds no task and frees the slot (`onWorkerMessage`), so the queue waits instead.
          if (state.timeoutHandle) {
            clearTimeout(state.timeoutHandle);
            state.timeoutHandle = undefined;
          }
          state.held = true;
        }
        this.schedule();
      }, this.timeoutMs);

      state.worker.postMessage({ id: task.id, input: task.input });
    }
  }
}
