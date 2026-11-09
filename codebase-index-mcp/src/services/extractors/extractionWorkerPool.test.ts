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
