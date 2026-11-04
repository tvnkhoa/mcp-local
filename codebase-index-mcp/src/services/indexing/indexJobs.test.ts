import assert from "node:assert/strict";
import test from "node:test";

import { IndexJobQueue, type IndexJobRequest } from "./indexJobs.js";
import type { IndexRunResult } from "../../types/index.js";

/**
 * MCP-ISSUE-112 (IX-2): `index_repository` is a job. These pin the queue without a server: it answers at once,
 * runs one job at a time in order, keeps a job queued (with the reason) while free RAM is under the floor, bounds
 * `wait`, and reports a failed run as `failed` with its error. The server-level acceptance (a disconnected client,
 * two repos queued) is scripts/test/test-index-jobs.mjs.
 */

const request = (repoId: string): IndexJobRequest => ({ repoId, repoPath: `/r/${repoId}`, mode: "full", docsEnabled: true, maxFiles: 100, batchSize: 50, source: "test" });
const tick = (ms = 5): Promise<void> => new Promise((r) => setTimeout(r, ms));

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

test("IX-2: enqueue answers at once; jobs run one at a time, in order, and each ends ok with its run's result", async () => {
  const gates = [deferred(), deferred()];
  const started: string[] = [];
  const queue = new IndexJobQueue({
    minFreeRamMb: 0,
    execute: async (job, req, onProgress) => {
      started.push(req.repoId);
      onProgress({ phase: "indexing 50%", progress: 5, total: 10 });
      await gates[started.length - 1]!.promise;
      return { runId: job.runId, status: "ok", filesIndexed: 3 } as IndexRunResult;
    }
  });
  const a = queue.enqueue(request("a"));
  const b = queue.enqueue(request("b"));
  assert.equal(a.state, "running", "the first job starts at once");
  assert.equal(b.state, "queued");
  assert.match(queue.get(b.runId)?.waitingFor ?? "", /another index run is in progress/);
  assert.deepEqual(started, ["a"], "never two at once");
  assert.equal(queue.get(a.runId)?.phase, "indexing 50%");
  assert.equal(queue.get(a.runId)?.total, 10);
  gates[0]!.resolve();
  await tick();
  assert.equal(queue.get(a.runId)?.state, "ok");
  assert.equal(queue.get(a.runId)?.result?.runId, a.runId, "the job's id is the run's id");
  assert.deepEqual(started, ["a", "b"]);
  gates[1]!.resolve();
  const done = await queue.wait(b.runId, 1_000);
  assert.equal(done?.state, "ok");
  assert.deepEqual(queue.pending(), []);
});

test("IX-2: a job does not START while free RAM is under the floor — it stays queued with the reason, then starts", async () => {
  let free = 4096;
  let ran = 0;
  const queue = new IndexJobQueue({
    minFreeRamMb: 8192,
    freeRamMb: () => free,
    ramRecheckMs: 10,
    execute: async (job) => {
      ran++;
      return { runId: job.runId, status: "ok" } as IndexRunResult;
    }
  });
  try {
    const job = queue.enqueue(request("a"));
    assert.equal(job.state, "queued");
    await tick(40);
    assert.equal(ran, 0, "not started below the floor, however often it looks");
    const waiting = queue.get(job.runId);
    assert.equal(waiting?.state, "queued");
    assert.match(waiting?.waitingFor ?? "", /free RAM 4096 MB is below CODEBASE_INDEX_MIN_FREE_RAM_MB=8192/);
    free = 9000;
    const done = await queue.wait(job.runId, 1_000);
    assert.equal(ran, 1);
    assert.equal(done?.state, "ok");
  } finally {
    queue.dispose();
  }
});

test("follow-up 5: a run past runTimeoutMs fails its job, is stopped once, and the next job starts", async () => {
  const stopped: string[] = [];
  let ran = 0;
  const queue = new IndexJobQueue({
    minFreeRamMb: 0,
    runTimeoutMs: 30,
    onRunTimeout: (job) => stopped.push(job.repoId),
    execute: async (job, req, _p, control) => {
      control.started();
      ran++;
      if (req.repoId === "hung") return new Promise<IndexRunResult>(() => undefined);
      return { runId: job.runId, status: "ok" } as IndexRunResult;
    }
  });
  const hung = queue.enqueue(request("hung"));
  const next = queue.enqueue(request("next"));
  const failed = await queue.wait(hung.runId, 2_000);
  assert.equal(failed?.state, "failed");
  assert.match(failed?.error ?? "", /CODEBASE_INDEX_RUN_TIMEOUT_MS=30 ms/);
  assert.deepEqual(stopped, ["hung"]);
  assert.equal((await queue.wait(next.runId, 2_000))?.state, "ok", "the queue is not held by the hung run");
  assert.equal(ran, 2);
});

