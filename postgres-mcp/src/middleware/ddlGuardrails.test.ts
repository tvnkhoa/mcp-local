/**
 * Tests for the DDL guardrail: tokenizer, statement splitter, allowlist, reserved schema,
 * transaction mode and directives.
 *
 * The splitter cases matter most. A statement boundary seen here but missed by Postgres is a
 * syntax error; one missed here but seen by Postgres is a statement the allowlist never
 * classified. Each case below is one of the ways the two lexers could disagree.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { hasMultipleStatements } from "./sqlGuardrails.js";
import { MAX_DDL_SCRIPT_BYTES, MAX_DDL_STATEMENTS, validateDdlScript, type ValidatedDdl, type ValidateOptions } from "./ddlGuardrails.js";

function accept(sql: string, options?: ValidateOptions): ValidatedDdl {
  const result = validateDdlScript(sql, options);
  if (!result.ok) {
    assert.fail(`expected acceptance, got ${result.error.code}: ${result.error.message}\n  sql: ${sql}`);
  }
  return result;
}

function refuse(sql: string, code: string, options?: ValidateOptions): string {
  const result = validateDdlScript(sql, options);
  assert.equal(result.ok, false, `expected ${code}, got acceptance\n  sql: ${sql}`);
  if (!result.ok) {
    assert.equal(result.error.code, code, `sql: ${sql}\n  message: ${result.error.message}`);
    return result.error.message;
  }
  return "";
}

// ── splitting ────────────────────────────────────────────────────────────────

test("a semicolon inside a dollar-quoted body does not split the statement", () => {
  const { statements } = accept(`
    create function bump() returns trigger language plpgsql as $body$
    begin new.updated_at := now(); return new; end
    $body$;
    create trigger t_bump before update on t for each row execute function bump();
  `);
  assert.deepEqual(statements.map((s) => `${s.verb} ${s.kind}`), ["create function", "create trigger"]);
});

test("semicolons in escape strings, standard strings and comments do not split", () => {
  const { statements } = accept(
    "comment on table t is E'it\\'s; fine'; comment on column t.a is 'a;b''c'; -- ; not here\ncreate table u (a int) /* ; nor here */"
  );
  assert.equal(statements.length, 3);
});

test("block comments nest, as they do in Postgres", () => {
  const { statements } = accept("/* outer /* inner */ ; drop table x; */ create table t (a int)");
  assert.deepEqual(statements.map((s) => s.kind), ["table"]);
  assert.equal(statements[0]?.verb, "create");
});

test("`$x$` that continues an identifier does not open a dollar quote", () => {
  // Postgres reads foo$x$ as one identifier, so it runs BOTH statements. A scanner that opened a
  // dollar quote at `$x$` would blank everything up to the `$x$` in the comment and see one.
  const sql = "create table foo$x$ (a int); drop table y; -- $x$";
  assert.equal(hasMultipleStatements(sql), false, "the shared scanner is expected to miss this — that is why this lane does not use it");
  const { statements } = accept(sql);
  assert.deepEqual(statements.map((s) => `${s.verb} ${s.kind}`), ["create table", "drop table"]);
});

test("statement text is the original, and empty statements are skipped", () => {
  const sql = ";; create table \"Mixed\" (a int) ;\n\n ; alter table \"Mixed\" add column b int;";
  const { statements } = accept(sql);
  assert.deepEqual(statements.map((s) => s.text), ['create table "Mixed" (a int)', 'alter table "Mixed" add column b int']);
});

test("anything left open is refused", () => {
  refuse("create table t (a text default 'oops)", "DDL_UNTERMINATED_SQL");
  refuse('create table "t (a int)', "DDL_UNTERMINATED_SQL");
  refuse("create table t (a int) /* never closed", "DDL_UNTERMINATED_SQL");
  refuse("create table t (a int) /* /* one level closed */", "DDL_UNTERMINATED_SQL");
  refuse("create function f() returns int language sql as $$ select 1", "DDL_UNTERMINATED_SQL");
});

