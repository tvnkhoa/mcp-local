import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import type Database from "better-sqlite3";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { McpError } from "@modelcontextprotocol/sdk/types.js";

import { GraphStore } from "../../repositories/graphStore.js";
import { buildLimitHint, handleSearchSymbols, resolveSymbolRepoId } from "./searchHandler.js";
import type { HandlerContext } from "./handlerContext.js";

/** IX-C: get_symbol_source resolves an omitted repoId from the symbolId; capped searches carry a limit hint. */

function withStore(fn: (store: GraphStore, db: Database.Database) => void): void {
  const dir = mkdtempSync(path.join(tmpdir(), "cim-ixc-"));
  const store = new GraphStore(path.join(dir, "x.db"));
  const db = (store as unknown as { db: Database.Database }).db;
  try {
    fn(store, db);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function addRepo(db: Database.Database, repoId: string): void {
  db.prepare("insert into repositories (repo_id, repo_path, updated_at) values (?, ?, ?)").run(repoId, `D:/x/${repoId}`, "2026-11-12T00:00:00Z");
}
function addSymbol(db: Database.Database, repoId: string, symbolId: string): void {
  db.prepare("insert into symbols (repo_id, symbol_id, file_path, name, kind, line) values (?, ?, ?, ?, ?, ?)").run(repoId, symbolId, "src/a.ts", "a", "function", 1);
}

test("findRepoIdsForSymbol: the repos holding the id, sorted; none for an unknown id", () => {
  withStore((store, db) => {
    addRepo(db, "zeta");
    addRepo(db, "alpha");
    addRepo(db, "other");
    addSymbol(db, "zeta", "sid1");
    addSymbol(db, "alpha", "sid1");
    addSymbol(db, "other", "sid2");
    assert.deepEqual(store.findRepoIdsForSymbol("sid1"), ["alpha", "zeta"]);
    assert.deepEqual(store.findRepoIdsForSymbol("sid2"), ["other"]);
    assert.deepEqual(store.findRepoIdsForSymbol("nope"), []);
  });
});

test("findRepoIdsForSymbol ignores a symbol row whose repo is not registered", () => {
  withStore((store, db) => {
    addSymbol(db, "ghost", "sid1");
    assert.deepEqual(store.findRepoIdsForSymbol("sid1"), []);
  });
});

test("resolveSymbolRepoId: one holder answers, none is not-found, several is a deterministic ambiguity error", () => {
  const stub = (ids: string[]) => ({ findRepoIdsForSymbol: () => ids });
  assert.equal(resolveSymbolRepoId(stub(["r1"]), "sid"), "r1");
  assert.throws(() => resolveSymbolRepoId(stub([]), "sid"), (e: unknown) => e instanceof McpError && /'sid' not found in any indexed repo/.test(e.message));
  assert.throws(
    () => resolveSymbolRepoId(stub(["a", "b"]), "sid"),
    (e: unknown) => e instanceof McpError && /in 2 indexed repos \(a, b\); pass repoId/.test(e.message)
  );
});

test("buildLimitHint names the max, and outputMode:files only where it applies", () => {
  assert.match(buildLimitHint(50, 500, false), /raise limit \(now 50, max 500\), or use outputMode:"files"/);
  assert.doesNotMatch(buildLimitHint(50, 500, true), /outputMode/);
  assert.doesNotMatch(buildLimitHint(50, 500, null), /outputMode/);
  assert.match(buildLimitHint(500, 500, false), /limit is at its max \(500\)/);
});

const sym = (name: string, matchType?: "fuzzy") => ({ symbolId: `id-${name}`, name, kind: "function", filePath: `src/${name}.ts`, line: 1, signature: null, repoId: "r", ...(matchType && { matchType }) });

function symbolsCall(rows: ReturnType<typeof sym>[], limit: number, profile = "compact"): Record<string, unknown> {
  const store = { searchSymbols: () => rows, getSearchSuggestions: () => [], getRepository: () => null, getLatestRun: () => null };
  const asText = (payload: unknown): CallToolResult => ({ content: [{ type: "text", text: JSON.stringify(payload) }] });
  const ctx = { store, asText, constants: { MAX_RESULT_LIMIT: 500 } } as unknown as HandlerContext;
  const out = handleSearchSymbols({ query: "a", strategy: "name", limit, compact: false, profile, ranked: false, excludeTests: false }, ctx);
  return JSON.parse((out.content[0] as { text: string }).text) as Record<string, unknown>;
}

test("search_symbols: name matches filling the limit carry complete:false + limitHint, at every profile", () => {
  for (const profile of ["nano", "compact", "standard", "verbose"]) {
    const out = symbolsCall([sym("a1"), sym("a2"), sym("a3")], 3, profile);
    assert.equal(out.complete, false, profile);
    assert.match(String(out.limitHint), /max 500/, profile);
  }
});

test("search_symbols: under the limit, or padded to it by near-neighbours, has no hint", () => {
  const under = symbolsCall([sym("a1"), sym("a2")], 3);
  assert.equal("limitHint" in under, false);
  assert.equal("complete" in under, false);
  const padded = symbolsCall([sym("a1"), sym("n1", "fuzzy"), sym("n2", "fuzzy")], 3);
  assert.equal("limitHint" in padded, false);
});
