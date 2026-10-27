import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { searchRegexImpl, type RegexSearchStore } from "./regexSearch.js";
import { handleSearchRegex } from "../../tools/handlers/searchHandler.js";

/**
 * MCP-ISSUE-100: a capped search_regex used to look complete. Every cap (match limit, scan cap, per-file
 * cap) must now say so, and `afterPath` must resume with no file repeated or skipped.
 */

function fakeStore(repoPath: string, files: string[]): RegexSearchStore {
  return {
    getRepository: () => ({ repoPath }),
    listIndexedFiles: () => files.map((p) => ({ path: p, language: "typescript" })),
    findSymbolAtLine: () => null
  };
}

function withRepo(files: Record<string, string>, run: (store: RegexSearchStore) => void): void {
  const repo = mkdtempSync(path.join(tmpdir(), "cim-regex-trunc-"));
  try {
    for (const [name, body] of Object.entries(files)) writeFileSync(path.join(repo, name), body);
    run(fakeStore(repo, Object.keys(files)));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

const ONE_HIT_PER_FILE = { "a.ts": "hit\n", "b.ts": "hit\n", "c.ts": "hit\n", "d.ts": "hit\n", "e.ts": "hit\n" };

test("match limit hit: nextAfterPath is the last finished file, filesUnscanned counts the rest", () => {
  withRepo(ONE_HIT_PER_FILE, (store) => {
    const r = searchRegexImpl(store, "r", { pattern: "hit", limit: 2 });
    assert.equal(r.truncationReason, "limit_reached");
    assert.deepEqual(r.matches.map((m) => m.filePath), ["a.ts", "b.ts"]);
    assert.equal(r.nextAfterPath, "b.ts");
    assert.equal(r.filesUnscanned, 3);
  });
});

test("afterPath resumes: pages together equal the full scan, no file repeated or skipped", () => {
  withRepo(ONE_HIT_PER_FILE, (store) => {
    const seen: string[] = [];
    let after: string | undefined;
    for (let page = 0; page < 10; page++) {
      const r = searchRegexImpl(store, "r", { pattern: "hit", limit: 2, afterPath: after });
      seen.push(...r.matches.map((m) => m.filePath));
      if (r.nextAfterPath === null) break;
      after = r.nextAfterPath;
    }
    assert.deepEqual(seen, ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"]);
    const full = searchRegexImpl(store, "r", { pattern: "hit", limit: 50 });
    assert.equal(full.truncated, false);
    assert.equal(full.nextAfterPath, null);
  });
});

test("files mode: limit hit resumes the same way, and an unread file is not counted as scanned", () => {
  withRepo(ONE_HIT_PER_FILE, (store) => {
    const r = searchRegexImpl(store, "r", { pattern: "hit", limit: 3, outputMode: "files" });
    assert.equal(r.truncationReason, "limit_reached");
    assert.equal(r.filesScanned, 3);
    assert.equal(r.nextAfterPath, "c.ts");
    const rest = searchRegexImpl(store, "r", { pattern: "hit", limit: 3, outputMode: "files", afterPath: r.nextAfterPath ?? undefined });
    assert.deepEqual(rest.files?.map((f) => f.filePath), ["d.ts", "e.ts"]);
    assert.equal(rest.truncated, false);
  });
});

test("limit reached inside one file: resume skips its tail and says so", () => {
  withRepo({ "a.ts": "hit\n".repeat(10), "b.ts": "hit\n" }, (store) => {
    const r = searchRegexImpl(store, "r", { pattern: "hit", limit: 3 });
    assert.equal(r.truncationReason, "limit_reached");
    assert.equal(r.nextAfterPath, "a.ts");
    assert.equal(r.nextAfterPathCutMidFile, true);
    assert.equal(r.filesUnscanned, 1);
  });
});

test("per-file cap alone is a truncation, with no resume point", () => {
  withRepo({ "a.ts": "hit\n".repeat(300), "b.ts": "hit\n" }, (store) => {
    const r = searchRegexImpl(store, "r", { pattern: "hit", limit: 1000 });
    assert.equal(r.truncated, true);
    assert.equal(r.truncationReason, "per_file_cap");
    assert.deepEqual(r.perFileCapFiles, ["a.ts"]);
    assert.equal(r.nextAfterPath, null);
    assert.equal(r.filesUnscanned, 0);
    const byFile = searchRegexImpl(store, "r", { pattern: "hit", limit: 1000, outputMode: "files" });
    assert.equal(byFile.truncationReason, "per_file_cap");
  });
});

test("untruncated search has no truncation fields set", () => {
  withRepo(ONE_HIT_PER_FILE, (store) => {
    const r = searchRegexImpl(store, "r", { pattern: "hit", limit: 50 });
    assert.equal(r.truncated, false);
    assert.equal(r.truncationReason, null);
    assert.equal(r.nextAfterPath, null);
    assert.deepEqual(r.perFileCapFiles, []);
  });
});

function runHandler(store: RegexSearchStore, args: { limit: number; profile: string; outputMode?: "matches" | "files"; afterPath?: string }): Record<string, unknown> {
  const ctx = {
    store: { searchRegex: (id: string, o: Parameters<typeof searchRegexImpl>[2]) => searchRegexImpl(store, id, o), getRepository: store.getRepository },
    asText: (payload: unknown) => ({ content: [{ type: "text", text: JSON.stringify(payload) }] })
  };
  const res = handleSearchRegex(
    { repoId: "r", pattern: "hit", excludeTests: false, scanAll: false, contextLines: 0, ...args },
    ctx as unknown as Parameters<typeof handleSearchRegex>[1]
  );
  return JSON.parse((res.content[0] as { text: string }).text) as Record<string, unknown>;
}

test("handler: every profile carries complete/warning/nextAfterPath on truncation, complete:true otherwise", () => {
  withRepo(ONE_HIT_PER_FILE, (store) => {
    for (const profile of ["nano", "compact", "standard", "verbose"]) {
      const cut = runHandler(store, { limit: 2, profile });
      assert.equal(cut.complete, false, profile);
      assert.match(String(cut.warning), /PARTIAL.*3 NOT searched.*raise limit.*afterPath:"b\.ts"/s, profile);
      assert.equal(cut.nextAfterPath, "b.ts", profile);
      const whole = runHandler(store, { limit: 50, profile });
      assert.equal(whole.complete, true, profile);
      assert.equal(whole.warning, undefined, profile);
      assert.equal(whole.nextAfterPath, undefined, profile);
    }
    const files = runHandler(store, { limit: 2, profile: "nano", outputMode: "files" });
    assert.equal(files.complete, false);
    assert.equal(files.nextAfterPath, "b.ts");
  });
});

test("handler: per-file cap makes the answer incomplete and names the file", () => {
  withRepo({ "a.ts": "hit\n".repeat(300) }, (store) => {
    const r = runHandler(store, { limit: 1000, profile: "compact" });
    assert.equal(r.complete, false);
    assert.match(String(r.warning), /per-file match cap.*a\.ts/s);
    assert.equal(r.nextAfterPath, undefined);
  });
});