test("syntax the tokenizer cannot follow is refused rather than guessed", () => {
  refuse("create function f() returns int language sql begin atomic select 1; end", "DDL_UNSUPPORTED_SYNTAX");
  refuse('create table U&"mcp\\005fops".t (a int)', "DDL_UNSUPPORTED_SYNTAX");
});

test("size limits", () => {
  refuse(`create table t (a int); -- ${"x".repeat(MAX_DDL_SCRIPT_BYTES)}`, "DDL_TOO_LARGE");
  const many = Array.from({ length: MAX_DDL_STATEMENTS + 1 }, (_, i) => `create table t${String(i)} (a int);`).join("\n");
  refuse(many, "DDL_TOO_MANY_STATEMENTS");
  refuse("  -- only a comment\n", "DDL_EMPTY");
});

// ── the allowlist ────────────────────────────────────────────────────────────

test("the allowed DDL forms are accepted", () => {
  for (const sql of [
    "create table if not exists app.orders (id bigint generated always as identity primary key, note text)",
    "create unlogged table scratch (a int)",
    "create table p_2026 partition of p for values from ('2026-01-01') to ('2027-01-01')",
    "create unique index if not exists orders_note on app.orders (note)",
    "create or replace view v as select id from app.orders",
    "create or replace recursive view r (n) as select 1",
    "create materialized view mv as select count(*) from app.orders",
    "create sequence s start 10",
    "create type mood as enum ('sad', 'ok')",
    "create domain posint as int check (value > 0)",
    "create schema if not exists reporting",
    'create schema "Reporting"',
    "create or replace function f(a int) returns int language sql immutable as $$ select a + 1 $$",
    "create function g() returns int language 'plpgsql' as $$ begin return 1; end $$",
    "create function h() returns int return 1",
    "create procedure p() language plpgsql as $$ begin null; end $$",
    "create constraint trigger ct after insert on t deferrable for each row execute function f()",
    "create extension if not exists pg_trgm",
    "alter table app.orders add column c int, alter column note set not null",
    "alter table t set schema reporting",
    "alter index i rename to j",
    "alter sequence s restart with 1",
    "alter type mood add value 'happy'",
    "alter function f(int) set search_path = public",
    "drop table if exists old_thing",
    "drop materialized view if exists mv",
    "drop index concurrently if exists i",
    "comment on column app.orders.note is 'free text'"
  ]) {
    accept(sql, /concurrently/.test(sql) ? { noTransaction: true } : undefined);
  }
});

test("statements outside the allowlist are refused with the reason", () => {
  const cases: Array<[string, RegExp]> = [
    ["insert into t values (1)", /write_preview/],
    ["with x as (select 1) delete from t", /write_preview/],
    ["update t set a = 1 where id = 1", /write_preview/],
    ["copy t from '/tmp/x'", /write_preview/],
    ["do $$ begin execute 'drop table t'; end $$", /IF \[NOT\] EXISTS/],
    ["call p()", /cannot see into/],
    ["grant some_role to bob", /role membership/],
    ["grant select on t to bob with grant option", /WITH GRANT OPTION/],
    ["set search_path = evil", /directives/],
    ["begin", /transaction control/],
    ["vacuum t", /maintenance/],
    ["create role r", /Role management/],
    ["alter default privileges grant select on tables to r", /DEFAULT PRIVILEGES/],
    ["drop extension pg_trgm", /extension/],
    ["alter extension pg_trgm update", /extension/],
    ["create rule r as on insert to t do instead nothing", /not allowed/],
    ["create database d", /not allowed/],
    ["drop owned by r", /not allowed/],
    ["create temp table t (a int)", /temporary/],
    ["create table t2 as select * from t", /writes data/],
    ["create schema s authorization bob", /AUTHORIZATION/],
    ["create schema s create table t (a int) grant select on t to public", /schema elements/],
    ["create function f() returns int language c as 'lib', 'f'", /LANGUAGE c/],
    ["alter table t owner to someone", /OWNER TO/],
    ["alter function f() owner to someone", /OWNER TO/]
  ];
  for (const [sql, reason] of cases) {
    const message = refuse(sql, "DDL_STATEMENT_NOT_ALLOWED");
    assert.match(message, reason, sql);
  }
});

