import assert from "node:assert/strict";
import test from "node:test";

import type { EdgeRecord, SymbolRecord } from "../../types/index.js";
import { stableId } from "./extractorPrimitives.js";
import { extractSql } from "./sqlExtractor.js";
import { extractGraphData } from "./treeSitterExtractor.js";

const MODULE = stableId("r:db/001.sql:module");

function run(source: string): { symbols: SymbolRecord[]; edges: EdgeRecord[]; gaps: number } {
  const out = extractSql({ repoId: "r", filePath: "db/001.sql", language: "sql", source }, MODULE);
  return { symbols: out.symbols, edges: out.edges, gaps: out.stats.gaps };
}

function sym(symbols: SymbolRecord[], kind: string, name: string): SymbolRecord {
  const found = symbols.find((s) => s.kind === kind && s.name === name);
  assert.ok(found, `expected ${kind} ${name} in ${symbols.map((s) => `${s.kind}:${s.name}`).join(", ")}`);
  return found;
}

function edgesFrom(edges: EdgeRecord[], fromId: string): string[] {
  return edges.filter((e) => e.fromId === fromId).map((e) => `${e.type} ${e.toId}`).sort();
}

test("extractSql: CREATE TABLE gives a table, its columns (children, one line each) and FK edges", () => {
  const { symbols, edges } = run(
    [
      "create table public.documents (", // 1
      "  id text primary key,", // 2
      "  owner_id text references people (id)", // 3
      ");" // 4
    ].join("\n")
  );
  const table = sym(symbols, "sql_table", "documents");
  assert.equal(table.line, 1);
  assert.match(table.signature!, /^public\.documents — table \(2 columns\)/);
  const owner = sym(symbols, "sql_column", "owner_id");
  assert.equal(owner.line, 3);
  assert.equal(owner.parentSymbolId, table.symbolId);
  assert.match(owner.signature!, /^public\.documents\.owner_id — column text/);
  assert.deepEqual(edgesFrom(edges, owner.symbolId), ["SQL_REFERENCES sqlcolumn:people.id", "SQL_REFERENCES sqltable:people"]);
  // Every edge is an unresolved token until the post-phase — labelled, never a symbol id.
  for (const e of edges) {
    assert.match(e.toId, /^sql[a-z]+:/);
    assert.equal(e.confidence, 0.5);
    assert.match(e.reason!, /^unresolved sql token: /);
  }
});

test("extractSql: ALTER TABLE ADD COLUMN defines a column AT the alter site; the ALTER is a statement that touches the table", () => {
  const { symbols, edges } = run(
    [
      "alter table documents add column reviewer_id text references people(id);" // 1
    ].join("\n")
  );
  const alter = sym(symbols, "sql_statement", "alter table documents");
  assert.deepEqual(edgesFrom(edges, alter.symbolId), ["SQL_USES sqltable:documents"]);
  const col = sym(symbols, "sql_column", "reviewer_id");
  assert.match(col.signature!, /^documents\.reviewer_id — column/);
  assert.deepEqual(edgesFrom(edges, col.symbolId), ["SQL_REFERENCES sqlcolumn:people.id", "SQL_REFERENCES sqltable:people"]);
});

test("extractSql: GRANT names the role and the privileges, with edges to the object, its columns and the role", () => {
  const { symbols, edges } = run(
    [
      "grant select, insert on table public.audit_events to aria_turn, aria_ingest;", // 1
      "grant update (status, note) on documents to aria_review;", // 2
      "revoke all on function public.usage_in_period(integer, text) from public;", // 3
      "grant select on all tables in schema conversation_store to aria_store;" // 4
    ].join("\n")
  );
  const g1 = sym(symbols, "sql_statement", "grant select, insert on table public.audit_events to aria_turn, aria_ingest");
  assert.deepEqual(edgesFrom(edges, g1.symbolId), [
    "SQL_GRANT sqlrole:aria_ingest",
    "SQL_GRANT sqlrole:aria_turn",
    "SQL_GRANT sqltable:public.audit_events"
  ]);
  const onTable = edges.find((e) => e.fromId === g1.symbolId && e.toId === "sqltable:public.audit_events")!;
  assert.equal(onTable.reason, "unresolved sql token: grant select,insert to aria_turn, aria_ingest");
  const g2 = sym(symbols, "sql_statement", "grant update(status,note) on documents to aria_review");
  assert.ok(edgesFrom(edges, g2.symbolId).includes("SQL_GRANT sqlcolumn:documents.status"));
  const g3 = symbols.find((s) => s.name.startsWith("revoke all on function public.usage_in_period"))!;
  assert.deepEqual(edgesFrom(edges, g3.symbolId), ["SQL_GRANT sqlfunc:public.usage_in_period"]);
  const g4 = symbols.find((s) => s.name.startsWith("grant select on all tables in schema conversation_store"))!;
  const wide = edges.find((e) => e.fromId === g4.symbolId && e.toId === "sqlschema:conversation_store")!;
  assert.match(wide.reason!, /on all tables in schema/);
});

