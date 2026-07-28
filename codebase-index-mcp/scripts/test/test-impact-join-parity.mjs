/**
 * Parity + query-plan guard for buildEdgeToSymbolPairsCte (S-30).
 *
 * The edge→symbol token grammar used to be one `(a or b or c …)` join predicate. A disjunction
 * over concatenated expressions is not indexable, so SQLite constrained only `e.repo_id` and
 * then tested every edge in the repo against every candidate symbol — with the *caller* symbol
 * as the outermost loop. `find_impact_files` on a 107-symbol file took 14.9 s.
 *
 * The rewrite splits it into a `union` of one indexable branch per alternative. This test pins
 * the two things that rewrite must not lose:
 *
 *   1. RESULTS — the new CTE selects exactly the (symbol, edge) pairs the old predicate did,
 *      over a fixture that exercises all six alternatives plus the decoys that must NOT match.
 *   2. PLAN SHAPE — no branch may fall back to a full scan of `edges`. This is the part a
 *      results-only test cannot see, and it is what actually regressed.
 *
 * The old predicate is frozen inline as the reference. Do not "keep it in sync" with the
 * production code — if a grammar change makes this test fail, that is the test working: update
 * the reference deliberately, in the same commit, and say why.
 *
 * One-time evidence beyond this fixture: the rewrite was diffed against the old predicate over
 * all 229 files of a workspace index (via getImpactFilesImpl's full two-query + aggregation
 * path) with 0 mismatches and a 448x speedup. See docs/migration/status.md, S-30.
 *
 * Usage: node scripts/test/test-impact-join-parity.mjs   (requires: npm run build)
 */
import Database from "better-sqlite3";
import process from "node:process";

import { buildEdgeToSymbolPairsCte } from "../../dist/impactAnalyzer.js";

/** The pre-S-30 predicate, frozen. Referenced `st` from an outer LEFT JOIN. */
const OLD_JOIN = `(
    e.to_id = s.symbol_id
    or (e.type = 'CALLS' and e.to_id = ('callee:' || s.name))
    or (e.type = 'TYPE_REF' and e.to_id = ('type:' || s.name))
    or (e.type in ('PROPERTY_REF', 'PROPERTY_WRITE') and e.to_id = ('property:' || s.name))
    or (e.type in ('PROPERTY_REF', 'PROPERTY_WRITE') and e.to_id = ('property:' || coalesce(st.name || '.', '') || s.name))
    or (e.type in ('PROPERTY_REF', 'PROPERTY_WRITE') and s.kind = 'property' and e.to_id like ('property:%.' || s.name))
  )`;

let passed = 0;
let failed = 0;

