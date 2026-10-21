import assert from "node:assert/strict";
import test from "node:test";

import { lexSql } from "./sqlLexer.js";
import { scanSqlReferences } from "./sqlQueryScan.js";
import { extractGraphData } from "./treeSitterExtractor.js";

const scan = (sql: string) =>
  scanSqlReferences(lexSql(sql), { columns: true })
    .map((r) => `${r.kind}:${r.name}`)
    .sort();

test("scanSqlReferences: FROM lists, JOIN, INSERT INTO, UPDATE, DELETE FROM; CTEs and aliases are not tables", () => {
  assert.deepEqual(scan("with recent as (select * from audit_events) select r.id from recent r, people p join teams t on t.id = p.team_id"), [
    "table:audit_events",
    "table:people",
    "table:teams"
  ]);
  assert.deepEqual(scan("delete from conversation_store.conversation_message where id = $1"), ["table:conversation_store.conversation_message"]);
  assert.deepEqual(scan("select a from t for update"), ["column:t.a", "table:t"]);
  assert.deepEqual(scan("select extract(epoch from created_at) from t"), ["table:t"]);
});

test("scanSqlReferences: columns only where unambiguous — insert list, update set, single-table select list", () => {
  assert.deepEqual(scan("insert into audit_events as a (audit_kind, tenant_id) values ($1, $2) on conflict do update set tenant_id = $2"), [
    "column:audit_events.audit_kind",
    "column:audit_events.tenant_id",
    "table:audit_events"
  ]);
  assert.deepEqual(scan("update documents d set status = 'x', note = lower($1) where d.id = $2"), [
    "column:documents.note",
    "column:documents.status",
    "table:documents"
  ]);
  assert.deepEqual(scan("select d.id, title as t from documents d"), ["column:documents.id", "column:documents.title", "table:documents"]);
});

test("scanSqlReferences: a multi-table statement makes NO column claim", () => {
  assert.deepEqual(scan("select id, title from documents d join people p on p.id = d.owner_id"), ["table:documents", "table:people"]);
  assert.deepEqual(scan("select id from documents where owner_id in (select id from people)"), ["table:documents", "table:people"]);
});

test("scanSqlReferences: a migration-made function is a reference; built-ins, casts and aliases are not", () => {
  assert.deepEqual(scan("select requests from usage_in_period($1, $2, $3)"), ["function:usage_in_period"]);
  assert.deepEqual(scan("select count(*), coalesce(sum(x), 0)::numeric(10,2), public.score(t.id) from t join unnest($1::text[]) as p(a) on true"), [
    "function:public.score",
    "table:t"
  ]);
});

const TS = [
  "import { pool } from './db'", // 1
  "const MESSAGE = 'conversation_store.conversation_message'", // 2
  "export const READ = `select id, text from ${MESSAGE} where conversation_id = $1`", // 3
  "export const SELECT_USAGE = 'select requests ' +", // 4
  "  'from usage_in_period($1, $2)'", // 5
  "export async function load(client: any, table: string) {", // 6
  "  await client.query<{ id: string }>(`insert into audit_events (audit_kind, tenant_id) values ($1, $2)`)", // 7
  "  await pool.query('select d.id from documents d join people p on p.id = d.owner_id')", // 8
  "  await client.query(`select 1 from ${table} where x = $1`)", // 9
  "  return one(SELECT_USAGE)", // 10
  "}" // 11
].join("\n");

test("TS → SQL: query literals and SQL-shaped consts emit SQL_QUERY tokens; ${CONST} is inlined; a dynamic table is a gap", () => {
  const out = extractGraphData({ repoId: "r", filePath: "src/store.ts", language: "typescript", source: TS });
  const q = out.edges.filter((e) => e.type === "SQL_QUERY");
  const byFrom = (name: string): string[] => {
    const from = out.symbols.find((s) => s.name === name)!;
    return q.filter((e) => e.fromId === from.symbolId).map((e) => e.toId).sort();
  };
  // The template's ${MESSAGE} is a same-file const: inlined, so the qualified table is read.
  assert.deepEqual(byFrom("READ"), [
    "sqlcolumn:conversation_store.conversation_message.id",
    "sqlcolumn:conversation_store.conversation_message.text",
    "sqltable:conversation_store.conversation_message"
  ]);
  assert.deepEqual(byFrom("SELECT_USAGE"), ["sqlfunc:usage_in_period"]);
  // `load`: the insert (with columns), the two-table select (NO columns), and the const it passes on.
  assert.deepEqual(byFrom("load"), [
    "sqlcolumn:audit_events.audit_kind",
    "sqlcolumn:audit_events.tenant_id",
    "sqlfunc:usage_in_period",
    "sqltable:audit_events",
    "sqltable:documents",
    "sqltable:people"
  ]);
  for (const e of q) {
    assert.equal(e.confidence, 0.5);
    assert.match(e.reason!, /^unresolved sql token: ts (query literal|query const|sql const|uses sql const)/);
  }
  const gap = out.symbols.find((s) => s.kind === "sql_gap")!;
  assert.equal(gap.line, 9);
  assert.match(gap.name, /dynamic table name/);
});

