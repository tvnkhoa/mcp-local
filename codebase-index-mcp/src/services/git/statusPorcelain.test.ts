import assert from "node:assert/strict";
import test from "node:test";

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  getRepoWorkingTreeState,
  parseStatusPorcelainV2,
  parseStatusPorcelainV2Entries,
  readStatusEntriesAsync,
  stillDirty,
  summarizeWorkingTree
} from "./gitHelpers.js";

/**
 * The R1 gate reads HEAD and the dirty set from one `git status --porcelain=v2 --branch -z` call
 * before every read query. The path set must equal what dirty-mode indexing re-reads.
 */

const SHA = "704eb34ffd375c72ffb7c843f60e8bebac0cb033";

test("head, modified, staged, untracked, a path with spaces, and both sides of a rename", () => {
  const out = [
    `# branch.oid ${SHA}`,
    "# branch.head develop",
    "1 .M N... 100644 100644 100644 aaa bbb packages/core/turn/index.ts",
    "1 A. N... 000000 100644 100644 000 ccc docs/new doc.md",
    "2 R. N... 100644 100644 100644 ddd eee R100 src/renamed.ts",
    "src/original.ts",
    "u UU N... 100644 100644 100644 100644 f1 f2 f3 conflicted.ts",
    "? zz-r1-probe.mjs",
    ""
  ].join("\0");
  const s = parseStatusPorcelainV2(out);
  assert.equal(s.head, SHA);
  assert.deepEqual(s.dirty.sort(), ["conflicted.ts", "docs/new doc.md", "packages/core/turn/index.ts", "src/original.ts", "src/renamed.ts", "zz-r1-probe.mjs"]);
});

test("a clean tree has a head and no paths; before the first commit there is no head", () => {
  assert.deepEqual(parseStatusPorcelainV2(`# branch.oid ${SHA}\0# branch.head main\0`), { head: SHA, dirty: [] });
  assert.equal(parseStatusPorcelainV2("# branch.oid (initial)\0# branch.head main\0? a.ts\0").head, null);
});

/**
 * MCP-ISSUE-086 (release K1): `health_check` reads git once, async, as porcelain v2 — and must answer
 * exactly what the two synchronous reads it replaced answered: v1's working-tree block (where an
 * untracked directory is ONE entry) and the dirty ledger's per-file check.
 */
test("health_check's one async read equals the v1 working-tree answer it replaced, on a real repo", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "cim-k1-"));
  const git = (...a: string[]) => execFileSync("git", a, { cwd: dir, encoding: "utf8" });
  try {
    git("init", "-q");
    git("config", "user.email", "t@t");
    git("config", "user.name", "t");
    writeFileSync(path.join(dir, "a.ts"), "export const a = 1;\n");
    writeFileSync(path.join(dir, "b.ts"), "export const b = 1;\n");
    writeFileSync(path.join(dir, "c.ts"), "export const c = 1;\n");
    git("add", ".");
    git("commit", "-qm", "init");
    const clean = await readStatusEntriesAsync(dir);
    assert.deepEqual(summarizeWorkingTree(clean.entries), getRepoWorkingTreeState(dir), "clean tree");
    assert.equal(clean.head, git("rev-parse", "HEAD").trim(), "HEAD from # branch.oid");

    writeFileSync(path.join(dir, "a.ts"), "export const a = 2;\n"); // modified
    git("mv", "b.ts", "b2.ts"); // staged rename
    mkdirSync(path.join(dir, "newdir"));
    writeFileSync(path.join(dir, "newdir", "x.ts"), "x\n"); // an untracked DIRECTORY
    writeFileSync(path.join(dir, "newdir", "y.ts"), "y\n");
    writeFileSync(path.join(dir, "loose.ts"), "z\n"); // an untracked file
    const dirty = await readStatusEntriesAsync(dir);
    assert.deepEqual(summarizeWorkingTree(dirty.entries), getRepoWorkingTreeState(dir), "dirty tree: same counts as v1");
    assert.equal(summarizeWorkingTree(dirty.entries).changedEntries, 4, "a.ts, the rename, newdir/ and loose.ts");

    // The ledger check: files under the collapsed untracked directory are still dirty; c.ts never was.
    assert.deepEqual(stillDirty(dirty.entries, ["newdir/x.ts", "b.ts", "b2.ts", "loose.ts", "c.ts", "gone.ts"]), ["newdir/x.ts", "b.ts", "b2.ts", "loose.ts"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("outside git the async read rejects, and the summary is the v1 non-git answer", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "cim-k1-nogit-"));
  try {
    await assert.rejects(readStatusEntriesAsync(dir));
    assert.deepEqual(summarizeWorkingTree(null), getRepoWorkingTreeState(dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("porcelain v2 entries keep one entry per rename, with its old path", () => {
  const out = [`# branch.oid ${SHA}`, "2 R. N... 100644 100644 100644 ddd eee R100 src/renamed.ts", "src/original.ts", "? newdir/", ""].join("\0");
  assert.deepEqual(parseStatusPorcelainV2Entries(out), {
    head: SHA,
    entries: [
      { code: "2", path: "src/renamed.ts", origPath: "src/original.ts", xy: "R." },
      { code: "?", path: "newdir/" }
    ]
  });
});
