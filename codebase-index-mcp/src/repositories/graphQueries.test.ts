import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";

import { initGraphSchema } from "./schema.js";
import { getCallEdges, getDependencies } from "./graphQueries.js";
import { CALL_TRAVERSAL_EDGE_TYPES } from "../types/index.js";

/**
 * The two edge-traversal query builders every graph tool reads through (backlog B-06).
 *
 * Against the **real** schema on an in-memory database, not a hand-written table: a bespoke
 * fixture schema would let these pass while the column names the queries depend on drift.
 * `:memory:` keeps it a unit test — no file, no index run, milliseconds.
 *
 * What is worth pinning here is the filtering, because it is invisible in the result shape:
 * `getDependencies` must see IMPORTS/DEPENDS_ON and nothing else, and `getCallEdges` must cross
 * the message bus (PUBLISHES, ISSUE-020) while ignoring unrelated types. A query that quietly
 * widens or narrows its `type in (...)` produces a plausible answer that is simply wrong.
 */

function db() {
  const conn = new Database(":memory:");
  initGraphSchema(conn);
  conn.prepare("insert into repositories (repo_id, repo_path, updated_at) values (?, ?, ?)")
    .run("r", "/tmp/r", new Date().toISOString());
  return conn;
}

function addEdge(conn: Database.Database, fromId: string, toId: string, type: string) {
  conn.prepare(
    `insert into edges (repo_id, from_id, to_id, type, confidence, reason)
     values (?, ?, ?, ?, ?, ?)`
  ).run("r", fromId, toId, type, 1.0, "test");
}

function addSymbol(conn: Database.Database, symbolId: string, name: string, filePath: string) {
  conn.prepare(
    `insert into symbols (repo_id, symbol_id, file_path, name, kind, line)
     values (?, ?, ?, ?, ?, ?)`
  ).run("r", symbolId, filePath, name, "method", 1);
}

test("getDependencies returns IMPORTS and DEPENDS_ON only", () => {
  const conn = db();
  addEdge(conn, "a", "imported", "IMPORTS");
  addEdge(conn, "a", "dependedOn", "DEPENDS_ON");
  addEdge(conn, "a", "called", "CALLS");
  addEdge(conn, "a", "typed", "TYPE_REF");

  const rows = getDependencies(conn, "r", "a", 50);
  assert.deepEqual(rows.map((r) => r.toId).sort(), ["dependedOn", "imported"]);
  conn.close();
});

test("getDependencies is scoped by repo and by from_id", () => {
  const conn = db();
  conn.prepare("insert into repositories (repo_id, repo_path, updated_at) values (?, ?, ?)")
    .run("other", "/tmp/other", new Date().toISOString());
  addEdge(conn, "a", "mine", "IMPORTS");
  addEdge(conn, "b", "someoneElses", "IMPORTS");
  conn.prepare(
    `insert into edges (repo_id, from_id, to_id, type, confidence, reason) values (?, ?, ?, ?, ?, ?)`
  ).run("other", "a", "otherRepo", "IMPORTS", 1.0, "test");

  const rows = getDependencies(conn, "r", "a", 50);
  assert.deepEqual(rows.map((r) => r.toId), ["mine"]);
  conn.close();
});

test("getDependencies honours the limit", () => {
  const conn = db();
  for (let i = 0; i < 10; i++) addEdge(conn, "a", `dep${String(i)}`, "IMPORTS");
  assert.equal(getDependencies(conn, "r", "a", 3).length, 3);
  assert.equal(getDependencies(conn, "r", "a", 50).length, 10);
  conn.close();
});

test("getCallEdges follows callees forward and callers backward", () => {
  const conn = db();
  addEdge(conn, "caller", "target", "CALLS");
  addEdge(conn, "target", "callee", "CALLS");

  const callees = getCallEdges(conn, "r", "target", "callees", 50);
  assert.deepEqual(callees.map((e) => e.toId), ["callee"]);

  const callers = getCallEdges(conn, "r", "target", "callers", 50);
  assert.deepEqual(callers.map((e) => e.fromId), ["caller"]);
  conn.close();
});

