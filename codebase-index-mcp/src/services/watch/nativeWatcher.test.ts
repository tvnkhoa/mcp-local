import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type fs from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { isIgnoredWatchPath, startNativeRecursiveWatcher, type WatchFn } from "./nativeWatcher.js";

/** A fake fs.watch: the test fires the listener itself, as Windows would. */
function fakeWatch(): { watchFn: WatchFn; fire: (filename: string | null) => void } {
  let listener: ((event: string, filename: string | Buffer | null) => void) | undefined;
  const watcher = Object.assign(new EventEmitter(), { close: () => {}, ref: () => watcher, unref: () => watcher });
  return {
    watchFn: (_root, _opts, l) => {
      listener = l;
      return watcher as unknown as fs.FSWatcher;
    },
    fire: (filename) => listener?.("rename", filename)
  };
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 50));

test("MCP-ISSUE-121 review M: a nameless event with the root still present is a buffer overflow, not a root check only", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "cim-native-ovf-"));
  const seen: string[] = [];
  const fake = fakeWatch();
  const w = startNativeRecursiveWatcher(
    dir,
    {
      onChange: () => seen.push("change"),
      onDelete: () => seen.push("delete"),
      onError: () => seen.push("error"),
      onRootGone: () => seen.push("gone"),
      onOverflow: () => seen.push("overflow")
    },
    fake.watchFn
  );
  try {
    fake.fire(null);
    await tick();
    assert.deepEqual(seen, ["overflow"]);
    rmSync(dir, { recursive: true, force: true });
    fake.fire(null);
    await tick();
    assert.deepEqual(seen, ["overflow", "gone"], "a nameless event after the root went away stops the watcher instead");
  } finally {
    await w.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ignored subtrees match by path segment, either slash", () => {
  assert.equal(isIgnoredWatchPath("node_modules/x/index.js"), true);
  assert.equal(isIgnoredWatchPath("packages\\api\\dist\\a.js"), true);
  assert.equal(isIgnoredWatchPath(".git"), true);
  assert.equal(isIgnoredWatchPath("src/distribution.ts"), false);
});
