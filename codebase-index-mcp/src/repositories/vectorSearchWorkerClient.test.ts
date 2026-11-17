import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { createRequire } from "node:module";
import test from "node:test";

import Database from "better-sqlite3";

import { GraphStore } from "./graphStore.js";
import { MAX_PENDING, MAX_WORKERS, VectorSearchWorkerClient, type VectorWorkerLike } from "./vectorSearchWorkerClient.js";
import { createSearchHandler, type VectorSearchMessage, type VectorSearchRequest } from "./vectorSearchWorker.js";
import { batchUpsertSymbolVectors, initVectorStore } from "./vectorStore.js";

type SearchReq = Extract<VectorSearchRequest, { kind: "search" }>;
type Answer = (req: SearchReq, reply: (m: VectorSearchMessage) => void, self: FakeWorker) => void;

/** A scripted worker: `answer` decides each search's reply and when it is sent. */
class FakeWorker extends EventEmitter {
  posted: VectorSearchRequest[] = [];
  constructor(private readonly answer: Answer) {
    super();
  }
  postMessage(req: VectorSearchRequest): void {
    this.posted.push(req);
    if (req.kind === "search") this.answer(req, (m) => this.emit("message", m), this);
  }
  terminate(): Promise<number> {
    this.emit("exit", 1);
    return Promise.resolve(1);
  }
}

function client(answer: Answer, idleExitMs = 60_000): { c: VectorSearchWorkerClient; spawned: FakeWorker[] } {
  const spawned: FakeWorker[] = [];
  const c = new VectorSearchWorkerClient("db.sqlite", {
    spawn: () => {
      const w = new FakeWorker(answer);
      spawned.push(w);
      return w as unknown as VectorWorkerLike;
    },
    idleExitMs
  });
  return { c, spawned };
}

const answersAtOnce: Answer = (req, reply) => setImmediate(() => reply({ kind: "result", id: req.id, rows: [{ symbolId: "s1", distance: 0.5 }], ms: 1 }));

test("answers within the budget resolve with the rows; the worker is spawned lazily, once", async () => {
  const { c, spawned } = client(answersAtOnce);
  assert.equal(spawned.length, 0, "no worker before the first search");
  assert.deepEqual(await c.search("r", "foo", 5, 1_000), { rows: [{ symbolId: "s1", distance: 0.5 }] });
  assert.deepEqual(await c.search("r", "bar", 5, 1_000), { rows: [{ symbolId: "s1", distance: 0.5 }] });
  assert.equal(spawned.length, 1);
  const first = spawned[0]!.posted[0] as SearchReq;
  assert.deepEqual({ dbPath: first.dbPath, repoId: first.repoId, text: first.text, k: first.k }, { dbPath: "db.sqlite", repoId: "r", text: "foo", k: 5 });
  await c.dispose();
});

test("a late answer resolves `budget` at the budget, without waiting for the worker", async () => {
  let release: (() => void) | null = null;
  const { c } = client((req, reply) => {
    release = () => reply({ kind: "result", id: req.id, rows: [], ms: 1 });
  });
  const t0 = performance.now();
  // The budget timer is unref'd (it must never keep a server alive on its own); the server's transport keeps its loop
  // alive, here nothing would, so hold the loop open while waiting.
  const keepAlive = setInterval(() => {}, 1_000);
  const late = await c.search("r", "slow", 5, 50);
  clearInterval(keepAlive);
  assert.deepEqual(late, { skipped: "budget" });
  assert.ok(performance.now() - t0 < 1_000);
  assert.equal(c.pendingCount, 1, "the late request still counts until the worker answers it");
  (release as unknown as () => void)();
  assert.equal(c.pendingCount, 0);
  await c.dispose();
});