test("getCallEdges crosses the message bus (ISSUE-020)", () => {
  // A publisher counts as a caller of the consumer it was matched to. If PUBLISHES is dropped
  // from the traversal list, trace_execution_flow and get_call_chain stop at the bus boundary
  // and report a shorter chain rather than an error — which is why this is asserted.
  const conn = db();
  addEdge(conn, "publisher", "consumer", "PUBLISHES");

  assert.deepEqual(
    getCallEdges(conn, "r", "consumer", "callers", 50).map((e) => e.fromId),
    ["publisher"]
  );
  assert.deepEqual(
    getCallEdges(conn, "r", "publisher", "callees", 50).map((e) => e.toId),
    ["consumer"]
  );
  assert.ok(CALL_TRAVERSAL_EDGE_TYPES.includes("PUBLISHES"));
  conn.close();
});

test("getCallEdges ignores edge types outside the traversal set", () => {
  const conn = db();
  addEdge(conn, "importer", "target", "IMPORTS");
  addEdge(conn, "typer", "target", "TYPE_REF");
  addEdge(conn, "writer", "target", "PROPERTY_WRITE");

  assert.deepEqual(getCallEdges(conn, "r", "target", "callers", 50), []);
  conn.close();
});

test("getCallEdges carries confidence and reason through", () => {
  // Consumers tag via:"interface" (ISSUE-022) and via:"bus" off these two columns; dropping
  // either from the select silently removes the tag rather than failing.
  const conn = db();
  conn.prepare(
    `insert into edges (repo_id, from_id, to_id, type, confidence, reason) values (?, ?, ?, ?, ?, ?)`
  ).run("r", "caller", "impl", "CALLS", 0.7, "interface-dispatch");

  const [row] = getCallEdges(conn, "r", "impl", "callers", 50);
  assert.equal(row.confidence, 0.7);
  assert.equal(row.reason, "interface-dispatch");
  conn.close();
});

test("both queries resolve endpoint names and files (MCP-ISSUE-049)", () => {
  // The defect these pin: ids only. `get_call_chain` at its DEFAULT profile could report nothing
  // but a 24-hex `fromId`/`toId`, so acting on the answer cost a second tool call per hop. Asserted
  // on both queries because they had the same omission and `getModuleFlow` — same table, same
  // join — did not, which is how the inconsistency survived.
  const conn = db();
  addSymbol(conn, "caller", "HandleAsync", "src/Handlers/Handler.cs");
  addSymbol(conn, "target", "NotifyAsync", "src/Notify/Notifier.cs");
  addSymbol(conn, "importer", "Module", "src/Module.ts");
  addSymbol(conn, "imported", "Dep", "src/Dep.ts");
  addEdge(conn, "caller", "target", "CALLS");
  addEdge(conn, "importer", "imported", "IMPORTS");

  const [call] = getCallEdges(conn, "r", "target", "callers", 50);
  assert.equal(call.fromName, "HandleAsync");
  assert.equal(call.fromFilePath, "src/Handlers/Handler.cs");
  assert.equal(call.toName, "NotifyAsync");
  assert.equal(call.toFilePath, "src/Notify/Notifier.cs");

  const [dep] = getDependencies(conn, "r", "importer", 50);
  assert.equal(dep.fromName, "Module");
  assert.equal(dep.toName, "Dep");
  assert.equal(dep.toFilePath, "src/Dep.ts");
  conn.close();
});

test("an unresolved callee still yields a hop, with null identity (MCP-ISSUE-049)", () => {
  // The endpoint resolution is a LEFT join for this reason: `callee:` placeholders have no symbols
  // row. An inner join would have silently shortened every call chain that reaches external/BCL
  // code, which is the majority of them.
  const conn = db();
  addSymbol(conn, "caller", "HandleAsync", "src/Handlers/Handler.cs");
  addEdge(conn, "caller", "callee:Console.WriteLine", "CALLS");

  const [row] = getCallEdges(conn, "r", "caller", "callees", 50);
  assert.equal(row.toId, "callee:Console.WriteLine");
  assert.equal(row.toName, null);
  assert.equal(row.fromName, "HandleAsync");
  conn.close();
});
