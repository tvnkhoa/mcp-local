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
  | { id: string; status: "ok"; output: ExtractOutput }
  | { id: string; status: "timeout"; reason: "parse-timeout"; error: string }
  | { id: string; status: "error"; error: string };

export type WorkerExtractResult =
  | { status: "ok"; output: ExtractOutput }
  | { status: "timeout"; reason: "parse-timeout" | "job-timeout"; error?: string }
  | { status: "error"; error: string };

export class ExtractionWorkerPool {
  private readonly workers: WorkerState[] = [];
  private readonly taskQueue: PoolTask[] = [];
  private readonly pendingTasks = new Map<string, PoolTask>();

  constructor(
    private readonly size: number,
    private readonly timeoutMs: number
  ) {
    for (let i = 0; i < size; i += 1) {
      this.workers.push(this.createWorker());
    }
  }

  extract(input: ExtractInput): Promise<WorkerExtractResult> {
    return new Promise<WorkerExtractResult>((resolve) => {
      const task: PoolTask = {
        id: randomUUID(),
        input,
        resolve
      };
      this.taskQueue.push(task);
      this.schedule();
    });
  }

  async dispose(): Promise<void> {
    const queued = this.taskQueue.splice(0);
    for (const task of queued) {
      task.resolve({ status: "timeout", reason: "job-timeout" });
    }

    const pending = [...this.pendingTasks.values()];
    this.pendingTasks.clear();
    for (const task of pending) {
      task.resolve({ status: "timeout", reason: "job-timeout" });
    }

    await Promise.all(this.workers.map(async (state) => {
      if (state.timeoutHandle) {
        clearTimeout(state.timeoutHandle);
        state.timeoutHandle = undefined;
      }
      await state.worker.terminate();
    }));
  }

  private createWorker(): WorkerState {
    const worker = new Worker(new URL("./extractionWorker.js", import.meta.url));
    const state: WorkerState = { worker, busy: false };

    worker.on("message", (message: WorkerExtractMessage) => {
      this.onWorkerMessage(state, message);
    });

    worker.on("error", (error) => {
      this.onWorkerFailure(state, error instanceof Error ? error.message : String(error));
    });

    worker.on("exit", (code) => {
      if (code !== 0) {
        this.onWorkerFailure(state, `worker exited with code ${String(code)}`);
      }
    });

    return state;
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
      task.resolve({ status: "ok", output: message.output });
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
        void state.worker.terminate();
        state.worker = new Worker(new URL("./extractionWorker.js", import.meta.url));
        state.worker.on("message", (message: WorkerExtractMessage) => this.onWorkerMessage(state, message));
        state.worker.on("error", (error) => this.onWorkerFailure(state, error instanceof Error ? error.message : String(error)));
        state.worker.on("exit", (code) => {
          if (code !== 0) {
            this.onWorkerFailure(state, `worker exited with code ${String(code)}`);
          }
        });
        this.schedule();
      }, this.timeoutMs);

      state.worker.postMessage({ id: task.id, input: task.input });
    }
  }
}