test("one bad statement refuses the whole migration, naming it", () => {
  const message = refuse("create table a (x int); grant some_role to public; create table b (y int)", "DDL_STATEMENT_NOT_ALLOWED");
  assert.match(message, /^Statement 2:/);
});

// ── reserved schema ──────────────────────────────────────────────────────────

test("the server's own schema is refused anywhere it is named", () => {
  for (const sql of [
    "create table mcp_ops.x (a int)",
    'create table "mcp_ops"."x" (a int)',
    "alter table t set schema mcp_ops",
    "create view v as select * from MCP_OPS.audit_log",
    "comment on table mcp_ops.audit_log is 'x'",
    "drop schema mcp_ops",
    "create trigger t after insert on mcp_ops.ddl_history for each row execute function f()"
  ]) {
    refuse(sql, "DDL_RESERVED_SCHEMA");
  }
  // In a string it is text, not a name.
  accept("comment on table t is 'moved from mcp_ops'");
  // Inside a routine body it is text as well — what the body does at run time is the write
  // lane's execution-time check to catch.
  accept("create function f() returns int language sql as $$ select count(*)::int from mcp_ops.audit_log $$");
});

// ── transaction mode ─────────────────────────────────────────────────────────

test("CONCURRENTLY needs a no-transaction migration of exactly one statement", () => {
  refuse("create index concurrently i on t (a)", "DDL_NEEDS_NO_TRANSACTION");
  refuse("alter table p detach partition p_2026 concurrently", "DDL_NEEDS_NO_TRANSACTION");

  const viaDirective = accept("-- mcp:no-transaction\ncreate index concurrently i on t (a)");
  assert.equal(viaDirective.mode, "non_transactional");
  assert.equal(viaDirective.statements[0]?.needsNoTransaction, true);
  assert.equal(accept("drop index concurrently i", { noTransaction: true }).mode, "non_transactional");

  refuse("-- mcp:no-transaction\ncreate index concurrently i on t (a); create table x (a int)", "DDL_NO_TRANSACTION_MULTI_STATEMENT");
});

test("a column named `concurrently` inside parentheses does not need no-transaction", () => {
  assert.equal(accept('create index i on t ("concurrently", concurrently)').mode, "transactional");
});

test("no-transaction without a statement that needs it is allowed, with a warning", () => {
  const result = accept("-- mcp:no-transaction\ncreate table t (a int)");
  assert.equal(result.mode, "non_transactional");
  assert.equal(result.warnings.length, 1);
});

// ── directives ───────────────────────────────────────────────────────────────

test("directives are read from the header", () => {
  const { directives } = accept("-- a note\n-- mcp:lock-timeout-ms=500\n-- mcp:statement-timeout-ms=60000\ncreate table t (a int)");
  assert.deepEqual(directives, { noTransaction: false, lockTimeoutMs: 500, statementTimeoutMs: 60000 });
});

test("a directive that is unknown, malformed or misplaced is an error, not a no-op", () => {
  refuse("-- mcp:no-transacton\ncreate index concurrently i on t (a)", "DDL_UNKNOWN_DIRECTIVE");
  refuse("-- mcp:lock-timeout-ms=0\ncreate table t (a int)", "DDL_INVALID_DIRECTIVE");
  refuse("-- mcp:lock-timeout-ms=soon\ncreate table t (a int)", "DDL_UNKNOWN_DIRECTIVE");
  refuse("create table t (a int);\n-- mcp:no-transaction\n", "DDL_MISPLACED_DIRECTIVE");
  // Text that merely looks like a directive inside a body is part of the body.
  accept("create function f() returns int language plpgsql as $$\n-- mcp:no-transaction\nbegin return 1; end $$");
});

// ── privileges and ownership ─────────────────────────────────────────────────

