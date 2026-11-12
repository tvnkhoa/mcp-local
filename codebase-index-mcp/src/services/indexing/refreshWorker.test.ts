import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import type { GraphStore } from "../../repositories/graphStore.js";
import { SHUTDOWN_RETIRE_GRACE_MS, type ExtractionWorkerPool, type ExtractionWorkerPoolDisposeOptions } from "../extractors/extractionWorkerPool.js";
import type { IndexRunResult } from "../../types/index.js";
import type { createIndexRunner, RunExtras } from "./indexRunner.js";
import { attachRefreshWorker, type RefreshWorkerMessage, type RefreshWorkerRequest } from "./refreshWorker.js";
import { SHUTDOWN_WORKER_EXIT_MS } from "./refreshWorkerClient.js";

/**
 * MCP-ISSUE-123 review: the refresh worker's `exit`.
 * #1 — it aborts the run in flight and exits only after that run settled (recorded cancelled, no commit) and the parse
 *      pool's workers left; the run is never left to commit job-timeout batches.
 * #3 — once `exit` arrived, no parse pool is built (a run reaching its pool late would leave one nobody disposes, whose
 *      workers process.exit then kills mid-parse) and no new request starts.
 */

const LIMITS = { subtxSize: 20, checkpointEveryNBatches: 1, largeFileThresholdBytes: 0, maxFileSizeBytes: 500_000, parseWorkers: 1, parseJobTimeoutMs: 20_000 };

class FakePort extends EventEmitter {
  readonly sent: RefreshWorkerMessage[] = [];
  postMessage(message: RefreshWorkerMessage): void {
    this.sent.push(message);
  }
  send(request: Partial<RefreshWorkerRequest> & Pick<RefreshWorkerRequest, "kind" | "id">): void {
    this.emit("message", { dbPath: "/tmp/x.db", limits: LIMITS, repoId: "r", repoPath: "/r", mode: "full", docsEnabled: false, maxFiles: 10, batchSize: 5, ...request });
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 10));

/**
 * A worker whose runner calls `body(extras, sharedParsePool)`; counts the pools built and disposed and the exits.
 */
function harness(body: (extras: RunExtras, sharedParsePool: (() => ExtractionWorkerPool) | undefined) => Promise<IndexRunResult>) {
  const port = new FakePort();
  const counts = { poolsBuilt: 0, poolsDisposed: 0, exits: [] as number[], runs: 0, disposeOptions: [] as (ExtractionWorkerPoolDisposeOptions | undefined)[] };
  const poolDisposed = deferred();
  const createRunner = ((options: Parameters<typeof createIndexRunner>[0]) =>
    (_repoId: string, _repoPath: string, _mode: string, _docs: boolean, _max: number, _batch: number, extras: RunExtras = {}) => {
      counts.runs++;
      return body(extras, options.sharedParsePool);
    }) as unknown as typeof createIndexRunner;
  attachRefreshWorker(port, {
    openStore: () => ({ endIndexSession: () => undefined }) as unknown as GraphStore,
    createRunner,
    createPool: () => {
      counts.poolsBuilt++;
      return {
        dispose: async (options?: ExtractionWorkerPoolDisposeOptions) => {
          counts.poolsDisposed++;
          counts.disposeOptions.push(options);
          await poolDisposed.promise;
        }
      } as unknown as ExtractionWorkerPool;
    },
    exit: (code) => counts.exits.push(code)
  });
  return { port, counts, poolDisposed };
}

test("MCP-ISSUE-123 #1: exit aborts the run in flight and exits only after it settled and the pool's workers left", async () => {
  const runEnds = deferred();
  let signal: AbortSignal | undefined;
  const { port, counts, poolDisposed } = harness(async (extras, sharedParsePool) => {
    sharedParsePool?.();
    signal = extras.abortSignal;
    await runEnds.promise; // the pipeline's next batch boundary
    return { runId: "x", status: extras.abortSignal?.aborted ? "cancelled" : "ok" } as IndexRunResult;
  });
  port.send({ kind: "run", id: 1 });
  await tick();
  assert.equal(counts.poolsBuilt, 1);
  assert.ok(signal, "the run is handed an abort signal");
  assert.equal(signal.aborted, false);

  port.send({ kind: "exit", id: 0 });
  await tick();
  assert.equal(signal.aborted, true, "exit aborts the run in flight");
  assert.equal(counts.poolsDisposed, 1, "and retires the parse pool");
  assert.deepEqual(counts.exits, [], "not before the run settled");

  runEnds.resolve();
  await tick();
  assert.deepEqual(counts.exits, [], "nor before the pool's workers left");
  const result = port.sent.find((m) => m.type === "result");
  assert.equal(result?.type === "result" && result.result.status, "cancelled", "the run recorded itself cancelled");

  poolDisposed.resolve();
  await tick();
  assert.deepEqual(counts.exits, [0], "then the thread exits");
});

