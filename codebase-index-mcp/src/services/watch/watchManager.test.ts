import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import type { WatchConfig } from "../../types/index.js";
import { WatchManager, type WatchBatch } from "./watchManager.js";

/**
 * MCP-ISSUE-101: a watcher batch hands its changed / deleted paths to the indexer (a dirty run over them), instead
 * of starting a whole-repo incremental re-hash; only a batch that dropped events falls back, pruning first.
 */

const config = { debounceMs: 10, maxQueuedEvents: 3, maxFilesPerRun: 100, batchSize: 10 } as unknown as WatchConfig;
type Internals = { onEvent: (repoId: string, repoPath: string, abs: string, mode: "changed" | "deleted") => void };
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 60));

test("MCP-ISSUE-101: a watcher batch passes its paths; nothing is pruned ahead of the dirty run", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "cim-watch-"));
  const batches: WatchBatch[] = [];
  const pruned: string[][] = [];
  const m = new WatchManager(config, async (_r, _p, _c, batch) => { batches.push(batch); }, (_r, paths) => { pruned.push(paths); return paths.length; });
  try {
    m.start("r", dir);
    const internals = m as unknown as Internals;
    internals.onEvent("r", dir, path.join(dir, "src", "a.ts"), "changed");
    internals.onEvent("r", dir, path.join(dir, "b.ts"), "deleted");
    await settle();
    assert.deepEqual(batches, [{ changed: ["src/a.ts"], deleted: ["b.ts"], overflowed: false }]);
    assert.deepEqual(pruned, [], "the dirty run removes b.ts itself, re-extracting its dependents");
  } finally {
    await m.stopAll();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("MCP-ISSUE-101: a batch that dropped events says so, and its deleted paths are pruned for the fallback run", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "cim-watch-"));
  const batches: WatchBatch[] = [];
  const pruned: string[][] = [];
  const m = new WatchManager(config, async (_r, _p, _c, batch) => { batches.push(batch); }, (_r, paths) => { pruned.push(paths); return paths.length; });
  try {
    m.start("r", dir);
    const internals = m as unknown as Internals;
    internals.onEvent("r", dir, path.join(dir, "gone.ts"), "deleted");
    for (const n of ["c1", "c2", "c3", "c4"]) internals.onEvent("r", dir, path.join(dir, `${n}.ts`), "changed");
    await settle();
    assert.equal(batches.length, 1);
    assert.equal(batches[0]?.overflowed, true);
    assert.deepEqual(pruned, [["gone.ts"]]);
  } finally {
    await m.stopAll();
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * MCP-ISSUE-121: the win32 backend (one recursive fs.watch) must see what chokidar saw. The same file operations
 * run under both backends; the union of what their batches report must be equal — ignored subtrees left out.
 */
async function observe(backend: "native-recursive" | "chokidar"): Promise<{ changed: string[]; deleted: string[] }> {
  const dir = mkdtempSync(path.join(tmpdir(), `cim-watch-${backend}-`));
  mkdirSync(path.join(dir, "src"), { recursive: true });
  writeFileSync(path.join(dir, "src", "keep.ts"), "export const k = 1;\n");
  writeFileSync(path.join(dir, "src", "gone.ts"), "export const g = 1;\n");
  const changed = new Set<string>();
  const deleted = new Set<string>();
  const slow = { ...config, debounceMs: 300, maxQueuedEvents: 1000 } as WatchConfig;
  const m = new WatchManager(slow, async (_r, _p, _c, batch) => {
    for (const p of batch.changed) changed.add(p);
    for (const p of batch.deleted) deleted.add(p);
  }, () => 0, undefined, backend);
  try {
    m.start("r", dir);
    await new Promise((r) => setTimeout(r, 1500)); // chokidar's initial walk
    writeFileSync(path.join(dir, "src", "new.ts"), "export const n = 1;\n");
    writeFileSync(path.join(dir, "src", "keep.ts"), "export const k = 2;\n");
    rmSync(path.join(dir, "src", "gone.ts"));
    mkdirSync(path.join(dir, "node_modules", "pkg"), { recursive: true });
    writeFileSync(path.join(dir, "node_modules", "pkg", "index.js"), "module.exports = 1;\n");
    mkdirSync(path.join(dir, "dist"), { recursive: true });
    writeFileSync(path.join(dir, "dist", "out.js"), "1;\n");
    await new Promise((r) => setTimeout(r, 2000)); // awaitWriteFinish (chokidar) + debounce
    return { changed: [...changed].sort(), deleted: [...deleted].sort() };
  } finally {
    await m.stopAll();
    rmSync(dir, { recursive: true, force: true });
  }
}

test("MCP-ISSUE-121: the native recursive watcher reports the same changes as chokidar, ignored subtrees excluded", async () => {
  const native = await observe("native-recursive");
  const choki = await observe("chokidar");
  assert.deepEqual(native, { changed: ["src/keep.ts", "src/new.ts"], deleted: ["src/gone.ts"] });
  assert.deepEqual(native, choki);
});

test("MCP-ISSUE-121: a watcher whose root is deleted stops itself (a removed worktree)", async () => {
  // chokidar on Windows leaves one fs.watch handle open after its root is deleted (inside chokidar), which keeps the
  // test process alive; win32 serves watchers natively, so chokidar's case is checked where it serves them.
  const backends = process.platform === "win32" ? (["native-recursive"] as const) : (["native-recursive", "chokidar"] as const);
  for (const backend of backends) {
    const dir = mkdtempSync(path.join(tmpdir(), `cim-watch-gone-${backend}-`));
    mkdirSync(path.join(dir, "src"), { recursive: true });
    writeFileSync(path.join(dir, "src", "a.ts"), "export const a = 1;\n");
    const m = new WatchManager(config, async () => {}, () => 0, undefined, backend);
    try {
      m.start("r", dir);
      await new Promise((r) => setTimeout(r, 1000));
      assert.equal(m.getStatus("r").length, 1);
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      const until = Date.now() + 5000;
      while (m.getStatus("r").length > 0 && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
      assert.equal(m.getStatus("r").length, 0, `${backend}: the watcher of a deleted root is still running`);
    } finally {
      await m.stopAll();
      rmSync(dir, { recursive: true, force: true });
    }
  }
});
