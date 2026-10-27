import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { pathToFileURL } from "node:url";

import Database from "better-sqlite3";

import { parseStatusPorcelainV2 } from "../services/git/gitHelpers.js";
import { applyFreshness, computeTreeKey, createFreshnessGate, clearRepairNeeded, liveRunMarkers, pathsChangedSince, readDirtyLedger, readRepairNeeded, recordDirtyLedger, removeRepoStateFiles, tryAcquireLock, UNREADABLE, watcherRunPlan, type RepoTreeState, type TreeKey } from "./freshness.js";
import { GraphStore } from "../repositories/graphStore.js";
import { createIndexRunner } from "../services/indexing/indexRunner.js";
import { runIndexPipeline } from "../services/indexing/indexPipeline.js";
import { readWorkingTreeState } from "../services/git/gitHelpers.js";
import type { IndexMode, IndexRunResult } from "../types/index.js";

/**
 * R1 — read tools answer from a current index, without a manual index_repository.
 *
 * wec.aria's index was 463 commits behind with no watcher, and every answer said `coverage: "high"`.
 * These pin the gate's contract with a fake git and a fake runner: refresh when the tree moved, never
 * abort a slow run (its result serves the next query), one run per repo however many callers, and an
 * honest `freshness` block whenever an answer comes from an older index.
 */

type Harness = {
  gate: ReturnType<typeof createFreshnessGate>;
  runs: { mode: IndexMode; dirtyPaths?: readonly string[] }[];
  setTree: (t: RepoTreeState) => void;
  setIndexed: (sha: string | null) => void;
  finishRun: () => void;
  triggered: string[];
  pending: string[][];
  lockDir: string;
  cleanup: () => void;
};

type HarnessOpts = {
  budgetMs: number;
  autoFinish?: boolean;
  refuse?: string;
  pending?: boolean;
  /** MCP-ISSUE-101: the index DB's `tree_key` column, shared by every gate (process) handed the same map. */
  keyStore?: Map<string, string>;
  /** Repo folder to share with another harness (another process on the same tree). */
  repoDir?: string;
  status?: () => IndexRunResult["status"];
};

function harness(opts: HarnessOpts): Harness {
  const lockDir = opts.repoDir ?? mkdtempSync(path.join(tmpdir(), "cim-fresh-"));
  let tree: RepoTreeState = { head: "aaa111", dirty: [] };
  let indexed: string | null = "aaa111";
  const runs: { mode: IndexMode; dirtyPaths?: readonly string[] }[] = [];
  const triggered: string[] = [];
  const pending: string[][] = [];
  let release: (() => void) | null = null;
  const gate = createFreshnessGate({
    enabled: true,
    budgetMs: opts.budgetMs,
    lockDir,
    checkTtlMs: 0,
    getRepoPath: () => lockDir,
    getIndexedCommit: () => indexed,
    readTree: () => tree,
    markTriggered: (runId) => triggered.push(runId),
    ...(opts.pending && { markPendingReindex: (_repoId: string, paths: string[]) => pending.push(paths) }),
    ...(opts.refuse !== undefined && { refuseRefresh: () => opts.refuse ?? null }),
    ...(opts.keyStore && {
      getCoveredKey: (repoId: string) => opts.keyStore?.get(repoId) ?? null,
      recordCoveredKey: (repoId: string, _runId: string, key: string) => opts.keyStore?.set(repoId, key)
    }),
    run: async (_repoId, _repoPath, mode, dirtyPaths) => {
      runs.push({ mode, ...(dirtyPaths && { dirtyPaths: [...dirtyPaths] }) });
      if (!opts.autoFinish) await new Promise<void>((resolve) => (release = resolve));
      indexed = tree.head;
      return { runId: `run-${String(runs.length)}`, ...(opts.status && { status: opts.status() }) } as IndexRunResult;
    }
  });
  return {
    gate,
    runs,
    triggered,
    pending,
    lockDir,
    setTree: (t) => (tree = t),
    setIndexed: (sha) => (indexed = sha),
    finishRun: () => release?.(),
    cleanup: () => rmSync(lockDir, { recursive: true, force: true })
  };
}

test("an index at HEAD with a clean tree is fresh, and nothing runs", async () => {
  const h = harness({ budgetMs: 1000, autoFinish: true });
  try {
    assert.deepEqual(await h.gate.ensureFresh("r"), { state: "fresh" });
    assert.equal(h.runs.length, 0);
  } finally { h.cleanup(); }
});

test("HEAD moved: an incremental refresh runs, and a query inside the budget answers refreshed", async () => {
  const h = harness({ budgetMs: 1000, autoFinish: true });
  try {
    h.setTree({ head: "bbb222", dirty: [] });
    const note = await h.gate.ensureFresh("r");
    assert.equal(note.state, "refreshed");
    assert.equal(note.mode, "incremental");
    assert.deepEqual(h.runs.map((r) => r.mode), ["incremental"]);
    assert.deepEqual(h.triggered, ["run-1"], "the run is tagged as query-triggered");
    assert.deepEqual(await h.gate.ensureFresh("r"), { state: "fresh" }, "and the next query is fresh with no second run");
    assert.equal(h.runs.length, 1);
  } finally { h.cleanup(); }
});

test("a run that outlives the budget is not aborted: the answer says refreshing, the next query uses it", async () => {
  const h = harness({ budgetMs: 20 });
  try {
    h.setTree({ head: "ccc333", dirty: [] });
    const first = await h.gate.ensureFresh("r");
    assert.equal(first.state, "refreshing");
    assert.match(first.reason ?? "", /continues in the background/);

    // A call that joins a run already past its budget answers at once — measured live, each call
    // during a 20 s refresh used to wait another full budget.
    const t0 = Date.now();
    const second = await h.gate.ensureFresh("r");
    assert.equal(second.state, "refreshing");
    assert.ok(Date.now() - t0 < 15, `joining an overdue run must not wait (${String(Date.now() - t0)} ms)`);
    assert.equal(h.runs.length, 1, "one run, however many callers");

    h.finishRun();
    await new Promise((r) => setTimeout(r, 5));
    assert.deepEqual(await h.gate.ensureFresh("r"), { state: "fresh" }, "the finished run serves the next query");
    assert.equal(h.runs.length, 1);
  } finally { h.cleanup(); }
});

test("only the working tree changed: a dirty-mode refresh, and the same dirty tree is not refreshed twice", async () => {
  const h = harness({ budgetMs: 1000, autoFinish: true });
  try {
    fs.writeFileSync(path.join(h.lockDir, "edited.ts"), "export const a = 1;\n");
    h.setTree({ head: "aaa111", dirty: ["edited.ts"] });
    assert.equal((await h.gate.ensureFresh("r")).mode, "dirty");
    assert.deepEqual(await h.gate.ensureFresh("r"), { state: "fresh" }, "unchanged dirty set: covered");
    fs.writeFileSync(path.join(h.lockDir, "edited.ts"), "export const a = 22;\n");
    const t = new Date(Date.now() + 5_000);
    fs.utimesSync(path.join(h.lockDir, "edited.ts"), t, t);
    assert.equal((await h.gate.ensureFresh("r")).state, "refreshed", "an edit to a dirty file refreshes again");
    assert.equal(h.runs.length, 2);
  } finally { h.cleanup(); }
});

test("another live process holding the repo's lock means: do not run, say the answer is not current", async () => {
  const h = harness({ budgetMs: 1000, autoFinish: true });
  try {
    h.setTree({ head: "ddd444", dirty: [] });
    // The parent process is alive and is not us: a real foreign holder.
    fs.writeFileSync(path.join(h.lockDir, "refresh-r.lock"), JSON.stringify({ pid: process.ppid, at: Date.now() }));
    const note = await h.gate.ensureFresh("r");
    assert.equal(note.state, "refreshing");
    assert.match(note.reason ?? "", /another server process/);
    assert.equal(h.runs.length, 0);
  } finally { h.cleanup(); }
});

