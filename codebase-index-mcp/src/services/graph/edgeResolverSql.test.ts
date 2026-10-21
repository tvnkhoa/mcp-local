import assert from "node:assert/strict";
import test from "node:test";

import Database from "better-sqlite3";

import { resolveSqlEdges, sqlNameKey } from "./edgeResolverSql.js";
import { getSqlDefinitionInfo, pickCurrentSqlDefinition, sqlDefinitionRank } from "./sqlDefinitions.js";

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
  // Release I3: ONE edge, to the current definition (the baseline beats archive/), labelled with the count.
  assert.deepEqual(rows.filter((r) => r.f === "TS1").map((r) => [r.t, r.c, r.reason]), [
    ["T_PUB", 0.6, "name_resolved (current of 2 definitions): ts query literal from | sqltable:audit_events"]
  ]);
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

test("resolveSqlEdges: rebinding is a pure function of tokens and definitions (a later definition takes over an earlier binding)", () => {
  const d = db();
  def(d, "T1", "sql_table", "t", "t", "db/001-a.sql");
  token(d, "TS1", "sqltable:t");
  resolveSqlEdges(d, "r");
  assert.deepEqual(edges(d).map((r) => r.t), ["T1"]);
  def(d, "T2", "sql_table", "t", "public.t", "db/002-b.sql");
  resolveSqlEdges(d, "r");
  assert.deepEqual(edges(d).map((r) => r.t), ["T2"]);
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

// ─── release I3: one current definition per name ────────────────────────────────────────────────

function defAt(d: Database.Database, id: string, kind: string, name: string, qualified: string, file: string, line: number): void {
  d.prepare("insert into symbols values ('r', ?, ?, ?, ?, ?, ?)").run(id, file, name, kind, line, `${qualified} — x`);
}

test("pickCurrentSqlDefinition: latest migration; the baseline beats any archive/ file; .down.sql is never current; later line wins", () => {
  const pick = (...sites: [string, number][]) => pickCurrentSqlDefinition(sites.map(([filePath, line], i) => ({ symbolId: String(i), filePath, line })))?.filePath + ":" + String(pickCurrentSqlDefinition(sites.map(([filePath, line], i) => ({ symbolId: String(i), filePath, line })))?.line);
  assert.equal(pick(["db/migrations/archive/0019-x.sql", 232], ["db/migrations/0001-baseline.sql", 356], ["db/migrations/archive/0010-y.sql", 291]), "db/migrations/0001-baseline.sql:356");
  assert.equal(pick(["db/migrations/0001-baseline.sql", 469], ["db/migrations/0043-e.sql", 20], ["db/migrations/0043-e.down.sql", 6], ["db/migrations/archive/0010-t.sql", 341]), "db/migrations/0043-e.sql:20");
  assert.equal(pick(["db/migrations/0001-baseline.sql", 1538], ["db/migrations/0044-x.down.sql", 27], ["db/migrations/0039-y.down.sql", 26]), "db/migrations/0001-baseline.sql:1538", "a down migration restores an older shape: never current while an up exists");
  assert.equal(pick(["db/migrations/0044-x.down.sql", 27], ["db/migrations/0039-y.down.sql", 26]), "db/migrations/0044-x.down.sql:27", "only down files: the latest of them");
  assert.equal(pick(["db/m/0005-a.sql", 10], ["db/m/0005-a.sql", 40]), "db/m/0005-a.sql:40", "CREATE OR REPLACE twice in one file: the later one");
  assert.equal(pick(["db/checks/fixture.sql", 1], ["db/migrations/archive/0004-a.sql", 77]), "db/migrations/archive/0004-a.sql:77", "an unnumbered file is not migration history");
  assert.equal(pick(["db/m/0002-b.sql", 1], ["db/m/0010-a.sql", 1]), "db/m/0010-a.sql:1", "by number, not by name");
  assert.deepEqual(sqlDefinitionRank("db\\migrations\\Archive\\0004-a.sql", 3).slice(0, 2), [2, 4], "backslashes and case do not hide archive/");
});

test("resolveSqlEdges: CREATE OR REPLACE keeps each version's reads; grants, comments and TS callers bind to the current version once", () => {
  const d = db();
  defAt(d, "F_ARCH", "sql_function", "usage_in_period", "usage_in_period", "db/migrations/archive/0010-quota.sql", 341);
  defAt(d, "F_BASE", "sql_function", "usage_in_period", "public.usage_in_period", "db/migrations/0001-baseline.sql", 469);
  defAt(d, "F_DOWN", "sql_function", "usage_in_period", "public.usage_in_period", "db/migrations/0043-errored.down.sql", 6);
  defAt(d, "F_43", "sql_function", "usage_in_period", "public.usage_in_period", "db/migrations/0043-errored.sql", 20);
  defAt(d, "UE", "sql_table", "usage_events", "public.usage_events", "db/migrations/0001-baseline.sql", 1064);
  defAt(d, "UE_ARCH", "sql_table", "usage_events", "usage_events", "db/migrations/archive/0005-usage.sql", 119);
  defAt(d, "TQ", "sql_table", "turn_quality", "turn_quality", "db/migrations/0004-tq.sql", 40);
  // Each version's own body.
  for (const f of ["F_ARCH", "F_BASE", "F_DOWN", "F_43"]) token(d, f, "sqltable:usage_events", "SQL_USES", "reads");
  token(d, "F_43", "sqltable:turn_quality", "SQL_USES", "reads");
  // Inbound: two grants (baseline + archive spelling), a TS const and its caller.
  token(d, "G_BASE", "sqlfunc:public.usage_in_period", "SQL_GRANT", "grant all to aria_turn");
  token(d, "G_ARCH", "sqlfunc:usage_in_period", "SQL_GRANT", "grant execute to aria_turn");
  token(d, "TS_CONST", "sqlfunc:usage_in_period", "SQL_QUERY", "ts sql const SELECT_USAGE_IN_PERIOD from (set-returning call) (line 98)");
  token(d, "TS_FN", "sqlfunc:usage_in_period", "SQL_QUERY", "ts uses sql const SELECT_USAGE_IN_PERIOD from (set-returning call) (line 368)");
  resolveSqlEdges(d, "r");
  const first = edges(d);
  for (const from of ["G_BASE", "G_ARCH", "TS_CONST", "TS_FN"]) {
    const out = first.filter((r) => r.f === from);
    assert.deepEqual(out.map((r) => r.t), ["F_43"], `${from} binds once, to the current version`);
    assert.match(out[0]!.reason, /^name_resolved \(current of 4 definitions\): /);
    assert.equal(out[0]!.c, 0.6);
  }
  assert.deepEqual(first.filter((r) => r.f === "F_43").map((r) => r.t).sort(), ["TQ", "UE"], "0043 reads turn_quality and usage_events");
  assert.deepEqual(first.filter((r) => r.f === "F_BASE").map((r) => r.t), ["UE"], "the baseline version does not read turn_quality");
  assert.deepEqual(first.filter((r) => r.f === "F_ARCH").map((r) => r.t), ["UE"], "an archive version's reads bind to the current usage_events");
  assert.equal(first.filter((r) => r.t === "UE_ARCH").length, 0, "nothing binds to a superseded table");

  const info = getSqlDefinitionInfo(d, "r", ["F_43", "F_BASE", "UE"]);
  assert.deepEqual(info.get("F_43"), {
    current: true,
    definitions: 4,
    currentDefinition: "db/migrations/0043-errored.sql:20",
    currentSymbolId: "F_43",
    alsoDefinedAt: ["db/migrations/0043-errored.down.sql:6", "db/migrations/archive/0010-quota.sql:341", "db/migrations/0001-baseline.sql:469"],
    note: info.get("F_43")!.note
  });
  assert.equal(info.get("F_BASE")?.current, false);
  assert.equal(info.get("F_BASE")?.currentDefinition, "db/migrations/0043-errored.sql:20");
  assert.ok(info.get("F_BASE")!.alsoDefinedAt.includes("db/migrations/0043-errored.sql:20"));
  assert.deepEqual(info.get("UE")?.alsoDefinedAt, ["db/migrations/archive/0005-usage.sql:119"]);

  // Idempotent: a second run (an incremental run with nothing changed) lands on the same set.
  resolveSqlEdges(d, "r");
  assert.deepEqual(edges(d), first);
});

// ─── release I4: imported query consts ─────────────────────────────────────────────────────────

function fileWithModule(d: Database.Database, path: string, moduleId: string): void {
  d.prepare("insert into files values ('r', ?, 'typescript')").run(path);
  d.prepare("insert into symbols values ('r', ?, ?, ?, 'module', 1, null)").run(moduleId, path, path.split("/").pop());
}

test("resolveSqlEdges: an imported SQL const gives the CALLER its targets 'via CONST (file:line)'; a renamed import, a barrel hop; a non-SQL const gives nothing", () => {
  const d = db();
  defAt(d, "AE", "sql_table", "audit_events", "public.audit_events", "db/migrations/0001-baseline.sql", 562);
  defAt(d, "AE_ARCH", "sql_table", "audit_events", "audit_events", "db/migrations/archive/0004-audit.sql", 77);
  fileWithModule(d, "src/store-sql.ts", "MOD_SQL");
  fileWithModule(d, "src/store.ts", "MOD_STORE");
  fileWithModule(d, "src/index.ts", "MOD_BARREL");
  d.prepare("insert into symbols values ('r', 'V_INSERT', 'src/store-sql.ts', 'INSERT_AUDIT', 'variable', 3, null)").run();
  d.prepare("insert into symbols values ('r', 'V_LIMIT', 'src/store-sql.ts', 'PAGE_SIZE', 'variable', 9, null)").run();
  d.prepare("insert into symbols values ('r', 'C_RENAMED', 'src/store.ts', 'recordDecision', 'function', 20, null)").run();
  d.prepare("insert into symbols values ('r', 'C_BARREL', 'src/store.ts', 'viaBarrel', 'function', 40, null)").run();
  d.prepare("insert into symbols values ('r', 'C_NOTSQL', 'src/store.ts', 'pageSize', 'function', 60, null)").run();
  d.prepare("insert into symbols values ('r', 'C_MISSING', 'src/store.ts', 'missing', 'function', 70, null)").run();
  // The const's own declaration scan (jsSqlQueries rule 2).
  token(d, "V_INSERT", "sqltable:audit_events", "SQL_QUERY", "ts sql const INSERT_AUDIT insert into (line 3)");
  token(d, "V_INSERT", "sqlcolumn:audit_events.tenant_id", "SQL_QUERY", "ts sql const INSERT_AUDIT insert into column (line 3)");
  // The barrel imports the sql module (resolved IMPORTS edge).
  d.prepare("insert into edges values ('r', 'MOD_BARREL', 'MOD_SQL', 'IMPORTS', 1, null, null)").run();
  // Anchors: `import { INSERT_AUDIT as INSERT_DECISION } from './store-sql.js'`, a barrel import, a non-SQL const, a missing name.
  token(d, "C_RENAMED", "sqlconst:./store-sql.js#INSERT_AUDIT", "SQL_QUERY", "ts query imported const INSERT_DECISION (line 25)");
  token(d, "C_BARREL", "sqlconst:./index.js#INSERT_AUDIT", "SQL_QUERY", "ts query imported const INSERT_AUDIT (line 44)");
  token(d, "C_NOTSQL", "sqlconst:./store-sql.js#PAGE_SIZE", "SQL_QUERY", "ts query imported const PAGE_SIZE (line 61)");
  token(d, "C_MISSING", "sqlconst:./nowhere.js#INSERT_AUDIT", "SQL_QUERY", "ts query imported const INSERT_AUDIT (line 71)");
  const stats = resolveSqlEdges(d, "r");
  const first = edges(d);

  const renamed = first.filter((r) => r.f === "C_RENAMED");
  assert.deepEqual(renamed.map((r) => r.t).sort(), ["AE", "V_INSERT", "sqlcolumn:audit_events.tenant_id"].sort());
  const table = renamed.find((r) => r.t === "AE")!;
  assert.equal(table.c, 0.6);
  assert.equal(table.reason, "name_resolved (current of 2 definitions): ts query imported const INSERT_DECISION via INSERT_AUDIT (src/store-sql.ts:3) insert into (line 25) | sqltable:audit_events");
  assert.equal(renamed.find((r) => r.t === "V_INSERT")!.reason, "name_resolved: ts query imported const INSERT_DECISION (line 25) | sqlconst:./store-sql.js#INSERT_AUDIT");

  assert.ok(first.some((r) => r.f === "C_BARREL" && r.t === "AE" && /via INSERT_AUDIT \(src\/store-sql\.ts:3\)/.test(r.reason)), "one barrel hop is followed");
  const notSql = first.filter((r) => r.f === "C_NOTSQL");
  assert.deepEqual(notSql.map((r) => [r.t, r.reason]), [["sqlconst:./store-sql.js#PAGE_SIZE", "unresolved sql token (not a sql const): ts query imported const PAGE_SIZE (line 61)"]], "a non-SQL const produces no SQL target");
  assert.deepEqual(first.filter((r) => r.f === "C_MISSING").map((r) => r.reason), ["unresolved sql token (module not in the repo): ts query imported const INSERT_AUDIT (line 71)"]);
  assert.equal(stats.constAnchorsFollowed, 2);
  assert.equal(stats.constAnchorsUnfollowed, 2);

  // Full = incremental: a second run is identical; a changed const reaches the unchanged caller.
  resolveSqlEdges(d, "r");
  assert.deepEqual(edges(d), first);
  d.prepare("delete from edges where from_id = 'V_INSERT'").run();
  token(d, "V_INSERT", "sqltable:usage_events", "SQL_QUERY", "ts sql const INSERT_AUDIT insert into (line 3)");
  defAt(d, "UE", "sql_table", "usage_events", "usage_events", "db/migrations/0001-baseline.sql", 1064);
  resolveSqlEdges(d, "r");
  assert.deepEqual(edges(d).filter((r) => r.f === "C_RENAMED").map((r) => r.t).sort(), ["UE", "V_INSERT"], "the caller follows the const's new text; the old targets are gone");
});
