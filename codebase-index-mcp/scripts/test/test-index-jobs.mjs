/**
 * MCP-ISSUE-112 (IX-2) — index_repository is a server-side job.
 *
 * One HTTP server (`--transport http`, `--import _lagSampler.mjs`), one process for every client, as the shared
 * server runs. Two repos: `big` (generated, a run of several seconds) and `small`.
 *   (a) client A queues `big` then `small` with the default wait:false: each answers at once with a runId and
 *       state running|queued; `small` says it waits behind `big`;
 *   (b) client A disconnects while `big` is running; client B (a new session) polls index_status: both jobs reach
 *       `ok`, in order, and the runIds are the runs' own (health_check's latestRun names them);
 *   (c) the server thread is never blocked > MAX_BLOCK_MS while the runs execute (they run in the worker);
 *   (d) wait:true answers the finished run summary with state ok; index_status of an unknown runId is an error.
 * The free-RAM floor is unit-tested with an injected reader (src/services/indexing/indexJobs.test.ts); here it is 0.
 */
import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { makeTempDir } from "./_fixtures.mjs";
import { indexStatusVia, waitForIndexJob } from "./_indexWait.mjs";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TOKEN = "ix2-jobs-token-".padEnd(48, "x");
const GENERATED_FILES = Number(process.env.JOBS_FIXTURE_FILES ?? 1200);
const MAX_BLOCK_MS = Number(process.env.JOBS_MAX_BLOCK_MS ?? 250);
const SERVER_START_MS = 120_000;

let passed = 0, failed = 0;
function assert(cond, label, detail = "") {
  if (cond) { console.log(`  PASS  ${label}`); passed++; }
  else { console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`); failed++; }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const txt = (r) => (Array.isArray(r?.content) ? (r.content.find((x) => x.type === "text")?.text ?? "") : "");
const js = (r) => { try { return JSON.parse(txt(r)); } catch { return null; } };
const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, "-c", "user.email=t@t", "-c", "user.name=t", ...args], { stdio: "pipe" });

function writeRepo(dir, files) {
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text, "utf8");
  }
  git(dir, "init", "-q");
  git(dir, "config", "core.autocrlf", "false");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "fixture");
}
function generated(n) {
  const files = {};
  for (let i = 0; i < n; i++) {
    const body = [];
    for (let k = 0; k < 10; k++) {
      const a = (i * 7 + k + 1) % n, b = (i * 13 + k + 3) % n;
      body.push(`export function fj_${i}_${k}(x: number): number {\n  return fj_${a}_${(k + 1) % 10}(x) + fj_${b}_${(k + 2) % 10}(x - 1);\n}`);
    }
    files[`src/m${Math.floor(i / 100)}/file${i}.ts`] = `${body.join("\n\n")}\n`;
  }
  return files;
}
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}
function rawStatus(port) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: "/mcp", method: "POST", headers: { host: `127.0.0.1:${port}`, "content-type": "application/json", accept: "application/json, text/event-stream" } },
      (res) => { res.resume(); resolve(res.statusCode); }
    );
    req.on("error", reject);
    req.end(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }));
  });
}
async function connect(port, name) {
  const client = new Client({ name, version: "0" });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${TOKEN}` } }
  });
  await client.connect(transport);
  return { client, transport };
}
async function call(c, name, args) {
  const t0 = performance.now();
  const r = await c.client.callTool({ name, arguments: args }, undefined, { timeout: 300_000 });
  return { ms: Math.round(performance.now() - t0), body: js(r), text: txt(r), isError: r.isError === true };
}

const tmp = makeTempDir("cbi-jobs-");
const stamp = Date.now();
const big = { id: `jobs-big-${stamp}`, dir: path.join(tmp, "big") };
const small = { id: `jobs-small-${stamp}`, dir: path.join(tmp, "small") };
writeRepo(big.dir, generated(GENERATED_FILES));
writeRepo(small.dir, { "src/a.ts": "export function jobsAlpha(): number {\n  return 1;\n}\n" });