test("MCP-ISSUE-123 #3: a run that reaches its pool after exit builds none, and nothing new starts after exit", async () => {
  const reachPool = deferred();
  const { port, counts, poolDisposed } = harness(async (_extras, sharedParsePool) => {
    await reachPool.promise; // git planning etc. before indexRunner asks for the shared pool
    sharedParsePool?.();
    return { runId: "x", status: "ok" } as IndexRunResult;
  });
  poolDisposed.resolve();
  port.send({ kind: "run", id: 1 });
  await tick();
  port.send({ kind: "exit", id: 0 });
  await tick();
  reachPool.resolve();
  await tick();
  assert.equal(counts.poolsBuilt, 0, "no parse pool is built after exit");
  const failed = port.sent.find((m) => m.type === "error" && m.id === 1);
  assert.match(failed?.type === "error" ? failed.error : "", /exiting/, "the late run fails instead");
  assert.deepEqual(counts.exits, [0], "and the thread exits after it");

  port.send({ kind: "run", id: 2 });
  port.send({ kind: "warm", id: 3 });
  await tick();
  assert.equal(counts.runs, 1, "no run starts after exit");
  assert.equal(counts.poolsBuilt, 0, "no warm-up builds a pool after exit");
  const refused = port.sent.find((m) => m.type === "error" && m.id === 2);
  assert.match(refused?.type === "error" ? refused.error : "", /exiting/);
});

test("MCP-ISSUE-123 re-review E: a shutdown exit bounds both waits — the pool's grace and the run that never settles", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const never = deferred(); // the run never reaches a batch boundary; the pool never sees its workers leave
  const { port, counts } = harness(async (_extras, sharedParsePool) => {
    sharedParsePool?.();
    await never.promise;
    return { runId: "x", status: "cancelled" } as IndexRunResult;
  });
  port.send({ kind: "run", id: 1 });
  for (let i = 0; i < 5; i++) await Promise.resolve();
  port.send({ kind: "exit", id: 0, shutdown: true });
  assert.deepEqual(counts.disposeOptions, [{ graceMs: SHUTDOWN_RETIRE_GRACE_MS }], "the pool terminates a stuck parse worker after the shutdown grace");
  t.mock.timers.tick(SHUTDOWN_WORKER_EXIT_MS - 1);
  assert.deepEqual(counts.exits, []);
  t.mock.timers.tick(1);
  assert.deepEqual(counts.exits, [0], "the thread exits at SHUTDOWN_WORKER_EXIT_MS");
  port.send({ kind: "exit", id: 0, shutdown: true });
  t.mock.timers.tick(SHUTDOWN_WORKER_EXIT_MS);
  assert.deepEqual(counts.exits, [0], "once");
});

test("MCP-ISSUE-123 re-review E: a normal exit (abortRun) keeps the pool's full grace and waits for the run", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const never = deferred();
  const { port, counts } = harness(async (_extras, sharedParsePool) => {
    sharedParsePool?.();
    await never.promise;
    return { runId: "x", status: "cancelled" } as IndexRunResult;
  });
  port.send({ kind: "run", id: 1 });
  for (let i = 0; i < 5; i++) await Promise.resolve();
  port.send({ kind: "exit", id: 0 });
  assert.deepEqual(counts.disposeOptions, [{}], "no shortened grace: no terminate during a parse outside shutdown");
  t.mock.timers.tick(60 * 60_000);
  assert.deepEqual(counts.exits, [], "the exit still waits for the run and the pool");
});

test("MCP-ISSUE-123 re-review E (leader review 1): a shutdown exit after an abort's exit upgrades it — bounded, not dropped", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const never = deferred();
  const { port, counts } = harness(async (_extras, sharedParsePool) => {
    sharedParsePool?.();
    await never.promise;
    return { runId: "x", status: "cancelled" } as IndexRunResult;
  });
  port.send({ kind: "run", id: 1 });
  for (let i = 0; i < 5; i++) await Promise.resolve();
  port.send({ kind: "exit", id: 0 }); // abortRun
  t.mock.timers.tick(10_000);
  port.send({ kind: "exit", id: 0, shutdown: true }); // server shutdown 10 s later
  assert.deepEqual(counts.disposeOptions, [{}, { graceMs: SHUTDOWN_RETIRE_GRACE_MS }], "the pool's running graces are shortened");
  t.mock.timers.tick(SHUTDOWN_WORKER_EXIT_MS - 1);
  assert.deepEqual(counts.exits, []);
  t.mock.timers.tick(1);
  assert.deepEqual(counts.exits, [0], "the thread exits SHUTDOWN_WORKER_EXIT_MS after the shutdown request");
});

test("IX-A: an exit's abortReason reaches the run's abort signal; a run's escalatedBecause reaches its extras", async () => {
  const runEnds = deferred();
  let seen: RunExtras | undefined;
  const { port, poolDisposed } = harness(async (extras) => {
    seen = extras;
    await runEnds.promise;
    return { runId: "x", status: "cancelled" } as IndexRunResult;
  });
  port.send({ kind: "run", id: 1, escalatedBecause: "full (refresh run r1 was stopped at the 600000 ms refresh deadline; dirty requested)" });
  await tick();
  assert.match(seen?.escalatedBecause ?? "", /refresh deadline/);
  port.send({ kind: "exit", id: 0, abortReason: "stopped at its deadline: CODEBASE_INDEX_REFRESH_RUN_DEADLINE_MS=600000 ms" });
  await tick();
  assert.equal(seen?.abortSignal?.aborted, true);
  assert.equal(seen?.abortSignal?.reason, "stopped at its deadline: CODEBASE_INDEX_REFRESH_RUN_DEADLINE_MS=600000 ms");
  runEnds.resolve();
  poolDisposed.resolve();
  await tick();
});