test("MAX_PENDING outstanding searches: the next one is refused at once (`queue`)", async () => {
  const { c } = client(() => {
    /* never answers */
  });
  const waits = Array.from({ length: MAX_PENDING }, (_, i) => c.search("r", `q${String(i)}`, 5, 10_000));
  assert.deepEqual(await c.search("r", "one-too-many", 5, 10_000), { skipped: "queue" });
  await c.dispose();
  for (const w of waits) assert.deepEqual(await w, { skipped: "worker-error" }, "dispose settles every waiter");
});

test("a worker error or exit settles its waiters with `error`; the next search spawns a fresh worker", async () => {
  const { c, spawned } = client((req, reply, self) => {
    if (req.text === "boom") setImmediate(() => reply({ kind: "error", id: req.id, message: "x" }));
    else if (req.text === "die") setImmediate(() => void self.terminate());
    else setImmediate(() => reply({ kind: "result", id: req.id, rows: [], ms: 1 }));
  });
  assert.deepEqual(await c.search("r", "boom", 5, 1_000), { skipped: "worker-error" });
  assert.deepEqual(await c.search("r", "die", 5, 1_000), { skipped: "worker-error" });
  assert.deepEqual(await c.search("r", "ok", 5, 1_000), { rows: [] });
  assert.equal(spawned.length, 2);
  await c.dispose();
});

test("idle: the worker is asked to exit after idleExitMs without a request; invalidate reaches a live worker only", async () => {
  const { c, spawned } = client(answersAtOnce, 30);
  c.invalidate();
  assert.equal(spawned.length, 0, "no worker yet: nothing to clear, nothing spawned");
  await c.search("r", "a", 5, 1_000);
  c.invalidate();
  assert.equal(spawned[0]!.posted.at(-1)?.kind, "invalidate");
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(spawned[0]!.posted.at(-1)?.kind, "exit");
  assert.equal(c.isRunning, false);
  await c.search("r", "b", 5, 1_000);
  assert.equal(spawned.length, 2, "a search after the idle exit spawns a new worker");
  await c.dispose();
});

// MCP-ISSUE-136: one serial worker made a small repo's search wait out the budget behind the big repo's rescan
// (CI e109539: 2073 ms). A search posted while a worker is busy takes an idle lane instead.
test("lanes: a search posted while the worker scans another one is answered by a second worker, at once", async () => {
  const held: (() => void)[] = [];
  const { c, spawned } = client((req, reply) => {
    const send = () => reply({ kind: "result", id: req.id, rows: [{ symbolId: req.text, distance: 0.1 }], ms: 1 });
    if (req.repoId === "big") held.push(send);
    else setImmediate(send);
  });
  const keepAlive = setInterval(() => {}, 1_000);
  const slow = c.search("big", "fn_7_1", 5, 5_000);
  const t0 = performance.now();
  assert.deepEqual(await c.search("small", "smallBeta", 5, 5_000), { rows: [{ symbolId: "smallBeta", distance: 0.1 }] });
  assert.ok(performance.now() - t0 < 500, "not queued behind the held scan");
  assert.equal(spawned.length, 2);
  assert.equal(spawned[1]!.posted.filter((r) => r.kind === "search").length, 1, "the second lane took the small search");
  // Both idle again: the first lane is preferred, so the usual one-at-a-time traffic keeps one warm memo.
  held.shift()!();
  assert.deepEqual(await slow, { rows: [{ symbolId: "fn_7_1", distance: 0.1 }] });
  await c.search("small", "again", 5, 5_000);
  assert.equal(spawned[0]!.posted.filter((r) => r.kind === "search").length, 2);
  c.invalidate();
  assert.deepEqual(spawned.map((w) => w.posted.at(-1)?.kind), ["invalidate", "invalidate"], "invalidate reaches every lane");
  clearInterval(keepAlive);
  await c.dispose();
});

