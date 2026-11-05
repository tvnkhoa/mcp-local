import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { acquireHeavyLock, formatHeavyLockStatus, heavyLockHoldersDir, heavyLockPipeName, heavyLockStatus, heavyLockWaitersDir, isPidAlive, LOCK_TIMEOUT_EXIT } from "./heavyLock.mjs";
import { admit, BYPASS_MS, buildRequest, capKey, declaredMb, exclusiveReason, FALLBACK_MB, FLOOR_MB, isDotnet, isHarness, LONE_HEAD_MARGIN_MB, RESERVE_MB } from "./heavyLockBudget.mjs";

/**
 * H-6b: the RAM-budget semaphore. The rules (heavyLockBudget.mjs) are tested as pure functions; the lock
 * cases use a scratch lock (MCP_HEAVY_LOCK_PATH, which also names its pipes) and pin free RAM with
 * MCP_HEAVY_LOCK_TEST_FREE_MB, so the budget is exact: budget = free − 8192 + measured.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MODULE = pathToFileURL(path.join(HERE, "heavyLock.mjs")).href;
const CLI = path.join(HERE, "..", "heavy-lock.mjs");
const noPipe = heavyLockPipeName("x") !== null ? false : `no OS-owned lock name on ${process.platform}`;

const scratchDirs = [];
function scratchDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of scratchDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // a child still holding it open
    }
  }
});

const tempLock = () => path.join(scratchDir("heavy-lock-budget-"), "heavy-check.lock");
/** A clean env whose budget is `budgetMb` (free RAM pinned at reserve + budget). */
function envFor(lockPath, budgetMb) {
  const env = {
    ...process.env,
    MCP_HEAVY_LOCK_PATH: lockPath,
    MCP_HEAVY_LOCK_LINEAGE: "off",
    MCP_HEAVY_LOCK_SAMPLE: "off",
    MCP_HEAVY_LOCK_SESSIONS_FILE: `${lockPath}.no-sessions.jsonl`,
    MCP_HEAVY_LOCK_TEST_FREE_MB: String(RESERVE_MB + budgetMb)
  };
  delete env.CI;
  delete env.MCP_HEAVY_LOCK_TOKEN;
  return env;
}
const quiet = () => {};
/** Take the scratch lock in this process (each call its own env, so no call inherits another's hold). */
function take(lockPath, budgetMb, { klass = "test/small", cmd = "t", ...rest } = {}) {
  return acquireHeavyLock({ cmd, klass, env: envFor(lockPath, budgetMb), pollMs: 20, readLineage: async () => [], log: quiet, ...rest });
}
const timesOut = (promise) => assert.rejects(promise, (error) => error.code === "HEAVY_LOCK_TIMEOUT");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function hardKill(pid) {
  if (process.platform === "win32") spawnSync("taskkill", ["/F", "/PID", String(pid)], { windowsHide: true });
  else process.kill(pid, "SIGKILL");
}
/** Wait until `check()` is true, polling. */
async function until(check, ms = 10_000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("condition not met in time");
    await sleep(20);
  }
}
const tickets = (lockPath) => {
  try {
    return fs
      .readdirSync(heavyLockWaitersDir(lockPath))
      .filter((n) => /^t\d+\.json$/.test(n))
      .map((n) => JSON.parse(fs.readFileSync(path.join(heavyLockWaitersDir(lockPath), n), "utf8")));
  } catch {
    return [];
  }
};

// ---- the rules (P2-P4) ----