test("GRANT / REVOKE on a named object is accepted, to or from roles and PUBLIC", () => {
  const { statements } = accept(
    [
      "grant select, insert on table app.orders to app_rw",
      "grant select (id, total) on app.orders to reporting",
      "revoke all on function public.f(timestamptz, timestamptz) from public",
      "grant execute on function public.f(timestamptz, timestamptz) to aria_review",
      "grant usage on schema app to app_rw, reporting",
      "grant usage, select on sequence app.orders_id_seq to app_rw",
      "revoke grant option for select on app.orders from reporting cascade"
    ].join(";\n")
  );
  assert.deepEqual([...new Set(statements.map((s) => s.kind))], ["privilege"]);
  assert.deepEqual(statements.map((s) => s.verb), ["grant", "grant", "revoke", "grant", "grant", "grant", "revoke"]);
});

test("GRANT / REVOKE shapes outside the lane are refused, each with its reason", () => {
  const cases: Array<[string, RegExp]> = [
    ["grant app_rw to bob", /role membership/],
    ["revoke app_rw from bob", /role membership/],
    ["grant select on all tables in schema app to bob", /ALL … IN SCHEMA/],
    ["grant connect on database d to bob", /DATABASE/],
    ["grant set on parameter work_mem to bob", /PARAMETER/],
    ["grant usage on language plpgsql to bob", /LANGUAGE/],
    ["grant usage on foreign data wrapper w to bob", /FOREIGN/],
    ["grant select on t to bob with grant option", /WITH GRANT OPTION/],
    ["grant select on t to bob granted by alice", /GRANTED BY/],
    ["grant select on t to current_user", /CURRENT_USER/],
    ["revoke select on t from session_user", /SESSION_USER/]
  ];
  for (const [sql, reason] of cases) {
    assert.match(refuse(sql, "DDL_STATEMENT_NOT_ALLOWED"), reason, sql);
  }
  refuse("grant select on mcp_ops.ddl_history to bob", "DDL_RESERVED_SCHEMA");
});

test("CREATE / ALTER / DROP POLICY are accepted", () => {
  const { statements } = accept(
    "create policy p on app.orders for select to reporting using (tenant_id = 1); alter policy p on app.orders to reporting, auditor; drop policy if exists p on app.orders"
  );
  assert.deepEqual(statements.map((s) => `${s.verb} ${s.kind}`), ["create policy", "alter policy", "drop policy"]);
});

test("OWNER TO is accepted only as the sole action, and only to an allowlisted role", () => {
  const roles = { ownerRoles: ["aria"] };
  for (const sql of [
    "alter function public.f(timestamptz, timestamptz) owner to aria",
    "alter table public.t owner to aria",
    'alter table only "public"."T" owner to "aria"',
    "alter materialized view mv owner to aria",
    "alter schema s owner to aria"
  ]) {
    accept(sql, roles);
  }
  const cases: Array<[string, RegExp, ValidateOptions]> = [
    ["alter table t owner to aria", /no owner role is allowlisted/, {}],
    ["alter table t owner to postgres", /not in POSTGRES_DDL_OWNER_ROLES \(aria\)/, roles],
    ['alter table t owner to "Aria"', /not in POSTGRES_DDL_OWNER_ROLES/, roles],
    ["alter table t owner to current_user", /CURRENT_USER/, roles],
    ["alter table t add column x int, owner to aria", /only action/, roles],
    ["alter table t owner to aria, add column x int", /only action/, roles],
    ["alter index i owner to aria", /accepted only on ALTER/, roles],
    ["alter trigger tr on t owner to aria", /accepted only on ALTER/, roles]
  ];
  for (const [sql, reason, options] of cases) {
    assert.match(refuse(sql, "DDL_STATEMENT_NOT_ALLOWED", options), reason, sql);
  }
});

// ── psql mode ────────────────────────────────────────────────────────────────

