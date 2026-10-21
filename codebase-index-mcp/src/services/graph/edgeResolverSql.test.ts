import assert from "node:assert/strict";
import test from "node:test";

import Database from "better-sqlite3";

import { resolveSqlEdges, sqlNameKey } from "./edgeResolverSql.js";

function db(): Database.Database {
  const d = new Database(":memory:");
  d.exec(`
    create table files (repo_id text, path text, language text);
    create table symbols (repo_id text, symbol_id text, file_path text, name text, kind text, line integer, signature text);
    create table edges (repo_id text, from_id text, to_id text, type text, confidence real, reason text, assigned_expression text);
  `);
  return d;
}

function def(d: Database.Database, id: string, kind: string, name: string, qualified: string, file = "db/001.sql"): void {
  d.prepare("insert into symbols values ('r', ?, ?, ?, ?, 1, ?)").run(id, file, name, kind, `${qualified} — x`);
}

function token(d: Database.Database, from: string, toId: string, type = "SQL_QUERY", clause = "ts query literal from"): void {
  d.prepare("insert into edges values ('r', ?, ?, ?, 0.5, ?, null)").run(from, toId, type, `unresolved sql token: ${clause}`);
}

const edges = (d: Database.Database) =>
  d.prepare("select from_id as f, to_id as t, confidence as c, reason from edges where type != 'SQL_MIGRATION_ORDER' order by f, t").all() as { f: string; t: string; c: number; reason: string }[];

test("sqlNameKey: public is the default schema; columns and policies are table-scoped", () => {
  assert.deepEqual(sqlNameKey("table", "public.audit_events"), { schema: null, rest: "audit_events" });
  assert.deepEqual(sqlNameKey("table", "audit_events"), { schema: null, rest: "audit_events" });
  assert.deepEqual(sqlNameKey("column", "conversation_store.conversation_message.text"), { schema: "conversation_store", rest: "conversation_message.text" });
  assert.deepEqual(sqlNameKey("column", "audit_events.tenant_id"), { schema: null, rest: "audit_events.tenant_id" });
  assert.deepEqual(sqlNameKey("role", "aria_turn"), { schema: null, rest: "aria_turn" });
});

test("resolveSqlEdges: a qualified name binds only inside its schema; public ≡ unqualified; every binding says name_resolved at 0.6", () => {
  const d = db();
  def(d, "T_PUB", "sql_table", "audit_events", "public.audit_events");
  def(d, "T_ARCH", "sql_table", "audit_events", "audit_events", "db/archive/0004.sql");
  def(d, "M_STORE", "sql_table", "conversation_message", "conversation_store.conversation_message");
  token(d, "TS1", "sqltable:audit_events");
  token(d, "TS2", "sqltable:conversation_store.conversation_message");
  token(d, "TS3", "sqltable:other_schema.conversation_message");
  resolveSqlEdges(d, "r");
  const rows = edges(d);
  // Fan-out to both definition sites of audit_events.
  assert.deepEqual(rows.filter((r) => r.f === "TS1").map((r) => r.t).sort(), ["T_ARCH", "T_PUB"]);
  assert.ok(rows.filter((r) => r.f === "TS1").every((r) => r.c === 0.6 && r.reason === "name_resolved (2 definitions): ts query literal from | sqltable:audit_events"));
  assert.deepEqual(rows.filter((r) => r.f === "TS2").map((r) => [r.t, r.c]), [["M_STORE", 0.6]]);
  // A qualified name in a schema nothing defines never falls back to another schema's table.
  assert.deepEqual(rows.filter((r) => r.f === "TS3").map((r) => [r.t, r.reason]), [["sqltable:other_schema.conversation_message", "unresolved sql token: ts query literal from"]]);
});

test("resolveSqlEdges: an unqualified name with no default-schema definition binds to the ONE other schema (labelled search_path, 0.5), or stays ambiguous", () => {
  const d = db();
  def(d, "M_STORE", "sql_table", "conversation_message", "conversation_store.conversation_message");
  def(d, "X_A", "sql_table", "x", "a.x");
  def(d, "X_B", "sql_table", "x", "b.x");
  token(d, "TS1", "sqltable:conversation_message");
  token(d, "TS2", "sqltable:x");
  resolveSqlEdges(d, "r");
  const rows = edges(d);
  assert.deepEqual(rows.filter((r) => r.f === "TS1").map((r) => [r.t, r.c, r.reason]), [
    ["M_STORE", 0.5, "name_resolved (search_path): ts query literal from | sqltable:conversation_message"]
  ]);
  assert.deepEqual(rows.filter((r) => r.f === "TS2").map((r) => [r.t, r.reason]), [
    ["sqltable:x", "unresolved sql token (ambiguous: a.x, b.x): ts query literal from"]
  ]);
});

test("resolveSqlEdges: rebinding is a pure function of tokens and definitions (a new definition re-fans an earlier binding)", () => {
  const d = db();
  def(d, "T1", "sql_table", "t", "t");
  token(d, "TS1", "sqltable:t");
  resolveSqlEdges(d, "r");
  assert.deepEqual(edges(d).map((r) => r.t), ["T1"]);
  def(d, "T2", "sql_table", "t", "public.t", "db/002.sql");
  resolveSqlEdges(d, "r");
  assert.deepEqual(edges(d).map((r) => r.t).sort(), ["T1", "T2"]);
  d.prepare("delete from symbols where symbol_id in ('T1', 'T2')").run();
  resolveSqlEdges(d, "r");
  // The definitions are gone: the binding is restored as a labelled token, never dropped.
  assert.deepEqual(edges(d).map((r) => [r.t, r.reason]), [["sqltable:t", "unresolved sql token: ts query literal from"]]);
});

test("resolveSqlEdges: a schema-wide grant fans out to the schema's tables; the migration order follows file names", () => {
  const d = db();
  def(d, "S", "sql_schema", "store", "store");
  def(d, "A", "sql_table", "a", "store.a");
  def(d, "B", "sql_table", "b", "store.b");
  def(d, "P", "sql_table", "p", "public.p");
  token(d, "G", "sqlschema:store", "SQL_GRANT", "grant select on all tables in schema to r");
  for (const [path, id] of [["db/m/001-a.sql", "M1"], ["db/m/002-b.sql", "M2"], ["db/m/002-b.down.sql", "M2D"], ["db/m/010-c.sql", "M10"]]) {
    d.prepare("insert into files values ('r', ?, 'sql')").run(path);
    d.prepare("insert into symbols values ('r', ?, ?, 'm', 'module', 1, null)").run(id, path);
  }
  const stats = resolveSqlEdges(d, "r");
  assert.deepEqual(edges(d).filter((r) => r.f === "G").map((r) => r.t).sort(), ["A", "B", "S"]);
  assert.match(edges(d).find((r) => r.f === "G")!.reason, /^name_resolved \(schema-wide, 2 objects\): /);
  const order = d.prepare("select from_id as f, to_id as t from edges where type = 'SQL_MIGRATION_ORDER' order by f").all();
  assert.deepEqual(order, [{ f: "M10", t: "M2" }, { f: "M2", t: "M1" }, { f: "M2D", t: "M2" }]);
  assert.equal(stats.migrationOrderEdges, 3);
});