test("declared MB: --ram-mb wins; fallback 8000 dotnet / 1500 other under 3 measured runs; then p95 x 1.5 with floors 4000 / 512", () => {
  const rows = (klass, peaks) => peaks.map((peakMb) => ({ class: klass, peakMb }));
  assert.deepEqual(declaredMb({ ramMb: 700, klass: "wecbe-build:X", rows: rows("wecbe-build:X", [100, 100, 100]) }).mb, 700);
  assert.equal(declaredMb({ klass: "mcp-local/x", rows: rows("mcp-local/x", [800, 900]) }).mb, FALLBACK_MB.other);
  assert.equal(declaredMb({ klass: "wecbe-build:X", rows: [] }).mb, FALLBACK_MB.dotnet);
  assert.equal(declaredMb({ klass: "ai/x", cmd: "dotnet build a.csproj", rows: [] }).mb, 8000, "a dotnet command is a dotnet class");
  // Unmeasured rows (peakMb null) and other classes do not count toward the 3.
  assert.equal(declaredMb({ klass: "k", rows: [...rows("k", [1000, 1000]), { class: "k", peakMb: null }, ...rows("other", [5, 5, 5])] }).from, "fallback");
  // Measured: wec.be's real CRM.Customer.Mcp.Test build peaks (1358 MB) → p95 x 1.5 = 2037, under the dotnet floor.
  assert.deepEqual(
    { ...declaredMb({ klass: "wecbe-build:CRM.Customer.Mcp.Test", rows: rows("wecbe-build:CRM.Customer.Mcp.Test", [1300, 1358, 1340]) }) },
    { mb: FLOOR_MB.dotnet, from: "p95", runs: 3, p95: 1358 }
  );
  assert.equal(declaredMb({ klass: "k", rows: rows("k", [100, 200, 300]) }).mb, FLOOR_MB.other, "450 is under the 512 floor");
  assert.equal(declaredMb({ klass: "k", rows: rows("k", [421, 600, 859, 700]) }).mb, Math.ceil(859 * 1.5), "nearest-rank p95 of four is the max");
  assert.equal(declaredMb({ klass: "wecbe-test:T", rows: rows("wecbe-test:T", [5000, 6000, 7000]) }).mb, 10500);
});

test("exclusive (P3): --cost large, .sln build, Release publish, Docker build, verify:all, a codebase-index run of wec.be; not a csproj build or a harness", () => {
  assert.equal(exclusiveReason({ cost: "large", cmd: "x" }), "--cost large");
  assert.equal(exclusiveReason({ cmd: "dotnet build D:/wec.be/wecrm.sln -c Debug" }), ".sln build");
  assert.equal(exclusiveReason({ cmd: "dotnet publish App.csproj -c Release -r win-x64" }), "Release publish");
  assert.equal(exclusiveReason({ cmd: "dotnet publish App.csproj --configuration Release" }), "Release publish");
  assert.equal(exclusiveReason({ cmd: "docker build -t x ." }), "Docker build");
  assert.equal(exclusiveReason({ cmd: "docker compose build" }), "Docker build");
  assert.equal(exclusiveReason({ cmd: "npm run verify:all:steps" }), "verify:all");
  assert.equal(exclusiveReason({ klass: "codebase-index/index wec.be", cmd: "node index.mjs" }), "codebase-index run of wec.be");
  assert.equal(exclusiveReason({ cmd: "dotnet build CRM.Customer.Mcp.Test.csproj" }), null);
  assert.equal(exclusiveReason({ cmd: "dotnet publish App.csproj -c Debug" }), null);
  assert.equal(exclusiveReason({ cmd: "npm run verify:packages:steps" }), null);
  assert.equal(exclusiveReason({ cost: "small", cmd: "codebase-index run-tests" }), null);
});

test("harness suites and the wec.be cap key (P4); dotnet classes (P2)", () => {
  assert.equal(isHarness("mcp-local/x", "codebase-index run-tests --changed"), true);
  assert.equal(isHarness(undefined, "run-servers test"), true);
  assert.equal(isHarness(undefined, "npm run verify:servers:steps"), true);
  assert.equal(isHarness(undefined, "dotnet test X.csproj"), false);
  assert.equal(buildRequest({ cmd: "npm run verify:all:steps", klass: "k" }).harness, false, "verify:all is exclusive, not a harness slot");
  assert.equal(capKey("wecbe-build:CRM.Task.Test"), "wec.be");
  assert.equal(capKey("wecbe-test:SS.UnitTest"), "wec.be");
  assert.equal(capKey("ai-coding-hub/dotnet build"), null);
  assert.equal(isDotnet("wecbe-test:T", "pwsh x.ps1"), true);
  assert.equal(isDotnet("mcp-local/run-tests", "node run-tests.mjs"), false);
});

