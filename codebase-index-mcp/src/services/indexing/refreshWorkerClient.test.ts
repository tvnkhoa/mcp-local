import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import type { IndexRunResult } from "../../types/index.js";
import type { RefreshWorkerMessage, RefreshWorkerRequest } from "./refreshWorker.js";
import { RefreshWorkerClient, type RefreshWorkerLike } from "./refreshWorkerClient.js";

/**
 * Release I1b — the R1 refresh runs in a worker thread. These pin the server-thread side over a fake
 * worker: a result resolves the run and fires the cache hook, a run error rejects only that run, a
 * crash rejects every outstanding run (the gate turns that into "the refresh run failed" and releases
 * its lock) and the next run spawns a fresh worker.
 */

class FakeWorker extends EventEmitter implements RefreshWorkerLike {
  readonly requests: RefreshWorkerRequest[] = [];
  terminated = false;
  postMessage(value: RefreshWorkerRequest): void {
    this.requests.push(value);
  }
  async terminate(): Promise<number> {
    this.terminated = true;
    return 0;
  }
  send(message: RefreshWorkerMessage): void {
    this.emit("message", message);
  }
}

const LIMITS = { subtxSize: 20, checkpointEveryNBatches: 1, largeFileThresholdBytes: 0, maxFileSizeBytes: 500_000, parseWorkers: 1, parseJobTimeoutMs: 20_000 };

function harness(): { client: RefreshWorkerClient; workers: FakeWorker[]; landed: string[] } {
  const workers: FakeWorker[] = [];
  const landed: string[] = [];
  const client = new RefreshWorkerClient({
    dbPath: "/tmp/index.db",
    limits: LIMITS,
    spawn: () => {
      const w = new FakeWorker();
      workers.push(w);
      return w;
    },
    onRunLanded: (repoId, result) => landed.push(`${repoId}:${result.runId}`)
  });
  return { client, workers, landed };
}

const result = (runId: string): IndexRunResult => ({ runId }) as IndexRunResult;

test("a run is posted to one lazily spawned worker with the db path and limits; its result resolves it and fires onRunLanded", async () => {
  const { client, workers, landed } = harness();
  assert.equal(workers.length, 0, "no worker before the first refresh");
  const p = client.run("repo-a", "/repo/a", "dirty", true, 20_000, 200);
  assert.equal(workers.length, 1);
  const req = workers[0].requests[0];
  assert.deepEqual(
    { dbPath: req.dbPath, limits: req.limits, repoId: req.repoId, repoPath: req.repoPath, mode: req.mode, docsEnabled: req.docsEnabled, maxFiles: req.maxFiles, batchSize: req.batchSize },
    { dbPath: "/tmp/index.db", limits: LIMITS, repoId: "repo-a", repoPath: "/repo/a", mode: "dirty", docsEnabled: true, maxFiles: 20_000, batchSize: 200 }
  );
  workers[0].send({ type: "result", id: req.id, result: result("run-1") });
  assert.equal((await p).runId, "run-1");
  assert.deepEqual(landed, ["repo-a:run-1"]);
  assert.equal(client.outstanding, 0);

  // The worker is reused for the next run.
  const p2 = client.run("repo-b", "/repo/b", "incremental", true, 20_000, 200);
  assert.equal(workers.length, 1);
  workers[0].send({ type: "result", id: workers[0].requests[1].id, result: result("run-2") });
  assert.equal((await p2).runId, "run-2");
});

test("a run error (e.g. the newer-build refusal) rejects that run only and keeps the worker", async () => {
  const { client, workers, landed } = harness();
  const refused = client.run("repo-a", "/repo/a", "dirty", true, 20_000, 200);
  const other = client.run("repo-b", "/repo/b", "dirty", true, 20_000, 200);
  const [r1, r2] = workers[0].requests;
  workers[0].send({ type: "error", id: r1.id, error: "index_repository refused: this repo's index was written by a newer codebase-index build" });
  await assert.rejects(refused, /refused: .*newer codebase-index build/);
  workers[0].send({ type: "result", id: r2.id, result: result("run-b") });
  assert.equal((await other).runId, "run-b");
  assert.deepEqual(landed, ["repo-b:run-b"], "a refused run lands nothing");
  assert.equal(workers.length, 1);
});

test("a crash rejects every outstanding run, and the next run spawns a fresh worker", async () => {
  const { client, workers } = harness();
  const a = client.run("repo-a", "/repo/a", "dirty", true, 20_000, 200);
  const b = client.run("repo-b", "/repo/b", "incremental", true, 20_000, 200);
  workers[0].emit("error", new Error("boom"));
  await assert.rejects(a, /refresh worker crashed: boom/);
  await assert.rejects(b, /refresh worker crashed: boom/);
  assert.equal(workers[0].terminated, true);
  assert.equal(client.outstanding, 0);

  const c = client.run("repo-a", "/repo/a", "dirty", true, 20_000, 200);
  assert.equal(workers.length, 2, "respawned");
  // A late message from the dead worker is ignored.
  workers[0].send({ type: "result", id: workers[0].requests[0].id, result: result("ghost") });
  workers[1].send({ type: "result", id: workers[1].requests[0].id, result: result("run-c") });
  assert.equal((await c).runId, "run-c");
});

test("an unexpected exit rejects outstanding runs; dispose terminates and rejects", async () => {
  const { client, workers } = harness();
  const a = client.run("repo-a", "/repo/a", "dirty", true, 20_000, 200);
  workers[0].emit("exit", 1);
  await assert.rejects(a, /exited with code 1/);

  const b = client.run("repo-a", "/repo/a", "dirty", true, 20_000, 200);
  await client.dispose();
  await assert.rejects(b, /shut down/);
  assert.equal(workers[1].terminated, true);
});

test("warm spawns the worker ahead of the first refresh, which then reuses it", async () => {
  const { client, workers } = harness();
  client.warm();
  assert.equal(workers.length, 1);
  assert.equal(workers[0].requests[0].kind, "warm");
  assert.equal(client.outstanding, 0, "a warm-up is not a run");
  const p = client.run("repo-a", "/repo/a", "dirty", true, 20_000, 200);
  assert.equal(workers.length, 1, "no second spawn");
  const req = workers[0].requests[1];
  assert.equal(req.kind, "run");
  workers[0].send({ type: "result", id: req.id, result: result("run-w") });
  assert.equal((await p).runId, "run-w");
});

test("a spawn failure rejects the run instead of throwing at the caller", async () => {
  const client = new RefreshWorkerClient({
    dbPath: "/tmp/index.db",
    limits: LIMITS,
    spawn: () => {
      throw new Error("cannot spawn");
    }
  });
  await assert.rejects(client.run("repo-a", "/repo/a", "dirty", true, 20_000, 200), /cannot spawn/);
});
