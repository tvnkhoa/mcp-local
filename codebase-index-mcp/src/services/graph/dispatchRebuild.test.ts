import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";

import { initGraphSchema, runGraphMigrations } from "../../repositories/schema.js";
import { rebuildInterfaceDispatchEdges } from "./edgeResolverCalls.js";
import { resolveBaseClassDispatch } from "./edgeResolverContracts.js";

/**
 * Release L (MCP-ISSUE-094): both dispatch fan-outs are rebuilt whole every run, from the resolved CALLS,
 * IMPLEMENTS and EXTENDS edges — so the result is the same whatever rows the run touched. Re-running never
 * duplicates; a caller's direct CALLS edge to the implementation wins over a dispatch edge; an implementor
 * added later is reached without re-resolving the caller.
 */

function db(): Database.Database {
  const conn = new Database(":memory:");
  initGraphSchema(conn);
  runGraphMigrations(conn, false);
  return conn;
}
const sym = (conn: Database.Database, id: string, name: string, kind: string, filePath: string, parent: string | null = null, signature: string | null = null): void => {
  conn.prepare(`insert into symbols (repo_id, symbol_id, file_path, name, kind, line, parent_symbol_id, signature) values ('r', ?, ?, ?, ?, 1, ?, ?)`).run(id, filePath, name, kind, parent, signature);
};
const edge = (conn: Database.Database, from: string, to: string, type: string, reason: string, confidence = 0.8): void => {
  conn.prepare(`insert into edges (repo_id, from_id, to_id, type, confidence, reason) values ('r', ?, ?, ?, ?, ?)`).run(from, to, type, confidence, reason);
};
const calls = (conn: Database.Database, reason: string) =>
  (conn.prepare(`select from_id as f, to_id as t from edges where repo_id = 'r' and type = 'CALLS' and reason = ? order by f, t`).all(reason) as { f: string; t: string }[]).map((r) => `${r.f}>${r.t}`);

test("release L: interface dispatch is rebuilt whole — idempotent, direct edges win, a new implementor is reached", () => {
  const conn = db();
  sym(conn, "I", "IStore", "interface", "IStore.cs");
  sym(conn, "I.Save", "Save", "method", "IStore.cs", "I");
  sym(conn, "A", "StoreA", "class", "StoreA.cs");
  sym(conn, "A.Save", "Save", "method", "StoreA.cs", "A");
  sym(conn, "B", "StoreB", "class", "StoreB.cs");
  sym(conn, "B.Save", "Save", "method", "StoreB.cs", "B");
  sym(conn, "caller1", "Handle", "method", "H1.cs");
  sym(conn, "caller2", "Handle", "method", "H2.cs");
  edge(conn, "A", "I", "IMPLEMENTS", "resolved interface");
  edge(conn, "B", "I", "IMPLEMENTS", "resolved interface");
  edge(conn, "caller1", "I.Save", "CALLS", "resolved interface method");
  edge(conn, "caller2", "I.Save", "CALLS", "resolved interface method (unproven receiver)", 0.7);
  edge(conn, "caller2", "B.Save", "CALLS", "resolved callee by receiver type", 0.85); // a direct edge to an implementation

  assert.equal(rebuildInterfaceDispatchEdges(conn, "r"), 3);
  assert.deepEqual(calls(conn, "interface-dispatch"), ["caller1>A.Save", "caller1>B.Save", "caller2>A.Save"], "caller2 keeps its direct edge to B.Save");
  assert.equal(rebuildInterfaceDispatchEdges(conn, "r"), 3, "a re-run rebuilds the same set");
  assert.equal(calls(conn, "interface-dispatch").length, 3, "and never duplicates it");

  // A third implementor appears; neither caller is touched — the rebuild still reaches it.
  sym(conn, "C", "StoreC", "class", "StoreC.cs");
  sym(conn, "C.Save", "Save", "method", "StoreC.cs", "C");
  edge(conn, "C", "I", "IMPLEMENTS", "resolved interface");
  rebuildInterfaceDispatchEdges(conn, "r");
  assert.deepEqual(calls(conn, "interface-dispatch"), ["caller1>A.Save", "caller1>B.Save", "caller1>C.Save", "caller2>A.Save", "caller2>C.Save"]);

  // An implementor whose IMPLEMENTS edge is still a token is not an implementor (yet).
  conn.prepare(`update edges set to_id = 'iface:IStore' where from_id = 'C' and type = 'IMPLEMENTS'`).run();
  rebuildInterfaceDispatchEdges(conn, "r");
  assert.ok(!calls(conn, "interface-dispatch").some((e) => e.endsWith(">C.Save")), "the stale C.Save edges are gone");
});

test("release L: base-class dispatch is rebuilt whole — a re-run never duplicates, a direct edge wins", () => {
  const conn = db();
  sym(conn, "Base", "ValueObject", "class", "ValueObject.cs");
  sym(conn, "Base.M", "GetEqualityComponents", "method", "ValueObject.cs", "Base", "protected abstract IEnumerable<object> GetEqualityComponents();");
  sym(conn, "Sub", "Money", "class", "Money.cs");
  sym(conn, "Sub.M", "GetEqualityComponents", "method", "Money.cs", "Sub", "protected override IEnumerable<object> GetEqualityComponents()");
  sym(conn, "Sub2", "Email", "class", "Email.cs");
  sym(conn, "Sub2.M", "GetEqualityComponents", "method", "Email.cs", "Sub2", "protected override IEnumerable<object> GetEqualityComponents()");
  sym(conn, "caller", "Equals", "method", "ValueObject.cs", "Base");
  edge(conn, "Sub", "Base", "EXTENDS", "base_list class", 0.9);
  edge(conn, "Sub2", "Base", "EXTENDS", "base_list class", 0.9);
  edge(conn, "caller", "Base.M", "CALLS", "resolved callee same-file", 0.9);
  edge(conn, "caller", "Sub2.M", "CALLS", "resolved callee by receiver type", 0.85);

  resolveBaseClassDispatch(conn, "r");
  resolveBaseClassDispatch(conn, "r");
  assert.deepEqual(calls(conn, "base-class-dispatch"), ["caller>Sub.M"], "one edge after two runs; Sub2.M keeps its direct edge");
});
