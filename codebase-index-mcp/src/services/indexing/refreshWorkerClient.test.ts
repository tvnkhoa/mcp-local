import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import type { IndexRunResult } from "../../types/index.js";
import type { RefreshWorkerMessage, RefreshWorkerRequest } from "./refreshWorker.js";
import { DEFAULT_RETIRE_GRACE_MS, SHUTDOWN_RETIRE_GRACE_MS } from "../extractors/extractionWorkerPool.js";
import {
  DEFAULT_ABORT_GRACE_MS,
  DEFAULT_DISPOSE_GRACE_MS,
  RefreshWorkerClient,
  SHUTDOWN_WORKER_EXIT_MS,
  type RefreshWorkerLike
} from "./refreshWorkerClient.js";

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

/**
 * The client's terminate fallback timer is unref'd (leader review 1), and a fake worker is no handle: without this the
 * loop would empty while a test awaits that fallback. Real setInterval — mock timers here only fake setTimeout.
 */
const keepAlive = setInterval(() => undefined, 1000);
test.after(() => clearInterval(keepAlive));

/** MCP-ISSUE-123: these fakes ignore the `exit` request, so the client terminates them after this grace. */
const GRACE = { abortGraceMs: 20, disposeGraceMs: 20 };

const LIMITS = { subtxSize: 20, checkpointEveryNBatches: 1, largeFileThresholdBytes: 0, maxFileSizeBytes: 500_000, parseWorkers: 1, parseJobTimeoutMs: 20_000 };

