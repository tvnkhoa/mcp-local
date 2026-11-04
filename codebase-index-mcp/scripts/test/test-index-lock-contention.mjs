/**
 * MCP-ISSUE-111 — "database is locked" while another repo indexes (wec.aria D1/D2, 4 Nov).
 *
 * Every repo shares one SQLite file. The harness reproduces the live shape on a scratch DB:
 *   - server A (stdio, `--import _lagSampler.mjs`) runs index_repository mode full on `big` (a second repo);
 *   - server B, a second PROCESS on the same DB (a stdio session beside the HTTP server), runs a full index of
 *     `peer` at the same time — a cross-process writer;
 *   - meanwhile READS: >= 24 calls on `small`, whose working tree is dirty so each call goes through the freshness
 *     gate (a refresh run + its bookkeeping writes), plus reads on `big` while it is being written.
 * Asserts:
 *   (a) 0 responses mention "locked" / SQLITE_BUSY, and both index runs end ok;
 *   (b) every read answers within the query budget + 2 s, and the server thread's longest block is bounded
 *       (LOCK_MAX_BLOCK_MS, default 1000: the runs execute in the worker since IX-2; reads on the repo being
 *       rewritten keep ~470 ms of their own work);
 *   (c) after the runs, the dirty edit on `small` is in the index (the queued refresh ran, behind `big`'s run).
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { makeTempDir } from "./_fixtures.mjs";
import { attachServerStderr } from "./_serverStderr.mjs";
import "./_indexWait.mjs";

const GENERATED_FILES = Number(process.env.LOCK_FIXTURE_FILES ?? 1200);
const READS = Number(process.env.LOCK_READS ?? 24);
const BUDGET_MS = 300;
// IX-1 measured max 2834 ms with index_repository on the server thread. Since IX-2 (MCP-ISSUE-112) every run is the
// worker's and the server thread only reads; what is left is the reads' own synchronous work — a search on `big` while
// its full run rewrites it measured ~470 ms. test:index-jobs bounds the runs alone at 250 ms.
const MAX_BLOCK_MS = Number(process.env.LOCK_MAX_BLOCK_MS ?? 1000);
const LOCKED = /database is locked|SQLITE_BUSY/i;

let passed = 0, failed = 0;
function assert(cond, label, detail = "") {
  if (cond) { console.log(`  PASS  ${label}`); passed++; }
  else { console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`); failed++; }
}
const txt = (r) => Array.isArray(r?.content) ? (r.content.find((x) => x.type === "text")?.text ?? "") : "";
const js = (t) => { try { return JSON.parse(t); } catch { return null; } };
const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, "-c", "user.email=t@t", "-c", "user.name=t", ...args], { stdio: "pipe" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function writeRepo(dir, files) {
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text, "utf8");
  }
  git(dir, "init", "-q");
  git(dir, "config", "core.autocrlf", "false");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "fixture");
}

function generated(n, prefix) {
  const files = {};
  for (let i = 0; i < n; i++) {
    const body = [];
    for (let k = 0; k < 10; k++) {
      const a = (i * 7 + k + 1) % n, b = (i * 13 + k + 3) % n;
      body.push(`export function ${prefix}_${i}_${k}(x: number): number {
  const y = ${prefix}_${a}_${(k + 1) % 10}(x) + ${prefix}_${b}_${(k + 2) % 10}(x - 1);
  return Math.max(y, ${k});
}`);
    }
    files[`src/m${Math.floor(i / 100)}/file${i}.ts`] = `${body.join("\n\n")}\n`;
  }
  return files;
}

const root = makeTempDir("index-lock-");
const stamp = Date.now();
const repos = {
  big: { id: `lk-big-${stamp}`, dir: join(root, "big") },
  peer: { id: `lk-peer-${stamp}`, dir: join(root, "peer") },
  small: { id: `lk-small-${stamp}`, dir: join(root, "small") }
};
writeRepo(repos.big.dir, generated(GENERATED_FILES, "fb"));
writeRepo(repos.peer.dir, generated(Math.round(GENERATED_FILES / 2), "fp"));
writeRepo(repos.small.dir, {
  "src/a.ts": "export function smallAlpha(): number {\n  return 1;\n}\n",
  "src/b.ts": "import { smallAlpha } from './a';\nexport function smallBeta(): number {\n  return smallAlpha() + 1;\n}\n"
});
const dbPath = join(root, ".index", "index.db");
mkdirSync(dirname(dbPath), { recursive: true });

function server(name, withSampler, onLine) {
  const sampler = pathToFileURL(resolve("scripts/test/_lagSampler.mjs")).href;
  const transport = new StdioClientTransport({
    command: "node",
    args: [...(withSampler ? ["--import", sampler] : []), "dist/index.js"],
    env: {
      ...process.env,
      CODEBASE_INDEX_ALLOWED_ROOTS: root,
      CODEBASE_INDEX_DB_PATH: dbPath,
      CODEBASE_INDEX_LLM_ENABLED: "false",
      CODEBASE_INDEX_QUERY_REFRESH_BUDGET_MS: String(BUDGET_MS),
      LAG_SAMPLER_REPORT_MS: "100"
    },
    stderr: "pipe"
  });
  let buf = "";
  transport.stderr?.on("data", (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      onLine?.(line);
    }
  });
  const client = new Client({ name, version: "0.1.0" });
  return { client, transport };
}

const lags = [];
const lockedLines = [];
const onA = (line) => {
  const m = /^\[lag-sampler\] (.*)$/.exec(line);
  if (m) { try { lags.push(JSON.parse(m[1])); } catch { /* partial */ } }
  if (LOCKED.test(line)) lockedLines.push(`A: ${line.trim()}`);
};
const A = server("lock-a", true, onA);
const B = server("lock-b", false, (line) => { if (LOCKED.test(line)) lockedLines.push(`B: ${line.trim()}`); });
await A.client.connect(A.transport);
attachServerStderr(A.transport, "test-index-lock-contention:A");
await B.client.connect(B.transport);
attachServerStderr(B.transport, "test-index-lock-contention:B");