const port = await freePort();
const sampler = pathToFileURL(path.join(ROOT, "scripts/test/_lagSampler.mjs")).href;
const lags = [];
let buf = "";
const child = spawn(process.execPath, ["--import", sampler, path.join(ROOT, "dist", "index.js"), "--transport", "http"], {
  env: {
    ...process.env,
    CODEBASE_INDEX_ALLOWED_ROOTS: tmp,
    CODEBASE_INDEX_DB_PATH: path.join(tmp, "index.db"),
    CODEBASE_INDEX_HTTP_PORT: String(port),
    CODEBASE_INDEX_HTTP_TOKEN: TOKEN,
    CODEBASE_INDEX_REFACTOR_APPROVAL_SECRET: "test-index-jobs-secret-0123456789abcdef",
    CODEBASE_INDEX_WATCH_AUTO_START_ENABLED: "false",
    CODEBASE_INDEX_MIN_FREE_RAM_MB: "0",
    LAG_SAMPLER_REPORT_MS: "100"
  },
  stdio: ["ignore", "ignore", "pipe"]
});
child.stderr.on("data", (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    const m = /^\[lag-sampler\] (.*)$/.exec(line);
    if (m) { try { lags.push(JSON.parse(m[1])); } catch { /* partial */ } }
  }
});

try {
  const deadline = Date.now() + SERVER_START_MS;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`server exited early (${child.exitCode})`);
    try { if ((await rawStatus(port)) === 401) break; } catch { /* not yet */ }
    if (Date.now() > deadline) throw new Error("server did not start");
    await sleep(200);
  }

  // (a)
  const A = await connect(port, "jobs-a");
  const t0 = Date.now();
  const qBig = await call(A, "index_repository", { repoId: big.id, repoPath: big.dir, mode: "full" });
  const qSmall = await call(A, "index_repository", { repoId: small.id, repoPath: small.dir, mode: "full" });
  console.log(`  info  enqueue big ${qBig.ms} ms ${qBig.text.slice(0, 160)}`);
  console.log(`  info  enqueue small ${qSmall.ms} ms ${qSmall.text.slice(0, 200)}`);
  assert(!qBig.isError && typeof qBig.body?.runId === "string" && ["queued", "running"].includes(qBig.body?.state), "(a) index_repository answers a runId and state queued|running", qBig.text.slice(0, 200));
  assert(qBig.ms < 2000 && qSmall.ms < 2000, "(a) ... at once (< 2 s each)", `${qBig.ms} / ${qSmall.ms} ms`);
  assert(qSmall.body?.state === "queued" && /another index run is in progress/.test(qSmall.body?.waitingFor ?? ""), "(a) the second repo is queued behind the first, and says so", qSmall.text.slice(0, 300));

  // (b) A goes away mid-run.
  const midA = await call(A, "index_status", { runId: qBig.body.runId });
  assert(midA.body?.state === "running", "(b) the first job is running when its client disconnects", midA.text.slice(0, 200));
  await A.transport.terminateSession?.().catch(() => {});
  await A.client.close();

  const B = await connect(port, "jobs-b");
  const states = { big: [], small: [] };
  let bigDone = null, smallDone = null;
  for (let i = 0; i < 1200 && !(bigDone && smallDone); i++) {
    if (!bigDone) {
      const s = await call(B, "index_status", { runId: qBig.body.runId });
      states.big.push(s.body?.state);
      if (s.body?.state === "ok" || s.body?.state === "failed") bigDone = s;
    }
    if (!smallDone) {
      const s = await call(B, "index_status", { runId: qSmall.body.runId });
      states.small.push(s.body?.state);
      if (s.body?.state === "ok" || s.body?.state === "failed") smallDone = s;
    }
    await sleep(250);
  }
  const t1 = Date.now();
  console.log(`  info  window ${t1 - t0} ms; big phases seen: ${[...new Set(states.big)].join(",")}; small: ${[...new Set(states.small)].join(",")}`);
  assert(bigDone?.body?.state === "ok" && (bigDone.body.filesIndexed ?? 0) >= GENERATED_FILES, "(b) a new client sees the disconnected client's job end ok", bigDone?.text.slice(0, 300));
  assert(smallDone?.body?.state === "ok", "(b) the queued second repo ends ok too", smallDone?.text.slice(0, 300));
  assert(bigDone && smallDone && bigDone.body.finishedAt <= smallDone.body.startedAt, "(b) one run at a time: the second started after the first finished", `${bigDone?.body?.finishedAt} / ${smallDone?.body?.startedAt}`);
  const health = await call(B, "health_check", { repoId: big.id });
  const latest = health.body?.latestRun?.runId ?? health.body?.repo?.latestRun?.runId ?? null;
  assert(latest === qBig.body.runId || health.text.includes(qBig.body.runId), "(b) the job's runId is the recorded run's id (health_check)", health.text.slice(0, 300));

  // (c)
  const inWindow = lags.filter((l) => l.at >= t0 && l.at <= t1);
  const blocks = inWindow.filter((l) => !l.heartbeat);
  const maxLag = Math.max(0, ...blocks.map((l) => l.blockedMs));
  console.log(`  info  server-thread ticks late > 100 ms during the runs: ${blocks.length}, max ${maxLag} ms`);
  assert(inWindow.length > blocks.length, "(c) the lag sampler reported from inside the window");
  assert(maxLag <= MAX_BLOCK_MS, `(c) no server-thread block > ${MAX_BLOCK_MS} ms while the jobs ran`, JSON.stringify(blocks.slice(0, 8)));

  // (d)
  fs.appendFileSync(path.join(small.dir, "src/a.ts"), "export function jobsBeta(): number {\n  return 2;\n}\n");
  const waited = await call(B, "index_repository", { repoId: small.id, repoPath: small.dir, mode: "full", wait: true });
  assert(waited.body?.state === "ok" && typeof waited.body?.filesIndexed === "number" && waited.body?.runId, "(d) wait:true answers the finished run summary, state ok", waited.text.slice(0, 300));
  const unknown = await call(B, "index_status", { runId: "00000000-0000-0000-0000-000000000000" });
  assert(unknown.isError && /unknown runId/.test(unknown.text), "(d) index_status of an unknown runId is an error", unknown.text.slice(0, 200));
  await B.client.close();
} catch (error) {
  assert(false, "harness ran to the end", error instanceof Error ? error.stack ?? error.message : String(error));
} finally {
  child.kill();
  await sleep(500);
}

