import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";

import { initGraphSchema } from "../../repositories/schema.js";
import { getSymbolCandidatesImpl } from "./symbolSearchCandidates.js";

/**
 * MCP-ISSUE-060 — `search_symbols({ranked:true})` with no `repoId` returned 0 for every query.
 *
 * Isolated by toggling one variable at a time: dropping `ranked` made cross-repo search work, and
 * adding `repoId` made `ranked` work. Only the combination failed. The cause was the handler
 * coercing an absent repoId with `args.repoId ?? ""` into a `where s.repo_id = ?`, which matches no
 * row in any repo — so the response was a well-formed empty result, indistinguishable from "this
 * symbol exists nowhere". That is precisely the shape an agent cannot detect.
 *
 * Cross-repo lookup is the whole point of a shared index: nine repos live in one database here.
 */

function fixture(): Database.Database {
  const db = new Database(":memory:");
  initGraphSchema(db);
  db.exec("drop table if exists symbols_fts");
  const repo = db.prepare("insert into repositories (repo_id, repo_path, updated_at) values (?, ?, ?)");
  repo.run("alpha", "/tmp/alpha", new Date().toISOString());
  repo.run("beta", "/tmp/beta", new Date().toISOString());

  const sym = db.prepare(
    `insert into symbols (repo_id, symbol_id, file_path, name, kind, line, parent_symbol_id)
     values (?, ?, ?, ?, ?, ?, ?)`
  );
  sym.run("alpha", "a1", "src/Startup.cs", "Startup", "class", 1, null);
  sym.run("beta", "b1", "src/Startup.cs", "Startup", "class", 1, null);
  sym.run("beta", "b2", "src/Other.cs", "OtherThing", "class", 1, null);
  return db;
}

test("the filed case: no repoId means every repo, not a repo literally named empty string", () => {
  const db = fixture();

  const crossRepo = getSymbolCandidatesImpl(db, null, "Startup", 10, "name", {});
  assert.equal(crossRepo.length, 2, "a symbol present in two repos must be found in both");
  assert.deepEqual([...new Set(crossRepo.map((c) => c.symbolId))].sort(), ["a1", "b1"]);

  // The empty string reached the query the same way and must behave the same, since that is the
  // exact value the handler used to pass.
  assert.equal(getSymbolCandidatesImpl(db, "", "Startup", 10, "name", {}).length, 2);

  db.close();
});

test("an explicit repoId still scopes — the fix must not widen a deliberate narrow search", () => {
  const db = fixture();
  const scoped = getSymbolCandidatesImpl(db, "alpha", "Startup", 10, "name", {});
  assert.equal(scoped.length, 1);
  assert.equal(scoped[0].symbolId, "a1");

  assert.equal(getSymbolCandidatesImpl(db, "alpha", "OtherThing", 10, "name", {}).length, 0,
    "a symbol that exists only in another repo must not leak into a scoped search");

  db.close();
});

test("an unknown repoId still returns nothing, and is not silently widened to the whole index", () => {
  const db = fixture();
  // This one is important in the other direction: making repoId optional must not turn a typo into
  // a repo-wide search that looks authoritative.
  assert.equal(getSymbolCandidatesImpl(db, "no-such-repo", "Startup", 10, "name", {}).length, 0);
  db.close();
});