function assert(condition, label, details = "") {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ FAIL: ${label}${details ? ` — ${details}` : ""}`);
    failed++;
  }
}

function makeDb() {
  const db = new Database(":memory:");
  db.exec(`
    create table symbols (
      repo_id text not null, symbol_id text not null, file_path text not null,
      name text not null, kind text not null, line integer not null, end_line integer,
      signature text, parent_symbol_id text,
      primary key (repo_id, symbol_id)
    );
    create table edges (
      repo_id text not null, from_id text not null, to_id text not null, type text not null,
      confidence real not null default 1.0, reason text, assigned_expression text
    );
    create index idx_symbols_repo_file on symbols(repo_id, file_path);
    create index idx_symbols_repo_kind on symbols(repo_id, kind);
    create index idx_symbols_repo_kind_name on symbols(repo_id, kind, name);
    create index idx_edges_repo_to on edges(repo_id, to_id);
    create index idx_edges_repo_type_to on edges(repo_id, type, to_id);
    create index idx_edges_repo_from_to on edges(repo_id, from_id, to_id);
    create index idx_edges_repo_type_to_from on edges(repo_id, type, to_id, from_id);
  `);

  const sym = db.prepare(
    `insert into symbols (repo_id, symbol_id, file_path, name, kind, line, parent_symbol_id)
     values (?, ?, ?, ?, ?, ?, ?)`
  );
  const edge = db.prepare(`insert into edges (repo_id, from_id, to_id, type, confidence) values (?, ?, ?, ?, ?)`);

  // Target file: one symbol per alternative, plus an owner type for the qualified branch.
  sym.run("r1", "sym-owner", "target.ts", "Owner", "class", 1, null);
  sym.run("r1", "sym-resolved", "target.ts", "resolvedFn", "function", 10, null);
  sym.run("r1", "sym-callee", "target.ts", "calleeFn", "function", 20, null);
  sym.run("r1", "sym-type", "target.ts", "TypeName", "interface", 30, null);
  sym.run("r1", "sym-bare-prop", "target.ts", "barePropertyName", "property", 40, null);
  sym.run("r1", "sym-owned-prop", "target.ts", "ownedProp", "property", 50, "sym-owner");
  sym.run("r1", "sym-anyowner-prop", "target.ts", "anyOwnerProp", "property", 60, "sym-owner");
  // A non-property symbol whose name a property token happens to share — the any-owner branch
  // is gated on kind='property', so this must NOT match it.
  sym.run("r1", "sym-method-namesake", "target.ts", "namesake", "method", 70, null);

  // Callers, in another file (the impact queries require sf.file_path != s.file_path).
  for (let i = 1; i <= 9; i++) sym.run("r1", `caller-${i}`, "caller.ts", `caller${i}`, "function", i * 10, null);
  // A caller in the SAME file — matches the join, excluded later by the file_path filter.
  sym.run("r1", "same-file-caller", "target.ts", "sameFileCaller", "function", 900, null);

  // Other repo — must never appear.
  sym.run("r2", "other-resolved", "target.ts", "resolvedFn", "function", 10, null);
  sym.run("r2", "other-caller", "caller.ts", "otherCaller", "function", 10, null);

  // ── the six matching alternatives ──────────────────────────────────────────
  edge.run("r1", "caller-1", "sym-resolved", "CALLS", 1.0);                       // 1 resolved id
  edge.run("r1", "caller-2", "callee:calleeFn", "CALLS", 0.8);                    // 2 callee token
  edge.run("r1", "caller-3", "type:TypeName", "TYPE_REF", 0.75);                  // 3 type token
  edge.run("r1", "caller-4", "property:barePropertyName", "PROPERTY_REF", 0.6);   // 4 bare property
  edge.run("r1", "caller-5", "property:Owner.ownedProp", "PROPERTY_WRITE", 0.9);  // 5 qualified
  edge.run("r1", "caller-6", "property:Whatever.anyOwnerProp", "PROPERTY_REF", 0.7); // 6 any owner
  edge.run("r1", "same-file-caller", "sym-resolved", "CALLS", 1.0);              // matches, filtered later

  // ── decoys: right token, wrong edge type ──────────────────────────────────
  edge.run("r1", "caller-7", "callee:calleeFn", "TYPE_REF", 1.0);                 // callee token needs CALLS
  edge.run("r1", "caller-7", "type:TypeName", "CALLS", 1.0);                      // type token needs TYPE_REF
  edge.run("r1", "caller-7", "property:barePropertyName", "CALLS", 1.0);          // property token needs PROPERTY_*
  edge.run("r1", "caller-8", "property:Whatever.namesake", "PROPERTY_REF", 1.0);  // any-owner, but kind != property
  edge.run("r1", "caller-9", "callee:noSuchSymbol", "CALLS", 1.0);                // unresolved, no symbol
  edge.run("r2", "other-caller", "other-resolved", "CALLS", 1.0);                // other repo
  return db;
}

/** Old predicate → the (symbol, edge) pairs it produced. */
function oldPairs(db, filter, params) {
  return db
    .prepare(
      `select s.symbol_id as sid, e.rowid as eid
       from symbols s
       inner join edges e on e.repo_id = s.repo_id and ${OLD_JOIN}
       left join symbols st on st.repo_id = s.repo_id and st.symbol_id = s.parent_symbol_id
       where ${filter}
       order by sid, eid`
    )
    .all(params);
}

function newPairs(db, filter, params) {
  return db
    .prepare(`with ${buildEdgeToSymbolPairsCte(filter)} select sid, eid from pairs order by sid, eid`)
    .all(params);
}

function describe(db, pairs) {
  return pairs
    .map((p) => {
      const e = db.prepare("select from_id, to_id, type from edges where rowid = ?").get(p.eid);
      const s = db.prepare("select name from symbols where symbol_id = ? and repo_id = 'r1'").get(p.sid);
      return `${s?.name ?? p.sid} <- ${e.from_id} (${e.type} ${e.to_id})`;
    })
    .sort();
}

const db = makeDb();

// ── 1. results parity, selecting by file ────────────────────────────────────
console.log("\n[parity] symbolFilter by file_path");
{
  const filter = "s.repo_id = @repoId and s.file_path = @filePath";
  const params = { repoId: "r1", filePath: "target.ts" };
  const before = describe(db, oldPairs(db, filter, params));
  const after = describe(db, newPairs(db, filter, params));
  assert(before.length > 0, "old predicate matched something (fixture is live)", `got ${before.length}`);
  assert(
    JSON.stringify(before) === JSON.stringify(after),
    "new CTE selects exactly the old pairs",
    `\n    old (${before.length}): ${before.join("\n                 ")}\n    new (${after.length}): ${after.join("\n                 ")}`
  );
  // Pin the grammar itself, so a silently-narrowed branch fails even if both sides narrow.
  const joined = after.join("\n");
  for (const [label, needle] of [
    ["resolved symbol_id", "resolvedFn <- caller-1"],
    ["callee: token", "calleeFn <- caller-2"],
    ["type: token", "TypeName <- caller-3"],
    ["bare property: token", "barePropertyName <- caller-4"],
    ["qualified property:Owner.Member", "ownedProp <- caller-5"],
    ["any-owner property:%.Member", "anyOwnerProp <- caller-6"]
  ]) {
    assert(joined.includes(needle), `matches ${label}`);
  }
  assert(!joined.includes("namesake <- caller-8"), "any-owner branch stays gated on kind='property'");
  assert(!joined.includes("caller-7"), "token alternatives stay gated on edge type");
  assert(!joined.includes("otherCaller"), "never crosses repo_id");
}

// ── 2. results parity, selecting by symbol (GraphStore.getFieldAccesses) ────
console.log("\n[parity] symbolFilter by symbol_id");
for (const symbolId of ["sym-owned-prop", "sym-anyowner-prop", "sym-resolved", "sym-method-namesake"]) {
  const filter = "s.repo_id = @repoId and s.symbol_id = @symbolId";
  const params = { repoId: "r1", symbolId };
  const before = describe(db, oldPairs(db, filter, params));
  const after = describe(db, newPairs(db, filter, params));
  assert(JSON.stringify(before) === JSON.stringify(after), `${symbolId}: identical pairs (${before.length})`);
}

// ── 3. query-plan guard — this is the regression that actually happened ─────
console.log("\n[plan] no branch may scan the edges table");
{
  const filter = "s.repo_id = @repoId and s.file_path = @filePath";
  const plan = db
    .prepare(`explain query plan with ${buildEdgeToSymbolPairsCte(filter)} select sid, eid from pairs`)
    .all({ repoId: "r1", filePath: "target.ts" })
    .map((r) => r.detail);

  const scansEdges = plan.filter((d) => /^SCAN e\b/.test(d));
  assert(scansEdges.length === 0, "no full scan of edges", scansEdges.join(" | "));

  // Each of the six branches must reach `edges` through an index. Six branches → six lookups.
  const edgeSearches = plan.filter((d) => /^SEARCH e\b.*INDEX idx_edges_/.test(d));
  assert(edgeSearches.length === 6, "all six branches reach edges via an index", `got ${edgeSearches.length}:\n    ${plan.join("\n    ")}`);

  // And the old shape's tell: `edges` constrained by repo_id alone.
  const repoOnly = edgeSearches.filter((d) => /\(repo_id=\?\)/.test(d));
  assert(repoOnly.length === 0, "no branch constrains edges by repo_id alone", repoOnly.join(" | "));
}

console.log(`\n[results] ${passed} passed, ${failed} failed`);
db.close();
if (failed > 0) process.exit(1);
