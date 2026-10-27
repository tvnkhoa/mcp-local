import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { existsWithExactCase, scanRepoFiles, type DirListings } from "./fileScan.js";

/**
 * MCP-ISSUE-066 structural fix. The caller truncates `files` to `maxFiles`, so anything the scan
 * returns competes for that budget. A segment-only exclusion (`public`, `wwwroot`, `.vscode`, …)
 * that the scan still returned could fill the budget ahead of the real sources — `.vs/` did exactly
 * that in wec.social-ads (`filesIndexed: 1`). The scan must drop those paths itself.
 */
function makeRepo(layout: Record<string, number>): string {
  const root = mkdtempSync(path.join(tmpdir(), "fileScan-"));
  for (const [dir, count] of Object.entries(layout)) {
    mkdirSync(path.join(root, dir), { recursive: true });
    for (let i = 0; i < count; i++) writeFileSync(path.join(root, dir, `f${String(i)}.ts`), "export {};\n");
  }
  return root;
}

const rel = (root: string, files: string[]) => files.map((f) => path.relative(root, f).replace(/\\/g, "/"));

test("segment-only excluded trees never reach the maxFiles budget", async () => {
  const root = makeRepo({ "assets/gen": 30, "public": 30, ".vscode": 5, "logs": 5, "src": 3 });
  try {
    const { files } = await scanRepoFiles({ repoId: "r", repoPath: root, mode: "full" }, 10, false);
    assert.deepEqual(rel(root, files), ["src/f0.ts", "src/f1.ts", "src/f2.ts"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("exclusion is tested on the repo-relative path, so a repo under an excluded name still scans", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "fileScan-"));
  const root = path.join(parent, "assets", "repo");
  mkdirSync(path.join(root, "src"), { recursive: true });
  writeFileSync(path.join(root, "src", "a.ts"), "export {};\n");
  try {
    const { files } = await scanRepoFiles({ repoId: "r", repoPath: root, mode: "full" }, 10, false);
    assert.deepEqual(rel(root, files), ["src/a.ts"]);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("the dirty-file restriction still applies on top of the exclusion", async () => {
  const root = makeRepo({ "public": 2, "src": 2 });
  try {
    const { files } = await scanRepoFiles(
      { repoId: "r", repoPath: root, mode: "dirty", onlyRelativePaths: new Set(["src/f1.ts", "public/f0.ts"]) },
      10,
      false
    );
    assert.deepEqual(rel(root, files), ["src/f1.ts"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("gitignored output is not walked, and is named in the skip tally; untracked-not-ignored is", async () => {
  // wec.aria (release B acceptance): packages/core/dist-runtime/ is gitignored, yet was indexed, so
  // every core symbol appeared twice. Git decides what is source.
  const root = makeRepo({ "src": 2, "dist-runtime/tools": 3 });
  try {
    writeFileSync(path.join(root, ".gitignore"), "dist-runtime/\n");
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["add", ".gitignore", "src/f0.ts"], { cwd: root });
    // src/f1.ts stays untracked but not ignored: it is new work, and must be indexed.
    const { files, droppedByPath } = await scanRepoFiles({ repoId: "r", repoPath: root, mode: "full" }, 100, false);
    assert.deepEqual(rel(root, files).filter((p) => p.endsWith(".ts")), ["src/f0.ts", "src/f1.ts"]);
    assert.equal(droppedByPath.get("gitignored\u0000.ts"), 3);

    const off = await scanRepoFiles({ repoId: "r", repoPath: root, mode: "full", respectGitignore: false }, 100, false);
    assert.equal(rel(root, off.files).filter((p) => p.startsWith("dist-runtime/")).length, 3, "the opt-out restores the plain walk");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a dirty run's restricted scan keeps exactly what the full walk would (release J)", async () => {
  // The dirty run no longer walks the tree: `isIgnoredByIndexWalk` stands in for the glob's ignore list.
  // Every path here is dirty, so the full walk's answer restricted to them is what the dirty scan must return.
  const files = [
    "src/a.ts",
    "src/node_modules/pkg/index.ts",
    "deep/x/.git/hooks/h.ts",
    "src/build.log",
    "src/yarn.lock",
    "src/package-lock.json",
    "src/.hidden/b.ts",
    "packages/p/vendor-like/c.ts",
    "docs/readme.md"
  ];
  const root = mkdtempSync(path.join(tmpdir(), "fileScan-dirty-"));
  try {
    for (const f of files) {
      mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
      writeFileSync(path.join(root, f), "export {};\n");
    }
    const all = new Set(files);
    const walked = rel(root, (await scanRepoFiles({ repoId: "r", repoPath: root, mode: "full", respectGitignore: false }, 100, true)).files);
    const dirty = rel(root, (await scanRepoFiles({ repoId: "r", repoPath: root, mode: "dirty", onlyRelativePaths: all }, 100, true)).files);
    assert.deepEqual(dirty, walked);
    assert.ok(dirty.includes("src/a.ts") && !dirty.includes("src/node_modules/pkg/index.ts") && !dirty.includes("src/build.log"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("existsWithExactCase: each directory is read once per run, across many paths and both passes (filter, prune)", () => {
  const root = mkdtempSync(path.join(tmpdir(), "cim-exactcase-"));
  try {
    mkdirSync(path.join(root, "src", "a"), { recursive: true });
    for (const n of ["one.ts", "two.ts", "three.ts"]) writeFileSync(path.join(root, "src", "a", n), "x\n");
    writeFileSync(path.join(root, "src", "Caller.ts"), "x\n");
    const reads = new Map<string, number>();
    const readdir = (dir: string): string[] => {
      reads.set(dir, (reads.get(dir) ?? 0) + 1);
      return readdirSync(dir);
    };
    const listings: DirListings = new Map();
    const paths = ["src/a/one.ts", "src/a/two.ts", "src/a/three.ts", "src/Caller.ts", "src/caller.ts"];
    for (let pass = 0; pass < 2; pass++) {
      assert.deepEqual(
        paths.map((p) => existsWithExactCase(root, p, listings, readdir)),
        [true, true, true, true, false],
        "the old spelling of a case-only rename does not exist"
      );
    }
    assert.deepEqual([...reads.values()], [1, 1, 1], `one read each for root, src, src/a: ${JSON.stringify([...reads])}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("existsWithExactCase: names compare in NFC, so an NFD listing (macOS HFS+) still finds a non-ASCII file", () => {
  const root = mkdtempSync(path.join(tmpdir(), "cim-exactcase-nfc-"));
  try {
    const nfc = "café.ts";
    writeFileSync(path.join(root, nfc), "x\n");
    const nfdListing = (): string[] => [nfc.normalize("NFD")];
    assert.equal(existsWithExactCase(root, nfc, new Map(), nfdListing), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
