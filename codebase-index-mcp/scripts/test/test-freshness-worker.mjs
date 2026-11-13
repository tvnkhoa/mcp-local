/**
 * Release I1b — the R1 freshness gate's refresh runs in a worker thread, so a slow dirty refresh never
 * blocks the server's event loop.
 *
 * Fixture: two git repos under one temp root. `big` is GENERATED_FILES generated TS files whose
 * functions call one another across files by name (a large call population every run re-resolves);
 * `small` is a handful of files. No test-only hook in the server: the refresh is slow because the
 * repo is big. The server is spawned with `node --import _lagSampler.mjs dist/index.js` — the sampler
 * (test-only, outside src/) reports every main-thread tick later than 100 ms on stderr.
 *
 *   (a) a dirty edit to DIRTY_FILES files of `big`; the first search_symbols on `big` answers within
 *       its budget + 1 s (freshness "refreshing" when the run outlives the budget), while search_symbols
 *       on `small`, issued every 150 ms through the refresh, each answer in < 1 s;
 *   (b) no main-thread block > 250 ms from the trigger until the refresh has landed (the sampler), and
 *       a trivial list_repositories probe every 100 ms stays < 250 ms;
 *       after landing, the edit is found and the answer is current;
 *   (c) the F guard inside the worker: with the latest run's index_version forced to a newer
 *       generation, a refresh posted straight to the worker client (dist) is refused — the run rejects
 *       with the newer-build reason and no run row is written;
 *       IX-B: the repo has a previous index, so no search waits for the run: the first pays at most the
 *       bounded tree check, and each search that joins the running refresh waits < 200 ms;
 *   (d) the B.1 delete/revert repros (MCP-ISSUE-069) are test:query-refresh, which runs the same gate
 *       and therefore the worker path; not duplicated here.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { makeTempDir } from "./_fixtures.mjs";
import { attachServerStderr } from "./_serverStderr.mjs";
import "./_indexWait.mjs";

const GENERATED_FILES = Number(process.env.FRESHNESS_WORKER_FIXTURE_FILES ?? 1500);
const DIRTY_FILES = Number(process.env.FRESHNESS_WORKER_DIRTY_FILES ?? 300);
const BUDGET_MS = 300;
// Load-aware bound (row #19, 2026-11-13). Alone 17/17 green, but inside a local --changed suite (6208ca9) one tick was
// 296 ms late and one list_repositories probe took 307 ms — the setup's full run of `big` took 10.7 s there. The bound
// is calibrated on that setup run, measured in this process on this machine just before the window:
// max(BLOCK_FLOOR_MS, BLOCK_PER_SETUP_RUN × setup run ms). The suite case gives 0.035 × 10.7 s = 375 ms; solo on the
// same (shared) machine the setup run took 10.5-13.3 s, so the bound sat at 366-466 ms there too — on a machine whose
// setup run is under 7.1 s it is the 250 ms floor. A refresh back on the server thread blocks for whole run phases
// (seconds), far above it.
// FRESHNESS_WORKER_BLOCK_MS pins the bound. Negative control: FRESHNESS_WORKER_INJECT_BLOCK_MS=<ms> makes the server
// busy-wait that long once inside the window (a preload watching a sentinel file); with <ms> >= 3x the bound, (b) FAILS.
const BLOCK_FLOOR_MS = 250;
const BLOCK_PER_SETUP_RUN = 0.035;
const INJECT_BLOCK_MS = Number(process.env.FRESHNESS_WORKER_INJECT_BLOCK_MS ?? 0);

let passed = 0, failed = 0;
function assert(cond, label, detail = "") {
  if (cond) { console.log(`  PASS  ${label}`); passed++; }
  else { console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`); failed++; }
}
const txt = (r) => Array.isArray(r?.content) ? (r.content.find((x) => x.type === "text")?.text ?? "") : "";
const js = (r) => { try { return JSON.parse(txt(r)); } catch { return null; } };
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

function bigFiles(n) {
  const files = {};
  for (let i = 0; i < n; i++) {
    const body = [];
    for (let k = 0; k < 10; k++) {
      // Calls into other files by bare name: unresolved at extraction, bound by the post-phase resolver.
      const a = (i * 7 + k + 1) % n, b = (i * 13 + k + 3) % n;
      body.push(`export function fn_${i}_${k}(x: number): number {
  const y = fn_${a}_${(k + 1) % 10}(x) + fn_${b}_${(k + 2) % 10}(x - 1);
  return helper_${i % 50}(y) + Math.max(x, ${k});
}`);
    }
    if (i < 50) body.push(`export function helper_${i}(v: number): number {\n  return v * ${i};\n}`);
    files[`src/m${Math.floor(i / 100)}/file${i}.ts`] = `${body.join("\n\n")}\n`;
  }
  return files;
}

const root = makeTempDir("freshness-worker-");
const bigDir = join(root, "big");
const smallDir = join(root, "small");
const stamp = Date.now();
const bigRepo = `fw-big-${stamp}`;
const smallRepo = `fw-small-${stamp}`;
writeRepo(bigDir, bigFiles(GENERATED_FILES));
writeRepo(smallDir, { "src/a.ts": "export function smallAlpha(): number {\n  return 1;\n}\n", "src/b.ts": "import { smallAlpha } from './a';\nexport function smallBeta(): number {\n  return smallAlpha() + 1;\n}\n" });
const dbPath = join(root, ".index", "index.db");
mkdirSync(dirname(dbPath), { recursive: true });

const sampler = pathToFileURL(resolve("scripts/test/_lagSampler.mjs")).href;
const injectSentinel = join(root, "inject-block.now");
const injectPreload = `data:text/javascript,${encodeURIComponent(`
import fs from "node:fs";
import { isMainThread } from "node:worker_threads";
if (isMainThread) {
  const t = setInterval(() => {
    if (!fs.existsSync(${JSON.stringify(injectSentinel)})) return;
    fs.rmSync(${JSON.stringify(injectSentinel)}, { force: true });
    clearInterval(t);
    const end = Date.now() + ${INJECT_BLOCK_MS};
    while (Date.now() < end) { /* negative control: a synchronous block on the server thread */ }
  }, 50);
  t.unref();
}
`)}`;
const transport = new StdioClientTransport({
  command: "node",
  args: ["--import", sampler, ...(INJECT_BLOCK_MS > 0 ? ["--import", injectPreload] : []), "dist/index.js"],
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
const lags = [];
let landedLine = null;
let buf = "";
transport.stderr?.on("data", (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    const m = /^\[lag-sampler\] (.*)$/.exec(line);
    if (m) { try { lags.push(JSON.parse(m[1])); } catch { /* partial line */ } }
    else if (line.includes(`✓ index ${bigRepo}`)) landedLine = line.trim();
  }
});
const client = new Client({ name: "test-freshness-worker", version: "0.1.0" });
await client.connect(transport);
attachServerStderr(transport, "test-freshness-worker");

async function call(name, args) {
  const t0 = performance.now();
  const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 600_000 });
  return { ms: Math.round(performance.now() - t0), body: js(r), text: txt(r) };
}