test("admit (P1): Σ declared + own ≤ free + measured (each at most its declaration) − 8192; exclusive and the caps", () => {
  const req = (mb, extra = {}) => ({ declaredMb: mb, exclusive: false, exclusiveWhy: null, harness: false, capKey: null, ...extra });
  const free = RESERVE_MB + 3000;
  assert.equal(admit(req(1500), [], { freeMb: free }).ok, true);
  assert.equal(admit(req(1500), [req(1500)], { freeMb: free }).ok, true, "two small fit");
  const third = admit(req(1500), [req(1500), req(1500)], { freeMb: free });
  assert.deepEqual([third.ok, third.sumMb, third.budgetMb], [false, 4500, 3000]);
  // A holder using RAM is already out of "free"; its working set is added back, capped at its declaration.
  assert.equal(admit(req(2000), [req(2000, { wsMb: 1500 })], { freeMb: RESERVE_MB + 2500 }).ok, true, "2500 free + 1500 measured = 4000 ≥ 4000");
  assert.equal(admit(req(2000), [req(2000, { wsMb: 9000 })], { freeMb: RESERVE_MB + 500 }).ok, false, "an over-declared holder adds back only its 2000");
  assert.equal(admit(req(100, { exclusive: true, exclusiveWhy: "x" }), [req(100)], { freeMb: free }).ok, false, "exclusive waits for all");
  assert.equal(admit(req(100, { exclusive: true }), [], { freeMb: free }).ok, true);
  assert.equal(admit(req(100), [req(100, { exclusive: true, pid: 1 })], { freeMb: free }).ok, false, "exclusive blocks all");
  assert.equal(admit(req(100), [], { freeMb: free, legacyOccupied: true }).ok, false, "an older caller holding the name counts as exclusive");
  const h = (extra) => req(100, { harness: true, ...extra });
  assert.equal(admit(h(), [h(), h()], { freeMb: free }).ok, false, "at most two harness suites");
  assert.equal(admit(h(), [h(), req(100)], { freeMb: free }).ok, true);
  assert.equal(admit(req(100, { capKey: "wec.be" }), [req(100, { capKey: "wec.be" })], { freeMb: RESERVE_MB + 100_000 }).ok, false, "one wec.be build/test whatever the budget");
  assert.equal(admit(req(0), [], { freeMb: RESERVE_MB - 1 }).ok, false, "below the reserve nothing runs");
});

test("P1 amendment: the FIFO head alone is admitted at free ≥ declared + 2048, below the reserve; never beside a holder or when not the head", () => {
  const req = (mb, extra = {}) => ({ declaredMb: mb, exclusive: false, exclusiveWhy: null, harness: false, capKey: null, ...extra });
  assert.equal(LONE_HEAD_MARGIN_MB, 2048);
  assert.equal(admit(req(1500), [], { freeMb: 3548, head: true }).ok, true);
  assert.equal(admit(req(1500), [], { freeMb: 3547, head: true }).ok, false);
  assert.match(admit(req(1500), [], { freeMb: 3547, head: true }).reason, /alone: needs 3548 MB \(1500 declared \+ 2048\), free 3547 MB/);
  assert.equal(admit(req(1500, { exclusive: true, exclusiveWhy: "x" }), [], { freeMb: 3548, head: true }).ok, true, "a lone exclusive head too");
  assert.equal(admit(req(1500), [], { freeMb: 3548 }).ok, false, "a bypassing (non-head) run still needs the reserve");
  assert.equal(admit(req(100), [req(1500)], { freeMb: 100_000 - 1, head: true }).ok, true, "beside a holder: the reserve rule");
  assert.equal(admit(req(100), [req(1500)], { freeMb: RESERVE_MB + 1599, head: true }).ok, false, "beside a holder the reserve applies");
  assert.equal(admit(req(1500), [], { freeMb: 100_000, head: true, legacyOccupied: true }).ok, false, "an older holder of the name still blocks");
});

// ---- the lock (scratch) ----

test("two small holders are admitted together within the budget; a third that does not fit waits; status shows Σ / BUDGET", async () => {
  const lockPath = tempLock();
  const a = await take(lockPath, 3000, { ramMb: 1500, cmd: "a" });
  const b = await take(lockPath, 3000, { ramMb: 1500, cmd: "b" });
  assert.equal(a.acquired && b.acquired, true);
  assert.deepEqual(b.admission, { sumMb: 3000, budgetMb: 3000 });
  const lines = [];
  await timesOut(take(lockPath, 3000, { ramMb: 1500, cmd: "c", timeoutMs: 300, log: (l) => lines.push(l) }));
  assert.match(lines.join("\n"), /Σ 4500 MB > budget 3000 MB; 1500 MB declared \(--ram-mb\)/);
  const status = await heavyLockStatus({ env: envFor(lockPath, 3000), readTable: async () => null });
  assert.deepEqual(
    status.holders.map((h) => [h.cmd, h.declaredMb]),
    [
      ["a", 1500],
      ["b", 1500]
    ]
  );
  assert.equal(status.holders[0].nameGuard, true, "the first shared holder guards the lock name");
  assert.deepEqual([status.budget.sumMb, status.budget.budgetMb], [3000, 3000]);
  assert.match(formatHeavyLockStatus(status), /budget: Σ 3000 MB declared \/ BUDGET 3000 MB \(free 11192 \+ measured 0 − reserve 8192\)/);
  assert.match(formatHeavyLockStatus(status), /test\/small · 1500 MB declared \(--ram-mb\) · now unmeasured · holds the lock name/);
  a.release();
  const c = await take(lockPath, 3000, { ramMb: 1500, cmd: "c", timeoutMs: 2_000 });
  assert.equal(c.acquired, true, "room again once one leaves");
  b.release();
  c.release();
  assert.deepEqual(fs.readdirSync(heavyLockHoldersDir(lockPath)), [], "every slot removed on release");
});