test("follow-up 8: a second request for a repo with a job queued or running joins it; another mode or repo does not", async () => {
  const gate = deferred();
  let ran = 0;
  const queue = new IndexJobQueue({
    minFreeRamMb: 0,
    execute: async (job) => {
      ran++;
      await gate.promise;
      return { runId: job.runId, status: "ok" } as IndexRunResult;
    }
  });
  const a = queue.enqueue(request("a"));
  const again = queue.enqueue(request("a"));
  assert.equal(again.runId, a.runId);
  assert.equal(again.coalesced, true);
  const b = queue.enqueue(request("b"));
  const bAgain = queue.enqueue(request("b"));
  assert.equal(bAgain.runId, b.runId, "a queued job is joined too");
  const bDirty = queue.enqueue({ ...request("b"), mode: "dirty" });
  assert.equal(bDirty.runId, b.runId, "a full job covers a scoped request");
  const cInc = queue.enqueue({ ...request("c"), mode: "incremental" });
  const cFull = queue.enqueue(request("c"));
  assert.notEqual(cFull.runId, cInc.runId, "a full request is not covered by a queued incremental job");
  gate.resolve();
  await queue.wait(cFull.runId, 2_000);
  assert.equal(ran, 4, "a, b, c incremental, c full — no duplicate runs");
  const later = queue.enqueue(request("a"));
  assert.notEqual(later.runId, a.runId, "a finished job is not joined");
  await queue.wait(later.runId, 2_000);
});

test("review follow-up A: a request differing in path, docs or file cap is not joined to a job", async () => {
  const gate = deferred();
  const queue = new IndexJobQueue({
    minFreeRamMb: 0,
    execute: async (job) => {
      await gate.promise;
      return { runId: job.runId, status: "ok" } as IndexRunResult;
    }
  });
  const a = queue.enqueue(request("a"));
  assert.equal(queue.enqueue(request("a")).runId, a.runId);
  for (const diff of [{ repoPath: "/elsewhere" }, { docsEnabled: false }, { maxFiles: 5 }]) {
    const other = queue.enqueue({ ...request("a"), ...diff });
    assert.notEqual(other.runId, a.runId, JSON.stringify(diff));
    assert.equal(other.coalesced, undefined);
  }
  gate.resolve();
  for (const j of queue.pending()) await queue.wait(j.runId, 2_000);
});

test("review follow-up C: the run timeout counts from started(), and a job failed before its run starts never runs", async () => {
  const waiting = deferred();
  let started = 0;
  const seen: boolean[] = [];
  const queue = new IndexJobQueue({
    minFreeRamMb: 0,
    runTimeoutMs: 40,
    execute: async (job, req, _p, control) => {
      if (req.repoId === "slow-queue") {
        await new Promise((r) => setTimeout(r, 120)); // waits in the DB-wide queue: no clock yet
        seen.push(control.cancelled());
        control.started();
        started++;
        return { runId: job.runId, status: "ok" } as IndexRunResult;
      }
      await waiting.promise;
      seen.push(control.cancelled());
      return { runId: job.runId, status: "ok" } as IndexRunResult;
    }
  });
  const slow = queue.enqueue(request("slow-queue"));
  assert.equal((await queue.wait(slow.runId, 2_000))?.state, "ok", "120 ms in the queue is not run time");
  assert.deepEqual(seen, [false]);
  assert.equal(started, 1);

  // A job that times out after started() is cancelled for the executor too.
  const q2 = new IndexJobQueue({
    minFreeRamMb: 0,
    runTimeoutMs: 20,
    execute: async (_job, _req, _p, control) => {
      control.started();
      await new Promise((r) => setTimeout(r, 80));
      seen.push(control.cancelled());
      return new Promise<IndexRunResult>(() => undefined);
    }
  });
  const timed = q2.enqueue(request("t"));
  assert.equal((await q2.wait(timed.runId, 2_000))?.state, "failed");
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(seen, [false, true], "after the timeout the executor sees cancelled() and must not start anything");
  waiting.resolve();
});

test("IX-2: wait returns the job as it stands when the bound passes; a failed or throwing run is failed with its error", async () => {
  const gate = deferred();
  const queue = new IndexJobQueue({
    minFreeRamMb: 0,
    execute: async (job, req) => {
      if (req.repoId === "slow") {
        await gate.promise;
        return { runId: job.runId, status: "ok" } as IndexRunResult;
      }
      if (req.repoId === "bad") return { runId: job.runId, status: "failed" } as IndexRunResult;
      throw new Error("index_repository refused: newer build");
    }
  });
  const slow = queue.enqueue(request("slow"));
  const t0 = Date.now();
  const mid = await queue.wait(slow.runId, 30);
  assert.equal(mid?.state, "running");
  assert.ok(Date.now() - t0 < 1_000);
  const bad = queue.enqueue(request("bad"));
  const boom = queue.enqueue(request("boom"));
  gate.resolve();
  assert.equal((await queue.wait(bad.runId, 1_000))?.state, "failed");
  const thrown = await queue.wait(boom.runId, 1_000);
  assert.equal(thrown?.state, "failed");
  assert.match(thrown?.error ?? "", /newer build/);
  assert.equal(await queue.wait("no-such-run", 10), null);
});
