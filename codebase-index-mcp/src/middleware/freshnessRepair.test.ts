import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { markRepairNeeded, readRepairNeeded, readRepairNeededAsync } from "./freshness.js";

/**
 * MCP-ISSUE-134 follow-up: the freshness gate reads the repair flags with readRepairNeededAsync (off the server thread).
 * It must give the sync reader's answer for every shape of the state dir.
 */

function withDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(path.join(tmpdir(), "cim-repair-async-"));
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}

async function same(dir: string, repoId: string): Promise<ReturnType<typeof readRepairNeeded>> {
  const sync = readRepairNeeded(dir, repoId);
  const async = await readRepairNeededAsync(dir, repoId);
  assert.deepEqual(async, sync, `repoId ${repoId}`);
  return async;
}

test("a missing state dir and an empty one: no repair, both readers", async () => {
  await withDir(async (dir) => {
    assert.equal(await same(path.join(dir, "missing"), "r"), null);
    assert.equal(await same(dir, "r"), null);
  });
});

test("several flags: the strongest mode, the newest at, the attempts counted", async () => {
  await withDir(async (dir) => {
    assert.ok(markRepairNeeded(dir, "r", { mode: "dirty", pid: 11, at: 100 }));
    assert.ok(markRepairNeeded(dir, "r", { mode: "incremental", pid: 12, at: 300 }));
    writeFileSync(path.join(dir, "repairtry-r-1-2-3.json"), JSON.stringify({ at: 1 }));
    writeFileSync(path.join(dir, "repairtry-r-1-2-4.json"), JSON.stringify({ at: 2 }));
    const r = await same(dir, "r");
    assert.equal(r?.mode, "incremental");
    assert.equal(r?.at, 300);
    assert.equal(r?.attempts, 2);
    assert.equal(r?.flags.length, 2);
  });
});

test("a half-written or unreadable flag reads as a full repair", async () => {
  await withDir(async (dir) => {
    writeFileSync(path.join(dir, "repair-r-1-2-3.json"), "{\"mode\":\"dir");
    assert.equal((await same(dir, "r"))?.mode, "full");
  });
});

test("a namesake's flags and attempts are not this repo's (shared sanitized prefix)", async () => {
  await withDir(async (dir) => {
    // "a/b" and "a_b" sanitize to the same prefix; the body's repoId tells them apart.
    assert.ok(markRepairNeeded(dir, "a/b", { mode: "full", pid: 1, at: 5 }));
    writeFileSync(path.join(dir, "repairtry-a_b-1-2-3.json"), JSON.stringify({ repoId: "a/b", at: 1 }));
    assert.equal(await same(dir, "a_b"), null);
    assert.equal((await same(dir, "a/b"))?.attempts, 1);
    // A prefix of another id ("a" vs "a-b") never matches: the name check needs digits after the prefix.
    assert.ok(markRepairNeeded(dir, "a-b", { mode: "dirty", pid: 1, at: 5 }));
    assert.equal(await same(dir, "a"), null);
    assert.equal((await same(dir, "a-b"))?.mode, "dirty");
  });
});

test("attempts without a flag: no repair (the attempt count alone is not a verdict)", async () => {
  await withDir(async (dir) => {
    writeFileSync(path.join(dir, "repairtry-r-1-2-3.json"), JSON.stringify({ at: 1 }));
    assert.equal(await same(dir, "r"), null);
  });
});

test("readRepairNeededAsync makes no sync fs call (the gate runs it on the server thread)", async () => {
  await withDir(async (dir) => {
    assert.ok(markRepairNeeded(dir, "r", { mode: "full", pid: 1, at: 5 }));
    writeFileSync(path.join(dir, "repairtry-r-1-2-3.json"), JSON.stringify({ at: 1 }));
    const { createRequire, syncBuiltinESMExports } = await import("node:module");
    const fsCjs = createRequire(import.meta.url)("node:fs") as Record<string, unknown>;
    const names = ["readFileSync", "readdirSync", "statSync", "existsSync"];
    const originals = names.map((n) => fsCjs[n]);
    const calls: string[] = [];
    names.forEach((n, i) => {
      const orig = originals[i] as (...a: unknown[]) => unknown;
      fsCjs[n] = (...a: unknown[]) => {
        calls.push(`${n}(${String(a[0])})`);
        return orig(...a);
      };
    });
    syncBuiltinESMExports();
    let answer: Awaited<ReturnType<typeof readRepairNeededAsync>> = null;
    try {
      answer = await readRepairNeededAsync(dir, "r");
      assert.deepEqual(calls, []);
      readRepairNeeded(dir, "r");
      assert.ok(calls.length > 0, "the spy sees the sync reader's calls");
    } finally {
      names.forEach((n, i) => {
        fsCjs[n] = originals[i];
      });
      syncBuiltinESMExports();
    }
    assert.equal(answer?.mode, "full");
    assert.equal(answer?.attempts, 1);
  });
});
