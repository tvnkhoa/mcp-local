import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import test from "node:test";

import { MAX_PENDING, VectorSearchWorkerClient, type VectorWorkerLike } from "./vectorSearchWorkerClient.js";
import type { VectorSearchMessage, VectorSearchRequest } from "./vectorSearchWorker.js";

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
  assert.deepEqual(await c.search("r", "slow", 5, 50), { skipped: "budget" });
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
  for (const w of waits) assert.deepEqual(await w, { skipped: "error" }, "dispose settles every waiter");
});

test("a worker error or exit settles its waiters with `error`; the next search spawns a fresh worker", async () => {
  const { c, spawned } = client((req, reply, self) => {
    if (req.text === "boom") setImmediate(() => reply({ kind: "error", id: req.id, message: "x" }));
    else if (req.text === "die") setImmediate(() => void self.terminate());
    else setImmediate(() => reply({ kind: "result", id: req.id, rows: [], ms: 1 }));
  });
  assert.deepEqual(await c.search("r", "boom", 5, 1_000), { skipped: "error" });
  assert.deepEqual(await c.search("r", "die", 5, 1_000), { skipped: "error" });
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

test("the worker file sits beside the client (the spawner's `new URL('./vectorSearchWorker.js')`)", () => {
  // Under tsx the sources are .ts; under dist/ (and dist/bundle/, scripts/bundle.mjs ENTRIES) the .js twin.
  const here = fileURLToPath(new URL("./", import.meta.url));
  assert.ok(existsSync(`${here}vectorSearchWorker.ts`) || existsSync(`${here}vectorSearchWorker.js`));
});