try {
  let setupBigMs = 0;
  for (const [repoId, repoPath] of [[bigRepo, bigDir], [smallRepo, smallDir]]) {
    const r = await call("index_repository", { wait: true, repoId, repoPath, mode: "full" });
    if (repoId === bigRepo) setupBigMs = r.ms;
    assert(r.body && !r.body.error && (r.body.filesIndexed ?? r.body.summary?.filesIndexed ?? 1) > 0, `index_repository ${repoId}`, r.text.slice(0, 200));
  }
  // Settle both: clean trees at the indexed HEAD, so neither query below starts a run of its own. IX-B: a read no longer
  // waits for a run it starts (the repo has a previous index), so poll until each answers fresh — otherwise a settle run
  // lands inside the window below and its "✓ index" line ends the window early.
  for (const [repoId, query] of [[smallRepo, "smallAlpha"], [bigRepo, "fn_1_1"]]) {
    for (let i = 0; i < 240; i++) {
      const r = await call("search_symbols", { repoId, query, strategy: "name", limit: 5 });
      if (!r.body?.freshness || r.body.freshness.state === "fresh") break;
      await sleep(250);
    }
  }

  // (a) Dirty DIRTY_FILES files of big.
  for (let i = 0; i < DIRTY_FILES; i++) {
    appendFileSync(join(bigDir, `src/m${Math.floor(i / 100)}/file${i}.ts`), `\nexport function dirtyEdit_${i}(): number {\n  return fn_${(i + 1) % GENERATED_FILES}_0(${i});\n}\n`);
  }
  const lagFloor = lags.length;
  // MCP-ISSUE-125: the window ends when THIS refresh lands (its own "✓ index" line), not at the first answer that is
  // not "refreshing". A tree check slower than BUDGET_MS (two git spawns: 180-370 ms on a busy Windows machine) answers
  // "refreshing … checking the working tree" on an index that is already current, so that signal stretched a 5 s
  // refresh to a 118 s window (10 Nov) — 15x the exposure of (b) to an unrelated stall. The setup's own full run
  // printed a line too: forget it here.
  landedLine = null;
  const t0 = Date.now();
  const probes = [];
  let stop = false;
  const probeLoop = (async () => {
    while (!stop) {
      const p = await call("list_repositories", {});
      probes.push(p.ms);
      await sleep(100);
    }
  })();
  const smallTimes = [];
  const smallLoop = (async () => {
    await sleep(50);
    while (!stop) {
      const s = await call("search_symbols", { repoId: smallRepo, query: "smallBeta", strategy: "name", limit: 5 });
      smallTimes.push({ ms: s.ms, ok: s.text.includes("smallBeta"), state: s.body?.freshness?.state ?? "fresh", reason: (s.body?.freshness?.reason ?? "").slice(0, 40) });
      await sleep(150);
    }
  })();

  // Inside the window every call is a light one with name hits (no vector padding): the sampler is to
  // measure what the REFRESH does to the server thread, not a tool's own synchronous work.
  const lightBig = { repoId: bigRepo, query: "fn_7_1", strategy: "name", limit: 5 };
  const first = await call("search_symbols", lightBig);
  if (INJECT_BLOCK_MS > 0) writeFileSync(injectSentinel, "");
  console.log(`  info  first search on the dirty repo: ${first.ms} ms, freshness ${JSON.stringify(first.body?.freshness?.state ?? "fresh")}`);
  assert(first.ms < BUDGET_MS + 1000, "(a) the first query on the dirty repo answers within budget + 1 s", `${first.ms} ms`);
  const refreshing = first.body?.freshness?.state === "refreshing";
  // IX-B: the read that starts the refresh pays at most the tree check (bounded by the budget), never the run.
  const firstWait = first.body?.freshness?.waitedMs;
  const firstReason = first.body?.freshness?.reason ?? "";
  assert(refreshing && typeof firstWait === "number" && firstWait < BUDGET_MS + 200 && !firstReason.includes("re-index is still running after"),
    "(a) IX-B: the read that starts the refresh does not wait for the run (at most the bounded tree check)", `waitedMs ${String(firstWait)}, reason ${String(first.body?.freshness?.reason).slice(0, 80)}`);
  if (refreshing) {
    const conf = typeof first.body?.coverage === "string" ? first.body.coverage : first.body?.coverage?.confidence;
    assert(conf !== "high", "(a) ... and while refreshing its coverage is not high", JSON.stringify(first.body?.coverage));
  }

  let landed = refreshing ? null : first;
  const polls = [];
  for (let i = 0; i < 600 && !landed; i++) {
    await sleep(250);
    const r = await call("search_symbols", lightBig);
    polls.push({ at: Date.now() - t0, ms: r.ms, state: r.body?.freshness?.state ?? "fresh", waitedMs: r.body?.freshness?.waitedMs, reason: (r.body?.freshness?.reason ?? "").slice(0, 40), landedSeen: landedLine !== null });
    if (r.body?.freshness?.state !== "refreshing" || landedLine !== null) landed = r;
  }
  if (process.env.FRESHNESS_WORKER_DIAG) {
    console.log(`  diag  polls ${JSON.stringify(polls.slice(0, 40))}`);
    const counts = {};
    for (const s of smallTimes) counts[`${s.state}:${s.reason}`] = (counts[`${s.state}:${s.reason}`] ?? 0) + 1;
    console.log(`  diag  small states ${JSON.stringify(counts)}`);
  }
  const t1 = Date.now();
  stop = true;
  await Promise.all([probeLoop, smallLoop]);
  if (landed) landed = await call("search_symbols", { repoId: bigRepo, query: "dirtyEdit_7", strategy: "name", limit: 5 });
  const windowMs = t1 - t0;
  console.log(`  info  refresh window ${windowMs} ms (${landedLine ?? "no run line seen"}); small-repo searches: ${smallTimes.map((s) => s.ms).join(", ")} ms`);
  assert(refreshing, "(a) the fixture's dirty refresh outlives the budget (otherwise this harness measures nothing)", `window ${windowMs} ms`);
  assert(windowMs >= 1000, "(a) ... by at least a second", `${windowMs} ms`);
  // IX-B: every search that joined the running refresh answered without waiting for it.
  const joined = polls.filter((p) => p.state === "refreshing" && /re-index is running/.test(p.reason));
  console.log(`  info  searches that joined the refresh: ${joined.length}, waitedMs ${joined.map((p) => p.waitedMs).join(", ")}`);
  assert(joined.length >= 1 && joined.every((p) => typeof p.waitedMs === "number" && p.waitedMs < 200), "(a) IX-B: each search that joined the running refresh waited < 200 ms", JSON.stringify(joined.slice(0, 10)));
  assert(smallTimes.length >= 3, "(a) the other repo was queried during the refresh", `${smallTimes.length} calls`);
  assert(smallTimes.every((s) => s.ok && s.ms < 1000), "(a) every search on the other repo answered, each in < 1 s", JSON.stringify(smallTimes));
  assert(landed && landed.text.includes("dirtyEdit_7"), "(a) after landing, the dirty edit is found", landed?.text.slice(0, 200));

  const inWindow = lags.slice(lagFloor).filter((l) => l.at >= t0 && l.at <= t1);
  const windowLags = inWindow.filter((l) => !l.heartbeat);
  const heartbeats = inWindow.length - windowLags.length;
  // A maximum over an empty list is 0: without heartbeats "no block" and "no sampler" read the same.
  assert(heartbeats > 0, "(b) the lag sampler reported from inside the refresh window", `${String(heartbeats)} heartbeats`);
  const maxLag = Math.max(0, ...windowLags.map((l) => l.blockedMs));
  const maxProbe = Math.max(0, ...probes);
  const BLOCK_MS = Number(process.env.FRESHNESS_WORKER_BLOCK_MS || Math.max(BLOCK_FLOOR_MS, Math.round(BLOCK_PER_SETUP_RUN * setupBigMs)));
  console.log(`  info  main-thread ticks late > 100 ms during the refresh: ${windowLags.length}, max ${maxLag} ms; list_repositories probes n=${probes.length}, max ${maxProbe} ms`);
  console.log(`  info  bound ${BLOCK_MS} ms = ${process.env.FRESHNESS_WORKER_BLOCK_MS ? "FRESHNESS_WORKER_BLOCK_MS" : `max(${BLOCK_FLOOR_MS}, ${BLOCK_PER_SETUP_RUN} × setup run ${setupBigMs} ms)`}${INJECT_BLOCK_MS > 0 ? `; NEGATIVE CONTROL injected ${INJECT_BLOCK_MS} ms` : ""}`);
  assert(maxLag <= BLOCK_MS, `(b) no server main-thread block > ${BLOCK_MS} ms during the refresh`, JSON.stringify(windowLags.slice(0, 10)));
  assert(probes.length >= 5 && maxProbe < BLOCK_MS, `(b) a trivial tool answers in < ${BLOCK_MS} ms throughout`, `n=${probes.length} max=${maxProbe}`);
} finally {
  // Row 15: the race's timer is cleared once close settles. Left running, it held the event loop 5 s into (c) and hid
  // that (c) holds nothing of its own — the CI exit 13 (69ae7e7, run 42772428018).
  let closeBound;
  await Promise.race([client.close().catch(() => {}), new Promise((r) => { closeBound = setTimeout(r, 5000); })]);
  clearTimeout(closeBound);
}

