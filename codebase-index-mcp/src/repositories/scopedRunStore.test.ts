import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import Database from "better-sqlite3";

import { GraphStore } from "./graphStore.js";
import {
  SYMBOL_ID_COLUMNS_EXEMPT,
  SYMBOL_ID_COLUMNS_REMAPPED,
  idsAtRiskFromIdOrder,
  pairShiftedSymbols,
  remapSymbolIds,
  symbolRowKey,
  type SymbolRowShape
} from "./scopedRunStore.js";

/** MCP-ISSUE-101 part 3: pairing a file's rows across a row shift, the two order guards, and the id re-point. */

const rowsOf = (rows: Array<Partial<SymbolRowShape> & { symbolId: string; name: string; line: number }>): Map<string, string> =>
  new Map(rows.map((r) => [symbolRowKey({ kind: "function", filePath: "a.ts", ...r }), r.name]));

/** A fresh index DB (every table and migration), opened a second time for raw rows. */
function withStore(fn: (store: GraphStore, db: Database.Database) => void): void {
  const dir = mkdtempSync(path.join(tmpdir(), "cim-shift-"));
  const store = new GraphStore(path.join(dir, "x.db"));
  const db = new Database(path.join(dir, "x.db"));
  try {
    fn(store, db);
  } finally {
    db.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test("every schema column that can hold a symbol id is either re-pointed on a shift or exempt with a reason", () => {
  withStore((store, db) => {
    const tables = db.prepare(`select name from sqlite_master where type = 'table'`).all() as { name: string }[];
    const idColumns: string[] = [];
    for (const { name } of tables) {
      let cols: { name: string }[] = [];
      try {
        cols = db.prepare(`select name from pragma_table_info(?)`).all(name) as { name: string }[];
      } catch {
        continue; // a virtual table whose module is not loaded here
      }
      for (const c of cols) if (/(^|_)symbol_id$|^from_id$|^to_id$|_ids$/.test(c.name)) idColumns.push(`${name}.${c.name}`);
    }
    assert.ok(idColumns.includes("edges.to_id") && idColumns.includes("routes.handler_symbol_id"), `found: ${idColumns.join(", ")}`);
    const remapped = new Set<string>(SYMBOL_ID_COLUMNS_REMAPPED);
    for (const col of idColumns) {
      assert.ok(remapped.has(col) || (SYMBOL_ID_COLUMNS_EXEMPT[col] ?? "").length > 0, `${col}: neither re-pointed by remapSymbolIds nor exempt with a reason`);
    }
    for (const col of [...remapped, ...Object.keys(SYMBOL_ID_COLUMNS_EXEMPT)]) assert.ok(idColumns.includes(col), `${col} is listed but not in the schema`);
  });
});

test("a pure row shift pairs every declaration, children through their parents, and keeps the order", () => {
  const before = rowsOf([
    { symbolId: "c1", name: "Box", kind: "class", line: 1 },
    { symbolId: "m1", name: "open", kind: "method", parentSymbolId: "c1", signature: "open()", line: 2 },
    { symbolId: "f1", name: "helper", line: 5 }
  ]);
  const after = rowsOf([
    { symbolId: "c2", name: "Box", kind: "class", line: 4 },
    { symbolId: "m2", name: "open", kind: "method", parentSymbolId: "c2", signature: "open()", line: 5 },
    { symbolId: "f2", name: "helper", line: 8 }
  ]);
  const shift = pairShiftedSymbols(before, after);
  assert.deepEqual(
    shift.pairs.map((p) => `${p.oldId}>${p.newId}`).sort(),
    ["c1>c2", "f1>f2", "m1>m2"]
  );
  assert.equal(shift.orderKept, true);
  assert.equal(shift.unpairedBefore.size + shift.unpairedAfter.size, 0);
});

test("a rename, a removal and a signature change stay unpaired, so their names go to K", () => {
  const before = rowsOf([
    { symbolId: "a1", name: "keep", line: 1 },
    { symbolId: "b1", name: "oldName", line: 3 },
    { symbolId: "c1", name: "gone", line: 5 },
    { symbolId: "d1", name: "sig", signature: "sig()", line: 7 }
  ]);
  const after = rowsOf([
    { symbolId: "a2", name: "keep", line: 2 },
    { symbolId: "b2", name: "newName", line: 4 },
    { symbolId: "d2", name: "sig", signature: "sig(x)", line: 8 }
  ]);
  const shift = pairShiftedSymbols(before, after);
  assert.deepEqual(shift.pairs.map((p) => p.name), ["keep"]);
  assert.deepEqual([...shift.unpairedBefore.values()].sort(), ["gone", "oldName", "sig"]);
  assert.deepEqual([...shift.unpairedAfter.values()].sort(), ["newName", "sig"]);
});

test("guard (b): two same-named overloads swapped in place pair by signature, but their order breaks", () => {
  // Foo(int) and Foo(string) trade rows, so each takes the other's id; the (line, id) order of the name flips.
  const before = rowsOf([
    { symbolId: "id-r3", name: "Foo", kind: "method", signature: "Foo(int x)", line: 3 },
    { symbolId: "id-r4", name: "Foo", kind: "method", signature: "Foo(string s)", line: 4 }
  ]);
  const after = rowsOf([
    { symbolId: "id-r3", name: "Foo", kind: "method", signature: "Foo(string s)", line: 3 },
    { symbolId: "id-r4", name: "Foo", kind: "method", signature: "Foo(int x)", line: 4 }
  ]);
  const shift = pairShiftedSymbols(before, after);
  assert.equal(shift.pairs.length, 2);
  assert.equal(shift.orderKept, false);
});

test("guard (b) ignores different names that share a line; two equal logical keys on one line do not pair", () => {
  const sameLineNames = pairShiftedSymbols(
    rowsOf([
      { symbolId: "b", name: "start", kind: "property", line: 1 },
      { symbolId: "a", name: "end", kind: "property", line: 1 }
    ]),
    rowsOf([
      { symbolId: "y", name: "start", kind: "property", line: 4 },
      { symbolId: "z", name: "end", kind: "property", line: 4 }
    ])
  );
  assert.equal(sameLineNames.pairs.length, 2);
  assert.equal(sameLineNames.orderKept, true);

  const duplicateKey = pairShiftedSymbols(
    rowsOf([
      { symbolId: "p", name: "x", kind: "variable", line: 1 },
      { symbolId: "q", name: "x", kind: "variable", line: 1 }
    ]),
    rowsOf([
      { symbolId: "r", name: "x", kind: "variable", line: 2 },
      { symbolId: "s", name: "x", kind: "variable", line: 2 }
    ])
  );
  assert.equal(duplicateKey.pairs.length, 0);
  assert.equal(duplicateKey.unpairedBefore.size, 2);
});

test("guard (a): only a shift that moves an id past a same-file, same-family namesake puts ids at risk", () => {
  withStore((store, db) => {
    store.ensureRepository("r", "/r");
    const insert = db.prepare(`insert into symbols (repo_id, symbol_id, file_path, name, kind, line) values ('r', ?, ?, ?, ?, 1)`);
    insert.run("m", "a.ts", "helper", "function"); // the same-file namesake (an overload, a redeclared name)
    insert.run("p", "b.ts", "helper", "function"); // another file: the tie breaks on the path, which did not move
    insert.run("z", "a.ts", "helper", "class"); // another family: never tied with a function
    insert.run("n", "a.ts", "helper", "function"); // the shifted symbol, now
    // old "k" < "m" < new "n": flipped against a.ts's other helper (b.ts's "p" is above both; the class does not count).
    assert.deepEqual([...idsAtRiskFromIdOrder(db, "r", [{ oldId: "k", newId: "n", name: "helper" }], new Set(["n"]))].sort(), ["m", "n"]);
    // old "q" > "p", new "n" < "p": flipped against b.ts's helper only (a.ts's "x" is above both) — another file, nothing at risk.
    db.prepare(`update symbols set symbol_id = 'x' where symbol_id = 'm'`).run();
    assert.deepEqual([...idsAtRiskFromIdOrder(db, "r", [{ oldId: "q", newId: "n", name: "helper" }], new Set(["n"]))], []);
  });
});

test("remapSymbolIds re-points other files' rows, applies a swap once, and leaves the written file alone", () => {
  withStore((store, db) => {
    store.ensureRepository("r", "/r");
    // a.ts was written: Foo(int) and Foo(string) swapped ids (o1 <-> o2). b.ts still points at the old ones.
    db.prepare(`insert into symbols (repo_id, symbol_id, file_path, name, kind, line) values ('r', 'o2', 'a.ts', 'Foo', 'method', 1), ('r', 'o1', 'a.ts', 'Foo', 'method', 2), ('r', 'b1', 'b.ts', 'main', 'function', 1)`).run();
    db.prepare(`insert into edges (repo_id, from_id, to_id, type, confidence) values ('r', 'b1', 'o1', 'CALLS', 0.9), ('r', 'b1', 'o2', 'TYPE_REF', 0.9), ('r', 'o1', 'o2', 'CALLS', 0.9)`).run();
    db.prepare(`insert into routes (repo_id, file_path, controller_symbol_id, handler_symbol_id, handler_name, http_method, route_template, line) values ('r', 'b.ts', 'o1', 'o2', 'Foo', 'GET', '/', 1)`).run();
    db.prepare(`insert into doc_mentions (repo_id, doc_id, symbol_id, mention_type, confidence, mention_text, candidate_count, candidate_ids) values ('r', 'd', null, 'backtick', 1, 'Foo', 2, '["o1","o2"]')`).run();
    db.prepare(`insert into cross_repo_deps (from_repo_id, from_symbol_id, to_repo_id, to_symbol_id, type) values ('other', 'x', 'r', 'o1', 'CALLS'), ('other', 'x', 'r', 'o2', 'CALLS')`).run();

    remapSymbolIds(db, "r", [{ oldId: "o1", newId: "o2", name: "Foo" }, { oldId: "o2", newId: "o1", name: "Foo" }], ["a.ts"]);

    const edges = db.prepare(`select from_id || '>' || to_id || ':' || type as e from edges order by e`).all().map((r) => (r as { e: string }).e);
    assert.deepEqual(edges, ["b1>o1:TYPE_REF", "b1>o2:CALLS", "o1>o2:CALLS"], "b.ts re-pointed once each; a.ts's fresh edge untouched");
    assert.deepEqual(db.prepare(`select controller_symbol_id c, handler_symbol_id h from routes`).get(), { c: "o2", h: "o1" });
    assert.equal((db.prepare(`select candidate_ids c from doc_mentions`).get() as { c: string }).c, '["o2","o1"]');
    assert.deepEqual(db.prepare(`select to_symbol_id t from cross_repo_deps order by t`).all(), [{ t: "o1" }, { t: "o2" }]);
  });
});
