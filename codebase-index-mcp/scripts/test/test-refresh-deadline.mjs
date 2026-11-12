/**
 * IX-A (MCP-ISSUE-126) — a freshness-gate / watcher refresh run has a runId, progress and a deadline.
 *
 * On 11 Nov a gate-triggered dirty refresh of wec.aria ran 5.0 h with no runId, no progress and no deadline, and through
 * the DB-wide queue every query waited on it. This harness runs the REAL refresh worker client, a real refresh worker
 * thread (`attachRefreshWorker`, the production message loop) and the real runner on a scratch DB and repo. The only
 * test hook is the worker's runner factory (this file, when it runs as the worker): while a flag file exists, a run
 * reports one progress step and then hangs —
 *   - `hang-abortable`: until the run's abort signal fires, then runs the real runner with that (aborted) signal, so the
 *     production abort path records it (`recordAborted`);
 *   - `hang-stubborn`: forever, ignoring the abort — the client's grace terminates the worker; no row is recorded.
 *
 *   (a) a normal run under the deadline is untouched: ok, recorded under the registry's runId, no repair pending;
 *   (b) a hung run is listed by index_status (refreshRuns: runId, repoId, mode, phase, progress/total, elapsedMs,
 *       deadline) and answered by its runId; index_status still answers a recorded run by runId;
 *   (c) at the deadline it is stopped: the run rejects with the deadline reason, its row is `cancelled` with no commit
 *       and the deadline in its scope, the queue is free (the next serialized run proceeds), the next refresh is full
 *       and says why;
 *   (d) a run that ignores the abort is terminated after the grace; no row, and the next refresh is still full;
 *   (e) after the repair landed, a dirty refresh runs dirty again.
 */
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const DIST = resolve(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "../../dist");
const distUrl = (rel) => pathToFileURL(join(DIST, rel)).href;

if (!isMainThread) {
  // ── The refresh worker, with the runner factory wrapped (the only test hook) ──
  const { attachRefreshWorker } = await import(distUrl("services/indexing/refreshWorker.js"));
  const { createIndexRunner } = await import(distUrl("services/indexing/indexRunner.js"));
  const flagDir = workerData.flagDir;
  // The module attached its own loop to parentPort on import (it does whenever it runs in a worker): only ours answers.
  parentPort.removeAllListeners("message");
  attachRefreshWorker(parentPort, {
    createRunner: (deps) => {
      const real = createIndexRunner(deps);
      return async (repoId, repoPath, mode, docsEnabled, maxFiles, batchSize, extras = {}) => {
        const abortable = existsSync(join(flagDir, "hang-abortable"));
        const stubborn = existsSync(join(flagDir, "hang-stubborn"));
        if (abortable || stubborn) {
          extras.onProgress?.(1, 3, `index ${repoId}: hang-test`);
          if (stubborn) await new Promise(() => {}); // never settles; the port keeps this thread alive
          await new Promise((r) => (extras.abortSignal?.aborted ? r() : extras.abortSignal?.addEventListener("abort", () => r(), { once: true })));
        }
        return real(repoId, repoPath, mode, docsEnabled, maxFiles, batchSize, extras).catch((e) => { console.error("WORKER-RUN-ERROR", e?.stack ?? e); throw e; });
      };
    }
  });
} else {
  await main();
}

