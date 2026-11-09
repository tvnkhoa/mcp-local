import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { searchRegexImpl, type RegexSearchStore } from "./regexSearch.js";

/**
 * `search_regex{ outputMode:"files" }` — the `grep -l` answer.
 *
 * Replaying 51 real wec.aria greps, 9 missed only because a broad pattern spent the 500-match limit
 * on the first few files. Files mode spends `limit` on FILES, so "which files mention X" is one call.
 */

function fakeStore(repoPath: string, files: string[]): RegexSearchStore {
  return {
    getRepository: () => ({ repoPath }),
    listIndexedFiles: () => files.map((p) => ({ path: p, language: "typescript" })),
    findSymbolAtLine: () => null
  };
}

test("files mode returns one row per matching file, and limit counts files, not matches", async () => {
  const repo = mkdtempSync(path.join(tmpdir(), "cim-regex-files-"));
  try {
    const names = ["a.ts", "b.ts", "c.ts", "d.ts"];
    // a.ts alone holds 300 matches: in match mode, limit 50 would never leave it.
    writeFileSync(path.join(repo, "a.ts"), "const usage = 1;\n".repeat(300));
    writeFileSync(path.join(repo, "b.ts"), "// nothing here\nexport const usage = 2;\n");
    writeFileSync(path.join(repo, "c.ts"), "export const other = 3;\n");
    writeFileSync(path.join(repo, "d.ts"), "usage;\n");
    const store = fakeStore(repo, names);

    const byMatch = await searchRegexImpl(store, "r", { pattern: "usage", limit: 50 });
    assert.deepEqual([...new Set(byMatch.matches.map((m) => m.filePath))], ["a.ts"], "precondition: match mode drowns in one file");

    const byFile = await searchRegexImpl(store, "r", { pattern: "usage", limit: 50, outputMode: "files" });
    assert.deepEqual(byFile.matches, []);
    assert.deepEqual(byFile.files?.map((f) => f.filePath), ["a.ts", "b.ts", "d.ts"]);
    assert.equal(byFile.files?.[1]?.firstLine, 2);
    assert.equal(byFile.files?.[0]?.matchCount, 200, "per-file counting stops at the per-file cap");
    // a.ts hits the per-file cap: MCP-ISSUE-100 makes that a truncation instead of a silent one.
    assert.equal(byFile.truncationReason, "per_file_cap");

    const capped = await searchRegexImpl(store, "r", { pattern: "usage", limit: 2, outputMode: "files" });
    assert.equal(capped.files?.length, 2);
    assert.equal(capped.truncationReason, "limit_reached");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

/**
 * MCP-ISSUE-121: the scan must not hold the server thread. 600 files used to be read with statSync/readFileSync in one
 * synchronous stretch, during which no timer, socket or other call could run. A 1 ms interval must fire while the
 * scan runs, and the answer must be what the synchronous scan returned.
 */
test("the scan yields to the event loop while it reads, and its answer is unchanged", async () => {
  const repo = mkdtempSync(path.join(tmpdir(), "cim-regex-yield-"));
  try {
    const names = Array.from({ length: 600 }, (_, i) => `f${String(i).padStart(4, "0")}.ts`);
    for (const [i, n] of names.entries()) writeFileSync(path.join(repo, n), `export const v${String(i)} = "needle ${String(i)}";\n`.repeat(40));
    const store = fakeStore(repo, names);
    let ticks = 0;
    const timer = setInterval(() => ticks++, 1);
    const r = await searchRegexImpl(store, "r", { pattern: "needle [0-9]+", limit: 500, outputMode: "files" });
    clearInterval(timer);
    assert.ok(ticks > 0, "no timer ran during the scan: it blocked the event loop");
    assert.equal(r.files?.length, 500);
    assert.deepEqual(r.files?.slice(0, 2).map((f) => [f.filePath, f.matchCount, f.firstLine]), [["f0000.ts", 40, 1], ["f0001.ts", 40, 1]]);
    assert.equal(r.filesScanned, 500);
    assert.equal(r.nextAfterPath, "f0499.ts");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