/** The shape of wec.aria's 0017: \set, a BEGIN/COMMIT wrapper, a SECURITY DEFINER body with SET search_path, OWNER TO, REVOKE, GRANT. */
const PSQL_FILE = `-- 0017 — header comment
-- with a second line

\\set ON_ERROR_STOP on

begin;

alter table public.review_run add column if not exists turns_in_window integer;

create or replace function public.turns_recorded_in_window(p_from timestamptz, p_to timestamptz)
  returns integer
  language sql
  stable
  security definer
  set search_path = pg_catalog, public
as $$
  select count(*)::integer from usage_events u where u.created_at >= p_from and u.created_at <= p_to;
$$;

alter function public.turns_recorded_in_window(timestamptz, timestamptz) owner to aria;

comment on function public.turns_recorded_in_window(timestamptz, timestamptz) is 'it''s one integer; nothing else';

revoke all on function public.turns_recorded_in_window(timestamptz, timestamptz) from public;
grant execute on function public.turns_recorded_in_window(timestamptz, timestamptz) to aria_review;

commit;
`;

test("psql mode: \\set ON_ERROR_STOP and the file's own BEGIN / COMMIT are dropped, the rest runs", () => {
  const result = accept(PSQL_FILE, { psql: true, ownerRoles: ["aria"] });
  assert.equal(result.mode, "transactional");
  assert.deepEqual(
    result.statements.map((s) => `${s.verb} ${s.kind}`),
    ["alter table", "create function", "alter function", "comment comment", "revoke privilege", "grant privilege"]
  );
  // Statement numbers still count from the top of the file, BEGIN included.
  assert.deepEqual(result.statements.map((s) => s.index), [1, 2, 3, 4, 5, 6]);
  assert.ok(result.statements.every((s) => !/\\set|^begin|^commit/i.test(s.text)));
  // SET search_path inside CREATE FUNCTION is part of the definition, not a session SET.
  assert.match(result.statements[1]?.text ?? "", /set search_path = pg_catalog, public/);
});

test("outside psql mode the same file is refused at the backslash", () => {
  refuse(PSQL_FILE, "DDL_STATEMENT_NOT_ALLOWED", { ownerRoles: ["aria"] });
});

test("psql mode refuses every other meta-command, and one inside a statement", () => {
  for (const meta of ["\\i other.sql", "\\c otherdb", "\\gexec", "\\set ON_ERROR_STOP off", "\\set AUTOCOMMIT on", "\\! rm -rf /"]) {
    refuse(`${meta}\ncreate table t (a int);`, "DDL_PSQL_META_COMMAND", { psql: true });
  }
  refuse("create table t (a int)\n\\set ON_ERROR_STOP on\n;", "DDL_PSQL_META_COMMAND", { psql: true });
  // A meta-command after a statement on the same line runs between statements in psql; after a
  // complete statement that is harmless, so only the text of the command decides.
  refuse("create table t (a int); \\gexec", "DDL_PSQL_META_COMMAND", { psql: true });
  // A backslash inside a literal or a body is data, not a meta-command.
  accept("comment on table t is 'a \\i b';\ncreate function f() returns text language sql as $$ select '\\c' $$;", { psql: true });
});

test("psql mode: BEGIN / COMMIT are dropped only as an exact wrapper", () => {
  accept("begin;\ncreate table t (a int);\ncommit;", { psql: true });
  accept("start transaction;\ncreate table t (a int);\nend;", { psql: true });
  accept("create table t (a int);", { psql: true });
  // Anything else is transaction control the server owns.
  refuse("begin;\ncreate table t (a int);", "DDL_STATEMENT_NOT_ALLOWED", { psql: true });
  refuse("create table t (a int);\ncommit;", "DDL_STATEMENT_NOT_ALLOWED", { psql: true });
  refuse("begin isolation level serializable;\ncreate table t (a int);\ncommit;", "DDL_STATEMENT_NOT_ALLOWED", { psql: true });
  refuse("begin;\ncreate table t (a int);\ncommit;\nbegin;\ncreate table u (a int);\ncommit;", "DDL_STATEMENT_NOT_ALLOWED", { psql: true });
  refuse("begin;\ncreate table t (a int);\ncommit and chain;", "DDL_STATEMENT_NOT_ALLOWED", { psql: true });
  refuse("begin;\ncommit;", "DDL_EMPTY", { psql: true });
  refuse("-- mcp:no-transaction\nbegin;\ncreate index concurrently i on t (a);\ncommit;", "DDL_INVALID_DIRECTIVE", { psql: true });
});