// MCP-ISSUE-136: the memo lives on the server thread, so a second lane's empty memo never costs a known query a rescan.
test("memo: a known query never reaches a worker; a late answer is memoized; an answer older than invalidate() is not", async () => {
  const held = new Map<string, () => void>();
  const { c, spawned } = client((req, reply) => {
    const send = () => reply({ kind: "result", id: req.id, rows: [{ symbolId: req.text, distance: 0.2 }], ms: 1 });
    if (req.text.startsWith("hold")) held.set(req.text, send);
    else setImmediate(send);
  });
  const searches = () => spawned.reduce((n, w) => n + w.posted.filter((r) => r.kind === "search").length, 0);
  const keepAlive = setInterval(() => {}, 1_000);
  assert.deepEqual(await c.search("r", "foo", 5, 1_000), { rows: [{ symbolId: "foo", distance: 0.2 }] });
  assert.deepEqual(await c.search("r", "foo", 5, 1_000), { rows: [{ symbolId: "foo", distance: 0.2 }] });
  assert.equal(searches(), 1, "the repeat is answered from the memo");
  await c.search("r", "foo", 3, 1_000);
  await c.search("other", "foo", 5, 1_000);
  assert.equal(searches(), 3, "repo and k are part of the key");

  assert.deepEqual(await c.search("r", "hold-late", 5, 20), { skipped: "budget" });
  held.get("hold-late")!();
  assert.deepEqual(await c.search("r", "hold-late", 5, 20), { rows: [{ symbolId: "hold-late", distance: 0.2 }] }, "the late answer was kept");
  assert.equal(searches(), 4);

  const stale = c.search("r", "hold-stale", 5, 1_000);
  c.invalidate();
  held.get("hold-stale")!();
  assert.deepEqual(await stale, { rows: [{ symbolId: "hold-stale", distance: 0.2 }] }, "the waiter still gets its answer");
  await c.search("r", "foo", 5, 1_000);
  assert.equal(searches(), 6, "invalidate() cleared the memo (foo rescanned)");
  void c.search("r", "hold-stale", 5, 1_000);
  assert.equal(searches(), 7, "an answer to a request posted before invalidate() was not memoized");
  clearInterval(keepAlive);
  await c.dispose();
});

test("lanes: never more than MAX_WORKERS; past that a search queues on the least busy lane", async () => {
  const { c, spawned } = client(() => {
    /* never answers */
  });
  const waits = Array.from({ length: MAX_PENDING }, (_, i) => c.search("r", `q${String(i)}`, 5, 10_000));
  assert.equal(spawned.length, MAX_WORKERS);
  const perLane = spawned.map((w) => w.posted.filter((r) => r.kind === "search").length);
  assert.ok(Math.max(...perLane) - Math.min(...perLane) <= 1, `balanced: ${JSON.stringify(perLane)}`);
  await c.dispose();
  for (const w of waits) assert.deepEqual(await w, { skipped: "worker-error" });
});

test("lanes: a worker that dies fails only its own waiters; the other lane answers on", async () => {
  let releaseOther: (() => void) | null = null;
  const { c, spawned } = client((req, reply, self) => {
    if (req.text === "die") setImmediate(() => void self.terminate());
    else if (req.text === "hold") releaseOther = () => reply({ kind: "result", id: req.id, rows: [], ms: 1 });
    else setImmediate(() => reply({ kind: "result", id: req.id, rows: [], ms: 1 }));
  });
  const keepAlive = setInterval(() => {}, 1_000);
  const held = c.search("r", "hold", 5, 5_000);
  assert.deepEqual(await c.search("r", "die", 5, 5_000), { skipped: "worker-error" });
  assert.equal(c.workerCount, 1, "the dead lane is gone, the busy one stays");
  (releaseOther as unknown as () => void)();
  assert.deepEqual(await held, { rows: [] }, "the surviving lane's waiter is not failed");
  assert.equal(spawned.length, 2);
  clearInterval(keepAlive);
  await c.dispose();
});

