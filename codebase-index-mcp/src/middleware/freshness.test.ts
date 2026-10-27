import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { applyFreshness, computeTreeKey, createFreshnessGate, pathsChangedSince, tryAcquireLock, type RepoTreeState } from "./freshness.js";
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
    fs.writeFileSync(file, "export const a = 2;\n"); // same size, new content
    fs.utimesSync(file, t, t); // and the same mtime: only the content says it changed
    assert.equal((await h.gate.ensureFresh("r")).state, "refreshed", "a content change refreshes");
    assert.deepEqual(await h.gate.ensureFresh("r"), { state: "fresh" });
    assert.equal(h.runs.length, 2, "exactly one more run");
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
