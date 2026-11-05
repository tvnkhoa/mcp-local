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

async function withRepo(files: Record<string, string>, run: (store: RegexSearchStore) => Promise<void>): Promise<void> {
  const repo = mkdtempSync(path.join(tmpdir(), "cim-regex-trunc-"));
  try {
    for (const [name, body] of Object.entries(files)) writeFileSync(path.join(repo, name), body);
    await run(fakeStore(repo, Object.keys(files)));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

const ONE_HIT_PER_FILE = { "a.ts": "hit\n", "b.ts": "hit\n", "c.ts": "hit\n", "d.ts": "hit\n", "e.ts": "hit\n" };

test("match limit hit: nextAfterPath is the last finished file, filesUnscanned counts the rest", async () => {
  await withRepo(ONE_HIT_PER_FILE, async (store) => {
    const r = await searchRegexImpl(store, "r", { pattern: "hit", limit: 2 });
    assert.equal(r.truncationReason, "limit_reached");
    assert.deepEqual(r.matches.map((m) => m.filePath), ["a.ts", "b.ts"]);
    assert.equal(r.nextAfterPath, "b.ts");
    assert.equal(r.filesUnscanned, 3);
  });
});

test("afterPath resumes: pages together equal the full scan, no file repeated or skipped", async () => {
  await withRepo(ONE_HIT_PER_FILE, async (store) => {
    const seen: string[] = [];
    let after: string | undefined;
    for (let page = 0; page < 10; page++) {
      const r = await searchRegexImpl(store, "r", { pattern: "hit", limit: 2, afterPath: after });
      seen.push(...r.matches.map((m) => m.filePath));
      if (r.nextAfterPath === null) break;
      after = r.nextAfterPath;
    }
    assert.deepEqual(seen, ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"]);
    const full = await searchRegexImpl(store, "r", { pattern: "hit", limit: 50 });
    assert.equal(full.truncated, false);
    assert.equal(full.nextAfterPath, null);
  });
});

test("files mode: limit hit resumes the same way, and an unread file is not counted as scanned", async () => {
  await withRepo(ONE_HIT_PER_FILE, async (store) => {
    const r = await searchRegexImpl(store, "r", { pattern: "hit", limit: 3, outputMode: "files" });
    assert.equal(r.truncationReason, "limit_reached");
    assert.equal(r.filesScanned, 3);
    assert.equal(r.nextAfterPath, "c.ts");
    const rest = await searchRegexImpl(store, "r", { pattern: "hit", limit: 3, outputMode: "files", afterPath: r.nextAfterPath ?? undefined });
    assert.deepEqual(rest.files?.map((f) => f.filePath), ["d.ts", "e.ts"]);
    assert.equal(rest.truncated, false);
  });
});

test("limit reached inside one file: the cursor is the previous path plus the matches already returned", async () => {
  await withRepo({ "a.ts": "hit\n".repeat(10), "b.ts": "hit\n" }, async (store) => {
    const r = await searchRegexImpl(store, "r", { pattern: "hit", limit: 3 });
    assert.equal(r.truncationReason, "limit_reached");
    assert.equal(r.nextAfterPath, null, "a.ts is the first file: nothing precedes it");
    assert.equal(r.nextSkipMatches, 3);
    assert.equal(r.filesUnscanned, 1);
  });
});

test("a cursor loop over a file with more matches than the limit collects every match once, and terminates", async () => {
  await withRepo({ "a.ts": "x\n", "b.ts": "hit\n".repeat(30), "c.ts": "hit\n".repeat(4) }, async (store) => {
    const seen: string[] = [];
    let after: string | undefined;
    let skip: number | undefined;
    let pages = 0;
    for (; pages < 50; pages++) {
      const r = await searchRegexImpl(store, "r", { pattern: "hit", limit: 7, afterPath: after, skipMatches: skip });
      seen.push(...r.matches.map((m) => `${m.filePath}:${String(m.line)}`));
      if (r.truncationReason !== "limit_reached") break;
      after = r.nextAfterPath ?? undefined;
      skip = r.nextSkipMatches > 0 ? r.nextSkipMatches : undefined;
    }
    const full = await searchRegexImpl(store, "r", { pattern: "hit", limit: 500 });
    assert.deepEqual(seen, full.matches.map((m) => `${m.filePath}:${String(m.line)}`));
    assert.equal(seen.length, 34);
    assert.ok(pages < 10, "no endless loop");
  });
});

test("a cursor loop whose cut lands in the FIRST file (no path before it) collects every match once, and terminates", async () => {
  await withRepo({ "a.ts": "hit\n".repeat(30), "b.ts": "hit\n".repeat(4) }, async (store) => {
    const seen: string[] = [];
    let after: string | undefined;
    let skip: number | undefined;
    let pages = 0;
    for (; pages < 50; pages++) {
      const r = await searchRegexImpl(store, "r", { pattern: "hit", limit: 7, afterPath: after, skipMatches: skip });
      seen.push(...r.matches.map((m) => `${m.filePath}:${String(m.line)}`));
      if (r.truncationReason !== "limit_reached") break;
      after = r.nextAfterPath ?? undefined;
      skip = r.nextSkipMatches > 0 ? r.nextSkipMatches : undefined;
    }
    const full = await searchRegexImpl(store, "r", { pattern: "hit", limit: 500 });
    assert.deepEqual(seen, full.matches.map((m) => `${m.filePath}:${String(m.line)}`));
    assert.equal(seen.length, 34);
    assert.ok(pages < 10, "no endless loop");
  });
});

test("handler echoes skipMatches without afterPath", async () => {
  await withRepo({ "a.ts": "hit\n".repeat(10) }, async (store) => {
    const r = await runHandler(store, { limit: 50, profile: "compact", skipMatches: 4 });
    assert.equal(r.skipMatches, 4);
    assert.equal(r.afterPath, undefined);
    assert.equal(r.count, 6);
  });
});

test("a file with exactly the per-file cap of matches is not reported as capped; one more is", async () => {
  await withRepo({ "a.ts": "hit\n".repeat(200), "b.ts": "hit\n".repeat(201) }, async (store) => {
    for (const outputMode of ["files", "matches"] as const) {
      const exact = await searchRegexImpl(fakeStoreFor(store, ["a.ts"]), "r", { pattern: "hit", limit: 1000, outputMode });
      assert.equal(exact.truncated, false, outputMode);
      const over = await searchRegexImpl(fakeStoreFor(store, ["b.ts"]), "r", { pattern: "hit", limit: 1000, outputMode });
      assert.equal(over.truncationReason, "per_file_cap", outputMode);
    }
  });
});

function fakeStoreFor(base: RegexSearchStore, files: string[]): RegexSearchStore {
  return { ...base, listIndexedFiles: () => files.map((p) => ({ path: p, language: "typescript" })) };
}

test("afterPath past every in-scope file reports it removed them all", async () => {
  await withRepo(ONE_HIT_PER_FILE, async (store) => {
    const r = await searchRegexImpl(store, "r", { pattern: "hit", limit: 5, afterPath: "zzz.ts" });
    assert.equal(r.afterPathRemovedAll, true);
    assert.equal((await searchRegexImpl(store, "r", { pattern: "hit", limit: 5, afterPath: "a.ts" })).afterPathRemovedAll, false);
    assert.equal((await searchRegexImpl(store, "r", { pattern: "hit", limit: 5 })).afterPathRemovedAll, false);
  });
});

test("per-file cap alone is a truncation, with no resume point", async () => {
  await withRepo({ "a.ts": "hit\n".repeat(300), "b.ts": "hit\n" }, async (store) => {
    const r = await searchRegexImpl(store, "r", { pattern: "hit", limit: 1000 });
    assert.equal(r.truncated, true);
    assert.equal(r.truncationReason, "per_file_cap");
    assert.deepEqual(r.perFileCapFiles, ["a.ts"]);
    assert.equal(r.nextAfterPath, null);
    assert.equal(r.filesUnscanned, 0);
    const byFile = await searchRegexImpl(store, "r", { pattern: "hit", limit: 1000, outputMode: "files" });
    assert.equal(byFile.truncationReason, "per_file_cap");
  });
});

test("untruncated search has no truncation fields set", async () => {
  await withRepo(ONE_HIT_PER_FILE, async (store) => {
    const r = await searchRegexImpl(store, "r", { pattern: "hit", limit: 50 });
    assert.equal(r.truncated, false);
    assert.equal(r.truncationReason, null);
    assert.equal(r.nextAfterPath, null);
    assert.deepEqual(r.perFileCapFiles, []);
  });
});

async function runHandler(store: RegexSearchStore, args: { limit: number; profile: string; outputMode?: "matches" | "files"; afterPath?: string; skipMatches?: number }): Promise<Record<string, unknown>> {
  const ctx = {
    store: { searchRegex: (id: string, o: Parameters<typeof searchRegexImpl>[2]) => searchRegexImpl(store, id, o), getRepository: store.getRepository },
    asText: (payload: unknown) => ({ content: [{ type: "text", text: JSON.stringify(payload) }] })
  };
  const res = await handleSearchRegex(
    { repoId: "r", pattern: "hit", excludeTests: false, scanAll: false, contextLines: 0, ...args },
    ctx as unknown as Parameters<typeof handleSearchRegex>[1]
  );
  return JSON.parse((res.content[0] as { text: string }).text) as Record<string, unknown>;
}

test("handler: every profile carries complete/warning/nextAfterPath on truncation, complete:true otherwise", async () => {
  await withRepo(ONE_HIT_PER_FILE, async (store) => {
    for (const profile of ["nano", "compact", "standard", "verbose"]) {
      const cut = await runHandler(store, { limit: 2, profile });
      assert.equal(cut.complete, false, profile);
      assert.match(String(cut.warning), /PARTIAL.*3 NOT searched.*raise limit.*afterPath:"b\.ts"/s, profile);
      assert.equal(cut.nextAfterPath, "b.ts", profile);
      const whole = await runHandler(store, { limit: 50, profile });
      assert.equal(whole.complete, true, profile);
      assert.equal(whole.warning, undefined, profile);
      assert.equal(whole.nextAfterPath, undefined, profile);
    }
    const files = await runHandler(store, { limit: 2, profile: "nano", outputMode: "files" });
    assert.equal(files.complete, false);
    assert.equal(files.nextAfterPath, "b.ts");
  });
});

test("handler: afterPath past the end is echoed with a warning; a cut resume carries nextSkipMatches", async () => {
  await withRepo({ "a.ts": "hit\n".repeat(10) }, async (store) => {
    const past = await runHandler(store, { limit: 5, profile: "compact", afterPath: "zzz.ts" });
    assert.equal(past.afterPath, "zzz.ts");
    assert.match(String(past.warning), /sorts after every in-scope file/);
    const cut = await runHandler(store, { limit: 4, profile: "nano" });
    assert.equal(cut.nextSkipMatches, 4);
    assert.match(String(cut.warning), /skipMatches:4/);
  });
});

test("handler: per-file cap makes the answer incomplete and names the file", async () => {
  await withRepo({ "a.ts": "hit\n".repeat(300) }, async (store) => {
    const r = await runHandler(store, { limit: 1000, profile: "compact" });
    assert.equal(r.complete, false);
    assert.match(String(r.warning), /per-file match cap.*a\.ts/s);
    assert.equal(r.nextAfterPath, undefined);
  });
});

// MCP-ISSUE-117 (IX-7): `total` when complete, `totalLowerBound` when capped, `truncated` on every response.

type Page = { total?: number; totalLowerBound?: number; truncated: boolean; keys: string[] };

/** Page a scan to completion via nextAfterPath + skipMatches; returns every match key and every page's count fields. */
async function pageAll(store: RegexSearchStore, limit: number, outputMode: "matches" | "files" = "matches"): Promise<{ seen: string[]; pages: Page[] }> {
  const seen: string[] = [];
  const pages: Page[] = [];
  let after: string | undefined;
  let skip: number | undefined;
  for (let n = 0; n < 100; n++) {
    const r = await searchRegexImpl(store, "r", { pattern: "hit", limit, outputMode, afterPath: after, skipMatches: skip });
    const keys = outputMode === "files" ? (r.files ?? []).map((f) => f.filePath) : r.matches.map((m) => `${m.filePath}:${String(m.line)}`);
    seen.push(...keys);
    pages.push({ total: r.total, totalLowerBound: r.totalLowerBound, truncated: r.truncated, keys });
    if (!r.truncated) break;
    after = r.nextAfterPath ?? undefined;
    skip = r.nextSkipMatches > 0 ? r.nextSkipMatches : undefined;
  }
  return { seen, pages };
}

test("an uncapped scan carries total === the match count and no lower bound", async () => {
  await withRepo({ "a.ts": "hit\nhit\n", "b.ts": "x\n", "c.ts": "hit\n" }, async (store) => {
    const r = await searchRegexImpl(store, "r", { pattern: "hit", limit: 50 });
    assert.equal(r.truncated, false);
    assert.equal(r.total, 3);
    assert.equal(r.totalLowerBound, undefined);
    const files = await searchRegexImpl(store, "r", { pattern: "hit", limit: 50, outputMode: "files" });
    assert.equal(files.total, 2, "files mode counts files");
  });
});

test("a capped scan has totalLowerBound and NO total", async () => {
  await withRepo(ONE_HIT_PER_FILE, async (store) => {
    const r = await searchRegexImpl(store, "r", { pattern: "hit", limit: 2 });
    assert.equal(r.truncated, true);
    assert.equal(r.total, undefined);
    assert.equal(r.totalLowerBound, 2);
    const cut = await searchRegexImpl(store, "r", { pattern: "hit", limit: 500 });
    assert.equal(cut.total, 5);
  });
  await withRepo({ "a.ts": "hit\n".repeat(300), "b.ts": "hit\n" }, async (store) => {
    const r = await searchRegexImpl(store, "r", { pattern: "hit", limit: 1000 });
    assert.equal(r.truncationReason, "per_file_cap");
    assert.equal(r.total, undefined, "a per-file cap hides matches: no exact total");
    assert.ok((r.totalLowerBound ?? 0) >= 201);
  });
});

test("paging to completion: every match once, and the FINAL page's total is the uncapped count", async () => {
  // The edges: the very first match is the cut point (limit 1) and the very last match ends the scan.
  const files = { "a.ts": "hit\n".repeat(5), "b.ts": "x\n", "c.ts": "hit\n".repeat(3), "d.ts": "hit\n" };
  await withRepo(files, async (store) => {
    const full = await searchRegexImpl(store, "r", { pattern: "hit", limit: 500 });
    assert.equal(full.total, 9);
    for (const limit of [1, 2, 4, 5, 9, 10]) {
      const { seen, pages } = await pageAll(store, limit);
      assert.deepEqual(seen, full.matches.map((m) => `${m.filePath}:${String(m.line)}`), `limit ${String(limit)}: every match once, in order`);
      const last = pages[pages.length - 1]!;
      assert.equal(last.truncated, false, `limit ${String(limit)}: ends complete`);
      assert.equal(last.total, 9, `limit ${String(limit)}: the final page reports the whole-scope total`);
      for (const page of pages.slice(0, -1)) {
        assert.equal(page.total, undefined, "a capped page has no total");
        assert.ok(page.totalLowerBound !== undefined && page.totalLowerBound <= 9);
      }
    }
  });
});

test("files mode pages to completion with the same total on the last page", async () => {
  await withRepo({ "a.ts": "hit\n", "b.ts": "x\n", "c.ts": "hit\n", "d.ts": "hit\n", "e.ts": "hit\n" }, async (store) => {
    const { seen, pages } = await pageAll(store, 2, "files");
    assert.deepEqual(seen, ["a.ts", "c.ts", "d.ts", "e.ts"]);
    assert.equal(pages[pages.length - 1]!.total, 4);
  });
});

test("a resume past the last file is complete and still reports the whole total", async () => {
  await withRepo(ONE_HIT_PER_FILE, async (store) => {
    const r = await searchRegexImpl(store, "r", { pattern: "hit", limit: 5, afterPath: "e.ts" });
    assert.equal(r.matches.length, 0);
    assert.equal(r.truncated, false);
    assert.equal(r.total, 5);
  });
});

test("a cut inside the first file, resumed, still totals the whole scope", async () => {
  await withRepo({ "a.ts": "hit\n".repeat(30), "b.ts": "hit\n".repeat(4) }, async (store) => {
    const { pages } = await pageAll(store, 7);
    assert.equal(pages[pages.length - 1]!.total, 34);
  });
});

test("handler: truncated is a boolean on EVERY profile and mode; total/totalLowerBound follow it", async () => {
  await withRepo(ONE_HIT_PER_FILE, async (store) => {
    for (const profile of ["nano", "compact", "standard", "verbose"]) {
      const whole = await runHandler(store, { limit: 50, profile });
      assert.equal(whole.truncated, false, profile);
      assert.equal(whole.total, 5, profile);
      assert.equal(whole.totalLowerBound, undefined, profile);
      const cut = await runHandler(store, { limit: 2, profile });
      assert.equal(cut.truncated, true, profile);
      assert.equal(cut.total, undefined, profile);
      assert.equal(cut.totalLowerBound, 2, profile);
    }
    const files = await runHandler(store, { limit: 50, profile: "compact", outputMode: "files" });
    assert.equal(files.truncated, false);
    assert.equal(files.total, 5);
  });
});