// Row 1 review: a memo hit handed out the stored array, so a caller that sorted or edited it changed every later answer.
test("memo: neither the first caller nor a memo hit holds the stored rows", async () => {
  const { c } = client(answersAtOnce);
  const first = await c.search("r", "foo", 5, 1_000);
  assert.ok("rows" in first);
  first.rows[0]!.symbolId = "edited-by-first-caller";
  const hit = await c.search("r", "foo", 5, 1_000);
  assert.ok("rows" in hit);
  assert.deepEqual(hit.rows, [{ symbolId: "s1", distance: 0.5 }]);
  hit.rows.push({ symbolId: "pushed", distance: 1 });
  hit.rows[0]!.distance = 9;
  assert.deepEqual(await c.search("r", "foo", 5, 1_000), { rows: [{ symbolId: "s1", distance: 0.5 }] }, "the next hit is unchanged");
  await c.dispose();
});

// MCP-ISSUE-135: a better-sqlite3 scan cannot be interrupted, so a lane whose scan outlives the cap is replaced.
test("lane cap: a scan past laneCapMs retires its lane — waiters settled, worker terminated, the next search gets a fresh lane", async () => {
  const terminated: FakeWorker[] = [];
  const spawned: FakeWorker[] = [];
  const c = new VectorSearchWorkerClient("db.sqlite", {
    laneCapMs: 80,
    spawn: () => {
      const w = new FakeWorker((req, reply) => {
        if (!req.text.startsWith("stuck")) setImmediate(() => reply({ kind: "result", id: req.id, rows: [], ms: 1 }));
      });
      const kill = w.terminate.bind(w);
      w.terminate = () => {
        terminated.push(w);
        return kill();
      };
      spawned.push(w);
      return w as unknown as VectorWorkerLike;
    }
  });
  const keepAlive = setInterval(() => {}, 1_000);
  const t0 = performance.now();
  assert.deepEqual(await c.search("r", "stuck-a", 5, 20), { skipped: "budget" }, "the caller gives up at its budget");
  void c.search("r", "stuck-b", 5, 20);
  // Both lanes busy: this one queues behind a stuck scan, with a budget longer than the cap.
  const queued = c.search("r", "stuck-queued", 5, 10_000);
  assert.equal(spawned.length, MAX_WORKERS);
  assert.equal(c.pendingCount, 3);
  assert.deepEqual(await queued, { skipped: "worker-error" }, "the waiter behind the stuck scan is released at the cap, not at its budget");
  assert.ok(performance.now() - t0 < 2_000, `released at the cap (${String(Math.round(performance.now() - t0))} ms)`);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(c.retiredCount, 2);
  assert.deepEqual(terminated, spawned, "every stuck worker was terminated");
  assert.equal(c.workerCount, 0);
  assert.equal(c.pendingCount, 0, "a retired lane's requests no longer count against MAX_PENDING");
  assert.deepEqual(await c.search("r", "fine", 5, 1_000), { rows: [] });
  assert.equal(spawned.length, 3, "a fresh lane answered");
  clearInterval(keepAlive);
  await c.dispose();
});

test("lane cap: it bounds ONE scan — a lane answering each request inside the cap is never retired, however long its queue", async () => {
  // A serial fake: each request is answered 40 ms after the previous one, as a real worker scans one at a time.
  const c = new VectorSearchWorkerClient("db.sqlite", {
    laneCapMs: 70,
    spawn: () => {
      let tail = Promise.resolve();
      const w = new FakeWorker((req, reply) => {
        tail = tail.then(() => new Promise<void>((r) => setTimeout(() => {
          reply({ kind: "result", id: req.id, rows: [{ symbolId: req.text, distance: 0 }], ms: 40 });
          r();
        }, 40)));
      });
      return w as unknown as VectorWorkerLike;
    }
  });
  const outs = await Promise.all(Array.from({ length: MAX_PENDING }, (_, i) => c.search("r", `q${String(i)}`, 5, 5_000)));
  assert.deepEqual(outs.map((o) => ("rows" in o ? o.rows[0]!.symbolId : o.skipped)), ["q0", "q1", "q2", "q3"]);
  assert.equal(c.retiredCount, 0, "2 x 40 ms on one lane exceeds the 70 ms cap in total, but no single scan does");
  await c.dispose();
});