test("lone head (amendment): admitted with free = declared + 2048 though below the reserve, refused at + 2047; a second run still needs the reserve", async () => {
  const lockPath = tempLock();
  const at = (freeMb) => ({ ...envFor(lockPath, 0), MCP_HEAVY_LOCK_TEST_FREE_MB: String(freeMb) });
  const lone = (freeMb, extra = {}) => acquireHeavyLock({ cmd: "t", klass: "test/lone", ramMb: 1500, env: at(freeMb), pollMs: 20, readLineage: async () => [], log: quiet, ...extra });
  const lines = [];
  await timesOut(lone(3547, { timeoutMs: 300, log: (l) => lines.push(l) }));
  assert.match(lines.join("\n"), /alone: needs 3548 MB \(1500 declared \+ 2048\), free 3547 MB/);
  const one = await lone(3548, { timeoutMs: 2_000 });
  assert.equal(one.acquired, true);
  await timesOut(lone(3548, { ramMb: 100, timeoutMs: 300 }));
  await timesOut(lone(RESERVE_MB + 1599, { ramMb: 100, timeoutMs: 300 }));
  const two = await lone(RESERVE_MB + 1600, { ramMb: 100, timeoutMs: 2_000 });
  assert.equal(two.acquired, true, "beside a holder: Σ 1600 ≤ free − 8192");
  one.release();
  two.release();
});

test("a holder's measured working set is added back to free RAM (at most its declaration)", async () => {
  const lockPath = tempLock();
  const a = await take(lockPath, 2000, { ramMb: 2000 });
  await timesOut(take(lockPath, 1000, { ramMb: 1000, timeoutMs: 200 }));
  const b = await take(lockPath, 1000, { ramMb: 1000, timeoutMs: 2_000, readWorkingSetMb: () => 2000 });
  assert.deepEqual(b.admission, { sumMb: 3000, budgetMb: 3000 });
  a.release();
  b.release();
});

test("exclusive waits for all holders and blocks all; it takes the lock name", async () => {
  const lockPath = tempLock();
  const small = await take(lockPath, 10_000, { ramMb: 500 });
  const lines = [];
  await timesOut(take(lockPath, 10_000, { cost: "large", cmd: "npm run verify:all:steps", timeoutMs: 300, log: (l) => lines.push(l) }));
  assert.match(lines.join("\n"), /exclusive \(--cost large\): waits for 1 holder/);
  small.release();
  const big = await take(lockPath, 10_000, { cmd: "npm run verify:all:steps", timeoutMs: 2_000 });
  assert.equal(big.request.exclusive, true);
  assert.equal(JSON.parse(fs.readFileSync(lockPath, "utf8")).token, big.token, "the exclusive holder writes the lock file");
  await timesOut(take(lockPath, 10_000, { ramMb: 100, timeoutMs: 300 }));
  big.release();
});

test("FIFO: the head is admitted first; a later small one may pass a head that does not fit, only while the head has waited < 10 min", async () => {
  const lockPath = tempLock();
  const h = await take(lockPath, 2000, { ramMb: 1500, cmd: "holder" });
  // The head needs 1500: it does not fit beside the holder.
  const head = take(lockPath, 2000, { ramMb: 1500, cmd: "head", timeoutMs: 20_000 });
  await until(() => tickets(lockPath).some((t) => t.cmd === "head" && t.declaredMb === 1500));
  // A later 500 MB run fits now: it passes the head (head waited < 10 min)...
  const small = await take(lockPath, 2000, { ramMb: 500, cmd: "small", timeoutMs: 2_000 });
  assert.equal(small.acquired, true);
  small.release();
  // ...but not once the head has waited 10 min (clock injected).
  const later = Date.now() + BYPASS_MS + 60_000;
  const lines = [];
  await timesOut(take(lockPath, 2000, { ramMb: 500, cmd: "late", timeoutMs: 300, clock: () => later, log: (l) => lines.push(l) }));
  assert.match(lines.join("\n"), /the first waiter has waited 11 min: no bypass/);
  // A head that fits is next however slowly it polls: a fast small one behind it does not pass.
  h.release();
  const order = [];
  const first = head.then((l) => (order.push("head"), l));
  const fast = take(lockPath, 2000, { ramMb: 500, cmd: "fast", pollMs: 1, timeoutMs: 20_000 }).then((l) => (order.push("fast"), l));
  const got = await first;
  assert.equal(order[0], "head");
  const f = await fast;
  got.release();
  f.release();
});