async function main() {
  const { makeTempDir } = await import("./_fixtures.mjs");
  const { GraphStore } = await import(distUrl("repositories/graphStore.js"));
  const { RefreshWorkerClient } = await import(distUrl("services/indexing/refreshWorkerClient.js"));
  const { RefreshRuns, IndexJobQueue } = await import(distUrl("services/indexing/indexJobs.js"));
  const { createFreshnessGate, freshnessStateDir, markRepairNeeded, readRepairNeeded } = await import(distUrl("middleware/freshness.js"));
  const { handleIndexStatus } = await import(distUrl("tools/handlers/indexHandler.js"));

  /** The hung runs' deadline; a normal run gets the registry's (NORMAL_DEADLINE_MS: a cold worker loads grammars). */
  const DEADLINE_MS = Number(process.env.REFRESH_DEADLINE_TEST_MS ?? 3_000);
  const NORMAL_DEADLINE_MS = 120_000;
  // The deadline timer and the worker are unref'd (a server keeps its loop alive); a harness must hold it itself.
  const keepAlive = setInterval(() => {}, 1_000);
  const GRACE_MS = 3_000;
  let passed = 0, failed = 0;
  const assert = (cond, label, detail = "") => {
    if (cond) { console.log(`  PASS  ${label}`); passed++; }
    else { console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`); failed++; }
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, "-c", "user.email=t@t", "-c", "user.name=t", ...args], { stdio: "pipe" });

  const root = makeTempDir("refresh-deadline-");
  const repo = join(root, "repo");
  const flagDir = join(root, "flags");
  mkdirSync(flagDir, { recursive: true });
  mkdirSync(join(repo, "src"), { recursive: true });
  for (let i = 0; i < 6; i++) writeFileSync(join(repo, "src", `f${i}.ts`), `export function f${i}(x: number): number {\n  return x + ${i};\n}\n`);
  git(repo, "init", "-q");
  git(repo, "config", "core.autocrlf", "false");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "fixture");
  const repoPath = repo.replace(/\\/g, "/");
  const dbPath = join(root, "index.db");
  const store = new GraphStore(dbPath);
  const lockDir = freshnessStateDir(dbPath);

  const client = new RefreshWorkerClient({
    dbPath,
    limits: { subtxSize: 20, checkpointEveryNBatches: 1, largeFileThresholdBytes: 0, maxFileSizeBytes: 500_000, parseWorkers: 0, parseJobTimeoutMs: 20_000 }, // no parse pool: the hang is before the run takes one, and an exiting worker builds none
    spawn: () => new Worker(new URL(import.meta.url), { workerData: { flagDir } }),
    abortGraceMs: GRACE_MS,
    onRunLanded: () => store.invalidateProcessCaches()
  });
  // As the server wires it: a deadline stop also writes the gate's durable repair flag.
  const refreshes = new RefreshRuns(NORMAL_DEADLINE_MS, NORMAL_DEADLINE_MS, {
    onDeadlineStop: ({ repoId, mode, at }) => void markRepairNeeded(lockDir, repoId, { mode, pid: process.pid, at })
  });
  const jobs = new IndexJobQueue({ execute: async () => { throw new Error("no jobs here"); }, minFreeRamMb: 0, refreshes });
  // The DB-wide queue (`serialize`) is the gate's own; nothing else of the gate runs here.
  const gate = createFreshnessGate({ enabled: true, budgetMs: 100, lockDir, getRepoPath: () => repoPath, getIndexedCommit: () => null, readTree: async () => ({ head: null, dirty: [] }), run: async () => { throw new Error("unused"); } });
  const ctx = { store, indexJobs: jobs, asText: (body) => ({ content: [{ type: "text", text: JSON.stringify(body) }] }) };
  const status = (runId) => JSON.parse(handleIndexStatus({ runId }, ctx).content[0].text);
  // As the gate does: a durable repair flag on disk makes the gate ask for a full run (and its full serialize clears it).
  const refresh = (requested, source = "freshness_gate", deadlineMs = undefined) => {
    const mode = readRepairNeeded(lockDir, "r") ? "full" : requested;
    return gate.serialize("r", () =>
      refreshes.run({
        repoId: "r",
        mode,
        source,
        ...(deadlineMs && { deadlineMs }),
        abort: (runId, reason) => client.abortRun(runId, reason),
        execute: (runId, runMode, onProgress, escalatedBecause) =>
          client.run("r", repoPath, runMode, false, 1000, 50, { runId, onProgress, ...(escalatedBecause && { escalatedBecause }) })
      }), mode);
  };
  const edit = (i) => writeFileSync(join(repo, "src", "f0.ts"), `export function f0(x: number): number {\n  return x * ${i};\n}\n`);

  try {
    console.log(`\n(a) a normal run under the ${NORMAL_DEADLINE_MS} ms deadline`);
    const t0 = Date.now();
    const first = await refresh("full");
    assert(first.status === "ok" || first.status === "partial", "first run lands", first.status);
    assert(Date.now() - t0 < NORMAL_DEADLINE_MS, `it ended under the deadline (${Date.now() - t0} ms)`);
    assert(store.getRunById(first.runId)?.status === first.status, "it is recorded under the registry's runId");
    assert(refreshes.modeFor("r", "dirty").mode === "dirty", "no repair is pending after a normal run");
    assert(refreshes.list().length === 0, "nothing listed in flight after it");

    console.log("\n(b)+(c) a hung run, aborted at the deadline");
    edit(2);
    writeFileSync(join(flagDir, "hang-abortable"), "");
    const t1 = Date.now();
    const hung = refresh("dirty", "freshness_gate", DEADLINE_MS).then((r) => ({ ok: r }), (e) => ({ error: e }));
    await sleep(Math.min(1500, DEADLINE_MS / 2));
    const listed = refreshes.list();
    assert(listed.length === 1, "index_status source lists one refresh in flight", JSON.stringify(listed));
    const inFlight = listed[0] ?? {};
    const byId = status(inFlight.runId ?? "none");
    assert(byId.runId === inFlight.runId && byId.state === "running" && byId.source === "freshness_gate", "index_status answers the refresh by its runId", JSON.stringify(byId));
    assert(byId.repoId === "r" && byId.mode === "dirty" && byId.phase === "hang-test" && byId.progress === 1 && byId.total === 3, "with repoId, mode, phase, progress/total", JSON.stringify(byId));
    assert(typeof byId.elapsedMs === "number" && byId.elapsedMs > 0 && byId.deadlineMs === DEADLINE_MS && typeof byId.deadlineAt === "string", "with elapsedMs and the deadline", JSON.stringify(byId));
    assert(Array.isArray(byId.refreshRuns) && byId.refreshRuns.length === 1, "every answer carries refreshRuns");
    const recorded = status(first.runId);
    assert(recorded.source === "index_runs" && recorded.runId === first.runId && recorded.refreshRuns?.length === 1, "a recorded run is still answered by runId (from index_runs)", JSON.stringify(recorded).slice(0, 200));
    const outcome = await hung;
    const stoppedAfter = Date.now() - t1;
    rmSync(join(flagDir, "hang-abortable"));
    assert(outcome.error && /CODEBASE_INDEX_REFRESH_RUN_DEADLINE_MS/.test(outcome.error.message), "the run rejects with the deadline reason", String(outcome.error?.message ?? JSON.stringify(outcome.ok)));
    assert(stoppedAfter >= DEADLINE_MS && stoppedAfter < DEADLINE_MS + GRACE_MS + 5_000, `it stopped at the deadline (${stoppedAfter} ms)`);
    const row = store.getRunById(inFlight.runId);
    assert(row?.status === "cancelled" && row.commitSha === null, "its row is cancelled with no commit", JSON.stringify(row));
    assert(/aborted \(refresh run .* stopped at its deadline: CODEBASE_INDEX_REFRESH_RUN_DEADLINE_MS=\d+ ms\)/.test(row?.scope ?? ""), "its scope names the deadline", row?.scope);
    assert(refreshes.list().length === 0, "it left the in-flight list");
    const q0 = Date.now();
    await gate.serialize("other", async () => "free");
    assert(Date.now() - q0 < 1_000, `the DB-wide queue is free (${Date.now() - q0} ms)`);
    const repair = await refresh("dirty");
    assert(repair.mode === "full" && (repair.status === "ok" || repair.status === "partial"), "the next refresh runs full", `${repair.mode} ${repair.status}`);
    assert(/stopped at the \d+ ms refresh deadline/.test(store.getRunById(repair.runId)?.scope ?? ""), "and its record says why", store.getRunById(repair.runId)?.scope);
    assert(readRepairNeeded(lockDir, "r") === null, "the full repair cleared the durable repair flag");

    console.log("\n(d) a run that ignores the abort: terminated after the grace");
    edit(3);
    writeFileSync(join(flagDir, "hang-stubborn"), "");
    const t2 = Date.now();
    const stubborn = await refresh("dirty", "freshness_gate", DEADLINE_MS).then((r) => ({ ok: r }), (e) => ({ error: e }));
    const stubbornAfter = Date.now() - t2;
    rmSync(join(flagDir, "hang-stubborn"));
    const flag = readRepairNeeded(lockDir, "r");
    assert(flag?.mode === "dirty", "a durable repair flag is on disk for other processes (no row was left)", JSON.stringify(flag));
    assert(stubborn.error && /CODEBASE_INDEX_REFRESH_RUN_DEADLINE_MS/.test(stubborn.error.message), "it rejects with the deadline reason", String(stubborn.error?.message));
    assert(stubbornAfter >= DEADLINE_MS + GRACE_MS && stubbornAfter < DEADLINE_MS + GRACE_MS + 5_000, `after the deadline + grace (${stubbornAfter} ms)`);
    const repair2 = await refresh("dirty");
    assert(repair2.mode === "full", "the next refresh still runs full (no row was left to say so)", repair2.mode);

    console.log("\n(e) after the repair, a dirty refresh is dirty again");
    edit(4);
    const after = await refresh("dirty", "watcher");
    assert(after.mode === "dirty" && after.status !== "cancelled", "dirty, untouched", `${after.mode} ${after.status}`);
  } finally {
    clearInterval(keepAlive);
    await client.dispose();
    store.close?.();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}
