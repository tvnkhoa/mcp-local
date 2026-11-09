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

export type ExtractionWorkerPoolOptions = {
  /** The worker script (a test's fixture). Default: `extractionWorker.js` beside this module. */
  workerUrl?: URL;
  retireGraceMs?: number;
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
  private disposed = false;

  constructor(
    private readonly size: number,
    private readonly timeoutMs: number,
    options: ExtractionWorkerPoolOptions = {}
  ) {
    this.workerUrl = options.workerUrl ?? defaultWorkerUrl();
    this.retireGraceMs = options.retireGraceMs ?? DEFAULT_RETIRE_GRACE_MS;
    for (let i = 0; i < size; i += 1) {
      const state = { busy: false } as WorkerState;
      this.spawnInto(state);
      this.workers.push(state);
    }
  }

  /** Retired workers that have not exited yet — exposed for tests. */
  get retiringCount(): number {
    return this.retiring.size;
  }

  extract(input: ExtractInput): Promise<WorkerExtractResult> {
    return new Promise<WorkerExtractResult>((resolve) => {
      if (this.disposed) {
        resolve({ status: "timeout", reason: "job-timeout" });
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
   */
  async dispose(): Promise<void> {
    this.disposed = true;
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
      this.retire(state.worker);
    }
    await Promise.all([...this.retiring]);
  }

  private spawnInto(state: WorkerState): void {
    const worker = new Worker(this.workerUrl);
    state.worker = worker;
    worker.once("exit", () => this.exited.add(worker));
    worker.on("message", (message: WorkerExtractMessage) => {
      if (state.worker === worker) this.onWorkerMessage(state, message);
    });
    worker.on("error", (error) => {
      if (state.worker === worker) this.onWorkerFailure(state, error instanceof Error ? error.message : String(error));
    });
    worker.on("exit", (code) => {
      if (state.worker === worker && code !== 0) {
        this.onWorkerFailure(state, `worker exited with code ${String(code)}`);
      }
    });
  }

  /**
   * MCP-ISSUE-123: detach `worker` from the pool and ask it to exit after the job it is running. Its late answer is
   * ignored (the `state.worker === worker` guards above). Terminated only if still alive after `retireGraceMs`.
   */
  private retire(worker: Worker): void {
    if (this.exited.has(worker)) return;
    let exited = false;
    let release!: () => void;
    const gone = new Promise<void>((resolve) => {
      release = resolve;
    });
    let grace: NodeJS.Timeout | undefined;
    const done = (): void => {
      if (exited) return;
      exited = true;
      if (grace) clearTimeout(grace);
      this.retiring.delete(gone);
      release();
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
    grace = setTimeout(() => {
      void worker.terminate().finally(done);
    }, this.retireGraceMs);
    grace.unref();
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

  private clearWorkerState(state: WorkerState): void {
    state.busy = false;
    state.currentTaskId = undefined;
    if (state.timeoutHandle) {
      clearTimeout(state.timeoutHandle);
      state.timeoutHandle = undefined;
    }
  }

  private schedule(): void {
    if (this.disposed) return;
    for (const state of this.workers) {
      if (state.busy) {
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
        this.clearWorkerState(state);
        timedOutTask.resolve({ status: "timeout", reason: "job-timeout" });
        // MCP-ISSUE-123: retire, never terminate — the job may be inside a native parse.
        this.retire(state.worker);
        this.spawnInto(state);
        this.schedule();
      }, this.timeoutMs);

      state.worker.postMessage({ id: task.id, input: task.input });
    }
  }
}