test("a lock left by a dead process or too old is broken", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "cim-lock-"));
  try {
    const file = path.join(dir, "x.lock");
    fs.writeFileSync(file, JSON.stringify({ pid: 2 ** 30, at: Date.now() }));
    assert.equal(tryAcquireLock(file, 60_000, Date.now()), true, "dead pid");
    fs.writeFileSync(file, JSON.stringify({ pid: process.ppid, at: 0 }));
    assert.equal(tryAcquireLock(file, 60_000, Date.now()), true, "older than the stale limit");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("serialize never lets two runs for one repo overlap", async () => {
  const h = harness({ budgetMs: 1000, autoFinish: true });
  try {
    const order: string[] = [];
    const slow = h.gate.serialize("r", async () => { order.push("a:start"); await new Promise((r) => setTimeout(r, 30)); order.push("a:end"); });
    const fast = h.gate.serialize("r", async () => { order.push("b:start"); order.push("b:end"); });
    await Promise.all([slow, fast]);
    assert.deepEqual(order, ["a:start", "a:end", "b:start", "b:end"]);
  } finally { h.cleanup(); }
});

test("applyFreshness: a not-current answer never keeps coverage high, and says why", () => {
  const note = { state: "refreshing" as const, mode: "incremental" as const, reason: "still running" };
  const obj = applyFreshness({ coverage: { confidence: "high", knownGaps: [] } }, note) as { coverage: { confidence: string; knownGaps: string[] }; freshness: unknown };
  assert.equal(obj.coverage.confidence, "medium");
  assert.ok(obj.coverage.knownGaps.some((g) => g.includes("still running")));
  assert.deepEqual(obj.freshness, note);
  assert.equal((applyFreshness({ coverage: "high" }, note) as { coverage: string }).coverage, "medium", "nano's bare string too");
  assert.deepEqual(applyFreshness({ a: 1 }, { state: "fresh" }), { a: 1 }, "a fresh answer is untouched");
  const refreshed = applyFreshness({ coverage: "high" }, { state: "refreshed", runId: "x" }) as { coverage: string; freshness: unknown };
  assert.equal(refreshed.coverage, "high", "a refreshed answer is current: coverage stands");
});

test("applyFreshness: an exact TypeScript answer scopes the note to its index-derived part", () => {
  const note = { state: "stale" as const, mode: "incremental" as const, reason: "the refresh run failed; this answer comes from the previous index." };
  const typed = { engine: "typescript-language-service", coverage: { confidence: "exact", engine: "typescript-language-service", knownGaps: [], gaps: [] } };
  const out = applyFreshness(typed, note) as { coverage: { confidence: string; knownGaps: string[] }; freshness: { reason: string; appliesTo: string } };
  assert.equal(out.coverage.confidence, "exact");
  assert.deepEqual(out.coverage.knownGaps, [], "coverage carries no 'previous index' line");
  assert.ok(!/previous index/i.test(JSON.stringify(out)), JSON.stringify(out));
  assert.equal(out.freshness.reason, "the refresh run failed");
  assert.ok(out.freshness.appliesTo.startsWith("index-derived parts only"));
  const nano = applyFreshness({ engine: "typescript-language-service", coverage: "exact" }, note) as { coverage: string };
  assert.equal(nano.coverage, "exact", "nano's bare word too");
});

test("release F: a process told it must not write over a newer build answers stale and runs nothing", async () => {
  const h = harness({ budgetMs: 1000, autoFinish: true, refuse: "written by a newer build (v7-x)." });
  try {
    h.setTree({ head: "bbb222", dirty: [] });
    const note = await h.gate.ensureFresh("r");
    assert.equal(note.state, "stale");
    assert.match(note.reason ?? "", /newer build/);
    assert.equal(h.runs.length, 0);
  } finally { h.cleanup(); }
});

test("release I1b: an async tree read; two calls racing through it start one run, not two", async () => {
  const lockDir = mkdtempSync(path.join(tmpdir(), "cim-fresh-"));
  const runs: IndexMode[] = [];
  let release: (() => void) | null = null;
  try {
    const gate = createFreshnessGate({
      enabled: true,
      budgetMs: 30,
      lockDir,
      getRepoPath: () => lockDir,
      getIndexedCommit: () => "aaa111",
      // Resolves on a later tick, as the server's execFile-based read does.
      readTree: () => new Promise<RepoTreeState>((resolve) => setTimeout(() => resolve({ head: "bbb222", dirty: [] }), 5)),
      run: async (_repoId, _repoPath, mode) => {
        runs.push(mode);
        await new Promise<void>((resolve) => (release = resolve));
        return { runId: "run-1" } as IndexRunResult;
      }
    });
    const [a, b] = await Promise.all([gate.ensureFresh("r"), gate.ensureFresh("r")]);
    assert.deepEqual(runs, ["incremental"], "one run for both callers");
    assert.equal(a.state, "refreshing");
    assert.equal(b.state, "refreshing");
    assert.doesNotMatch(b.reason ?? "", /another server process/, "the second caller joined this process's run");
    (release as (() => void) | null)?.();
  } finally {
    rmSync(lockDir, { recursive: true, force: true });
  }
});

test("release I1b: a refresh run that fails (the worker crashed) answers stale and releases the lock", async () => {
  const lockDir = mkdtempSync(path.join(tmpdir(), "cim-fresh-"));
  let fail = true;
  const runs: IndexMode[] = [];
  try {
    const gate = createFreshnessGate({
      enabled: true,
      budgetMs: 1000,
      lockDir,
      getRepoPath: () => lockDir,
      getIndexedCommit: () => (fail ? "aaa111" : "bbb222"),
      readTree: () => ({ head: "bbb222", dirty: [] }),
      run: async (_repoId, _repoPath, mode) => {
        runs.push(mode);
        if (fail) throw new Error("the refresh worker crashed: boom");
        return { runId: "run-2" } as IndexRunResult;
      }
    });
    const note = await gate.ensureFresh("r");
    assert.equal(note.state, "stale");
    assert.match(note.reason ?? "", /refresh run failed/);
    assert.equal(fs.existsSync(path.join(lockDir, "refresh-r.lock")), false, "the lock is released");
    // The next query retries (here the index caught up meanwhile, so it is simply fresh).
    fail = false;
    assert.equal((await gate.ensureFresh("r")).state, "fresh");
    assert.equal(runs.length, 1);
  } finally {
    rmSync(lockDir, { recursive: true, force: true });
  }
});

test("a file indexed while dirty, then deleted: a dirty run over that path cleans it, not a whole-repo incremental", async () => {
  // Release J, wec.aria's live check: removing one untracked probe ran `incremental` (re-hash every
  // file), 3.2 s warm and 6.5 s cold, against 0.4 s for the dirty run that added it.
  const h = harness({ budgetMs: 1000, autoFinish: true, pending: true });
  try {
    fs.writeFileSync(path.join(h.lockDir, "probe.ts"), "export const p = 1;\n");
    fs.writeFileSync(path.join(h.lockDir, "kept.ts"), "export const k = 1;\n");
    h.setTree({ head: "aaa111", dirty: ["kept.ts", "probe.ts"] });
    assert.equal((await h.gate.ensureFresh("r")).mode, "dirty");

    h.setTree({ head: "aaa111", dirty: ["kept.ts"] }); // probe.ts deleted
    const note = await h.gate.ensureFresh("r");
    assert.equal(note.state, "refreshed");
    assert.equal(note.mode, "dirty", "the cleanup is a dirty run");
    assert.deepEqual(h.pending, [["probe.ts"]], "the vanished path is handed to that run");
    assert.deepEqual(await h.gate.ensureFresh("r"), { state: "fresh" }, "and the ledger lets go of it: no run loop");
    assert.deepEqual(h.runs.map((r) => r.mode), ["dirty", "dirty"]);
  } finally { h.cleanup(); }
});

test("without a pending-reindex hook, a vanished path still falls back to an incremental run", async () => {
  const h = harness({ budgetMs: 1000, autoFinish: true });
  try {
    fs.writeFileSync(path.join(h.lockDir, "probe.ts"), "export const p = 1;\n");
    h.setTree({ head: "aaa111", dirty: ["probe.ts"] });
    await h.gate.ensureFresh("r");
    h.setTree({ head: "aaa111", dirty: [] });
    assert.equal((await h.gate.ensureFresh("r")).mode, "incremental");
    assert.deepEqual(await h.gate.ensureFresh("r"), { state: "fresh" });
  } finally { h.cleanup(); }
});

// MCP-ISSUE-101: on wec.aria every query on a dirty tree paid a ~7.4 s dirty run — the covered key was size+mtime,
// in memory, so a touch re-ran it and no other server process could reuse it.

test("MCP-ISSUE-101: an unchanged dirty tree is fresh with no run; a touch alone runs nothing; a content change runs once", async () => {
  const h = harness({ budgetMs: 1000, autoFinish: true, keyStore: new Map() });
  try {
    const file = path.join(h.lockDir, "edited.ts");
    fs.writeFileSync(file, "export const a = 1;\n");
    h.setTree({ head: "aaa111", dirty: ["edited.ts"] });
    assert.equal((await h.gate.ensureFresh("r")).state, "refreshed");
    assert.deepEqual(await h.gate.ensureFresh("r"), { state: "fresh" }, "second check on the same tree");
    const t = new Date(Date.now() + 60_000);
    fs.utimesSync(file, t, t);
    assert.deepEqual(await h.gate.ensureFresh("r"), { state: "fresh" }, "touched, same bytes: still covered");
    assert.equal(h.runs.length, 1);
    // A different SIZE, so the (size, mtime, ctime) hash cache cannot hit whatever the filesystem clock does.
    fs.writeFileSync(file, "export const a = 22;\n");
    assert.equal((await h.gate.ensureFresh("r")).state, "refreshed", "a content change refreshes");
    assert.deepEqual(await h.gate.ensureFresh("r"), { state: "fresh" });
    assert.equal(h.runs.length, 2, "exactly one more run");
  } finally { h.cleanup(); }
});

test("MCP-ISSUE-101: a same-size edit with the mtime set back is seen through ctime — KNOWN RESIDUAL: within one filesystem timestamp tick it is not", async () => {
  const h = harness({ budgetMs: 1000, autoFinish: true, keyStore: new Map() });
  try {
    const file = path.join(h.lockDir, "edited.ts");
    fs.writeFileSync(file, "export const a = 1;\n");
    h.setTree({ head: "aaa111", dirty: ["edited.ts"] });
    assert.equal((await h.gate.ensureFresh("r")).state, "refreshed");
    const t = new Date(Date.now() + 60_000);
    fs.utimesSync(file, t, t);
    await h.gate.ensureFresh("r"); // the hash cache now holds this stamp
    // Wait out the timestamp tick, so the write below gets a later ctime than the cached stamp.
    await new Promise((resolve) => setTimeout(resolve, 30));
    fs.writeFileSync(file, "export const a = 2;\n"); // same size, new content
    fs.utimesSync(file, t, t); // and the same mtime: only ctime (moved by the write and by utimes) says it changed
    assert.equal((await h.gate.ensureFresh("r")).state, "refreshed", "ctime is part of the cache identity");
    // The residual, not asserted because it depends on the filesystem clock: an edit that keeps size AND mtime
    // and lands in the same ctime tick as the stamp the cache holds hits the cache and is not re-hashed.
  } finally { h.cleanup(); }
});

test("MCP-ISSUE-101: the covered key is shared — a second gate (another process) on the same DB answers fresh without a run", async () => {
  const keyStore = new Map<string, string>();
  const a = harness({ budgetMs: 1000, autoFinish: true, keyStore });
  const b = harness({ budgetMs: 1000, autoFinish: true, keyStore, repoDir: a.lockDir });
  try {
    fs.writeFileSync(path.join(a.lockDir, "x.ts"), "export const x = 1;\n");
    a.setTree({ head: "aaa111", dirty: ["x.ts"] });
    b.setTree({ head: "aaa111", dirty: ["x.ts"] });
    assert.equal((await a.gate.ensureFresh("r")).state, "refreshed");
    assert.deepEqual(await b.gate.ensureFresh("r"), { state: "fresh" }, "process B reuses process A's key");
    assert.equal(b.runs.length, 0);
  } finally { a.cleanup(); }
});

test("MCP-ISSUE-101: a dirty run re-indexes only the files the covered key does not vouch for", async () => {
  const h = harness({ budgetMs: 1000, autoFinish: true, keyStore: new Map() });
  try {
    for (const n of ["p", "q", "r"]) fs.writeFileSync(path.join(h.lockDir, `${n}.ts`), `export const ${n} = 1;\n`);
    h.setTree({ head: "aaa111", dirty: ["p.ts", "q.ts", "r.ts"] });
    await h.gate.ensureFresh("r");
    assert.deepEqual(h.runs[0]?.dirtyPaths, ["p.ts", "q.ts", "r.ts"], "no key yet: every dirty file");
    fs.writeFileSync(path.join(h.lockDir, "q.ts"), "export const q = 2;\n");
    fs.writeFileSync(path.join(h.lockDir, "s.ts"), "export const s = 1;\n");
    h.setTree({ head: "aaa111", dirty: ["p.ts", "q.ts", "r.ts", "s.ts"] });
    await h.gate.ensureFresh("r");
    assert.deepEqual(h.runs[1]?.dirtyPaths, ["q.ts", "s.ts"], "only the changed and the new file");
  } finally { h.cleanup(); }
});

test("MCP-ISSUE-101: a run that ends failed or cancelled answers stale and records no key; the next query runs again", async () => {
  let status: IndexRunResult["status"] = "cancelled";
  const keyStore = new Map<string, string>();
  const h = harness({ budgetMs: 1000, autoFinish: true, keyStore, status: () => status });
  try {
    fs.writeFileSync(path.join(h.lockDir, "f.ts"), "export const f = 1;\n");
    h.setTree({ head: "aaa111", dirty: ["f.ts"] });
    const note = await h.gate.ensureFresh("r");
    assert.equal(note.state, "stale");
    assert.match(note.reason ?? "", /ended cancelled/);
    assert.equal(keyStore.size, 0, "no key for a run that covered nothing");
    status = "ok";
    assert.equal((await h.gate.ensureFresh("r")).state, "refreshed");
    assert.equal(h.runs.length, 2);
  } finally { h.cleanup(); }
});

test("MCP-ISSUE-101: pathsChangedSince — another HEAD vouches for nothing; reverted files are named", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "cim-key-"));
  try {
    fs.writeFileSync(path.join(dir, "a.ts"), "a");
    fs.writeFileSync(path.join(dir, "b.ts"), "b");
    const before = await computeTreeKey(dir, { head: "h1", dirty: ["b.ts", "a.ts", "gone.ts"] });
    assert.deepEqual(Object.keys(before.files), ["a.ts", "b.ts", "gone.ts"]);
    assert.equal(before.files["gone.ts"], "deleted");
    const now = await computeTreeKey(dir, { head: "h1", dirty: ["a.ts"] });
    assert.deepEqual(pathsChangedSince(before, now), ["b.ts", "gone.ts"], "no longer dirty: re-index from disk");
    assert.equal(pathsChangedSince(before, { ...now, head: "h2" }), null);
    assert.equal(pathsChangedSince(null, now), null);
    const big = await computeTreeKey(dir, { head: "h1", dirty: ["a.ts"] }, 0);
    assert.equal(big.files["a.ts"], "size:1", "above the hash cap: keyed by size");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("MCP-ISSUE-101: an unreadable dirty file is never vouched for, whatever was recorded", () => {
  const covered: TreeKey = { head: "h1", files: { "a.ts": UNREADABLE, "b.ts": "x" } };
  assert.deepEqual(pathsChangedSince(covered, { head: "h1", files: { "a.ts": UNREADABLE, "b.ts": "x" } }), ["a.ts"]);
});

test("MCP-ISSUE-101: watcherRunPlan — dirty over batch + unvouched at the indexed HEAD; incremental when HEAD moved", () => {
  const key: TreeKey = { head: "c2", files: { "y.ts": "h-y", "z.ts": "h-z" } };
  const batch = { changed: ["y.ts"], deleted: ["gone.ts"], overflowed: false };
  assert.deepEqual(watcherRunPlan(batch, key, { head: "c2", files: { "z.ts": "h-z" } }, "c2"), { mode: "dirty", paths: ["gone.ts", "y.ts"] });
  assert.deepEqual(watcherRunPlan(batch, key, null, "c2"), { mode: "dirty", paths: ["gone.ts", "y.ts", "z.ts"] }, "no key: every dirty file");
  assert.deepEqual(watcherRunPlan(batch, key, null, "c1"), { mode: "incremental" }, "HEAD moved since the indexed commit");
  assert.deepEqual(watcherRunPlan(batch, key, { head: "c1", files: {} }, "c2"), { mode: "incremental" }, "the key is at another HEAD");
  assert.deepEqual(watcherRunPlan({ ...batch, overflowed: true }, key, null, "c2"), { mode: "incremental" });
  assert.deepEqual(watcherRunPlan(batch, null, null, "c2"), { mode: "incremental" }, "outside git");
});

test("MCP-ISSUE-101: HEAD moved with no watcher running, then a watcher batch names only Y — X is re-indexed all the same", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "cim-watchhead-"));
  const git = (...args: string[]): void => {
    execFileSync("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", ...args], { stdio: "ignore" });
  };
  const dbPath = path.join(dir, ".index", "i.db");
  fs.mkdirSync(path.dirname(dbPath));
  fs.writeFileSync(path.join(dir, ".gitignore"), ".index/\n");
  fs.writeFileSync(path.join(dir, "x.ts"), "export function xOld(): number {\n  return 1;\n}\n");
  fs.writeFileSync(path.join(dir, "y.ts"), "export function yOne(): number {\n  return 1;\n}\n");
  git("init", "-q");
  git("add", ".");
  git("commit", "-q", "-m", "c1");
  const repoPath = dir.replace(/\\/g, "/");
  const store = new GraphStore(dbPath);
  try {
    store.ensureRepository("w", repoPath);
    const run = createIndexRunner({
      store,
      limits: { subtxSize: 20, checkpointEveryNBatches: 1, largeFileThresholdBytes: 512 * 1024, maxFileSizeBytes: 500 * 1024, parseWorkers: 0, parseJobTimeoutMs: 20_000 },
      resolvePerformanceProfileOverride: () => "standard"
    });
    await run("w", repoPath, "full", false, 1000, 50);
    // A pull the watcher never saw: X changes in a new commit.
    fs.writeFileSync(path.join(dir, "x.ts"), "export function xNew(): number {\n  return 2;\n}\n");
    git("commit", "-q", "-am", "c2");
    // Then the watcher sees one edit, to Y.
    fs.writeFileSync(path.join(dir, "y.ts"), "export function yTwo(): number {\n  return 2;\n}\n");
    const key = await computeTreeKey(repoPath, readWorkingTreeState(repoPath));
    const plan = watcherRunPlan({ changed: ["y.ts"], deleted: [], overflowed: false }, key, null, store.getLatestRun("w")?.commitSha ?? null);
    assert.deepEqual(plan, { mode: "incremental" });
    await run("w", repoPath, plan.mode, false, 1000, 50);
    const db = (store as unknown as { db: { prepare: (sql: string) => { all: (...a: unknown[]) => { name: string }[] } } }).db;
    const xs = db.prepare(`select name from symbols where repo_id = ? and file_path = 'x.ts' and kind = 'function'`).all("w").map((r) => r.name);
    assert.deepEqual(xs, ["xNew"], "the commit's change to X is in the index");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("MCP-ISSUE-101: a dirty run handed its paths takes the re-read ones out of the ledger", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "cim-ledger-"));
  try {
    recordDirtyLedger(dir, "r", "dirty", { head: "h1", dirty: ["a.ts", "b.ts"] });
    // b.ts was reverted and a watcher dirty run re-read it; a.ts is still dirty.
    recordDirtyLedger(dir, "r", "dirty", { head: "h1", dirty: ["a.ts"] }, ["a.ts", "b.ts"]);
    assert.deepEqual(readDirtyLedger(dir, "r")?.paths, ["a.ts"]);
    recordDirtyLedger(dir, "r", "dirty", { head: "h1", dirty: ["c.ts"] }, ["c.ts"]);
    assert.deepEqual(readDirtyLedger(dir, "r")?.paths, ["a.ts", "c.ts"], "a path the run did not re-read stays");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── MCP-ISSUE-101 part 5: no "fresh" while any process is running an index of the repo ────────────────────

/**
 * A second PROCESS on the same DB and state dir runs a real full index through its own gate's `serialize`
 * (as index_repository and the watcher do). It prints `midrun` from the pipeline's first progress tick, when
 * the first batch is committed and nothing is resolved yet, and `done` when the run ends.
 */
const CHILD = `
import { GraphStore } from ${JSON.stringify(pathToFileURL(path.resolve("src/repositories/graphStore.ts")).href)};
import { createFreshnessGate } from ${JSON.stringify(pathToFileURL(path.resolve("src/middleware/freshness.ts")).href)};
import { runIndexPipeline } from ${JSON.stringify(pathToFileURL(path.resolve("src/services/indexing/indexPipeline.ts")).href)};
import fs from "node:fs";
const [dbPath, lockDir, repoPath, runMode = "full", pathsFile] = process.argv.slice(2);
const only = pathsFile ? JSON.parse(fs.readFileSync(pathsFile, "utf8")) : undefined;
const store = new GraphStore(dbPath);
store.ensureRepository("r", repoPath);
const gate = createFreshnessGate({ enabled: true, budgetMs: 0, lockDir, getRepoPath: () => repoPath, getIndexedCommit: () => null, readTree: () => ({ head: null, dirty: [] }), run: async () => { throw new Error("unused"); } });
let told = false;
let ticks = 0;
const killAfter = Number(process.argv[7] ?? 1);
await gate.serialize("r", () => runIndexPipeline(store, {
  repoId: "r", repoPath, mode: runMode, maxFiles: 5000, batchSize: 10, subtxSize: 5, parseWorkers: 0,
  ...(only && { onlyRelativePaths: new Set(only) }),
  onProgress: () => { ticks += 1; if (!told && ticks >= killAfter) { told = true; process.stdout.write("midrun\\n"); } }
}), runMode, only);
store.close();
process.stdout.write("done\\n");
`;

function startChild(lockDir: string, repoDir: string, extra: string[] = []): { child: ChildProcess; lines: string[]; waitFor: (line: string) => Promise<void> } {
  const script = path.join(lockDir, "child.mts");
  fs.writeFileSync(script, CHILD);
  const child = spawn(process.execPath, ["--import", "tsx", script, path.join(lockDir, "x.db"), lockDir, repoDir.replace(/\\/g, "/"), ...extra], {
    stdio: ["ignore", "pipe", "pipe"]
  });
  const lines: string[] = [];
  const waiters: Array<{ line: string; resolve: () => void }> = [];
  child.stdout!.on("data", (b: Buffer) => {
    for (const l of b.toString().split(/\r?\n/).filter(Boolean)) {
      lines.push(l);
      for (const w of waiters.filter((x) => x.line === l)) w.resolve();
    }
  });
  const waitFor = (line: string): Promise<void> =>
    lines.includes(line)
      ? Promise.resolve()
      : new Promise((resolve, reject) => {
          waiters.push({ line, resolve });
          child.once("exit", (code) => (lines.includes(line) ? resolve() : reject(new Error(`child exited ${String(code)} before "${line}"`))));
        });
  return { child, lines, waitFor };
}

function bigRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "cim-fresh-repo-"));
  fs.mkdirSync(path.join(dir, "src"));
  fs.writeFileSync(path.join(dir, "src/util.ts"), "export function helper(): number {\n  return 1;\n}\n");
  for (let i = 0; i < 400; i++) {
    fs.writeFileSync(path.join(dir, `src/c${String(i)}.ts`), `import { helper } from "./util";\n\nexport function main${String(i)}(): number {\n  return helper();\n}\n`);
  }
  return dir;
}