const TS_IMPORTS = `import { INSERT_AUDIT as INSERT_DECISION, PAGE_SIZE } from './store-sql.js'
import type { Row } from './store-sql.js'
import * as sql from './more-sql.js'
const read = { statement: \`select id, title from documents\`, label: 'read' } as const

export async function decide(client: any) {
  await client.query(INSERT_DECISION, [1])
}
export async function page(client: any) {
  return client.query(PAGE_SIZE)
}
export async function viaNamespace(client: any) {
  return client.query<Row>(sql.SELECT_X, [])
}
export async function viaMember(client: any) {
  return client.query(read.statement)
}
export async function notAQuery(client: any) {
  return client.query(read.label)
}
`;

test("TS → SQL (release I4): an imported const at .query( is an anchor from the caller; a same-file member is read", () => {
  const out = extractGraphData({ repoId: "r", filePath: "src/store.ts", language: "typescript", source: TS_IMPORTS });
  const q = out.edges.filter((e) => e.type === "SQL_QUERY");
  const from = (name: string) => q.filter((e) => e.fromId === out.symbols.find((s) => s.name === name)!.symbolId);
  assert.deepEqual(from("decide").map((e) => [e.toId, e.reason]), [
    ["sqlconst:./store-sql.js#INSERT_AUDIT", "unresolved sql token: ts query imported const INSERT_DECISION (line 7)"]
  ], "a renamed import anchors on the EXPORTED name, the clause keeps the local one");
  assert.deepEqual(from("page").map((e) => e.toId), ["sqlconst:./store-sql.js#PAGE_SIZE"], "whether it is SQL is the resolver's question");
  assert.deepEqual(from("viaNamespace").map((e) => [e.toId, e.reason]), [
    ["sqlconst:./more-sql.js#SELECT_X", "unresolved sql token: ts query imported const sql.SELECT_X (line 13)"]
  ]);
  assert.deepEqual(from("viaMember").map((e) => e.toId).sort(), ["sqlcolumn:documents.id", "sqlcolumn:documents.title", "sqltable:documents"]);
  assert.match(from("viaMember")[0]!.reason!, /^unresolved sql token: ts query const read\.statement /);
  assert.deepEqual(from("notAQuery"), [], "a non-SQL member gives nothing");
});

test("TS → SQL (release I4): nested type arguments do not hide a file whose only SQL is imported", () => {
  const source = `import { SELECT_RETURNS } from './store-sql-notifications.js'
export async function returnedToMe(client: any) {
  const result = await client.query<Record<string, unknown>>(
    SELECT_RETURNS,
    [1],
  )
  return result.rows
}
`;
  const out = extractGraphData({ repoId: "r", filePath: "src/store-notifications.ts", language: "typescript", source });
  assert.deepEqual(out.edges.filter((e) => e.type === "SQL_QUERY").map((e) => [e.toId, e.reason]), [
    ["sqlconst:./store-sql-notifications.js#SELECT_RETURNS", "unresolved sql token: ts query imported const SELECT_RETURNS (line 3)"]
  ]);
});

test("TS → SQL: a same-file const at .query( says where its text is, 'via NAME (file:line)'", () => {
  const source = `export const INSERT_AUDIT = \`insert into audit_events (id) values ($1)\`
export async function recordAudit(client: any) {
  await client.query(INSERT_AUDIT, [1])
}
`;
  const out = extractGraphData({ repoId: "r", filePath: "src/db.ts", language: "typescript", source });
  const fn = out.symbols.find((s) => s.name === "recordAudit")!;
  const reasons = out.edges.filter((e) => e.type === "SQL_QUERY" && e.fromId === fn.symbolId).map((e) => e.reason);
  assert.ok(reasons.length > 0 && reasons.every((r) => /^unresolved sql token: ts query const INSERT_AUDIT via INSERT_AUDIT \(src\/db\.ts:1\) /.test(r ?? "")), JSON.stringify(reasons));
});
