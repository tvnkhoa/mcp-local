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

test("files mode returns one row per matching file, and limit counts files, not matches", () => {
  const repo = mkdtempSync(path.join(tmpdir(), "cim-regex-files-"));
  try {
    const names = ["a.ts", "b.ts", "c.ts", "d.ts"];
    // a.ts alone holds 300 matches: in match mode, limit 50 would never leave it.
    writeFileSync(path.join(repo, "a.ts"), "const usage = 1;\n".repeat(300));
    writeFileSync(path.join(repo, "b.ts"), "// nothing here\nexport const usage = 2;\n");
    writeFileSync(path.join(repo, "c.ts"), "export const other = 3;\n");
    writeFileSync(path.join(repo, "d.ts"), "usage;\n");
    const store = fakeStore(repo, names);

    const byMatch = searchRegexImpl(store, "r", { pattern: "usage", limit: 50 });
    assert.deepEqual([...new Set(byMatch.matches.map((m) => m.filePath))], ["a.ts"], "precondition: match mode drowns in one file");

    const byFile = searchRegexImpl(store, "r", { pattern: "usage", limit: 50, outputMode: "files" });
    assert.deepEqual(byFile.matches, []);
    assert.deepEqual(byFile.files?.map((f) => f.filePath), ["a.ts", "b.ts", "d.ts"]);
    assert.equal(byFile.files?.[1]?.firstLine, 2);
    assert.equal(byFile.files?.[0]?.matchCount, 200, "per-file counting stops at the per-file cap");
    // a.ts hits the per-file cap: MCP-ISSUE-100 makes that a truncation instead of a silent one.
    assert.equal(byFile.truncationReason, "per_file_cap");

    const capped = searchRegexImpl(store, "r", { pattern: "usage", limit: 2, outputMode: "files" });
    assert.equal(capped.files?.length, 2);
    assert.equal(capped.truncationReason, "limit_reached");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
