/**
 * MCP-ISSUE-135 — query_graph's timeoutMs is enforced, and a runaway statement never blocks the server thread.
 *
 * 16 Nov: a correlated-subquery SELECT on wec.be (timeoutMs 30000) ran synchronously on the served process's main
 * thread for 300 s+; every session's calls timed out until the process was restarted. The statement now runs in a
 * child process (`queryGraphRunner.ts`) that the server kills at timeoutMs.
 *
 * On a scratch DB (never the live one) holding a generated TypeScript repo, a deliberately cubic SELECT over `edges`:
 *   (a) a normal query_graph answers the same rows as runReadOnlyGraphQueryImpl on the DB directly; cold and warm
 *       latencies are printed;
 *   (b) ×3: the cubic query answers QUERY_TIMEOUT naming the budget; the server stopped it at timeoutMs ± 10% and the
 *       call answered within that plus a normal call's own overhead (the freshness gate etc., ~200 ms here); meanwhile
 *       list_repositories answers < PROBE_BOUND_MS and health_check (which spawns git, so it slows under the child's
 *       CPU load) never waits for the statement; the killed child's pid is gone afterwards and a fresh child (another
 *       pid) is ready; child RAM idle / busy is printed;
 *   (c) a child killed from outside mid-query fails that call cleanly (an error, not a hang), and the next call answers;
 *   (d) the next normal query answers.
 *
 * Negative control: QG_SERVER_ENTRY=<a dist/index.js built before the fix, inside this package so its imports resolve>
 * runs the old server; (b) must FAIL (the probes wait for the whole statement; each call has a request timeout, so the
 * harness ends).
 *
 * Real-repo repro: QG_REPO_PATH=<repo> QG_REPO_ID=<id> indexes that repo into the scratch DB instead of the fixture and,
 * with QG_SQL_FILE=<file>, runs that SQL as the runaway query (the 16 Nov wec.be query is in ISSUE-135).
 *   QG_TIMEOUT_MS (default 2000), QG_ROUNDS (default 3).
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import Database from "better-sqlite3";
import { makeTempDir } from "./_fixtures.mjs";
import { attachServerStderr } from "./_serverStderr.mjs";
import { indexStatusVia, waitForIndexJob } from "./_indexWait.mjs";

const CI_FACTOR = process.env.CI ? 2.5 : 1;
const TIMEOUT_MS = Number(process.env.QG_TIMEOUT_MS ?? 2000);
const ROUNDS = Number(process.env.QG_ROUNDS ?? 3);
const PROBE_BOUND_MS = 100 * CI_FACTOR;
const SERVER_ENTRY = process.env.QG_SERVER_ENTRY || "dist/index.js";
const REQUEST_TIMEOUT_MS = Math.max(TIMEOUT_MS * 3, 15_000);

let passed = 0, failed = 0;
function assert(cond, label, detail = "") {
  if (cond) { console.log(`  PASS  ${label}`); passed++; }
  else { console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`); failed++; }
}
const txt = (r) => Array.isArray(r?.content) ? (r.content.find((x) => x.type === "text")?.text ?? "") : "";
const js = (t) => { try { return JSON.parse(t); } catch { return null; } };
const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, "-c", "user.email=t@t", "-c", "user.name=t", ...args], { stdio: "pipe" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** Child processes of `ppid`: [{ pid, mb }]. Async: a sync spawn would stall this process and inflate every timing. */
async function childrenOf(ppid) {
  if (process.platform === "win32") {
    const { stdout: out } = await promisify(execFile)("powershell", ["-NoProfile", "-Command",
      `Get-CimInstance Win32_Process -Filter "ParentProcessId=${ppid}" | ForEach-Object { "$($_.ProcessId) $($_.WorkingSetSize) $($_.Name)" }`], { encoding: "utf8" });
    return out.split(/\r?\n/).filter(Boolean).map((l) => l.trim().split(" ")).filter((p) => /node/i.test(p[2] ?? "")).map(([pid, ws]) => ({ pid: Number(pid), mb: Math.round(Number(ws) / 1048576) }));
  }
  const { stdout: out } = await promisify(execFile)("ps", ["-o", "pid=,rss=,comm=", "--ppid", String(ppid)], { encoding: "utf8" });
  return out.split("\n").filter((l) => /node/.test(l)).map((l) => l.trim().split(/\s+/)).map(([pid, rss]) => ({ pid: Number(pid), mb: Math.round(Number(rss) / 1024) }));
}