// (c) The F guard inside the worker, through the real worker (dist), after the server is gone.
{
  const require = createRequire(import.meta.url);
  const Database = require("better-sqlite3");
  const db = new Database(dbPath);
  db.pragma("busy_timeout = 10000");
  const latest = db.prepare("select run_id as runId from index_runs where repo_id = ? order by finished_at desc, rowid desc limit 1").get(bigRepo);
  db.prepare("update index_runs set index_version = 'v99-from-the-future' where run_id = ?").run(latest.runId);
  const runsBefore = db.prepare("select count(*) as n from index_runs where repo_id = ?").get(bigRepo).n;
  db.close();
  appendFileSync(join(bigDir, "src/m0/file1.ts"), "\nexport function afterTheFuture(): number {\n  return 1;\n}\n");

  const { RefreshWorkerClient } = await import(pathToFileURL(resolve("dist/services/indexing/refreshWorkerClient.js")).href);
  let landedHook = 0;
  const worker = new RefreshWorkerClient({
    dbPath,
    limits: { subtxSize: 20, checkpointEveryNBatches: 1, largeFileThresholdBytes: 0, maxFileSizeBytes: 500_000, parseWorkers: 1, parseJobTimeoutMs: 20_000 },
    onRunLanded: () => landedHook++
  });
  // Row 15: the client unrefs its worker, as a server wants — its stdin holds the loop. `dispose` now holds the loop
  // itself (its fallback timer is ref'd), but an awaited `run` still does not: this script has no handle of its own,
  // so it holds the loop until the worker is gone. Without it the loop emptied while `dispose` awaited the worker's
  // exit: Node exit 13 (CI, 69ae7e7).
  const holdLoop = setInterval(() => {}, 1_000);
  let error = null;
  try {
    await worker.run(bigRepo, bigDir, "dirty", true, 20_000, 200);
  } catch (e) {
    error = e;
  } finally {
    await worker.dispose();
    clearInterval(holdLoop);
  }
  assert(error && /refused: .*newer codebase-index build \(v99-from-the-future\)/.test(error.message), "(c) the worker refuses to write over a newer build's index", error?.message ?? "the run succeeded");
  assert(landedHook === 0, "(c) ... and nothing is reported as landed");
  const after = new Database(dbPath, { readonly: true });
  const runsAfter = after.prepare("select count(*) as n from index_runs where repo_id = ?").get(bigRepo).n;
  const leaked = after.prepare("select count(*) as n from symbols where repo_id = ? and name = 'afterTheFuture'").get(bigRepo).n;
  after.close();
  assert(runsAfter === runsBefore && leaked === 0, "(c) ... and wrote no run row and no symbol", `runs ${runsBefore} -> ${runsAfter}, symbols ${leaked}`);
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
