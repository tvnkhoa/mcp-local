import assert from "node:assert/strict";
import test from "node:test";

import { IndexJobQueue, MAX_REFRESH_DEADLINE_STOPS, queuedWithin, RefreshRuns, sameRepoPath, type IndexJobRequest } from "./indexJobs.js";
import type { IndexMode } from "../../types/index.js";
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

test("review F1: queuedWithin gives up after waitMs behind a busy queue, and the skipped fn never runs", async () => {
  // A one-slot queue held by a long run.
  let chain: Promise<unknown> = Promise.resolve();
  const enqueue = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = chain.then(fn, fn);
    chain = next.catch(() => undefined);
    return next;
  };
  const hold = deferred();
  void enqueue(() => hold.promise);
  let purged = 0;
  const t0 = Date.now();
  await assert.rejects(
    queuedWithin(enqueue, async () => ++purged, 50, () => new Error("busy: retry")),
    /busy: retry/
  );
  assert.ok(Date.now() - t0 < 1_000, "answers after the bound, not when the queue frees");
  hold.resolve();
  await chain;
  assert.equal(purged, 0, "the abandoned call does not run when its turn comes");
  // A free queue: the call runs and answers.
  assert.equal(await queuedWithin(enqueue, async () => ++purged, 50, () => new Error("busy")), 1);
});