test("expired: a request still queued at its deadline is dropped unscanned; the caller sees `budget` and nothing is memoized", async () => {
  let opened = 0;
  const h = createSearchHandler({
    open: () => {
      opened++;
      throw new Error("no db in this test");
    },
    loadVec: () => true,
    now: () => 1_000
  });
  const req = (deadline: number | undefined): SearchReq => ({ kind: "search", id: 7, dbPath: "x", repoId: "r", text: "t", k: 1, ...(deadline === undefined ? {} : { deadline }) });
  assert.deepEqual(h.answer(req(1_000)), { kind: "expired", id: 7 });
  assert.deepEqual(h.answer(req(999)), { kind: "expired", id: 7 });
  assert.equal(opened, 0, "an expired request opens nothing and scans nothing");
  assert.equal(h.answer(req(1_001)).kind, "error", "a request inside its deadline is scanned (here: the open fails)");
  assert.equal(h.answer(req(undefined)).kind, "error", "no deadline: always scanned");
  assert.equal(opened, 2, "each scanned request tried to open: the two without an expired deadline");

  const { c, spawned } = client((r, reply) => setImmediate(() => reply({ kind: "expired", id: r.id })));
  assert.deepEqual(await c.search("r", "late", 5, 1_000), { skipped: "budget" });
  await c.search("r", "late", 5, 1_000);
  assert.equal(spawned[0]!.posted.filter((r) => r.kind === "search").length, 2, "an expired answer is not memoized");
  await c.dispose();
});

test("expired: only a request queued behind another scan carries a deadline; a lane's first request is always scanned", async () => {
  // Measured (17 Nov, scratch 200k vectors): a cold worker took ~2.5 s to boot and load sqlite-vec, so a deadline on the
  // first request expired it unscanned — the slow repo's padding was never memoized.
  const { c, spawned } = client(() => {
    /* never answers: every request stays in flight */
  });
  void c.search("r", "first-on-lane-1", 5, 1_000);
  void c.search("r", "first-on-lane-2", 5, 1_000);
  void c.search("r", "queued", 5, 1_000);
  const searches = spawned.flatMap((w) => w.posted.filter((r): r is SearchReq => r.kind === "search"));
  const byText = new Map(searches.map((r) => [r.text, r.deadline]));
  assert.equal(byText.get("first-on-lane-1"), undefined);
  assert.equal(byText.get("first-on-lane-2"), undefined);
  const d = byText.get("queued");
  assert.ok(typeof d === "number" && Math.abs(d - (Date.now() + 1_000)) < 1_000, `the queued one carries its deadline (${String(d)})`);
  await c.dispose();
});

