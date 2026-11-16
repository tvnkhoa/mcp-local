import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import Database from "better-sqlite3";

import { GraphStore } from "./graphStore.js";
import { QueryGraphRunnerClient, type RunnerChildLike } from "./queryGraphRunnerClient.js";
import { createQueryGraphHandler, type QueryGraphMessage, type QueryGraphRequest } from "./queryGraphRunner.js";

type Answer = (req: QueryGraphRequest, reply: (m: QueryGraphMessage) => void, self: FakeChild) => void;

let nextPid = 1000;

/** A scripted child: says `ready` at once, then `answer` decides each reply and when it is sent. */
class FakeChild extends EventEmitter {
  readonly pid = nextPid++;
  posted: QueryGraphRequest[] = [];
  killed = false;
  constructor(private readonly answer: Answer, ready = true) {
    super();
    if (ready) setImmediate(() => this.emit("message", { kind: "ready" }));
  }
  send(req: QueryGraphRequest): boolean {
    this.posted.push(req);
    this.answer(req, (m) => this.emit("message", m), this);
    return true;
  }
  kill(): boolean {
    if (this.killed) return false;
    this.killed = true;
    setImmediate(() => this.emit("exit", null, "SIGKILL"));
    return true;
  }
}

const RESULT = { columns: ["n"], rows: [{ n: 1 }], rowCount: 1, truncated: false, elapsedMs: 1, timedOut: false };
const answersAtOnce: Answer = (req, reply) => setImmediate(() => reply({ kind: "result", id: req.id, result: structuredClone(RESULT) }));
const neverAnswers: Answer = () => {};

function client(answer: Answer, opts: { maxInFlight?: number; idleExitMs?: number; ready?: boolean; readyTimeoutMs?: number } = {}) {
  const spawned: FakeChild[] = [];
  const c = new QueryGraphRunnerClient("db.sqlite", {
    spawn: () => {
      const ch = new FakeChild(answer, opts.ready ?? true);
      spawned.push(ch);
      return ch as unknown as RunnerChildLike;
    },
    maxInFlight: opts.maxInFlight,
    idleExitMs: opts.idleExitMs ?? 60_000,
    readyTimeoutMs: opts.readyTimeoutMs
  });
  return { c, spawned };
}

test("a result is returned; the child is spawned lazily and kept warm for the next call", async () => {
  const { c, spawned } = client(answersAtOnce);
  assert.equal(spawned.length, 0);
  const a = await c.run("select 1", { repoId: "r" }, 10, 1_000);
  const b = await c.run("select 2", { repoId: "r" }, 10, 1_000);
  assert.deepEqual(a, { kind: "result", result: RESULT });
  assert.equal(b.kind, "result");
  assert.equal(spawned.length, 1, "the warm child served both calls");
  assert.deepEqual(
    { dbPath: spawned[0]!.posted[0]!.dbPath, sql: spawned[0]!.posted[0]!.sql, limit: spawned[0]!.posted[0]!.limit },
    { dbPath: "db.sqlite", sql: "select 1", limit: 10 }
  );
  assert.deepEqual(c.childPids, [spawned[0]!.pid]);
  await c.dispose();
  assert.equal(spawned[0]!.killed, true, "dispose kills the idle child");
});

test("timeout: the child is killed at timeoutMs, the call resolves timeout, the next call gets a fresh child", async () => {
  const { c, spawned } = client((req, reply, self) => {
    if (req.sql === "slow") return; // never answers
    answersAtOnce(req, reply, self);
  });
  const t0 = Date.now();
  const out = await c.run("slow", { repoId: "r" }, 10, 150);
  const took = Date.now() - t0;
  assert.equal(out.kind, "timeout");
  assert.ok(took >= 140 && took < 1_000, `resolved at ${took} ms`);
  assert.equal(spawned[0]!.killed, true, "the stuck child was killed");
  assert.deepEqual(c.childPids, [spawned[1]!.pid], "only the replacement child is left after the kill");
  const next = await c.run("select 1", { repoId: "r" }, 10, 1_000);
  assert.equal(next.kind, "result");
  assert.equal(spawned.length, 2, "the replacement, started at the kill, answered the next call");
  assert.equal(spawned[1]!.posted.length, 1);
  await c.dispose();
});

