import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { scanRepoFiles } from "./fileScan.js";

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