function harness(): { client: RefreshWorkerClient; workers: FakeWorker[]; landed: string[] } {
  const workers: FakeWorker[] = [];
  const landed: string[] = [];
  const client = new RefreshWorkerClient({
    dbPath: "/tmp/index.db",
    limits: LIMITS,
    ...GRACE,
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
  const rejected = assert.rejects(b, /shut down/); // dispose now waits for the worker to stop (MCP-ISSUE-123)
  await client.dispose();
  await rejected;
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

test("review follow-up C: abortRun stops only the named run; a run not in the worker is left alone", async () => {
  const { client, workers } = harness();
  assert.equal(await client.abortRun("nobody", "x"), false, "nothing in flight: no-op");
  const job = client.run("repo-a", "/repo/a", "full", true, 100, 50, { runId: "job-1" });
  assert.equal(await client.abortRun("job-2", "x"), false, "another runId: the worker is not touched");
  assert.equal(workers[0].terminated, false);
  const aborted = client.abortRun("job-1", "stopped: timeout");
  await assert.rejects(job, /stopped: timeout/);
  assert.equal(await aborted, true);
  assert.equal(workers[0].terminated, true);
  // The next run spawns a fresh worker and works.
  const next = client.run("repo-b", "/repo/b", "dirty", true, 100, 50);
  assert.equal(workers.length, 2);
  workers[1].send({ type: "result", id: workers[1].requests[0].id, result: result("r-b") });
  assert.equal((await next).runId, "r-b");
});

test("review F2: abortRun rejects the run only after the old worker has terminated", async () => {
  let finishTerminate!: () => void;
  class SlowWorker extends FakeWorker {
    override async terminate(): Promise<number> {
      await new Promise<void>((r) => (finishTerminate = r));
      this.terminated = true;
      return 0;
    }
  }
  const workers: FakeWorker[] = [];
  const client = new RefreshWorkerClient({
    dbPath: "/tmp/index.db",
    limits: LIMITS,
    ...GRACE,
    spawn: () => {
      const w = new SlowWorker();
      workers.push(w);
      return w;
    }
  });
  const run = client.run("repo-a", "/repo/a", "full", true, 100, 50, { runId: "job-1" });
  let rejectedAt: "before" | "after" | null = null;
  const watched = run.catch(() => {
    rejectedAt = workers[0].terminated ? "after" : "before";
  });
  const aborted = client.abortRun("job-1", "timeout");
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(rejectedAt, null, "the run is not released while the old worker may still write");
  finishTerminate();
  assert.equal(await aborted, true);
  await watched;
  assert.equal(rejectedAt, "after");
});

test("review 3-rest: purge is posted to the worker and answered by its purged message; caches are dropped", async () => {
  const purged: string[] = [];
  const workers: FakeWorker[] = [];
  const client = new RefreshWorkerClient({
    dbPath: "/tmp/index.db",
    limits: LIMITS,
    spawn: () => {
      const w = new FakeWorker();
      workers.push(w);
      return w;
    },
    onPurged: (repoId) => purged.push(repoId)
  });
  const p = client.purge("repo-x");
  const req = workers[0].requests[0];
  assert.equal(req.kind, "purge");
  assert.equal(req.repoId, "repo-x");
  workers[0].send({ type: "purged", id: req.id, counts: { symbols: 3 } });
  assert.deepEqual(await p, { symbols: 3 });
  assert.deepEqual(purged, ["repo-x"]);
  const failing = client.purge("repo-y");
  workers[0].send({ type: "error", id: workers[0].requests[1].id, error: "SQLITE_BUSY" });
  await assert.rejects(failing, /SQLITE_BUSY/);
});

test("IX-9: seed and clear are posted to the worker (the single writer) and answered by its messages", async () => {
  const dropped: string[] = [];
  const workers: FakeWorker[] = [];
  const client = new RefreshWorkerClient({
    dbPath: "/tmp/index.db",
    limits: LIMITS,
    spawn: () => {
      const w = new FakeWorker();
      workers.push(w);
      return w;
    },
    onPurged: (repoId) => dropped.push(repoId)
  });
  const seeded = client.seed({ parentRepoId: "parent", childRepoId: "child", childRepoPath: "/r/child" }, "run-1");
  const req = workers[0].requests[0];
  assert.deepEqual({ kind: req.kind, repoId: req.repoId, repoPath: req.repoPath, seedFrom: req.seedFrom }, { kind: "seed", repoId: "child", repoPath: "/r/child", seedFrom: "parent" });
  const answer = { parentIndexedSha: "p".repeat(40), tablesCopied: { symbols: 3 }, durationMs: 5 };
  workers[0].send({ type: "seeded", id: req.id, seed: answer });
  assert.deepEqual(await seeded, answer);
  assert.deepEqual(dropped, ["child"], "the child's rows changed under the server thread: caches dropped");

  const failing = client.seed({ parentRepoId: "parent", childRepoId: "child", childRepoPath: "/r/child" });
  workers[0].send({ type: "error", id: workers[0].requests[1].id, error: "no ok run", code: "PARENT_NOT_INDEXED" });
  await assert.rejects(failing, (e: Error & { code?: string }) => e.code === "PARENT_NOT_INDEXED");

  const cleared = client.clear("child");
  const clearReq = workers[0].requests[2];
  assert.equal(clearReq.kind, "clear");
  workers[0].send({ type: "purged", id: clearReq.id, counts: { symbols: 3 } });
  assert.deepEqual(await cleared, { symbols: 3 });
});

test("IX-9: a hung seed is stopped by abortRun like a run (it carries the job's runId)", async () => {
  const { client, workers } = harness();
  const seeded = client.seed({ parentRepoId: "parent", childRepoId: "child", childRepoPath: "/r/child" }, "run-9");
  assert.equal(await client.abortRun("run-9", "timed out"), true);
  await assert.rejects(seeded, /timed out/);
  assert.equal(workers[0].terminated, true);
});

test("IX-9: the server thread never seeds or clears on its own connection (MCP-ISSUE-112 single writer)", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../../index.ts", import.meta.url), "utf8");
  assert.doesNotMatch(src, /\bstore\.(seedFromParent|clearRepositoryIndex|purgeRepository)\(/);
  assert.match(src, /refreshWorker\.seed\(/);
  assert.match(src, /refreshWorker\.clear\(/);
});

/** MCP-ISSUE-123: a worker that honours `exit` the way refreshWorker.ts does — it exits by itself, soon after. */
class ExitingWorker extends FakeWorker {
  override postMessage(value: RefreshWorkerRequest): void {
    super.postMessage(value);
    if (value.kind === "exit") setTimeout(() => this.emit("exit", 0), 5);
  }
}

function exitingHarness(): { client: RefreshWorkerClient; workers: ExitingWorker[] } {
  const workers: ExitingWorker[] = [];
  const client = new RefreshWorkerClient({
    dbPath: "/tmp/index.db",
    limits: LIMITS,
    abortGraceMs: 60_000,
    disposeGraceMs: 60_000,
    spawn: () => {
      const w = new ExitingWorker();
      workers.push(w);
      return w;
    }
  });
  return { client, workers };
}

test("MCP-ISSUE-123: abortRun asks the worker to exit and never terminates one that does (terminate mid-parse kills the process)", async () => {
  const { client, workers } = exitingHarness();
  const job = client.run("repo-a", "/repo/a", "full", true, 100, 50, { runId: "job-1" });
  const aborted = client.abortRun("job-1", "stopped: timeout");
  await assert.rejects(job, /stopped: timeout/);
  assert.equal(await aborted, true);
  assert.equal(workers[0].requests.at(-1)?.kind, "exit", "the worker was asked to exit");
  assert.equal(workers[0].terminated, false, "and was not terminated");
});

test("MCP-ISSUE-123: dispose asks the worker to exit and never terminates one that does", async () => {
  const { client, workers } = exitingHarness();
  const run = client.run("repo-a", "/repo/a", "dirty", true, 100, 50);
  const rejected = assert.rejects(run, /shut down/);
  await client.dispose();
  await rejected;
  assert.equal(workers[0].requests.at(-1)?.kind, "exit");
  assert.equal(workers[0].terminated, false);
});

test("MCP-ISSUE-123: a worker that does not answer exit within the grace is terminated after the request", async () => {
  const { client, workers } = harness();
  const job = client.run("repo-a", "/repo/a", "full", true, 100, 50, { runId: "job-1" });
  assert.equal(await client.abortRun("job-1", "timeout"), true);
  await assert.rejects(job, /timeout/);
  assert.deepEqual(workers[0].requests.map((r) => r.kind), ["run", "exit"]);
  assert.equal(workers[0].terminated, true);
});

test("MCP-ISSUE-123 review #2: the client never terminates the worker before the pool's retired parse workers may have left", () => {
  // Terminating the refresh worker tears down its nested parse workers wherever they are: inside a parse that is the
  // 0xC0000409. Its exit waits up to the pool's retire grace for them, so the client's fallback must come after that.
  assert.ok(DEFAULT_ABORT_GRACE_MS > DEFAULT_RETIRE_GRACE_MS, `abort grace ${String(DEFAULT_ABORT_GRACE_MS)} > retire grace ${String(DEFAULT_RETIRE_GRACE_MS)}`);
});

test("MCP-ISSUE-123 re-review E: shutdown is bounded at 35 s, and its terminate comes after the worker's own bounded exit", () => {
  assert.ok(DEFAULT_DISPOSE_GRACE_MS <= 35_000, `dispose grace ${String(DEFAULT_DISPOSE_GRACE_MS)} <= 35 s (was the 5.5 min abort grace)`);
  // The worker's pool terminates a stuck parse worker at SHUTDOWN_RETIRE_GRACE_MS, the worker exits by
  // SHUTDOWN_WORKER_EXIT_MS; the client's terminate is the fallback after both.
  assert.ok(SHUTDOWN_RETIRE_GRACE_MS < SHUTDOWN_WORKER_EXIT_MS && SHUTDOWN_WORKER_EXIT_MS < DEFAULT_DISPOSE_GRACE_MS);
  // tree-sitter's own parse timeout is 5 s: a parse worker is terminated at shutdown only well past it.
  assert.ok(SHUTDOWN_RETIRE_GRACE_MS >= 4 * 5_000);
});

test("MCP-ISSUE-123 re-review E: dispose marks its exit request shutdown; abortRun (a normal run) does not", async () => {
  const a = exitingHarness();
  const job = a.client.run("repo-a", "/repo/a", "full", true, 100, 50, { runId: "job-1" });
  assert.equal(await a.client.abortRun("job-1", "stopped"), true);
  await assert.rejects(job, /stopped/);
  const abortExit = a.workers[0].requests.at(-1);
  assert.equal(abortExit?.kind, "exit");
  assert.equal(abortExit?.shutdown, undefined, "abortRun keeps the full retire grace (no terminate during a parse)");

  const b = exitingHarness();
  b.client.warm();
  await b.client.dispose();
  const disposeExit = b.workers[0].requests.at(-1);
  assert.equal(disposeExit?.kind, "exit");
  assert.equal(disposeExit?.shutdown, true);
});

test("MCP-ISSUE-123 re-review E: a worker that never leaves its job is terminated by dispose at DEFAULT_DISPOSE_GRACE_MS, by abortRun only at the abort grace", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { client, workers } = new (class {
    workers: FakeWorker[] = [];
    client = new RefreshWorkerClient({ dbPath: "/tmp/index.db", limits: LIMITS, spawn: () => { const w = new FakeWorker(); this.workers.push(w); return w; } });
  })();
  client.warm();
  let disposed = false;
  void client.dispose().then(() => (disposed = true));
  t.mock.timers.tick(DEFAULT_DISPOSE_GRACE_MS - 1);
  await Promise.resolve();
  assert.equal(workers[0].terminated, false, "not before the grace");
  t.mock.timers.tick(1);
  for (let i = 0; i < 5; i++) await Promise.resolve();
  assert.equal(workers[0].terminated, true, "terminated at the 35 s bound");
  assert.equal(disposed, true);

  const job = client.run("repo-a", "/repo/a", "full", true, 100, 50, { runId: "job-2" });
  const rejected = assert.rejects(job, /stopped/);
  void client.abortRun("job-2", "stopped");
  t.mock.timers.tick(DEFAULT_DISPOSE_GRACE_MS * 2);
  await Promise.resolve();
  assert.equal(workers[1].terminated, false, "abortRun waits the full abort grace");
  t.mock.timers.tick(DEFAULT_ABORT_GRACE_MS);
  await rejected;
  assert.equal(workers[1].terminated, true);
});

test("MCP-ISSUE-123 re-review E (leader review 1): shutdown 10 s into an abortRun is bounded by the dispose grace", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const workers: FakeWorker[] = [];
  const client = new RefreshWorkerClient({
    dbPath: "/tmp/index.db",
    limits: LIMITS,
    spawn: () => {
      const w = new FakeWorker();
      workers.push(w);
      return w;
    }
  });
  const job = client.run("repo-a", "/repo/a", "full", true, 100, 50, { runId: "job-1" });
  const rejected = assert.rejects(job, /stopped/);
  let aborted = false;
  void client.abortRun("job-1", "stopped").then(() => (aborted = true));
  t.mock.timers.tick(10_000);
  let disposed = false;
  void client.dispose().then(() => (disposed = true));
  const exits = workers[0].requests.filter((r) => r.kind === "exit").map((r) => r.shutdown === true);
  assert.deepEqual(exits, [false, true], "the worker being aborted is sent the shutdown exit too");
  t.mock.timers.tick(DEFAULT_DISPOSE_GRACE_MS);
  for (let i = 0; i < 10; i++) await Promise.resolve();
  assert.equal(workers[0].terminated, true, "terminated by the 35 s bound, not the 5.5 min abort grace");
  assert.equal(disposed, true);
  workers[0].emit("exit", 1); // a real Worker's terminate ends in 'exit', which settles the abort's wait too
  for (let i = 0; i < 10; i++) await Promise.resolve();
  assert.equal(aborted, true);
  await rejected;
});
