import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
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