test("at most two harness suites at once, whatever the budget", async () => {
  const lockPath = tempLock();
  const cmd = "codebase-index run-tests --changed";
  const one = await take(lockPath, 30_000, { cmd, klass: "mcp-local/run-tests" });
  const two = await take(lockPath, 30_000, { cmd, klass: "mcp-local/run-tests" });
  assert.equal(one.request.harness && two.request.harness, true);
  const lines = [];
  await timesOut(take(lockPath, 30_000, { cmd: "run-servers test", klass: "mcp-local/run-servers", timeoutMs: 300, log: (l) => lines.push(l) }));
  assert.match(lines.join("\n"), /2 harness suites already run/);
  const other = await take(lockPath, 30_000, { cmd: "node build.mjs", timeoutMs: 2_000 });
  assert.equal(other.acquired, true, "a non-harness run still fits");
  for (const l of [one, two, other]) l.release();
});

test("wec.be: one build/test at a time (per-repo cap 1) whatever the budget; other dotnet runs are not capped by it", async () => {
  const lockPath = tempLock();
  const build = await take(lockPath, 100_000, { klass: "wecbe-build:CRM.Customer.Mcp.Test", cmd: "pwsh dotnet-build-safe.ps1 build x.csproj" });
  assert.deepEqual([build.request.declaredMb, build.request.declaredFrom, build.request.capKey], [8000, "fallback", "wec.be"]);
  const lines = [];
  await timesOut(take(lockPath, 100_000, { klass: "wecbe-test:CRM.Task.Test", timeoutMs: 300, log: (l) => lines.push(l) }));
  assert.match(lines.join("\n"), /one wec\.be build\/test at a time/);
  const hub = await take(lockPath, 100_000, { klass: "ai-coding-hub/dotnet build App.csproj", cmd: "dotnet build App.csproj", timeoutMs: 2_000 });
  assert.equal(hub.request.declaredMb, 8000);
  build.release();
  hub.release();
});

test("the declared MB comes from the class history next to the lock (p95 x 1.5 after 3 runs)", async () => {
  const lockPath = tempLock();
  const rows = [1300, 1358, 1340].map((peakMb) => JSON.stringify({ class: "wecbe-build:CRM.Customer.Mcp.Test", peakMb }));
  fs.writeFileSync(`${lockPath}.history.jsonl`, `${rows.join("\n")}\n`);
  const l = await take(lockPath, 100_000, { klass: "wecbe-build:CRM.Customer.Mcp.Test" });
  assert.deepEqual([l.request.declaredMb, l.request.declaredFrom], [4000, "p95"]);
  l.release();
});