// The served deployment runs dist/bundle/index.js (MCP-ISSUE-124), whose `new URL("./vectorSearchWorker.js",
// import.meta.url)` resolves inside dist/bundle/. Spawn the bundled worker for real on a scratch DB built by the store.
const BUNDLE = fileURLToPath(new URL("../../dist/bundle/", import.meta.url));
test("bundle: dist/bundle/vectorSearchWorker.js loads, opens a DB read-only and answers the KNN", { skip: existsSync(`${BUNDLE}index.js`) ? false : "no build" }, async (t) => {
  const bundledIndex = readFileSync(`${BUNDLE}index.js`, "utf8");
  assert.match(bundledIndex, /new URL\("\.\/vectorSearchWorker\.js", import\.meta\.url\)/, "the bundled server spawns the worker beside itself");
  const { GraphStore } = (await import(pathToFileURL(`${BUNDLE}../repositories/graphStore.js`).href)) as typeof import("./graphStore.js");
  const vectors = (await import(pathToFileURL(`${BUNDLE}../repositories/vectorStore.js`).href)) as typeof import("./vectorStore.js");
  const dir = mkdtempSync(path.join(tmpdir(), "vsw-bundle-"));
  const dbPath = path.join(dir, "index.db");
  const store = new GraphStore(dbPath);
  try {
    if (!store.isVectorEnabled) {
      t.skip("sqlite-vec not loadable here (or CODEBASE_INDEX_VECTOR_ENABLED=false)");
      return;
    }
    const writer = (store as unknown as { db: import("better-sqlite3").Database }).db;
    vectors.batchUpsertSymbolVectors(writer, "r", [
      { symbolId: "a", name: "sendNotificationEmail" },
      { symbolId: "b", name: "parseConfig" }
    ]);
    const c = new VectorSearchWorkerClient(dbPath, { spawn: () => new Worker(pathToFileURL(`${BUNDLE}vectorSearchWorker.js`)) as unknown as VectorWorkerLike });
    try {
      const out = await c.search("r", "sendNotificatonEmail", 1, 30_000);
      assert.deepEqual("rows" in out ? out.rows.map((r) => r.symbolId) : out, ["a"]);
    } finally {
      await c.dispose();
    }
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// Review (16 Nov): a worker whose sqlite-vec failed to load must not answer `rows: []` as a success (vectorStore's
// in-memory fallback is empty in that thread) — the padding would vanish without a word.
test("sqlite-vec load failure in the worker: every search is an error, reported as paddingSkipped worker-error", async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "vsw-novec-"));
  const dbPath = path.join(dir, "index.db");
  const store = new GraphStore(dbPath);
  try {
    if (!store.isVectorEnabled) {
      t.skip("sqlite-vec not loadable here (or CODEBASE_INDEX_VECTOR_ENABLED=false)");
      return;
    }
    batchUpsertSymbolVectors((store as unknown as { db: Database.Database }).db, "r", [{ symbolId: "a", name: "sendNotificationEmail" }]);
    const open = (p: string): Database.Database => new Database(p, { readonly: true, fileMustExist: true });
    const req = (id: number): SearchReq => ({ kind: "search", id, dbPath, repoId: "r", text: "sendNotificatonEmail", k: 1 });

    const failing = createSearchHandler({ open, loadVec: () => false });
    const failed = failing.answer(req(1));
    assert.equal(failed.kind, "error");
    assert.match(failed.kind === "error" ? failed.message : "", /sqlite-vec did not load/);
    assert.equal(failing.answer(req(2)).kind, "error", "and stays an error on the same connection");
    failing.close();

    // Control: the same handler with the real load answers the row.
    const working = createSearchHandler({ open, loadVec: (db) => initVectorStore(db, createRequire(import.meta.url)) });
    const ok = working.answer(req(3));
    assert.deepEqual(ok.kind === "result" ? ok.rows.map((r) => r.symbolId) : ok, ["a"]);
    working.close();

    // Through the client: the error reaches the caller as `worker-error`, not as an empty neighbour list.
    const replyWith = createSearchHandler({ open, loadVec: () => false });
    const { c } = client((r, reply) => setImmediate(() => reply(replyWith.answer(r))));
    assert.deepEqual(await c.search("r", "sendNotificatonEmail", 1, 5_000), { skipped: "worker-error" });
    await c.dispose();
    replyWith.close();
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the worker file sits beside the client (the spawner's `new URL('./vectorSearchWorker.js')`)", () => {
  // Under tsx the sources are .ts; under dist/ (and dist/bundle/, scripts/bundle.mjs ENTRIES) the .js twin.
  const here = fileURLToPath(new URL("./", import.meta.url));
  assert.ok(existsSync(`${here}vectorSearchWorker.ts`) || existsSync(`${here}vectorSearchWorker.js`));
});