// ── fixture ──────────────────────────────────────────────────────────────────
const root = makeTempDir("cbi-qg-timeout-");
const dbPath = join(root, ".index", "index.db");
mkdirSync(dirname(dbPath), { recursive: true });
let repoId = process.env.QG_REPO_ID ?? "qg";
let repoPath = process.env.QG_REPO_PATH ?? join(root, "repo");
if (!process.env.QG_REPO_PATH) {
  const n = 120;
  for (let i = 0; i < n; i++) {
    const body = [];
    for (let k = 0; k < 8; k++) {
      body.push(`export function f_${i}_${k}(x: number): number { return f_${(i * 7 + k + 1) % n}_${(k + 1) % 8}(x) + f_${(i * 13 + k + 3) % n}_${(k + 2) % 8}(x - 1); }`);
    }
    const imports = [...new Set([(i * 7 + 1) % n, (i * 13 + 3) % n])].map((j) => `import { ${Array.from({ length: 8 }, (_, k) => `f_${j}_${k}`).join(", ")} } from "./m${j}";`);
    mkdirSync(repoPath, { recursive: true });
    writeFileSync(join(repoPath, `m${i}.ts`), [...imports, ...body].join("\n") + "\n", "utf8");
  }
  git(repoPath, "init", "-q");
  git(repoPath, "config", "core.autocrlf", "false");
  git(repoPath, "add", ".");
  git(repoPath, "commit", "-q", "-m", "fixture");
}
const RUNAWAY_SQL = process.env.QG_SQL_FILE
  ? readFileSync(process.env.QG_SQL_FILE, "utf8").trim()
  : "select count(*) as n from edges a join edges b on b.repo_id = :repoId join edges c on c.repo_id = :repoId where a.repo_id = :repoId";
const NORMAL_SQL = "select type, count(*) as n from edges where repo_id = :repoId group by type order by type";

// ── server ───────────────────────────────────────────────────────────────────
const allowedRoots = process.env.QG_REPO_PATH ? `${root},${resolve(process.env.QG_REPO_PATH)}` : root;
const transport = new StdioClientTransport({
  command: "node",
  args: [SERVER_ENTRY],
  env: { ...process.env, CODEBASE_INDEX_ALLOWED_ROOTS: allowedRoots, CODEBASE_INDEX_DB_PATH: dbPath, CODEBASE_INDEX_LLM_ENABLED: "false" },
  stderr: "pipe"
});
const client = new Client({ name: "qg-timeout", version: "0.1.0" });
await client.connect(transport);
attachServerStderr(transport, "test-query-graph-timeout");
const serverPid = transport.pid;
console.log(`server ${SERVER_ENTRY} pid ${serverPid}, scratch db ${dbPath}`);

async function call(name, args, timeout = REQUEST_TIMEOUT_MS) {
  const t0 = performance.now();
  try {
    const r = await client.callTool({ name, arguments: args }, undefined, { timeout });
    return { ms: Math.round(performance.now() - t0), text: txt(r), isError: r.isError === true };
  } catch (e) {
    return { ms: Math.round(performance.now() - t0), text: String(e?.message ?? e), isError: true, thrown: true };
  }
}