/** A child holding the scratch lock (new code), `--ram-mb`-style; resolves its pid once it holds. */
function childHolder(lockPath, budgetMb, { ramMb = 1500, cost = null, cmd = "child" } = {}) {
  const script = `
    const { acquireHeavyLock } = await import(${JSON.stringify(MODULE)});
    const lock = await acquireHeavyLock({ cmd: ${JSON.stringify(cmd)}, klass: "test/child", ramMb: ${String(ramMb)}, cost: ${JSON.stringify(cost)}, pollMs: 25, log: () => {} });
    console.log(JSON.stringify({ pid: process.pid, token: lock.token }));
    setInterval(() => {}, 60000);
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { env: envFor(lockPath, budgetMb), stdio: ["ignore", "pipe", "inherit"] });
  const exited = new Promise((resolve) => child.on("exit", resolve));
  const held = new Promise((resolve, reject) => {
    let out = "";
    child.stdout.on("data", (c) => {
      out += c;
      if (out.includes("\n")) resolve(JSON.parse(out.slice(0, out.indexOf("\n"))));
    });
    exited.then((code) => reject(new Error(`child exited ${String(code)} before holding`)));
  });
  return { held, exited, child };
}

test("a crashed holder's slot is reclaimed: taskkill /F leaves its slot file, the next admission removes it", async (t) => {
  const lockPath = tempLock();
  const holder = childHolder(lockPath, 1500);
  const { pid, token } = await holder.held;
  t.after(() => isPidAlive(pid) && hardKill(pid));
  await timesOut(take(lockPath, 1500, { ramMb: 1500, timeoutMs: 300 }));
  hardKill(pid);
  await holder.exited;
  assert.equal(fs.existsSync(path.join(heavyLockHoldersDir(lockPath), `${token}.json`)), true, "a killed holder runs no release");
  const lock = await take(lockPath, 1500, { ramMb: 1500, timeoutMs: 3_000 });
  assert.equal(lock.acquired, true);
  assert.deepEqual(fs.readdirSync(heavyLockHoldersDir(lockPath)), [`${lock.token}.json`], "the dead slot was removed");
  lock.release();
});

test("a holder blocked in spawnSync keeps its slot: liveness is asked by listening, so used-up pipe instances never read as dead", { skip: noPipe }, async () => {
  const lockPath = tempLock();
  const script = `
    const { acquireHeavyLock } = await import(${JSON.stringify(MODULE)});
    const { spawnSync } = await import("node:child_process");
    await acquireHeavyLock({ cmd: "blocked", klass: "test/child", ramMb: 1500, log: () => {} });
    console.log("held");
    spawnSync(process.execPath, ["-e", "const t = Date.now(); while (Date.now() - t < 4000);"]);
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { env: envFor(lockPath, 1500), stdio: ["ignore", "pipe", "inherit"] });
  const exited = new Promise((resolve) => child.on("exit", resolve));
  await new Promise((resolve) => child.stdout.once("data", resolve));
  // Many waiters poll (connect probes would use up the holder's 4 pipe instances within a few polls).
  await Promise.all([1, 2, 3].map(() => timesOut(take(lockPath, 1500, { ramMb: 1500, timeoutMs: 1_200, pollMs: 10 }))));
  assert.equal(await exited, 0);
  const lock = await take(lockPath, 1500, { ramMb: 1500, timeoutMs: 3_000 });
  lock.release();
});

test("no over-admission under a race: 8 processes started at once, the budget fits 2 — never more than 2 hold, all 8 run", async () => {
  const lockPath = tempLock();
  const journal = `${lockPath}.journal`;
  const script = `
    const { acquireHeavyLock } = await import(${JSON.stringify(MODULE)});
    const { appendFileSync } = await import("node:fs");
    const lock = await acquireHeavyLock({ cmd: "racer", klass: "test/racer", ramMb: 1000, pollMs: 10, timeoutMs: 60000, log: () => {} });
    appendFileSync(${JSON.stringify(journal)}, "enter " + process.pid + "\\n");
    await new Promise((r) => setTimeout(r, 250));
    appendFileSync(${JSON.stringify(journal)}, "exit " + process.pid + "\\n");
    lock.release();
  `;
  const runs = Array.from(
    { length: 8 },
    () =>
      new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ["--input-type=module", "-e", script], { env: envFor(lockPath, 2000), stdio: ["ignore", "inherit", "inherit"] });
        child.on("error", reject);
        child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`racer exit ${String(code)}`))));
      })
  );
  await Promise.all(runs);
  let inside = 0;
  let most = 0;
  const lines = fs.readFileSync(journal, "utf8").trim().split("\n");
  for (const line of lines) {
    inside += line.startsWith("enter") ? 1 : -1;
    most = Math.max(most, inside);
  }
  assert.equal(lines.length, 16);
  assert.ok(most <= 2, `${String(most)} held at once: ${lines.join(" | ")}`);
  assert.equal(most, 2, "two fit, so two ran together at some point");
});