test("busy: beyond maxInFlight a call resolves busy at once; each in-flight call has its own child", async () => {
  const { c, spawned } = client(neverAnswers, { maxInFlight: 2 });
  const p1 = c.run("a", { repoId: "r" }, 10, 300);
  const p2 = c.run("b", { repoId: "r" }, 10, 300);
  assert.deepEqual(await c.run("c", { repoId: "r" }, 10, 300), { kind: "busy", inFlight: 2 });
  assert.equal((await p1).kind, "timeout");
  assert.equal((await p2).kind, "timeout");
  assert.equal(spawned.length, 3, "two busy children + one warm replacement (never more than one idle)");
  assert.equal(c.childPids.length, 1);
  assert.equal(c.inFlightCount, 0);
  await c.dispose();
});

test("a child that exits mid-query fails that call as crashed; nothing is retried", async () => {
  const { c, spawned } = client((_req, _reply, self) => setImmediate(() => self.emit("exit", 3, null)));
  const out = await c.run("select 1", { repoId: "r" }, 10, 5_000);
  assert.equal(out.kind, "crashed");
  assert.match((out as { message: string }).message, /exited mid-query \(code 3/);
  assert.equal(spawned.length, 1);
  assert.deepEqual(c.childPids, []);
  await c.dispose();
});

test("a child that never says ready fails the call as crashed after the ready bound", async () => {
  const { c, spawned } = client(answersAtOnce, { ready: false, readyTimeoutMs: 100 });
  const out = await c.run("select 1", { repoId: "r" }, 10, 5_000);
  assert.equal(out.kind, "crashed");
  assert.equal(spawned[0]!.killed, true);
  await c.dispose();
});

test("scope and SQL errors come back typed and keep the child", async () => {
  const { c, spawned } = client((req, reply) =>
    setImmediate(() => reply({ kind: "error", id: req.id, scope: req.sql === "scope", message: `bad ${req.sql}` }))
  );
  assert.deepEqual(await c.run("scope", { repoId: "r" }, 10, 1_000), { kind: "scope", message: "bad scope" });
  assert.deepEqual(await c.run("syntax", { repoId: "r" }, 10, 1_000), { kind: "error", message: "bad syntax" });
  assert.equal(spawned.length, 1);
  await c.dispose();
});

test("the idle child exits after idleExitMs", async () => {
  const { c, spawned } = client(answersAtOnce, { idleExitMs: 50 });
  await c.run("select 1", { repoId: "r" }, 10, 1_000);
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(spawned[0]!.killed, true);
  assert.deepEqual(c.childPids, []);
  await c.dispose();
});

test("the child's handler runs the same scoped query as the server thread did, on its own connection", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "qg-runner-"));
  const dbPath = path.join(dir, "g.sqlite");
  const store = new GraphStore(dbPath);
  try {
    store.ensureRepository("mine", dir);
    store.ensureRepository("theirs", dir);
    const handler = createQueryGraphHandler((p) => new Database(p, { readonly: true, fileMustExist: true }));
    const out = handler.answer({
      kind: "run",
      id: 7,
      dbPath,
      sql: "select repo_id as r from repositories where repo_id = :repoId",
      params: { repoId: "mine" },
      limit: 10
    });
    assert.equal(out.kind, "result");
    assert.deepEqual(out.kind === "result" ? out.result.rows : null, [{ r: "mine" }]);
    // Repo isolation is enforced in the child too: an unfiltered read still sees only the bound repo.
    const all = handler.answer({ kind: "run", id: 8, dbPath, sql: "select repo_id as r from repositories", params: { repoId: "mine" }, limit: 10 });
    assert.deepEqual(all.kind === "result" ? all.result.rows : null, [{ r: "mine" }]);
    const scoped = handler.answer({ kind: "run", id: 9, dbPath, sql: "select * from main.symbols", params: { repoId: "mine" }, limit: 10 });
    assert.equal(scoped.kind, "error");
    assert.equal(scoped.kind === "error" && scoped.scope, true);
    handler.close();
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
