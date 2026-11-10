/**
 * MCP-ISSUE-123: a parse job that outlives the pool's job timeout must not take the process down.
 *
 * tree-sitter 0.21's native parse does not survive `worker.terminate()` under it: the whole process exits 0xC0000409
 * with nothing on stderr. The pool used to terminate a timed-out worker; it now retires it. The pool runs in a CHILD
 * process here, because the failure is the process dying — red on 67e6ce3 (exit 0xC0000409), green after.
 *
 * The child hands the pool a fixture worker (`workerUrl`): the pool's message protocol around ONE real tree-sitter
 * parse, because the source-tree worker cannot load under tsx inside a worker thread. `POOL_MODULE` (env) points the
 * child at another build of the pool — an old `dist/`, whose pool ignores `workerUrl` and runs its own compiled
 * worker — for the red proof.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const poolModule = process.env.POOL_MODULE ?? pathToFileURL(fileURLToPath(new URL("./extractionWorkerPool.ts", import.meta.url))).href;
const packageRoot = fileURLToPath(new URL("../../../", import.meta.url));

const FIXTURE_WORKER = `
const { parentPort } = require("node:worker_threads");
const { createRequire } = require("node:module");
const req = createRequire(process.env.PACKAGE_ROOT + "/package.json");
const Parser = req("tree-sitter");
const parser = new Parser();
parser.setLanguage(req("tree-sitter-typescript").typescript);
parentPort.on("message", (message) => {
  if (message.type === "close") { parentPort.close(); return; }
  const t = Date.now();
  parser.parse(message.input.source, undefined, { bufferSize: Buffer.byteLength(message.input.source) * 2 + 1 });
  parentPort.postMessage({ id: message.id, status: "ok", output: { symbols: [], edges: [] }, parseMs: Date.now() - t });
});
`;

const CHILD = `
const { ExtractionWorkerPool } = await import(process.env.POOL_MODULE);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pool = new ExtractionWorkerPool(1, 300, { workerUrl: new URL(process.env.FIXTURE_URL) });
await sleep(3000); // the worker loads before the job's clock starts
const chunk = "export function f(a: number, b: string): Promise<Map<string, number[]>> { const x = [1,2,3].map((y) => ({ y, z: String(y) })); return new Promise((r) => r(new Map())); }\\n";
const big = chunk.repeat(12000); // ~2 MB: ~0.8 s of parse (solo), so the 300 ms timeout fires inside it
const first = await pool.extract({ repoId: "t", filePath: "big.ts", language: "typescript", source: big });
console.log("first " + first.status + " " + (first.reason ?? ""));
await sleep(3000); // a terminate mid-parse kills the process inside this window
const second = await pool.extract({ repoId: "t", filePath: "small.ts", language: "typescript", source: "export const a = 1;\\n" });
console.log("second " + second.status);
await pool.dispose();
console.log("SURVIVED retiring=" + String(pool.retiringCount ?? "n/a"));
`;

test("a job timed out mid-parse retires its worker and the process survives (MCP-ISSUE-123)", { timeout: 120_000 }, () => {
  // Files, not `-e`: workers inherit the parent's execArgv, and `--input-type` would break every worker.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pool-survival-"));
  const child = path.join(dir, "child.mjs");
  const fixture = path.join(dir, "fixture-worker.cjs");
  fs.writeFileSync(child, CHILD);
  fs.writeFileSync(fixture, FIXTURE_WORKER);
  let r;
  try {
    r = spawnSync(process.execPath, ["--import", "tsx", child], {
      encoding: "utf8",
      cwd: packageRoot,
      env: { ...process.env, POOL_MODULE: poolModule, FIXTURE_URL: pathToFileURL(fixture).href, PACKAGE_ROOT: packageRoot },
      timeout: 110_000
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const code = r.status === null ? null : r.status >>> 0;
  const detail = `exit ${code === null ? `signal ${String(r.signal)}` : `0x${code.toString(16)}`}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr.slice(-2000)}`;
  assert.notEqual(code, 0xc0000409, `the process died mid-parse (0xC0000409):\n${detail}`);
  assert.equal(code, 0, detail);
  assert.match(r.stdout, /^first timeout job-timeout$/m, detail);
  assert.match(r.stdout, /^second ok$/m, detail);
  assert.match(r.stdout, /^SURVIVED retiring=0$/m, detail);
});

test("MCP-ISSUE-123 review #4: repeated job timeouts never leave more retired workers than the pool size", { timeout: 60_000 }, async () => {
  // A plain-JS fixture (no tree-sitter: nothing here can crash the test process) that is busy 600 ms per job.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pool-cap-"));
  const fixture = path.join(dir, "slow-worker.cjs");
  fs.writeFileSync(
    fixture,
    `const { parentPort } = require("node:worker_threads");
parentPort.on("message", (m) => {
  if (m.type === "close") { parentPort.close(); return; }
  const until = Date.now() + 600;
  while (Date.now() < until) {}
  parentPort.postMessage({ id: m.id, status: "ok", output: { symbols: [], edges: [] }, parseMs: 600 });
});
`
  );
  const { ExtractionWorkerPool } = await import(poolModule);
  const pool = new ExtractionWorkerPool(1, 100, { workerUrl: pathToFileURL(fixture) });
  let maxRetiring = 0;
  const sampler = setInterval(() => {
    maxRetiring = Math.max(maxRetiring, pool.retiringCount);
  }, 5);
  try {
    await new Promise((r) => setTimeout(r, 300)); // the worker loads
    const input = { repoId: "t", filePath: "a.ts", language: "typescript", source: "export const a = 1;\n" };
    const results = await Promise.all([0, 1, 2, 3].map(() => pool.extract(input)));
    assert.deepEqual(results.map((r: { status: string }) => r.status), ["timeout", "timeout", "timeout", "timeout"]);
    const after = await pool.extract(input).catch(() => null);
    assert.ok(after, "the pool still answers");
    assert.ok(maxRetiring <= 1, `at most pool-size (1) retired workers at once, saw ${String(maxRetiring)}`);
  } finally {
    clearInterval(sampler);
    await pool.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("MCP-ISSUE-123 re-review D: a never-answering job held at the retire cap frees its slot when a retired worker exits", { timeout: 90_000 }, async () => {
  // Plain-JS fixture: SLOW is busy 600 ms then answers, HANG never answers (its event loop stays free, so it can close).
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pool-held-"));
  const fixture = path.join(dir, "fixture-worker.cjs");
  fs.writeFileSync(
    fixture,
    `const { parentPort } = require("node:worker_threads");
parentPort.on("message", (m) => {
  if (m.type === "close") { parentPort.close(); return; }
  if (m.input.source === "HANG") return;
  if (m.input.source === "SLOW") { const until = Date.now() + 600; while (Date.now() < until) {} }
  parentPort.postMessage({ id: m.id, status: "ok", output: { symbols: [], edges: [] }, parseMs: 0 });
});
`
  );
  const { ExtractionWorkerPool } = await import(poolModule);
  const pool = new ExtractionWorkerPool(1, 100, { workerUrl: pathToFileURL(fixture) });
  const job = (source: string) => pool.extract({ repoId: "t", filePath: "a.ts", language: "typescript", source });
  try {
    await new Promise((r) => setTimeout(r, 300)); // the worker loads
    const slow = job("SLOW"); // times out: retired (busy 600 ms more), a second worker takes the slot
    const hang = job("HANG"); // times out at the cap (one retired already): held, and never answers
    const after = job("export const a = 1;\n");
    assert.equal((await slow).status, "timeout");
    assert.equal((await hang).status, "timeout");
    // Before the fix it waited until dispose, so any bound shows it; 20 s leaves room for worker start-up under load.
    const served = await Promise.race([after, new Promise((r) => setTimeout(() => r("stuck"), 20_000).unref())]);
    assert.notEqual(served, "stuck", "the queued job is served once the retired worker left (it waited until dispose before)");
    // It may itself time out on the fresh worker's cold start (100 ms); once the workers settle the pool answers again.
    // Leader review: a fixed 1.5 s wait was load-sensitive. Under load a fresh worker starts slower than the 100 ms job
    // timeout, and each timed-out probe swaps in ANOTHER cold worker — so probes back off (0.5, 1, 2, 4 s …) to give the
    // newest worker time to load before the next probe's clock starts.
    let again = "";
    for (let wait = 500, deadline = Date.now() + 40_000; again !== "ok" && Date.now() < deadline; wait = Math.min(wait * 2, 8000)) {
      again = (await job("export const b = 2;\n")).status;
      if (again !== "ok") await new Promise((r) => setTimeout(r, wait));
    }
    assert.equal(again, "ok", "the pool answers again");
  } finally {
    await pool.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** Writes a plain-JS fixture worker (no tree-sitter: nothing here can crash the test process). */