test("mixed versions: an older client (the code before H-6b) never runs beside an exclusive holder, either way round", { skip: noPipe }, async (t) => {
  const lockPath = tempLock();
  // The lock as deployed before this change, verbatim from git.
  const oldDir = scratchDir("heavy-lock-old-");
  const repo = path.resolve(HERE, "..", "..");
  fs.writeFileSync(path.join(oldDir, "heavyLock.mjs"), execFileSync("git", ["show", "2f4badb:scripts/lib/heavyLock.mjs"], { cwd: repo, encoding: "utf8" }));
  const OLD = pathToFileURL(path.join(oldDir, "heavyLock.mjs")).href;
  const oldClient = (timeoutMs, holdMs) =>
    new Promise((resolve) => {
      const script = `
        const { acquireHeavyLock } = await import(${JSON.stringify(OLD)});
        try {
          const lock = await acquireHeavyLock({ cmd: "old client", timeoutMs: ${String(timeoutMs)}, pollMs: 25, log: () => {} });
          console.log("held " + process.pid);
          await new Promise((r) => setTimeout(r, ${String(holdMs)}));
          lock.release();
          console.log("released");
        } catch (error) {
          console.log(error.code);
        }
      `;
      const child = spawn(process.execPath, ["--input-type=module", "-e", script], { env: envFor(lockPath, 100_000), stdio: ["ignore", "pipe", "inherit"] });
      let out = "";
      const lines = [];
      child.stdout.on("data", (c) => {
        out += c;
        lines.push(...out.split("\n").slice(lines.length, -1));
      });
      resolve({ child, lines, exited: new Promise((r) => child.on("exit", () => r(out))) });
    });

  // 1. A new exclusive holder: the older client times out.
  const big = await take(lockPath, 100_000, { cost: "large", cmd: "docker build ." });
  const waiting = await oldClient(600, 0);
  assert.match(await waiting.exited, /HEAVY_LOCK_TIMEOUT/);
  big.release();

  // 2. The older client holds: a new exclusive waits, and so does a new shared run (it counts as exclusive).
  const holding = await oldClient(5_000, 1_500);
  t.after(() => holding.child.exitCode === null && holding.child.kill());
  await until(() => holding.lines.some((l) => l.startsWith("held")));
  const lines = [];
  await timesOut(take(lockPath, 100_000, { cost: "large", timeoutMs: 300, log: (l) => lines.push(l) }));
  assert.match(lines.join("\n"), /held by an exclusive run or a caller of an older version/);
  await timesOut(take(lockPath, 100_000, { ramMb: 100, timeoutMs: 300 }));
  await holding.exited;
  const after = await take(lockPath, 100_000, { cost: "large", timeoutMs: 3_000 });
  assert.equal(after.acquired, true, "free again once the older client released");
  after.release();
});

test("CLI: a run that does not fit exits 75 (the timeout code, unchanged); --ram-mb must be a whole number (exit 2)", async () => {
  const lockPath = tempLock();
  const held = await take(lockPath, 1500, { ramMb: 1500 });
  const run = (args) => spawnSync(process.execPath, [CLI, ...args], { env: { ...envFor(lockPath, 1500), MCP_HEAVY_LOCK_TIMEOUT_MS: "400" }, encoding: "utf8" });
  // This process holds the lock and sits in spawnSync: the CLI's admission must see it alive by its names.
  const r = run(["--ram-mb", "100", "--", process.execPath, "-e", "0"]);
  assert.equal(r.status, LOCK_TIMEOUT_EXIT, r.stderr);
  assert.match(r.stderr, /Σ 1600 MB > budget 1500 MB/);
  assert.equal(run(["--ram-mb", "1.5", "--", "x"]).status, 2);
  held.release();
  const ok = run(["--ram-mb", "1500", "--class", "test/cli", "--", process.execPath, "-e", "process.exit(3)"]);
  assert.equal(ok.status, 3, "the command's own exit code");
  const row = JSON.parse(fs.readFileSync(`${lockPath}.history.jsonl`, "utf8").trim().split("\n").at(-1));
  assert.deepEqual([row.class, row.declaredMb, row.declaredFrom, row.exclusive, row.admittedSumMb, row.admittedBudgetMb], ["test/cli", 1500, "--ram-mb", false, 1500, 1500]);
});

// ---- review follow-ups (H1, M1, M3) ----

test("H1: a head that cannot fit even alone times out saying what it needs and what is free; status shows its reason", async () => {
  const lockPath = tempLock();
  const env = { ...envFor(lockPath, 0), MCP_HEAVY_LOCK_TEST_FREE_MB: "3000" };
  let error = null;
  const waiting = acquireHeavyLock({ cmd: "big", klass: "test/big", ramMb: 1500, env, pollMs: 20, timeoutMs: 1_500, readLineage: async () => [], log: quiet }).catch((e) => (error = e));
  await until(() => tickets(lockPath).some((t) => typeof t.waiting === "string"));
  const status = await heavyLockStatus({ env, readTable: async () => null });
  assert.match(status.waiters[0].waiting, /alone: needs 3548 MB \(1500 declared \+ 2048\), free 3000 MB/);
  assert.match(formatHeavyLockStatus(status), /waiting: alone: needs 3548 MB/);
  await waiting;
  assert.equal(error?.code, "HEAVY_LOCK_TIMEOUT");
  assert.match(error.message, /^heavy-check lock: no room after 2 s — alone: needs 3548 MB \(1500 declared \+ 2048\), free 3000 MB/);
  assert.doesNotMatch(error.message, /unreadable holder/);
});