test("extractSql: CREATE INDEX, CREATE VIEW, CREATE FUNCTION (sql body parsed, plpgsql body tokenized)", () => {
  const { symbols, edges } = run(
    [
      "create index documents_owner on public.documents (owner_id);", // 1
      "create view open_documents as select d.id from documents d join people p on p.id = d.owner_id;", // 2
      "create function count_docs(p text) returns bigint language sql as $$ select count(*) from documents where owner_id = p $$;", // 3
      "create or replace function touch() returns trigger language plpgsql security definer as $$", // 4
      "begin insert into audit_log (doc) values (new.id); perform notify_change(new.id); return new; end $$;" // 5
    ].join("\n")
  );
  const idx = sym(symbols, "sql_index", "documents_owner");
  assert.deepEqual(edgesFrom(edges, idx.symbolId), ["SQL_USES sqlcolumn:public.documents.owner_id", "SQL_USES sqltable:public.documents"]);
  const view = sym(symbols, "sql_view", "open_documents");
  assert.deepEqual(edgesFrom(edges, view.symbolId), ["SQL_USES sqltable:documents", "SQL_USES sqltable:people"]);
  const count = sym(symbols, "sql_function", "count_docs");
  assert.deepEqual(edgesFrom(edges, count.symbolId), ["SQL_USES sqltable:documents"]);
  const touch = sym(symbols, "sql_function", "touch");
  assert.deepEqual(edgesFrom(edges, touch.symbolId), ["SQL_USES sqlfunc:notify_change", "SQL_USES sqltable:audit_log"]);
  assert.match(edges.find((e) => e.fromId === touch.symbolId && e.toId === "sqltable:audit_log")!.reason!, /plpgsql body, tokenized/);
});

test("extractSql: CREATE POLICY and CREATE TRIGGER (statements the AST parser rejects) are read by the token readers", () => {
  const { symbols, edges, gaps } = run(
    [
      "create policy docs_read on public.documents for select to aria_turn using (exists (select 1 from people p where p.id = owner_id));", // 1
      "create trigger documents_touch after insert on documents for each row execute function touch();" // 2
    ].join("\n")
  );
  assert.equal(gaps, 0);
  const policy = sym(symbols, "sql_policy", "docs_read");
  assert.match(policy.signature!, /^public\.documents\.docs_read — policy on public\.documents for select to aria_turn/);
  assert.deepEqual(edgesFrom(edges, policy.symbolId), ["SQL_GRANT sqlrole:aria_turn", "SQL_USES sqltable:people", "SQL_USES sqltable:public.documents"]);
  const trigger = sym(symbols, "sql_trigger", "documents_touch");
  assert.deepEqual(edgesFrom(edges, trigger.symbolId), ["SQL_USES sqlfunc:touch", "SQL_USES sqltable:documents"]);
});

test("extractSql: DDL inside a DO block is read ([do block]); its plpgsql control flow is not a gap", () => {
  const { symbols, gaps } = run(
    [
      "do $$ begin", // 1
      "  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'aria_turn') then", // 2
      "    create role aria_turn nologin;", // 3
      "  end if;", // 4
      "end $$;" // 5
    ].join("\n")
  );
  assert.equal(gaps, 0);
  const role = sym(symbols, "sql_role", "aria_turn");
  assert.equal(role.line, 3);
  assert.match(role.signature!, /\[do block\]/);
});

test("extractSql: a statement no reader recognises is a named gap at its line — counted, never a crash or a drop", () => {
  const { symbols, gaps } = run(["create table t (a int);", "create publication everything for all tables;", "select 1;"].join("\n"));
  assert.equal(gaps, 1);
  const gap = symbols.find((s) => s.kind === "sql_gap")!;
  assert.equal(gap.line, 2);
  assert.equal(gap.name, "gap: create publication everything for");
  assert.match(gap.signature!, /^not read: /);
  sym(symbols, "sql_table", "t");
});

test("extractSql: SET search_path qualifies the unqualified definitions that follow it", () => {
  const { symbols } = run(["set search_path to conversation_store, public;", "create table conversation_message (id text);"].join("\n"));
  assert.match(sym(symbols, "sql_table", "conversation_message").signature!, /^conversation_store\.conversation_message — /);
});

test("extractGraphData: .sql dispatches to the SQL lane with a module symbol and no edge policy", () => {
  const out = extractGraphData({ repoId: "r", filePath: "db/001.sql", language: "sql", source: "create table t (a int);", performanceProfile: "very-large" });
  assert.deepEqual(out.symbols.map((s) => s.kind).sort(), ["module", "sql_column", "sql_table"]);
});
