import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import type { FieldAnswer } from "./fieldReferences.js";
import type { FieldWorkerMessage, FieldWorkerRequest } from "./fieldWorker.js";
import { FieldWorkerClient, MAX_QUEUED, type FieldQuery, type WorkerLike } from "./fieldWorkerClient.js";

/** A worker that answers only when the test says so. */
class FakeWorker extends EventEmitter implements WorkerLike {
  readonly requests: FieldWorkerRequest[] = [];
  terminated = false;
  postMessage(value: FieldWorkerRequest): void {
    this.requests.push(value);
  }
  async terminate(): Promise<number> {
    this.terminated = true;
    return 0;
  }
  send(message: FieldWorkerMessage): void {
    this.emit("message", message);
  }
}

function harness(): { client: FieldWorkerClient; workers: FakeWorker[] } {
  const workers: FakeWorker[] = [];
  const client = new FieldWorkerClient(() => {
    const w = new FakeWorker();
    workers.push(w);
    return w;
  });
  return { client, workers };
}

function query(field = "kb_version_ids", waitMs = 30): FieldQuery {
  return { program: { repoId: "r", repoPath: "/repo", runKey: "run-1", relativeFiles: ["a.ts"] }, field, pick: {}, caps: { budgetMs: 60_000, maxRssMb: 2_500 }, waitMs };
}

function okAnswer(field = "kb_version_ids"): FieldAnswer {
  const meta = { engine: "typescript-language-service" as const, typescriptVersion: "5", tsconfig: null, rootFiles: 1, programFiles: 1, cold: true, coldMs: 10, warmMs: null, totalMs: 10, rssMb: 1 };
  return { status: "no_declaration", field, nonMatches: [], gaps: [], meta };
}

test("a call the worker does not answer within the wait budget is withheld as 'building', and the late answer serves the next identical call", async () => {
  const { client, workers } = harness();
  const first = client.ask(query());
  const worker = workers[0]!;
  worker.send({ type: "started", id: worker.requests[0]!.id, repoId: "r", cold: true });
  const withheld = await first;
  assert.equal(withheld.status, "cap_breach");
  assert.ok(withheld.status === "cap_breach" && withheld.breach.kind === "building");
  assert.match(withheld.status === "cap_breach" ? withheld.breach.detail : "", /type program still building for 'r'/);
  assert.ok(!("sites" in withheld), "no partial list");

  worker.send({ type: "answer", id: worker.requests[0]!.id, answer: okAnswer() });
  const next = await client.ask(query());
  assert.equal(next.status, "no_declaration");
  assert.equal(worker.requests.length, 1, "served from the late answer, no second request");
  assert.equal(typeof next.meta.roundTripMs, "number");
});

test("identical calls in flight share one request; a different field gets its own", async () => {
  const { client, workers } = harness();
  const a = client.ask(query("f", 1_000));
  const b = client.ask(query("f", 1_000));
  const c = client.ask(query("g", 1_000));
  const worker = workers[0]!;
  assert.equal(worker.requests.length, 2);
  worker.send({ type: "answer", id: worker.requests[0]!.id, answer: okAnswer("f") });
  worker.send({ type: "answer", id: worker.requests[1]!.id, answer: okAnswer("g") });
  assert.deepEqual([(await a).field, (await b).field, (await c).field], ["f", "f", "g"]);
});

test("a memory breach discards the worker; the next call spawns a fresh one", async () => {
  const { client, workers } = harness();
  const pending = client.ask(query("f", 1_000));
  const other = client.ask(query("g", 1_000));
  const worker = workers[0]!;
  const breach: FieldAnswer = { status: "cap_breach", field: "f", breach: { kind: "memory", detail: "findReferences: worker heap 3000 MB, cap 2500 MB (CODEBASE_INDEX_TS_LS_MAX_RSS_MB)" }, meta: { engine: "typescript-language-service", cold: true, totalMs: 5, rssMb: 1 } };
  worker.send({ type: "answer", id: worker.requests[0]!.id, answer: breach });
  const answered = await pending;
  assert.ok(answered.status === "cap_breach" && answered.breach.kind === "memory");
  const queued = await other;
  assert.ok(queued.status === "cap_breach" && queued.breach.kind === "memory" && /discarded/.test(queued.breach.detail), "the call queued behind it is withheld too");
  assert.equal(worker.terminated, true);
  void client.ask(query("f", 10));
  assert.equal(workers.length, 2);
  assert.equal(client.spawned, 2);
});

test("a worker that dies of V8 out-of-memory answers every waiting call with a memory gap", async () => {
  const { client, workers } = harness();
  const pending = client.ask(query("f", 1_000));
  const error = Object.assign(new Error("Worker terminated due to reaching memory limit: JS heap out of memory"), { code: "ERR_WORKER_OUT_OF_MEMORY" });
  workers[0]!.emit("error", error);
  const answer = await pending;
  assert.ok(answer.status === "cap_breach" && answer.breach.kind === "memory" && /maxOldGenerationSizeMb/.test(answer.breach.detail));
});

test("at most MAX_QUEUED distinct requests are outstanding; beyond that a call is withheld at once", async () => {
  const { client, workers } = harness();
  for (let i = 0; i < MAX_QUEUED; i++) void client.ask(query(`f${String(i)}`, 1_000));
  const started = performance.now();
  const over = await client.ask(query("one-too-many", 1_000));
  assert.ok(performance.now() - started < 500);
  assert.ok(over.status === "cap_breach" && over.breach.kind === "building" && /already queued/.test(over.breach.detail));
  assert.equal(workers[0]!.requests.length, MAX_QUEUED);
  await client.dispose();
});