test("M3: the wec.be cap also covers a dotnet run in the wec.be repo without the wecbe- prefix", async () => {
  assert.equal(capKey("custom/x", { repo: "wec.be", cmd: "pwsh dotnet-build-safe.ps1 test X.csproj" }), "wec.be");
  assert.equal(capKey("wec.be/dotnet test X.csproj", { repo: "wec.be" }), "wec.be");
  assert.equal(capKey("custom/x", { repo: "wec.be", cmd: "node tool.mjs" }), null, "a non-dotnet run in wec.be is not capped");
  assert.equal(capKey("custom/x", { repo: "ai-coding-hub", cmd: "dotnet build" }), null);
  // End to end: the repo comes from the caller's cwd (git common dir), as status names it.
  const repo = path.join(scratchDir("heavy-lock-repo-"), "wec.be");
  fs.mkdirSync(repo);
  execFileSync("git", ["init", "-q"], { cwd: repo });
  const lockPath = tempLock();
  const one = await take(lockPath, 100_000, { klass: undefined, cmd: "dotnet build A.csproj", cwd: repo });
  assert.equal(one.request.capKey, "wec.be");
  const lines = [];
  await timesOut(take(lockPath, 100_000, { klass: undefined, cmd: "dotnet test B.csproj", cwd: repo, timeoutMs: 300, log: (l) => lines.push(l) }));
  assert.match(lines.join("\n"), /one wec\.be build\/test at a time/);
  one.release();
});

test("M1: the lock name passes on between shared holders — an older client waits while any new shared holder remains", { skip: noPipe }, async (t) => {
  const lockPath = tempLock();
  const oldDir = scratchDir("heavy-lock-old-");
  fs.writeFileSync(path.join(oldDir, "heavyLock.mjs"), execFileSync("git", ["show", "2f4badb:scripts/lib/heavyLock.mjs"], { cwd: path.resolve(HERE, "..", ".."), encoding: "utf8" }));
  const OLD = pathToFileURL(path.join(oldDir, "heavyLock.mjs")).href;
  const oldClient = (timeoutMs) =>
    new Promise((resolve) => {
      const script = `
        const { acquireHeavyLock } = await import(${JSON.stringify(OLD)});
        try {
          const lock = await acquireHeavyLock({ cmd: "old client", timeoutMs: ${String(timeoutMs)}, pollMs: 25, log: () => {} });
          lock.release();
          console.log("held");
        } catch (error) {
          console.log(error.code);
        }
      `;
      const child = spawn(process.execPath, ["--input-type=module", "-e", script], { env: envFor(lockPath, 100_000), stdio: ["ignore", "pipe", "inherit"] });
      let out = "";
      child.stdout.on("data", (c) => (out += c));
      child.on("exit", () => resolve(out.trim()));
    });
  const a = await take(lockPath, 100_000, { ramMb: 500, cmd: "a" });
  const b = await take(lockPath, 100_000, { ramMb: 500, cmd: "b" });
  t.after(() => (a.release(), b.release()));
  assert.equal(JSON.parse(fs.readFileSync(lockPath, "utf8")).token, a.token, "a took the name at admission");
  a.release();
  // b's keeper re-takes the name within one poll (50 ms here) and writes b's slot as the lock file.
  await until(() => {
    try {
      return JSON.parse(fs.readFileSync(lockPath, "utf8")).token === b.token;
    } catch {
      return false;
    }
  }, 3_000);
  assert.equal(await oldClient(1_000), "HEAVY_LOCK_TIMEOUT", "the older client waits while b runs");
  const status = await heavyLockStatus({ env: envFor(lockPath, 100_000), readTable: async () => null });
  assert.equal(status.holders.length, 1);
  assert.equal(status.holders[0].nameGuard, true, "b's keeper holds the name for b");
  b.release();
  assert.equal(fs.existsSync(lockPath), false, "release removes the keeper's lock file");
  assert.equal(await oldClient(3_000), "held", "free once no new holder remains");
});

test("M1: a shared holder's keeper stops when its holder is killed (no name kept for a dead run)", { skip: noPipe }, async (t) => {
  const lockPath = tempLock();
  const holder = childHolder(lockPath, 100_000, { ramMb: 500 });
  const { pid } = await holder.held;
  t.after(() => isPidAlive(pid) && hardKill(pid));
  hardKill(pid);
  await holder.exited;
  const lock = await take(lockPath, 100_000, { cost: "large", timeoutMs: 5_000 });
  assert.equal(lock.acquired, true, "an exclusive run gets the name once the dead holder's keeper let it go");
  lock.release();
});