test("review A-low: coalescing compares repo paths in any spelling", () => {
  assert.equal(sameRepoPath("C:/a/b", "C:\\a\\b\\"), true);
  const queue = new IndexJobQueue({ minFreeRamMb: 0, execute: () => new Promise<IndexRunResult>(() => undefined) });
  const a = queue.enqueue({ ...request("a"), repoPath: "/r/a" });
  assert.equal(queue.enqueue({ ...request("a"), repoPath: "/r/a/" }).runId, a.runId);
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

// ── IX-A (MCP-ISSUE-126): refresh runs — runId, progress, deadline ──

type Landed = { runId: string; mode: IndexMode; status: string };

/** The deadline timer is unref'd (a server holds its loop open); a test holds it for the body. */
const held = (body: () => Promise<void>) => async (): Promise<void> => {
  const keep = setInterval(() => undefined, 5);
  try {
    await body();
  } finally {
    clearInterval(keep);
  }
};

test("IX-A: a refresh run under its deadline is listed while it runs, untouched, and gone after", async () => {
  const runs = new RefreshRuns(1_000);
  const gate = deferred();
  let aborts = 0;
  const p = runs.run<Landed>({
    repoId: "r",
    mode: "dirty",
    source: "watcher",
    abort: async () => ((aborts += 1), true),
    execute: async (runId, mode, onProgress) => {
      onProgress(2, 5, "index r: resolve");
      await gate.promise;
      return { runId, mode, status: "ok" };
    }
  });
  await tick();
  const [view] = runs.list();
  assert.equal(view?.repoId, "r");
  assert.equal(view?.mode, "dirty");
  assert.equal(view?.source, "watcher");
  assert.equal(view?.state, "running");
  assert.equal(view?.phase, "resolve");
  assert.equal(view?.progress, 2);
  assert.equal(view?.total, 5);
  assert.equal(view?.deadlineMs, 1_000);
  assert.ok(view && view.elapsedMs >= 0 && typeof view.deadlineAt === "string");
  assert.deepEqual(runs.get(view?.runId ?? ""), { ...view, elapsedMs: runs.get(view?.runId ?? "")?.elapsedMs });
  gate.resolve();
  const landed = await p;
  assert.equal(landed.runId, view?.runId, "the run is recorded under the registry's runId");
  assert.equal(aborts, 0);
  assert.deepEqual(runs.list(), []);
  assert.deepEqual(runs.modeFor("r", "dirty"), { mode: "dirty" });
});

test("IX-A: past the deadline the run is aborted, rejects with the reason only after the abort settled, and the next run is full", held(async () => {
  const runs = new RefreshRuns(30);
  const order: string[] = [];
  let stateWhileStopping: string | undefined;
  let rejectRun!: (e: Error) => void;
  const p = runs.run<Landed>({
    repoId: "r",
    mode: "dirty",
    source: "freshness_gate",
    abort: async (runId, reason) => {
      order.push(`abort ${reason.includes(runId) ? "names run" : "?"}`);
      stateWhileStopping = runs.get(runId)?.state;
      rejectRun(new Error("worker restarted")); // the worker client rejects first...
      await tick(20);
      order.push("worker gone");
      return true;
    },
    execute: () => new Promise<Landed>((_, reject) => (rejectRun = reject))
  });
  await assert.rejects(p, (e: Error) => /CODEBASE_INDEX_REFRESH_RUN_DEADLINE_MS=30 ms/.test(e.message));
  order.push("rejected");
  assert.deepEqual(order, ["abort names run", "worker gone", "rejected"], "...but the run settles only after the abort");
  assert.equal(stateWhileStopping, "stopping", "listed as stopping while the worker goes");
  assert.deepEqual(runs.list(), []);
  const next = runs.modeFor("r", "dirty");
  assert.equal(next.mode, "full");
  assert.match(next.escalatedBecause ?? "", /stopped at the 30 ms refresh deadline; dirty requested/);
  assert.deepEqual(runs.modeFor("other", "dirty"), { mode: "dirty" }, "per repo");
  // The repair run is handed full + the reason; once it lands ok, the repo is back to dirty.
  const repair = await runs.run<Landed>({
    repoId: "r",
    mode: "dirty",
    source: "freshness_gate",
    abort: async () => true,
    execute: async (runId, mode, _p, why) => {
      assert.equal(mode, "full");
      assert.match(why ?? "", /refresh deadline/);
      return { runId, mode, status: "ok" };
    }
  });
  assert.equal(repair.mode, "full");
  assert.deepEqual(runs.modeFor("r", "dirty"), { mode: "dirty" });
}));

test("IX-A: a failed or cancelled full run keeps the repair pending; a deadline that found nothing to stop clears it", held(async () => {
  const runs = new RefreshRuns(20);
  let rejectRun!: (e: Error) => void;
  await assert.rejects(
    runs.run<Landed>({
      repoId: "r",
      mode: "dirty",
      source: "watcher",
      abort: async () => (rejectRun(new Error("worker restarted")), true),
      execute: () => new Promise<Landed>((_, reject) => (rejectRun = reject))
    }),
    /deadline/
  );
  runs.landed("r", { mode: "full", status: "failed" });
  assert.equal(runs.modeFor("r", "dirty").mode, "full");
  runs.landed("r", { mode: "full", status: "cancelled" });
  assert.equal(runs.modeFor("r", "dirty").mode, "full");
  // A run that answered just as its deadline fired: abort found nothing (false), the run stands, no repair.
  const fresh = new RefreshRuns(10);
  const landed = await fresh.run<Landed>({
    repoId: "s",
    mode: "dirty",
    source: "watcher",
    abort: async () => false,
    execute: async (runId, mode) => {
      await tick(30);
      return { runId, mode, status: "ok" };
    }
  });
  assert.equal(landed.status, "ok");
  assert.deepEqual(fresh.modeFor("s", "dirty"), { mode: "dirty" });
}));

test("IX-A: the queue exposes its refresh registry for index_status", () => {
  const refreshes = new RefreshRuns(1_000);
  const q = new IndexJobQueue({ execute: async () => ({}) as IndexRunResult, minFreeRamMb: 0, refreshes });
  assert.equal(q.refreshes, refreshes);
  assert.equal(new IndexJobQueue({ execute: async () => ({}) as IndexRunResult, minFreeRamMb: 0 }).refreshes, null);
});

/** A run that hangs until aborted; the abort rejects it as the worker client does and answers `stopped`. */
const hangingRun = (runs: RefreshRuns, repoId: string, mode: IndexMode, stopped = true): Promise<Landed> => {
  let rejectRun!: (e: Error) => void;
  return runs.run<Landed>({
    repoId,
    mode,
    source: "watcher",
    abort: async () => {
      if (stopped) rejectRun(new Error("worker restarted"));
      return stopped;
    },
    execute: () => new Promise<Landed>((_, reject) => (rejectRun = reject))
  });
};

test("IX-A review (2): a full run gets the full-run deadline; after MAX stops in a row no refresh starts until a run lands", held(async () => {
  const runs = new RefreshRuns(20, 60);
  let seenDeadline = 0;
  await runs.run<Landed>({
    repoId: "r",
    mode: "full",
    source: "watcher",
    abort: async () => true,
    execute: async (runId, mode) => {
      seenDeadline = runs.get(runId)?.deadlineMs ?? 0;
      return { runId, mode, status: "ok" };
    }
  });
  assert.equal(seenDeadline, 60, "a full run: the full-run deadline");
  for (let i = 0; i < MAX_REFRESH_DEADLINE_STOPS; i++) await assert.rejects(hangingRun(runs, "r", "dirty"), /deadline/);
  await assert.rejects(hangingRun(runs, "r", "dirty"), /no refresh of r starts: its last 2 refresh runs were stopped/);
  assert.deepEqual(runs.list(), [], "the refused run never started");
  runs.landed("r", { mode: "full", status: "ok" }); // an index_repository job landed
  const back = await runs.run<Landed>({ repoId: "r", mode: "dirty", source: "watcher", abort: async () => true, execute: async (runId, mode) => ({ runId, mode, status: "ok" }) });
  assert.equal(back.mode, "dirty", "the stop count and the repair are lifted");
}));

test("IX-A review (4)(5)(6): a deadline that stopped nothing keeps the earlier repair and the run's own error; a job timeout asks for repair", held(async () => {
  const runs = new RefreshRuns(10);
  runs.needRepair("r", "index run j1 was stopped at CODEBASE_INDEX_RUN_TIMEOUT_MS=5 ms");
  assert.match(runs.modeFor("r", "dirty").escalatedBecause ?? "", /index run j1 was stopped/);
  // The forced-full run fails on its own just as the deadline fires; the abort finds nothing (false).
  let rejectRun!: (e: Error) => void;
  const failing = runs.run<Landed>({
    repoId: "r",
    mode: "dirty",
    source: "watcher",
    abort: async () => {
      rejectRun(new Error("the refresh worker crashed: boom"));
      return false;
    },
    execute: () => new Promise<Landed>((_, reject) => (rejectRun = reject))
  });
  await assert.rejects(failing, /the refresh worker crashed: boom/, "its own error, not the deadline reason");
  assert.match(runs.modeFor("r", "dirty").escalatedBecause ?? "", /index run j1 was stopped/, "the earlier repair is restored, not dropped");
}));
