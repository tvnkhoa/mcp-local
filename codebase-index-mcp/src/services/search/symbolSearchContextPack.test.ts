import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";

import { initGraphSchema } from "../../repositories/schema.js";
import { getContextByNameImpl } from "./symbolSearchContextPack.js";

/**
 * MCP-ISSUE-060(f) — `get_symbol_context_pack` pooled callers across every same-named symbol.
 *
 * Measured on `wec.be`: `name:"CreateMessageAsync"` returned **16** callers spanning BMW teleservice,
 * ZNS, lead creation and email reply. Ground truth is **one** call site — `grep -c` over four of the
 * reported caller files returned 0 for all four. `get_call_chain(symbolId)` on the same method
 * returned exactly 1, so the edges were right and only this pooling was wrong.
 *
 * Two things made it worse than a simple over-match. The FTS candidate query tokenises, so
 * `CreateMessageAsync` matched 12 candidates rather than the 3 an exact-name query finds; and the
 * non-FTS fallback selects `name = ? or name like '%name%'`, so a substring is enough to join the
 * pool. This is the tool the workspace rules tell an agent to reach for first.
 *
 * The fixture below deletes `symbols_fts` so the LIKE fallback runs — that branch is both the wider
 * of the two and the one a fresh index hits before its first FTS rebuild.
 */

const REPO = "r";

function fixture(): Database.Database {
  const db = new Database(":memory:");
  initGraphSchema(db);
  db.exec("drop table if exists symbols_fts");
  db.prepare("insert into repositories (repo_id, repo_path, updated_at) values (?, ?, ?)")
    .run(REPO, "/tmp/r", new Date().toISOString());

  const sym = db.prepare(
    `insert into symbols (repo_id, symbol_id, file_path, name, kind, line, parent_symbol_id)
     values (?, ?, ?, ?, ?, ?, ?)`
  );
  // Two unrelated classes, each with an identically named method.
  sym.run(REPO, "a", "svc/Alpha.cs", "Alpha", "class", 1, null);
  sym.run(REPO, "a.send", "svc/Alpha.cs", "SendAsync", "method", 5, "a");
  sym.run(REPO, "b", "svc/Beta.cs", "Beta", "class", 1, null);
  sym.run(REPO, "b.send", "svc/Beta.cs", "SendAsync", "method", 5, "b");
  // A third symbol that only CONTAINS the name — the LIKE branch used to admit it.
  sym.run(REPO, "c", "svc/Gamma.cs", "Gamma", "class", 1, null);
  sym.run(REPO, "c.send", "svc/Gamma.cs", "TrySendAsyncTwice", "method", 5, "c");

  sym.run(REPO, "callerA", "api/AlphaCaller.cs", "CallAlpha", "method", 9, null);
  sym.run(REPO, "callerB", "api/BetaCaller.cs", "CallBeta", "method", 9, null);
  sym.run(REPO, "callerC", "api/GammaCaller.cs", "CallGamma", "method", 9, null);

  const edge = db.prepare(
    `insert into edges (repo_id, from_id, to_id, type, confidence, reason) values (?, ?, ?, ?, ?, ?)`
  );
  edge.run(REPO, "callerA", "a.send", "CALLS", 0.9, "test");
  edge.run(REPO, "callerB", "b.send", "CALLS", 0.9, "test");
  edge.run(REPO, "callerC", "c.send", "CALLS", 0.9, "test");
  return db;
}

test("the filed case: callers belong to the selected symbol, not to every homonym", () => {
  const db = fixture();
  const ctx = getContextByNameImpl(db, REPO, "SendAsync", 50);

  assert.ok(ctx.symbol, "a symbol must be selected");
  const files = ctx.callers.map((c) => c.callerFile).sort();

  assert.equal(ctx.callers.length, 1, `expected 1 caller, got ${JSON.stringify(files)}`);
  // Whichever of Alpha/Beta ranked first, the caller must be ITS caller and no one else's.
  const expected = ctx.symbol.symbolId === "a.send" ? "api/AlphaCaller.cs" : "api/BetaCaller.cs";
  assert.deepEqual(files, [expected]);
  // The substring match is the clearest wrong answer: Gamma's method is not named SendAsync at all.
  assert.ok(!files.includes("api/GammaCaller.cs"), "a substring match must not contribute callers");

  db.close();
});

test("the other same-named symbols are still disclosed, so a wrong selection is visible", () => {
  const db = fixture();
  const ctx = getContextByNameImpl(db, REPO, "SendAsync", 50);

  // Narrowing the caller list must not narrow discoverability — an agent that got the wrong symbol
  // needs to see that alternatives exist. `allMatchedSymbols` is what the handler surfaces as
  // `candidates`, and it keeps the full match set.
  const names = ctx.allMatchedSymbols.map((s) => s.symbolId).sort();
  assert.ok(names.includes("a.send") && names.includes("b.send"), `got ${JSON.stringify(names)}`);
});

test("importedByFiles is scoped the same way callers are", () => {
  const db = fixture();
  db.prepare(
    `insert into edges (repo_id, from_id, to_id, type, confidence, reason) values (?, ?, ?, ?, ?, ?)`
  ).run(REPO, "callerB", "a.send", "IMPORTS", 0.9, "test");

  const ctx = getContextByNameImpl(db, REPO, "SendAsync", 50);
  assert.ok(ctx.symbol);
  const expectImporter = ctx.symbol.symbolId === "a.send";
  assert.equal(
    ctx.importedByFiles.length,
    expectImporter ? 1 : 0,
    "importers pooled across homonyms was the same defect in the same function"
  );

  db.close();
});

test("excludeTests reaches the candidate query, so the selected symbol cannot be a test double", () => {
  const db = new Database(":memory:");
  initGraphSchema(db);
  db.exec("drop table if exists symbols_fts");
  db.prepare("insert into repositories (repo_id, repo_path, updated_at) values (?, ?, ?)")
    .run(REPO, "/tmp/r", new Date().toISOString());
  const sym = db.prepare(
    `insert into symbols (repo_id, symbol_id, file_path, name, kind, line, parent_symbol_id)
     values (?, ?, ?, ?, ?, ?, ?)`
  );
  // The test double sorts first on an exact-name tie, so it used to win the selection while the
  // handler's own `candidates[]` — which does honour the flag — never listed it.
  sym.run(REPO, "fake", "src/test/FakeSender.cs", "Deliver", "method", 3, null);
  sym.run(REPO, "real", "svc/Sender.cs", "Deliver", "method", 3, null);

  const withTests = getContextByNameImpl(db, REPO, "Deliver", 50, false);
  const withoutTests = getContextByNameImpl(db, REPO, "Deliver", 50, true);

  assert.equal(withTests.allMatchedSymbols.length, 2);
  assert.equal(withoutTests.allMatchedSymbols.length, 1);
  assert.equal(withoutTests.symbol?.symbolId, "real");

  db.close();
});