// (e) Follow-up 1: under its free-RAM floor a job stays queued, says why, and a bounded wait gives up instead of looping.
{
  const floored = new StdioClientTransport({
    command: "node",
    args: [path.join(ROOT, "dist", "index.js")],
    env: { ...process.env, CODEBASE_INDEX_ALLOWED_ROOTS: tmp, CODEBASE_INDEX_DB_PATH: path.join(tmp, "floor.db"), CODEBASE_INDEX_MIN_FREE_RAM_MB: "999999999" },
    stderr: "pipe"
  });
  const c = new Client({ name: "jobs-floor", version: "0" });
  try {
    await c.connect(floored);
    const r = await c.callTool({ name: "index_repository", arguments: { repoId: `floor-${stamp}`, repoPath: small.dir, mode: "full" } });
    const first = js(r);
    assert(first?.state === "queued" && /below CODEBASE_INDEX_MIN_FREE_RAM_MB=999999999/.test(first?.waitingFor ?? ""), "(e) under the RAM floor the job stays queued and says why", txt(r).slice(0, 300));
    let threw = "";
    const t0 = Date.now();
    try {
      await waitForIndexJob(indexStatusVia(c), first, { deadlineMs: 1500, intervalMs: 250 });
    } catch (e) {
      threw = e instanceof Error ? e.message : String(e);
    }
    assert(/still queued after 1500 ms [(]free RAM/.test(threw) && Date.now() - t0 < 5000, "(e) the bounded wait gives up with the reason, it never loops forever", threw);
  } catch (error) {
    assert(false, "(e) ran", error instanceof Error ? error.message : String(error));
  } finally {
    await Promise.race([c.close().catch(() => {}), sleep(5000)]);
  }
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
