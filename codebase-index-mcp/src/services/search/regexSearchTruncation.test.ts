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

test("limit reached inside one file: the cursor is the previous path plus the matches already returned", () => {
  withRepo({ "a.ts": "hit\n".repeat(10), "b.ts": "hit\n" }, (store) => {
    const r = searchRegexImpl(store, "r", { pattern: "hit", limit: 3 });
    assert.equal(r.truncationReason, "limit_reached");
    assert.equal(r.nextAfterPath, null, "a.ts is the first file: nothing precedes it");
    assert.equal(r.nextSkipMatches, 3);
    assert.equal(r.filesUnscanned, 1);
  });
});

test("a cursor loop over a file with more matches than the limit collects every match once, and terminates", () => {
  withRepo({ "a.ts": "x\n", "b.ts": "hit\n".repeat(30), "c.ts": "hit\n".repeat(4) }, (store) => {
    const seen: string[] = [];
    let after: string | undefined;
    let skip: number | undefined;
    let pages = 0;
    for (; pages < 50; pages++) {
      const r = searchRegexImpl(store, "r", { pattern: "hit", limit: 7, afterPath: after, skipMatches: skip });
      seen.push(...r.matches.map((m) => `${m.filePath}:${String(m.line)}`));
      if (r.truncationReason !== "limit_reached") break;
      after = r.nextAfterPath ?? undefined;
      skip = r.nextSkipMatches > 0 ? r.nextSkipMatches : undefined;
    }
    const full = searchRegexImpl(store, "r", { pattern: "hit", limit: 500 });
    assert.deepEqual(seen, full.matches.map((m) => `${m.filePath}:${String(m.line)}`));
    assert.equal(seen.length, 34);
    assert.ok(pages < 10, "no endless loop");
  });
});

test("a file with exactly the per-file cap of matches is not reported as capped; one more is", () => {
  withRepo({ "a.ts": "hit\n".repeat(200), "b.ts": "hit\n".repeat(201) }, (store) => {
    for (const outputMode of ["files", "matches"] as const) {
      const exact = searchRegexImpl(fakeStoreFor(store, ["a.ts"]), "r", { pattern: "hit", limit: 1000, outputMode });
      assert.equal(exact.truncated, false, outputMode);
      const over = searchRegexImpl(fakeStoreFor(store, ["b.ts"]), "r", { pattern: "hit", limit: 1000, outputMode });
      assert.equal(over.truncationReason, "per_file_cap", outputMode);
    }
  });
});

function fakeStoreFor(base: RegexSearchStore, files: string[]): RegexSearchStore {
  return { ...base, listIndexedFiles: () => files.map((p) => ({ path: p, language: "typescript" })) };
}

test("afterPath past every in-scope file reports it removed them all", () => {
  withRepo(ONE_HIT_PER_FILE, (store) => {
    const r = searchRegexImpl(store, "r", { pattern: "hit", limit: 5, afterPath: "zzz.ts" });
    assert.equal(r.afterPathRemovedAll, true);
    assert.equal(searchRegexImpl(store, "r", { pattern: "hit", limit: 5, afterPath: "a.ts" }).afterPathRemovedAll, false);
    assert.equal(searchRegexImpl(store, "r", { pattern: "hit", limit: 5 }).afterPathRemovedAll, false);
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

function runHandler(store: RegexSearchStore, args: { limit: number; profile: string; outputMode?: "matches" | "files"; afterPath?: string; skipMatches?: number }): Record<string, unknown> {
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

test("handler: afterPath past the end is echoed with a warning; a cut resume carries nextSkipMatches", () => {
  withRepo({ "a.ts": "hit\n".repeat(10) }, (store) => {
    const past = runHandler(store, { limit: 5, profile: "compact", afterPath: "zzz.ts" });
    assert.equal(past.afterPath, "zzz.ts");
    assert.match(String(past.warning), /sorts after every in-scope file/);
    const cut = runHandler(store, { limit: 4, profile: "nano" });
    assert.equal(cut.nextSkipMatches, 4);
    assert.match(String(cut.warning), /skipMatches:4/);
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