function fixtureWorker(prefix: string, body: string): { url: URL; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const file = path.join(dir, "fixture-worker.cjs");
  fs.writeFileSync(file, `const { parentPort } = require("node:worker_threads");\n${body}\n`);
  return { url: pathToFileURL(file), cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const ANSWER = `parentPort.on("message", (m) => {
  if (m.type === "close") { parentPort.close(); return; }
  if (m.input.source === "DIE") process.exit(3);
  if (m.input.source === "EXIT0") process.exit(0);
  if (m.input.source === "SPIN") { for (;;) {} }
  parentPort.postMessage({ id: m.id, status: "ok", output: { symbols: [], edges: [] }, parseMs: 0 });
});`;

const within = <T,>(p: Promise<T>, ms: number): Promise<T | "stuck"> =>
  Promise.race([p, new Promise<"stuck">((r) => setTimeout(() => r("stuck"), ms).unref())]);

const job = (source: string) => ({ repoId: "t", filePath: "a.ts", language: "typescript", source });

test("MCP-ISSUE-123 review #5: a worker that exits on its own is replaced; the slot keeps serving", { timeout: 60_000 }, async () => {
  const fx = fixtureWorker("pool-respawn-", ANSWER);
  const { ExtractionWorkerPool } = await import(poolModule);
  const pool = new ExtractionWorkerPool(1, 30_000, { workerUrl: fx.url });
  try {
    const died = await within(pool.extract(job("DIE")), 10_000);
    assert.notEqual(died, "stuck");
    assert.equal((died as { status: string }).status, "error", "the dead worker's job is answered error");
    const next = await within(pool.extract(job("export const a = 1;\n")), 10_000);
    assert.notEqual(next, "stuck", "the slot was respawned (it stayed dead for the pool's life before)");
    assert.equal((next as { status: string }).status, "ok");
  } finally {
    await pool.dispose();
    fx.cleanup();
  }
});

test("MCP-ISSUE-123 review #5: a worker that dies at start is respawned at most MAX_RESPAWNS_PER_WINDOW times, then the pool degrades and says so", { timeout: 60_000 }, async () => {
  const fx = fixtureWorker("pool-storm-", `throw new Error("boom at start");`);
  const mod = await import(poolModule);
  const reported: { slot: number; respawns: number; deadSlots: number; size: number }[] = [];
  let spawnsSeen = 0;
  const pool = new mod.ExtractionWorkerPool(1, 30_000, { workerUrl: fx.url, onSlotDead: (e: (typeof reported)[number]) => reported.push(e) });
  try {
    const first = await within(pool.extract(job("export const a = 1;\n")), 15_000);
    assert.notEqual(first, "stuck", "the job is answered, not left waiting on a dead slot");
    assert.equal((first as { status: string }).status, "error");
    const deadline = Date.now() + 15_000;
    while (!pool.degraded && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    assert.equal(pool.degraded, true, "every slot dead: the pool says it is degraded");
    assert.equal(pool.deadSlots, 1);
    assert.deepEqual(reported.map((e) => [e.slot, e.respawns, e.deadSlots, e.size]), [[0, mod.MAX_RESPAWNS_PER_WINDOW, 1, 1]], "reported once, after the cap");
    const t0 = Date.now();
    const later = (await pool.extract(job("export const b = 2;\n"))) as { status: string; error?: string };
    assert.equal(later.status, "error");
    assert.match(later.error ?? "", /parse pool degraded/);
    assert.ok(Date.now() - t0 < 1000, "answered at once, no thread spawned per job");
    spawnsSeen = reported.length;
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(reported.length, spawnsSeen, "no further respawn");
  } finally {
    await pool.dispose();
    fx.cleanup();
  }
});

test("MCP-ISSUE-123 re-review E: dispose({ graceMs }) terminates a worker that never leaves its job; plain dispose keeps the retire grace", { timeout: 60_000 }, async () => {
  const fx = fixtureWorker("pool-shutdown-", ANSWER);
  const { ExtractionWorkerPool } = await import(poolModule);
  try {
    // Normal path: a job that never returns (JS spin) is retired, and a plain dispose waits for it — the retire grace
    // (60 s here) — instead of terminating it: ISSUE-123 A's guarantee for every run.
    const normal = new ExtractionWorkerPool(1, 200, { workerUrl: fx.url, retireGraceMs: 60_000 });
    await new Promise((r) => setTimeout(r, 300)); // the worker loads
    assert.equal((await normal.extract(job("SPIN"))).status, "timeout");
    const plain = normal.dispose();
    assert.equal(await within(plain, 1500), "stuck", "a plain dispose still waits for the retired worker");
    // A later shutdown dispose shortens the grace already running.
    assert.notEqual(await within(normal.dispose({ graceMs: 0 }), 5000), "stuck");
    await plain;

    // Shutdown path: the slot's own worker spins in its job; dispose({ graceMs: 500 }) ends within the bound.
    const pool = new ExtractionWorkerPool(1, 30_000, { workerUrl: fx.url, retireGraceMs: 60_000 });
    await new Promise((r) => setTimeout(r, 300));
    const spinning = pool.extract(job("SPIN"));
    await new Promise((r) => setTimeout(r, 200));
    const t0 = Date.now();
    assert.notEqual(await within(pool.dispose({ graceMs: 500 }), 5000), "stuck", "shutdown dispose is bounded by graceMs");
    assert.ok(Date.now() - t0 >= 400, "not before the grace");
    assert.equal((await spinning).status, "timeout");
    assert.equal(pool.retiringCount, 0);
  } finally {
    fx.cleanup();
  }
});

test("MCP-ISSUE-123 review #5 (leader nits): exit code 0 mid-job answers the job and respawns; the window expires; a degraded pool answers queued jobs", { timeout: 90_000 }, async () => {
  const fx = fixtureWorker("pool-respawn2-", ANSWER);
  const storm = fixtureWorker("pool-storm2-", `throw new Error("boom at start");`);
  const { ExtractionWorkerPool, MAX_RESPAWNS_PER_WINDOW } = await import(poolModule);
  const pool = new ExtractionWorkerPool(1, 30_000, { workerUrl: fx.url, respawnWindowMs: 1500, onSlotDead: () => undefined });
  const degraded = new ExtractionWorkerPool(1, 30_000, { workerUrl: storm.url, onSlotDead: () => undefined });
  try {
    // A worker exiting with code 0 in a job (ignored before: the job hung until its timeout).
    const zero = await within(pool.extract(job("EXIT0")), 10_000);
    assert.notEqual(zero, "stuck", "a code-0 exit answers the job");
    assert.equal((zero as { status: string }).status, "error");
    // Fill the window (the EXIT0 respawn counts), let it expire, then die again: respawned, not dead.
    for (let i = 1; i < MAX_RESPAWNS_PER_WINDOW; i++) assert.equal((await pool.extract(job("DIE"))).status, "error");
    await new Promise((r) => setTimeout(r, 1700));
    assert.equal((await pool.extract(job("DIE"))).status, "error");
    assert.equal(pool.deadSlots, 0, "respawns older than the window no longer count");
    const next = await within(pool.extract(job("export const a = 1;\n")), 10_000);
    assert.equal((next as { status: string }).status, "ok", "the slot keeps serving after the window expired");

    // Jobs queued while the slot burns through its respawns are all answered once the pool degrades.
    const queued = await within(Promise.all([0, 1, 2, 3].map((i) => degraded.extract(job(`export const q${String(i)} = 1;\n`)))), 15_000);
    assert.notEqual(queued, "stuck", "no queued job is left waiting");
    assert.deepEqual((queued as { status: string }[]).map((r) => r.status), ["error", "error", "error", "error"]);
    assert.equal(degraded.degraded, true);
  } finally {
    await pool.dispose();
    await degraded.dispose();
    fx.cleanup();
    storm.cleanup();
  }
});
