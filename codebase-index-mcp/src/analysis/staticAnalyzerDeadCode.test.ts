import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

import { getDeadCodeCandidates } from "./staticAnalyzerDeadCode.js";

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Database = require("better-sqlite3") as any;

/**
 * `dead_code_scan` returned an empty result for every repo, always.
 *
 * The cause was one character. `includePrivate: false` (the default) added
 * `s.name not like '_%'`, intending "skip names starting with an underscore" — but in SQL LIKE, `_`
 * is a single-character wildcard, so `'_%'` matches every name of length >= 1 and `NOT LIKE`
 * excluded everything. Measured on the real `wec.communication-hub` graph: 2760 symbols survive the
 * kind filter, and that one condition took it to 0.
 *
 * The failure mode is what makes it worth a test: an empty candidate list AND an empty suppressed
 * list reads as "nothing dead here", which is a plausible answer. The tool reported success while
 * being completely inert, and the response even offered an explanation ("this can also mean
 * call/import edges are unresolved") that sent a reader looking in the wrong place.
 *
 * An in-memory DB rather than a fixture repo: the query touches only `symbols`, `files` and `edges`,
 * and the bug is in the WHERE clause, so the smallest thing that can catch it is three tables.
 */

function makeDb() {
  const db = new Database(":memory:");
  db.exec(`
    create table symbols (
      repo_id text, symbol_id text, file_path text, name text, kind text,
      line integer, signature text, parent_symbol_id text, end_line integer
    );
    -- The primary key mirrors the real schema and is load-bearing for this test: without it the
    -- "insert or ignore" below has nothing to conflict on, several rows accumulate per path, and the
    -- LEFT JOIN multiplies every symbol. A test schema that drifts from the real one invents its own
    -- failures. (No backticks in here — this is a template literal.)
    create table files (
      repo_id text not null, path text not null, content_hash text,
      language text, updated_at text, primary key (repo_id, path)
    );
    create table edges (repo_id text, from_id text, to_id text, type text, reason text);
  `);
  return db;
}

function addSymbol(
  db: ReturnType<typeof makeDb>,
  { name, kind = "method", signature = "public void X()", file = "src/App/Service.cs" }: {
    name: string; kind?: string; signature?: string; file?: string;
  }
) {
  db.prepare(
    "insert into symbols (repo_id, symbol_id, file_path, name, kind, line, signature) values (?,?,?,?,?,?,?)"
  ).run("r", `id-${name}`, file, name, kind, 1, signature);
  db.prepare(
    "insert or ignore into files (repo_id, path, language) values (?,?,?)"
  ).run("r", file, "csharp");
}

test("the underscore filter no longer excludes every symbol", () => {
  // The regression, stated as the numbers that exposed it: ordinary names must survive.
  const db = makeDb();
  for (const name of ["DoWork", "Handle", "Process", "Foo"]) addSymbol(db, { name });

  const { candidates } = getDeadCodeCandidates(db, "r", null, null, null, false, 100);
  assert.equal(candidates.length, 4, "an unescaped '_%' would make this 0 — the whole bug");
  assert.deepEqual(candidates.map((c) => c.name).sort(), ["DoWork", "Foo", "Handle", "Process"]);
});

test("a name starting with a literal underscore is still excluded", () => {
  // The condition's actual intent — it must keep working, or the fix has simply removed the check.
  const db = makeDb();
  addSymbol(db, { name: "DoWork" });
  addSymbol(db, { name: "_backingField", kind: "variable", signature: "private int _backingField" });
  addSymbol(db, { name: "_helper" });

  const { candidates } = getDeadCodeCandidates(db, "r", null, null, null, false, 100);
  assert.deepEqual(candidates.map((c) => c.name), ["DoWork"]);
});

test("includePrivate:true lifts both conditions", () => {
  const db = makeDb();
  addSymbol(db, { name: "DoWork" });
  addSymbol(db, { name: "_helper" });
  addSymbol(db, { name: "Secret", signature: "private void Secret()" });

  const { candidates } = getDeadCodeCandidates(db, "r", null, null, null, true, 100);
  assert.deepEqual(candidates.map((c) => c.name).sort(), ["DoWork", "Secret", "_helper"]);
});

test("a symbol with an incoming edge is not a candidate", () => {
  // Guards the other half: the filter fix must not turn every symbol into a candidate.
  const db = makeDb();
  addSymbol(db, { name: "Called" });
  addSymbol(db, { name: "Uncalled" });
  db.prepare("insert into edges (repo_id, from_id, to_id, type) values (?,?,?,?)")
    .run("r", "id-Uncalled", "id-Called", "CALLS");

  const { candidates } = getDeadCodeCandidates(db, "r", null, null, null, false, 100);
  // Guards the other half: the fix must not turn every symbol into a candidate.
  assert.deepEqual(candidates.map((c) => c.name), ["Uncalled"]);
});

test("the language filter matches via the files join", () => {
  const db = makeDb();
  addSymbol(db, { name: "CsharpThing", file: "src/A.cs" });
  db.prepare("insert into symbols (repo_id, symbol_id, file_path, name, kind, line, signature) values (?,?,?,?,?,?,?)")
    .run("r", "id-TsThing", "src/b.ts", "TsThing", "function", 1, "export function TsThing()");
  db.prepare("insert into files (repo_id, path, language) values (?,?,?)").run("r", "src/b.ts", "typescript");

  assert.deepEqual(
    getDeadCodeCandidates(db, "r", null, "csharp", null, false, 100).candidates.map((c) => c.name),
    ["CsharpThing"]
  );
  assert.deepEqual(
    getDeadCodeCandidates(db, "r", null, "typescript", null, false, 100).candidates.map((c) => c.name),
    ["TsThing"]
  );
});