async function call(c, name, args) {
  const t0 = performance.now();
  try {
    const r = await c.callTool({ name, arguments: args }, undefined, { timeout: 600_000 });
    const t = txt(r);
    return { ms: Math.round(performance.now() - t0), body: js(t), text: t, isError: r.isError === true };
  } catch (e) {
    return { ms: Math.round(performance.now() - t0), body: null, text: String(e?.message ?? e), isError: true };
  }
}

try {
  // Baseline: small and a first version of big, so big's second full run rewrites an existing repo.
  for (const r of [repos.small, repos.big]) {
    const res = await call(A.client, "index_repository", { wait: true, repoId: r.id, repoPath: r.dir, mode: "full" });
    assert(!res.isError && !LOCKED.test(res.text), `baseline index_repository ${r.id}`, res.text.slice(0, 200));
  }
  await call(A.client, "search_symbols", { repoId: repos.small.id, query: "smallAlpha", strategy: "name", limit: 5 });

  // Dirty small: every read on it now goes through a gate refresh.
  appendFileSync(join(repos.small.dir, "src/a.ts"), "\nexport function lockProbeEdit(): number {\n  return 2;\n}\n");

  const t0 = Date.now();
  const lagFloor = lags.length;
  const bigRun = call(A.client, "index_repository", { wait: true, repoId: repos.big.id, repoPath: repos.big.dir, mode: "full" });
  const peerRun = call(B.client, "index_repository", { wait: true, repoId: repos.peer.id, repoPath: repos.peer.dir, mode: "full" });
  await sleep(300);

  const reads = [];
  for (let i = 0; i < READS; i++) {
    const onSmall = i % 3 !== 2;
    const args = onSmall
      ? { repoId: repos.small.id, query: i % 2 ? "smallBeta" : "smallAlpha", strategy: "name", limit: 5 }
      : { repoId: repos.big.id, query: `fb_${i}_1`, strategy: "name", limit: 5 };
    reads.push({ repo: onSmall ? "small" : "big", ...(await call(A.client, "search_symbols", args)) });
    await sleep(150);
  }
  const [big, peer] = await Promise.all([bigRun, peerRun]);
  const t1 = Date.now();

  const lockedReads = reads.filter((r) => LOCKED.test(r.text));
  const erroredReads = reads.filter((r) => r.isError);
  console.log(`  info  window ${t1 - t0} ms; reads ${reads.length}: ${reads.map((r) => `${r.repo}:${r.ms}${r.body?.freshness ? `/${r.body.freshness.state}` : ""}`).join(" ")}`);
  console.log(`  info  big run ${big.ms} ms (${big.text.slice(0, 120)}); peer run (2nd process) ${peer.ms} ms (${peer.text.slice(0, 120)})`);
  assert(reads.length >= 20, `(a) >= 20 reads during the runs`, String(reads.length));
  assert(lockedReads.length === 0, "(a) 0 reads answered 'database is locked' / SQLITE_BUSY", JSON.stringify(lockedReads.map((r) => r.text.slice(0, 160))));
  assert(erroredReads.length === 0, "(a) 0 reads errored", JSON.stringify(erroredReads.map((r) => r.text.slice(0, 160))));
  assert(!big.isError && !LOCKED.test(big.text), "(a) the second repo's full run (server A) ended ok", big.text.slice(0, 200));
  assert(!peer.isError && !LOCKED.test(peer.text), "(a) the other process's full run (server B) ended ok", peer.text.slice(0, 200));
  assert(lockedLines.length === 0, "(a) neither server logged a lock error", lockedLines.slice(0, 5).join(" | "));

  const slow = reads.filter((r) => r.ms > BUDGET_MS + 2000);
  assert(slow.length === 0, `(b) every read answered within the budget + 2 s`, JSON.stringify(slow.map((r) => `${r.repo}:${r.ms}`)));
  const inWindow = lags.slice(lagFloor).filter((l) => l.at >= t0 && l.at <= t1);
  const blocks = inWindow.filter((l) => !l.heartbeat);
  const maxLag = Math.max(0, ...blocks.map((l) => l.blockedMs));
  console.log(`  info  server A main-thread ticks late > 100 ms: ${blocks.length}, max ${maxLag} ms`);
  assert(inWindow.length > blocks.length, "(b) the lag sampler reported from inside the window");
  assert(maxLag <= MAX_BLOCK_MS, `(b) no server-thread block > ${MAX_BLOCK_MS} ms`, JSON.stringify(blocks.slice(0, 10)));

  let found = null;
  for (let i = 0; i < 120 && !found; i++) {
    const r = await call(A.client, "search_symbols", { repoId: repos.small.id, query: "lockProbeEdit", strategy: "name", limit: 5 });
    if (r.text.includes("lockProbeEdit") && r.body?.freshness?.state !== "refreshing") found = r;
    else await sleep(250);
  }
  assert(found !== null, "(c) the dirty edit on the read repo is indexed once the queue drains");
} finally {
  await Promise.race([Promise.all([A.client.close().catch(() => {}), B.client.close().catch(() => {})]), sleep(5000)]);
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