test("MCP-ISSUE-101 part 5: a query from another process while a full index runs answers refreshing, then fresh", async () => {
  const h = harness({ budgetMs: 1000, autoFinish: true });
  const repo = bigRepo();
  try {
    assert.deepEqual(await h.gate.ensureFresh("r"), { state: "fresh" }, "clean tree at HEAD, nothing running");
    const c = startChild(h.lockDir, repo);
    await c.waitFor("midrun");
    const mid = await h.gate.ensureFresh("r");
    const finished = c.lines.includes("done");
    assert.ok(!finished, "the child's run is still going when the query is answered");
    assert.equal(mid.state, "refreshing", JSON.stringify(mid));
    assert.match(mid.reason ?? "", /index run of this repo is in progress \(pid \d+/);
    assert.match(mid.reason ?? "", /partly re-written index/);
    assert.equal(h.runs.length, 0, "the gate does not start a run of its own over the other process's");
    await c.waitFor("done");
    await new Promise((resolve) => c.child.once("exit", resolve));
    assert.deepEqual(await h.gate.ensureFresh("r"), { state: "fresh" }, "the marker is gone with the run");
  } finally {
    h.cleanup();
    rmSync(repo, { recursive: true, force: true });
  }
});

test("MCP-ISSUE-101 part 5: a marker left by a killed process is not a run in progress", async () => {
  const h = harness({ budgetMs: 1000, autoFinish: true });
  const repo = bigRepo();
  try {
    const c = startChild(h.lockDir, repo);
    await c.waitFor("midrun");
    c.child.kill("SIGKILL");
    await new Promise((resolve) => c.child.once("exit", resolve));
    assert.ok(fs.readdirSync(h.lockDir).some((n) => n.startsWith("running-r-")), "the killed run left its marker");
    assert.deepEqual(liveRunMarkers(h.lockDir, "r", 60_000, Date.now()), [], "not live");
    assert.ok(!fs.readdirSync(h.lockDir).some((n) => n.startsWith("running-r-")), "the dead pid's marker is removed");
    assert.deepEqual(readRepairNeeded(h.lockDir, "r")?.mode, "full", "but it is remembered: the index was left part-written");
  } finally {
    h.cleanup();
    rmSync(repo, { recursive: true, force: true });
  }
});

test("MCP-ISSUE-101 F4: after a FULL run was killed mid-way, a query from another gate is never fresh, and the repair equals a full run", async () => {
  const h = harness({ budgetMs: 1000, autoFinish: true });
  const repo = bigRepo();
  const cleanDir = mkdtempSync(path.join(tmpdir(), "cim-clean-"));
  const dbPath = path.join(h.lockDir, "x.db");
  const shape = (db: Database.Database): Record<string, number> => {
    const n = (sql: string): number => (db.prepare(sql).get() as { n: number }).n;
    return {
      symbols: n("select count(*) as n from symbols where repo_id = 'r'"),
      edges: n("select count(*) as n from edges where repo_id = 'r'"),
      unresolved: n("select count(*) as n from edges where repo_id = 'r' and to_id like 'callee:%'"),
      files: n("select count(*) as n from files where repo_id = 'r'")
    };
  };
  // The runner, not the bare pipeline: the edge-resolve passes live in the runner, so only through it does "unresolved" mean something.
  const limits = { subtxSize: 5, checkpointEveryNBatches: 1, largeFileThresholdBytes: 512 * 1024, maxFileSizeBytes: 500 * 1024, parseWorkers: 0, parseJobTimeoutMs: 20_000 };
  const runnerFor = (store: GraphStore) => createIndexRunner({ store, limits, resolvePerformanceProfileOverride: () => "standard" });
  const fullRun = (store: GraphStore): Promise<unknown> => runnerFor(store)("r", repo, "full", false, 5000, 50);
  try {
    const c = startChild(h.lockDir, repo);
    await c.waitFor("midrun");
    c.child.kill("SIGKILL");
    await new Promise((resolve) => c.child.once("exit", resolve));

    // another process's gate: the tree is clean and HEAD is the indexed commit, so only the dead marker tells
    const store = new GraphStore(dbPath);
    const modes: string[] = [];
    const gate = createFreshnessGate({
      enabled: true,
      budgetMs: 120_000,
      lockDir: h.lockDir,
      getRepoPath: () => repo,
      getIndexedCommit: () => "aaa111",
      readTree: () => ({ head: "aaa111", dirty: [] }),
      run: async (_id, _path, mode) => {
        modes.push(mode);
        return runnerFor(store)("r", repo, mode, false, 5000, 50);
      }
    });
    const first = await gate.ensureFresh("r");
    assert.notEqual(first.state, "fresh", JSON.stringify(first));
    assert.deepEqual(modes, ["full"], "the repair is a full run");
    assert.deepEqual(await gate.ensureFresh("r"), { state: "fresh" }, "repaired once, then fresh");
    assert.deepEqual(modes, ["full"]);
    assert.equal(readRepairNeeded(h.lockDir, "r"), null);

    const clean = new GraphStore(path.join(cleanDir, "y.db"));
    clean.ensureRepository("r", repo);
    await fullRun(clean);
    const probe = new Database(dbPath);
    const probeClean = new Database(path.join(cleanDir, "y.db"));
    try {
      assert.deepEqual(shape(probe), shape(probeClean), "the repaired index equals a full run of the same tree");
      assert.ok((shape(probe).edges ?? 0) > 400, "and the run really resolved edges");
      assert.ok((shape(probeClean).unresolved ?? 0) < (shape(probeClean).edges ?? 0), "calls to helper() resolved: unresolved is below the edge total");
    } finally {
      probe.close();
      probeClean.close();
      clean.close();
      store.close();
    }
  } finally {
    h.cleanup();
    rmSync(cleanDir, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test("MCP-ISSUE-101 F4: a dead marker that names its mode asks for a full repair; one without a mode (older build) and a live one do not", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "cim-repair-"));
  try {
    fs.writeFileSync(path.join(dir, "running-old-999999-1.json"), JSON.stringify({ pid: 999999, at: 1 }));
    assert.deepEqual(liveRunMarkers(dir, "old", 60_000, Date.now()), []);
    assert.equal(readRepairNeeded(dir, "old"), null);
    fs.writeFileSync(path.join(dir, `running-live-${String(process.pid)}-1.json`), JSON.stringify({ pid: process.pid, at: Date.now(), mode: "full" }));
    assert.equal(liveRunMarkers(dir, "live", 60_000, Date.now()).length, 1);
    assert.equal(readRepairNeeded(dir, "live"), null);
    fs.writeFileSync(path.join(dir, "running-dead-999999-1.json"), JSON.stringify({ pid: 999999, at: 5, mode: "dirty", repoId: "dead" }));
    liveRunMarkers(dir, "dead", 60_000, Date.now());
    assert.equal(readRepairNeeded(dir, "dead")?.mode, "dirty");
    assert.equal(readRepairNeeded(dir, "dead")?.pid, 999999);
    assert.equal(readRepairNeeded(dir, "dead")?.at, 5);
    clearRepairNeeded(dir, "dead");
    assert.equal(readRepairNeeded(dir, "dead"), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("MCP-ISSUE-101 part 5: a marker older than staleRunMs is ignored even if its pid is alive (pid reuse)", async () => {
  const lockDir = mkdtempSync(path.join(tmpdir(), "cim-fresh-"));
  try {
    fs.writeFileSync(path.join(lockDir, "running-r-1-1.json"), JSON.stringify({ pid: process.pid, at: 1_000 }));
    assert.deepEqual(liveRunMarkers(lockDir, "r", 60_000, 2_000), [{ pid: process.pid, at: 1_000 }]);
    assert.deepEqual(liveRunMarkers(lockDir, "r", 60_000, 100_000), []);
    assert.deepEqual(fs.readdirSync(lockDir), []);
  } finally {
    rmSync(lockDir, { recursive: true, force: true });
  }
});

test("MCP-ISSUE-101 part 5: a run in this process (index_repository through serialize) is in progress for its queries too", async () => {
  const h = harness({ budgetMs: 1000, autoFinish: true });
  try {
    let release!: () => void;
    const run = h.gate.serialize("r", () => new Promise<void>((resolve) => (release = resolve)));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal((await h.gate.ensureFresh("r")).state, "refreshing");
    release();
    await run;
    assert.deepEqual(await h.gate.ensureFresh("r"), { state: "fresh" });
  } finally {
    h.cleanup();
  }
});

test("MCP-ISSUE-101 part 5: an index last fully built by another INDEX_VERSION answers refreshing with the reason", async () => {
  let version: string | null = "v14-release-m";
  const lockDir = mkdtempSync(path.join(tmpdir(), "cim-fresh-"));
  let tree: RepoTreeState = { head: "aaa111", dirty: [] };
  let indexed = "aaa111";
  const gate = createFreshnessGate({
    enabled: true,
    budgetMs: 1000,
    lockDir,
    getRepoPath: () => lockDir,
    getIndexedCommit: () => indexed,
    readTree: () => tree,
    getFullRunVersion: () => version,
    buildVersion: "v15-tiebreak-path",
    run: async () => {
      indexed = tree.head!;
      return { runId: "run-1" } as IndexRunResult;
    }
  });
  try {
    const clean = await gate.ensureFresh("r");
    assert.equal(clean.state, "refreshing");
    assert.match(clean.reason ?? "", /last fully built by v14-release-m; this server runs v15-tiebreak-path/);
    assert.match(clean.reason ?? "", /mode "full"/);
    // A scoped refresh does not make the index current: still flagged after it.
    tree = { head: "bbb222", dirty: [] };
    const after = await gate.ensureFresh("r");
    assert.equal(after.state, "refreshing", JSON.stringify(after));
    assert.equal(after.runId, "run-1");
    // A full run at this build's version clears it.
    version = "v15-tiebreak-path";
    assert.deepEqual(await gate.ensureFresh("r"), { state: "fresh" });
    // No full run on record (a new repo mid first run): nothing to compare.
    version = null;
    assert.deepEqual(await gate.ensureFresh("r"), { state: "fresh" });
  } finally {
    rmSync(lockDir, { recursive: true, force: true });
  }
});

test("MCP-ISSUE-101 part 5: getLatestFullRunVersion reads the latest ok FULL run, not a later scoped one", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "cim-fresh-db-"));
  const store = new GraphStore(path.join(dir, "x.db"));
  try {
    const db = new Database(path.join(dir, "x.db"));
    const insert = db.prepare(
      `insert into index_runs (run_id, repo_id, mode, status, started_at, finished_at, files_scanned, files_indexed, files_skipped,
         symbols_upserted, edges_upserted, parse_failures, elapsed_ms, index_version) values (?, 'r', ?, ?, ?, ?, 0, 0, 0, 0, 0, 0, 0, ?)`
    );
    insert.run("a", "full", "ok", "2026-10-27T01:00:00Z", "2026-10-27T01:01:00Z", "v14-release-m");
    insert.run("b", "full", "failed", "2026-10-27T02:00:00Z", "2026-10-27T02:01:00Z", "v15-tiebreak-path");
    insert.run("c", "dirty", "ok", "2026-10-27T03:00:00Z", "2026-10-27T03:01:00Z", "v15-tiebreak-path");
    db.close();
    assert.equal(store.getLatestFullRunVersion("r"), "v14-release-m");
    assert.equal(store.getLatestFullRunVersion("other"), null);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("MCP-ISSUE-101 F2: a dirty path that stays unreadable stops forcing runs after N checks, and the answer still reports it", async () => {
  const h = harness({ budgetMs: 1000, autoFinish: true });
  const bad = "bad\0name.ts"; // stat throws a non-ENOENT error: keyed UNREADABLE
  try {
    h.setTree({ head: "aaa111", dirty: [bad] });
    for (let i = 0; i < 3; i++) await h.gate.ensureFresh("r");
    const settled = h.runs.length;
    assert.ok(settled >= 1 && settled <= 3, `${String(settled)} runs while the path was being given up on`);
    for (let i = 0; i < 4; i++) {
      const note = await h.gate.ensureFresh("r");
      assert.equal(note.state, "fresh");
      assert.deepEqual(note.unreadable, [bad]);
    }
    assert.equal(h.runs.length, settled, "a capped path starts no further run");
    const answer = applyFreshness({ coverage: { confidence: "high", knownGaps: [] } }, await h.gate.ensureFresh("r")) as { coverage: { knownGaps: string[] }; freshness: { unreadable: string[] } };
    assert.match(answer.coverage.knownGaps[0] ?? "", /could not be read/);
    assert.deepEqual(answer.freshness.unreadable, [bad]);
    // another dirty file still triggers its run
    h.setTree({ head: "aaa111", dirty: [bad, "ok.ts"] });
    writeFileSync(path.join(h.lockDir, "ok.ts"), "x");
    await h.gate.ensureFresh("r");
    assert.equal(h.runs.length, settled + 1);
    assert.deepEqual(h.runs.at(-1)?.dirtyPaths, ["ok.ts"]);
  } finally { h.cleanup(); }
});

test("run markers are matched per exact repoId: `a` does not see the run of `a-b`, and an old-form marker still counts for its repo", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "cim-markers-"));
  try {
    const live = { pid: process.pid, at: Date.now() };
    writeFileSync(path.join(dir, `running-a-b-${String(process.pid)}-1.json`), JSON.stringify({ ...live, repoId: "a-b" }));
    assert.deepEqual(liveRunMarkers(dir, "a", 60_000, Date.now()), []);
    assert.equal(liveRunMarkers(dir, "a-b", 60_000, Date.now()).length, 1);
    // written before markers named their repo: matched on the name alone
    writeFileSync(path.join(dir, `running-a-${String(process.pid)}-2.json`), JSON.stringify(live));
    assert.equal(liveRunMarkers(dir, "a", 60_000, Date.now()).length, 1);
    assert.equal(liveRunMarkers(dir, "a-b", 60_000, Date.now()).length, 1);
    // two ids that sanitize to one name: the marker's own repoId decides, and the other repo's file is left alone
    writeFileSync(path.join(dir, `running-x_y-${String(process.pid)}-3.json`), JSON.stringify({ ...live, repoId: "x/y" }));
    assert.deepEqual(liveRunMarkers(dir, "x y", 60_000, Date.now()), []);
    assert.equal(liveRunMarkers(dir, "x/y", 60_000, Date.now()).length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a live run of `a-b` does not make the gate of `a` answer refreshing", async () => {
  const h = harness({ budgetMs: 1000, autoFinish: true });
  try {
    writeFileSync(path.join(h.lockDir, `running-a-b-${String(process.pid)}-1.json`), JSON.stringify({ pid: process.pid, at: Date.now(), repoId: "a-b" }));
    assert.deepEqual(await h.gate.ensureFresh("a"), { state: "fresh" });
    assert.equal((await h.gate.ensureFresh("a-b")).state, "refreshing");
  } finally { h.cleanup(); }
});

test("MCP-ISSUE-101 F3: a change inside a dirty submodule moves the key and reaches the dirty run as its own file", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "cim-sub-"));
  const git = (cwd: string, ...args: string[]): string =>
    execFileSync("git", ["-c", "protocol.file.allow=always", "-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" });
  const subSrc = path.join(root, "subsrc");
  const parent = path.join(root, "parent");
  mkdirSync(subSrc);
  mkdirSync(parent);
  git(subSrc, "init", "-q");
  writeFileSync(path.join(subSrc, "a.ts"), "export const a = 1;\n");
  git(subSrc, "add", "a.ts");
  git(subSrc, "commit", "-q", "-m", "s");
  git(parent, "init", "-q");
  git(parent, "submodule", "add", "-q", subSrc, "sub");
  git(parent, "commit", "-q", "-m", "p");
  try {
    writeFileSync(path.join(parent, "sub", "a.ts"), "export const a = 2;\n");
    const tree = (): RepoTreeState => parseStatusPorcelainV2(git(parent, "status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all")) as RepoTreeState;
    assert.deepEqual(tree().dirty, ["sub"], "git reports the dirty submodule as ONE directory entry");
    const k1 = await computeTreeKey(parent, tree());
    assert.match(k1.files["sub"] ?? "", /^submodule:[0-9a-f]{40}$/);
    assert.ok(k1.files["sub/a.ts"] && k1.files["sub/a.ts"] !== "deleted", "the dirty file inside is keyed");
    writeFileSync(path.join(parent, "sub", "a.ts"), "export const a = 3;\n");
    const k2 = await computeTreeKey(parent, tree());
    assert.notEqual(k2.files["sub/a.ts"], k1.files["sub/a.ts"]);
    assert.deepEqual(pathsChangedSince(k1, k2), ["sub/a.ts"], "the edit inside the submodule is seen");
    writeFileSync(path.join(parent, "sub", "b.ts"), "export const b = 1;\n");
    assert.deepEqual(pathsChangedSince(k2, await computeTreeKey(parent, tree())), ["sub/b.ts"], "a new untracked file inside is seen");

    // through the gate: the run gets the files inside, never the directory entry
    const h = harness({ budgetMs: 1000, autoFinish: true, repoDir: parent });
    h.setTree({ head: "aaa111", dirty: ["sub"] });
    await h.gate.ensureFresh("r");
    assert.deepEqual(h.runs.at(-1)?.dirtyPaths, ["sub/a.ts", "sub/b.ts"]);
    writeFileSync(path.join(parent, "sub", "a.ts"), "export const a = 4;\n");
    await h.gate.ensureFresh("r");
    assert.equal(h.runs.length, 2);
    assert.deepEqual(h.runs.at(-1)?.dirtyPaths, ["sub/a.ts"]);
    await h.gate.ensureFresh("r");
    assert.equal(h.runs.length, 2, "nothing changed: no run");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("MCP-ISSUE-101 F4: a repair that keeps failing is tried twice, then the gate answers stale and says what to run", async () => {
  const h = harness({ budgetMs: 1000, autoFinish: true, status: () => "failed" });
  try {
    fs.writeFileSync(path.join(h.lockDir, "running-r-999999-1.json"), JSON.stringify({ pid: 999999, at: 1, mode: "full", repoId: "r" }));
    const first = await h.gate.ensureFresh("r");
    assert.equal(first.state, "stale", "the run failed");
    assert.equal((await h.gate.ensureFresh("r")).state, "stale");
    assert.deepEqual(h.runs.map((r) => r.mode), ["full", "full"], "two repair attempts");
    assert.equal(readRepairNeeded(h.lockDir, "r")?.attempts, 2);
    const third = await h.gate.ensureFresh("r");
    assert.equal(third.state, "stale");
    assert.match(third.reason ?? "", /repair failed 2 times; run index_repository mode full/);
    assert.equal(h.runs.length, 2, "no third run");
    // an index_repository full run of any caller clears the flag and the gate is fresh again
    await h.gate.serialize("r", async () => ({ status: "ok" }), "full");
    assert.equal(readRepairNeeded(h.lockDir, "r"), null);
    assert.deepEqual(await h.gate.ensureFresh("r"), { state: "fresh" });
  } finally { h.cleanup(); }
});

test("MCP-ISSUE-101 F4: a killed repair is counted too (the attempt is written before the run starts)", async () => {
  const h = harness({ budgetMs: 1000 }); // the fake run never finishes until released
  try {
    fs.writeFileSync(path.join(h.lockDir, "running-r-999999-1.json"), JSON.stringify({ pid: 999999, at: 1, mode: "incremental", repoId: "r" }));
    void h.gate.ensureFresh("r");
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(readRepairNeeded(h.lockDir, "r")?.attempts, 1, "counted while still running");
    h.finishRun();
  } finally { h.cleanup(); }
});

test("MCP-ISSUE-101 F4: a marker older than staleRunMs whose holder is still alive is remembered, so its later death cannot leave fresh", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "cim-expired-"));
  try {
    fs.writeFileSync(path.join(dir, `running-r-${String(process.pid)}-1.json`), JSON.stringify({ pid: process.pid, at: 1_000, mode: "full", repoId: "r" }));
    assert.deepEqual(liveRunMarkers(dir, "r", 60_000, 1_000_000), [], "ignored as a live run");
    assert.equal(readRepairNeeded(dir, "r")?.mode, "full", "but remembered for its mode");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("MCP-ISSUE-101 F4: every dead run leaves its own flag file, so concurrent deaths are not lost; the flag mode is the most thorough one", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "cim-merge-"));
  try {
    const dead = (n: number, body: object): void => fs.writeFileSync(path.join(dir, `running-r-999999-${String(n)}.json`), JSON.stringify({ pid: 999999, at: n, repoId: "r", ...body }));
    dead(1, { mode: "dirty" });
    dead(2, { mode: "dirty" });
    liveRunMarkers(dir, "r", 60_000, Date.now());
    const flags = readRepairNeeded(dir, "r");
    assert.equal(flags?.flags.length, 2, "two dead runs, two flags");
    assert.equal(flags?.mode, "dirty");
    dead(3, { mode: "incremental" });
    liveRunMarkers(dir, "r", 60_000, Date.now());
    assert.equal(readRepairNeeded(dir, "r")?.flags.length, 3);
    assert.equal(readRepairNeeded(dir, "r")?.mode, "incremental");
    assert.ok(!fs.readdirSync(dir).some((n) => n.endsWith(".tmp")), "written by rename: no temp file is left");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("MCP-ISSUE-101 F4: a flag file that cannot be parsed counts as a full repair, never as nothing wrong", async () => {
  const h = harness({ budgetMs: 1000, autoFinish: true });
  try {
    fs.writeFileSync(path.join(h.lockDir, "repair-r-999999-1700000000000-1.json"), "{\"mode\":\"dir"); // half-written
    assert.equal(readRepairNeeded(h.lockDir, "r")?.mode, "full");
    const note = await h.gate.ensureFresh("r");
    assert.notEqual(note.state, "fresh", JSON.stringify(note));
    assert.deepEqual(h.runs.map((r) => r.mode), ["full"]);
    assert.equal(readRepairNeeded(h.lockDir, "r"), null, "cleared by the finished repair");
  } finally { h.cleanup(); }
});

test("MCP-ISSUE-101 F4: a repair clears only the flags it started with; a run that died meanwhile stays flagged", async () => {
  const h = harness({ budgetMs: 1000 }); // the fake run waits until released
  try {
    fs.writeFileSync(path.join(h.lockDir, "running-r-999999-1.json"), JSON.stringify({ pid: 999999, at: 1, mode: "full", repoId: "r" }));
    const first = h.gate.ensureFresh("r"); // starts the repair run, which waits
    await new Promise((resolve) => setTimeout(resolve, 50));
    // another process's run dies while the repair works
    fs.writeFileSync(path.join(h.lockDir, "repair-r-424242-1700000000001-1.json"), JSON.stringify({ repoId: "r", mode: "full", pid: 424242, at: 2 }));
    h.finishRun();
    await first;
    const left = readRepairNeeded(h.lockDir, "r");
    assert.equal(left?.flags.length, 1, "only the flag written during the run is left");
    assert.equal(left?.pid, 424242);
    // and a full run that began after that flag clears it
    await h.gate.serialize("r", async () => ({ status: "ok" }), "full");
    assert.equal(readRepairNeeded(h.lockDir, "r"), null);
  } finally { h.cleanup(); }
});

test("MCP-ISSUE-101 F4: a full run does not clear a flag written while it ran (snapshot taken at its start)", async () => {
  const h = harness({ budgetMs: 1000, autoFinish: true });
  try {
    fs.writeFileSync(path.join(h.lockDir, "repair-r-111-1700000000000-1.json"), JSON.stringify({ repoId: "r", mode: "full", pid: 111, at: 1 }));
    await h.gate.serialize("r", async () => {
      fs.writeFileSync(path.join(h.lockDir, "repair-r-222-1700000000001-1.json"), JSON.stringify({ repoId: "r", mode: "full", pid: 222, at: 2 }));
      return { status: "ok" };
    }, "full");
    assert.deepEqual(readRepairNeeded(h.lockDir, "r")?.flags, ["repair-r-222-1700000000001-1.json"]);
  } finally { h.cleanup(); }
});

test("MCP-ISSUE-101 F4: repair flags of `a` and `a-b` do not mix", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "cim-repair-ab-"));
  try {
    fs.writeFileSync(path.join(dir, "repair-a-b-1-2-3.json"), JSON.stringify({ repoId: "a-b", mode: "full", pid: 1, at: 1 }));
    assert.equal(readRepairNeeded(dir, "a"), null);
    assert.equal(readRepairNeeded(dir, "a-b")?.flags.length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("MCP-ISSUE-101 F4: a killed DIRTY run — dependents included — is repaired by a full run and the index equals a clean full run", async () => {
  const h = harness({ budgetMs: 1000, autoFinish: true });
  const repo = bigRepo();
  const cleanDir = mkdtempSync(path.join(tmpdir(), "cim-clean-"));
  const limits = { subtxSize: 5, checkpointEveryNBatches: 1, largeFileThresholdBytes: 512 * 1024, maxFileSizeBytes: 500 * 1024, parseWorkers: 0, parseJobTimeoutMs: 20_000 };
  const dbPath = path.join(h.lockDir, "x.db");
  const shape = (db: Database.Database): Record<string, number> => {
    const n = (sql: string): number => (db.prepare(sql).get() as { n: number }).n;
    return {
      symbols: n("select count(*) as n from symbols where repo_id = 'r'"),
      edges: n("select count(*) as n from edges where repo_id = 'r'"),
      unresolved: n("select count(*) as n from edges where repo_id = 'r' and to_id like 'callee:%'"),
      files: n("select count(*) as n from files where repo_id = 'r'")
    };
  };
  try {
    // 1. a complete index of the tree
    const first = new GraphStore(dbPath);
    first.ensureRepository("r", repo);
    await createIndexRunner({ store: first, limits, resolvePerformanceProfileOverride: () => "standard" })("r", repo, "full", false, 5000, 50);
    first.close();
    // 2. ONE file changes and its rows shift: every file importing it is a dependent the dirty run queues after it
    fs.writeFileSync(path.join(repo, "src/util.ts"), "// moved\n// down\nexport function helper(): number {\n  return 1;\n}\n");
    const edited = ["src/util.ts"];
    // 3. the dirty run is killed after a few progress ticks, i.e. once some of those dependents were re-extracted
    const pathsFile = path.join(h.lockDir, "paths.json");
    fs.writeFileSync(pathsFile, JSON.stringify(edited));
    const c = startChild(h.lockDir, repo, ["dirty", pathsFile, "2"]);
    await c.waitFor("midrun");
    c.child.kill("SIGKILL");
    await new Promise((resolve) => c.child.once("exit", resolve));
    const killed = new Database(dbPath);
    try {
      const util = killed.prepare("select content_hash as h from files where repo_id = 'r' and path = 'src/util.ts'").get() as { h: string };
      assert.ok(util.h.length > 0, "the dirty run had written util.ts");
    } finally { killed.close(); }

    // 4. another process's gate sees a clean tree at the indexed HEAD, and repairs
    const store = new GraphStore(dbPath);
    const run = createIndexRunner({ store, limits, resolvePerformanceProfileOverride: () => "standard" });
    const modes: string[] = [];
    const gate = createFreshnessGate({
      enabled: true,
      budgetMs: 120_000,
      lockDir: h.lockDir,
      getRepoPath: () => repo,
      getIndexedCommit: () => "aaa111",
      readTree: () => ({ head: "aaa111", dirty: [] }),
      run: async (id, p, mode, dirtyPaths) => {
        modes.push(mode);
        return run(id, p, mode, false, 5000, 50, dirtyPaths ? { knownDirtyPaths: dirtyPaths } : undefined);
      }
    });
    const note = await gate.ensureFresh("r");
    assert.notEqual(note.state, "fresh", JSON.stringify(note));
    assert.deepEqual(modes, ["full"], "a dead dirty run is repaired by a full run: the dependents it queued cannot be reconstructed");
    assert.deepEqual(await gate.ensureFresh("r"), { state: "fresh" });

    const clean = new GraphStore(path.join(cleanDir, "y.db"));
    clean.ensureRepository("r", repo);
    await createIndexRunner({ store: clean, limits, resolvePerformanceProfileOverride: () => "standard" })("r", repo, "full", false, 5000, 50);
    const probe = new Database(dbPath);
    const probeClean = new Database(path.join(cleanDir, "y.db"));
    try {
      assert.deepEqual(shape(probe), shape(probeClean), "the repaired index equals a full run of the edited tree");
      assert.ok((shape(probe).edges ?? 0) > 400);
    } finally {
      probe.close();
      probeClean.close();
      clean.close();
      store.close();
    }
  } finally {
    h.cleanup();
    rmSync(cleanDir, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test("MCP-ISSUE-101 F4: a dead marker is unlinked only after its repair flag is on disk; a failed write keeps it for the next check", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "cim-sweep-"));
  try {
    const marker = path.join(dir, "running-r-999999-1.json");
    fs.writeFileSync(marker, JSON.stringify({ pid: 999999, at: 1, mode: "full", repoId: "r" }));
    assert.deepEqual(liveRunMarkers(dir, "r", 60_000, Date.now(), () => false), [], "the failing writer: not a live run");
    assert.ok(fs.existsSync(marker), "the marker is kept: it is the only memory of the dead run");
    assert.equal(readRepairNeeded(dir, "r"), null);
    liveRunMarkers(dir, "r", 60_000, Date.now()); // the next check, with a working state dir
    assert.equal(readRepairNeeded(dir, "r")?.mode, "full");
    assert.ok(!fs.existsSync(marker), "swept once the flag exists");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("remove_repository's state sweep also removes orphan .tmp flag files of that repo, and only that repo's", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "cim-tmp-"));
  try {
    for (const f of ["repair-r-1-2-3.json.77.tmp", "repairtry-r-1-2-4.json.77.tmp", "repair-r-b-1-2-3.json.77.tmp"]) fs.writeFileSync(path.join(dir, f), "{");
    assert.deepEqual(removeRepoStateFiles(dir, "r"), ["repair-r-1-2-3.json.77.tmp", "repairtry-r-1-2-4.json.77.tmp"]);
    assert.deepEqual(fs.readdirSync(dir), ["repair-r-b-1-2-3.json.77.tmp"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