let exitCode = 1;
try {
  const idx = await call("index_repository", { wait: true, repoId, repoPath, mode: "full" }, 1_800_000);
  const t0 = Date.now();
  const idxBody = idx.isError ? null : await waitForIndexJob(indexStatusVia(client), js(idx.text));
  console.log(`index ${repoId}: ${Date.now() - t0 + idx.ms} ms, state ${idxBody?.state ?? "?"}`);
  assert(!idx.isError && idxBody?.state === "ok", "fixture indexed (job ok)", idx.text.slice(0, 300));

  // (a) a normal query: same rows as the direct run, cold then warm latency
  const { runReadOnlyGraphQueryImpl } = await import("../../dist/services/impact/impactRepoSummaries.js");
  const direct = (() => {
    const db = new Database(dbPath, { readonly: true });
    try { return runReadOnlyGraphQueryImpl(db, NORMAL_SQL, { repoId }, 100).rows; } finally { db.close(); }
  })();
  const lat = [];
  let normalRows = null;
  for (let i = 0; i < 6; i++) {
    const r = await call("query_graph", { repoId, sql: NORMAL_SQL, limit: 100, profile: "compact" });
    lat.push(r.ms);
    if (i === 0) normalRows = js(r.text)?.rows ?? null;
  }
  const warmMedian = [...lat.slice(1)].sort((x, y) => x - y)[2];
  console.log(`  normal query_graph latency ms: first ${lat[0]}, then ${lat.slice(1).join(" / ")} (median ${warmMedian})`);
  assert(JSON.stringify(normalRows) === JSON.stringify(direct) && direct.length > 0, "(a) normal query answers the direct run's rows", `${JSON.stringify(normalRows)?.slice(0, 200)} vs ${JSON.stringify(direct).slice(0, 200)}`);
  const idle = (await childrenOf(serverPid));
  console.log(`  children idle: ${JSON.stringify(idle)}`);
  // health_check does its own work (git status, counts): its bound is its idle latency + PROBE_BOUND_MS.
  const hcBase = [];
  for (let i = 0; i < 5; i++) hcBase.push((await call("health_check", { repoId })).ms);
  const hcIdle = Math.max(...hcBase);
  console.log(`  health_check idle ms: ${hcBase.join(" / ")}`);

  // (b) runaway query ×ROUNDS
  for (let round = 1; round <= ROUNDS; round++) {
    const before = (await childrenOf(serverPid)).map((c) => c.pid);
    const probes = [];
    const hcProbes = [];
    let done = false;
    let busySample = null;
    const runaway = call("query_graph", { repoId, sql: RUNAWAY_SQL, limit: 10, timeoutMs: TIMEOUT_MS }).finally(() => { done = true; });
    const probing = (async () => {
      await sleep(150);
      let i = 0;
      while (!done) {
        const hc = i++ % 2 === 1;
        const p = hc ? await call("health_check", { repoId }, TIMEOUT_MS * 2) : await call("list_repositories", {}, TIMEOUT_MS * 2);
        (hc ? hcProbes : probes).push(p.ms);
        if (busySample === null && i === 2) busySample = childrenOf(serverPid);
        await sleep(100);
      }
    })();
    const r = await runaway;
    await probing;
    const body = r.text;
    const maxProbe = Math.max(...probes, 0);
    const maxHc = Math.max(...hcProbes, 0);
    busySample = await busySample;
    console.log(`  round ${round}: runaway ${r.ms} ms → ${body.slice(0, 160)}`);
    console.log(`  round ${round}: list_repositories ×${probes.length} max ${maxProbe} ms [${probes.join(" ")}]; health_check ×${hcProbes.length} max ${maxHc} ms [${hcProbes.join(" ")}]; children busy ${JSON.stringify(busySample)}`);
    assert(r.isError && /QUERY_TIMEOUT|exceeded timeoutMs/.test(body) && body.includes(String(TIMEOUT_MS)), `(b${round}) runaway answers QUERY_TIMEOUT naming ${TIMEOUT_MS}`, body.slice(0, 200));
    const stoppedAfter = Number(/stopped after ([0-9]+)ms/.exec(body)?.[1] ?? NaN);
    assert(stoppedAfter >= TIMEOUT_MS * 0.9 && stoppedAfter <= TIMEOUT_MS * (1 + 0.1 * CI_FACTOR), `(b${round}) the statement was stopped at timeoutMs ± 10% (${stoppedAfter} ms)`);
    // Wall time adds what every query_graph call pays around the statement (the warm normal call's median).
    assert(r.ms <= TIMEOUT_MS * (1 + 0.1 * CI_FACTOR) + warmMedian, `(b${round}) answered within timeoutMs + 10% + the call's own overhead ${warmMedian} ms (${r.ms} ms)`);
    assert(probes.length >= 3 && maxProbe < PROBE_BOUND_MS, `(b${round}) every list_repositories < ${PROBE_BOUND_MS} ms during the runaway (max ${maxProbe}, n ${probes.length})`);
    // health_check spawns git and counts rows, and the runaway child holds a core: it slows under that CPU load
    // (measured idle 160-210 ms, during 160-366 ms) but must never wait for the statement.
    assert(hcProbes.length >= 2 && maxHc < TIMEOUT_MS / 2, `(b${round}) every health_check answers without waiting for the statement (max ${maxHc} < ${TIMEOUT_MS / 2} ms; idle max ${hcIdle}, n ${hcProbes.length})`);
    await sleep(300);
    const after = (await childrenOf(serverPid)).map((c) => c.pid);
    const killed = before.filter((p) => !after.includes(p));
    console.log(`  round ${round}: children before ${before.join(",")} after ${after.join(",")}`);
    assert(killed.length >= 1 && killed.every((p) => !alive(p)), `(b${round}) the runaway's child is gone (pid ${killed.join(",")} not alive)`);
    assert(after.length >= 1 && after.every((p) => !before.includes(p)), `(b${round}) a fresh child (pid ${after.join(",")}) is ready`);
  }

  // (c) a child killed from outside mid-query
  {
    const runaway = call("query_graph", { repoId, sql: RUNAWAY_SQL, limit: 10, timeoutMs: 20_000 });
    await sleep(700);
    const kids = (await childrenOf(serverPid));
    const killedAt = performance.now();
    for (const k of kids) { try { process.kill(k.pid); } catch { /* gone */ } }
    const r = await runaway;
    const afterKill = Math.round(performance.now() - killedAt);
    console.log(`  (c) killed ${kids.map((k) => k.pid).join(",")}; answer ${afterKill} ms after the kill → ${r.text.slice(0, 160)}`);
    // Timed from the kill: finding the child (a PowerShell CIM query) takes seconds on a loaded machine.
    assert(r.isError && !r.thrown && /exited mid-query|failed/.test(r.text) && afterKill < 2_000 * CI_FACTOR, `(c) a crashed child fails that call cleanly (${afterKill} ms after the kill)`, r.text.slice(0, 200));
  }

  // (d) the next normal query answers
  {
    const r = await call("query_graph", { repoId, sql: NORMAL_SQL, limit: 100, profile: "compact" });
    assert(!r.isError && JSON.stringify(js(r.text)?.rows) === JSON.stringify(direct), `(d) the next normal query answers (${r.ms} ms)`, r.text.slice(0, 200));
  }
  exitCode = failed === 0 ? 0 : 1;
} catch (e) {
  console.error(`  FAIL  harness error — ${e?.stack ?? e}`);
  failed++;
} finally {
  await client.close().catch(() => {});
}
console.log(`\ntest-query-graph-timeout: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? exitCode : 1);
