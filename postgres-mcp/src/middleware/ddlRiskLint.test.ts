/**
 * Tests for the DDL risk lint. Each code has a case that fires and a nearby case that must not.
 * A lint that fires on everything trains people to acknowledge without reading.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { validateDdlScript } from "./ddlGuardrails.js";
import { LARGE_TABLE_ROWS, lintDdl, type LintContext, type LintResult } from "./ddlRiskLint.js";

function lint(sql: string, context?: LintContext, noTransaction = false): LintResult {
  const validated = validateDdlScript(sql, { noTransaction, ownerRoles: ["aria", "big", "aria_review"], dataChanges: true, doBlocks: true });
  if (!validated.ok) {
    assert.fail(`guardrail refused: ${validated.error.code}: ${validated.error.message}`);
  }
  return lintDdl(validated.statements, context);
}

/** `code:level` for every finding, excluding the informational MISSING_IF_EXISTS noise. */
function codes(result: LintResult): string[] {
  return result.findings.filter((f) => f.code !== "MISSING_IF_EXISTS").map((f) => `${f.code}:${f.level}`);
}

const EXISTING: LintContext = { existingTables: new Set(["public.orders", "app.customers"]) };

// ── destructive ──────────────────────────────────────────────────────────────

test("DROP TABLE of an existing table is high; of one created in the same plan it is not", () => {
  assert.deepEqual(codes(lint("drop table if exists orders", EXISTING)), ["DROP_TABLE:high"]);
  assert.deepEqual(codes(lint("create table tmp (a int); drop table tmp", EXISTING)), []);
});

test("CASCADE is high, and on a schema it is blocked", () => {
  assert.deepEqual(codes(lint("drop view if exists v cascade")), ["DROP_CASCADE:high", "DROP_VIEW:warning"]);
  const schema = lint("drop schema if exists reporting cascade");
  assert.deepEqual(codes(schema), ["DROP_SCHEMA_CASCADE:blocked", "DROP_SCHEMA:high"]);
  assert.equal(schema.blocked.length, 1);
});

test("dropping a column is high; dropping a constraint or a default is not", () => {
  assert.deepEqual(codes(lint("alter table orders drop column note", EXISTING)), ["DROP_COLUMN:high"]);
  assert.deepEqual(codes(lint("alter table orders drop note", EXISTING)), ["DROP_COLUMN:high"]);
  assert.deepEqual(codes(lint("alter table orders drop constraint orders_note_check", EXISTING)), []);
  assert.deepEqual(codes(lint("alter table orders alter column note drop default", EXISTING)), []);
});

test("DROP without IF EXISTS is an info finding", () => {
  assert.deepEqual(
    lint("drop view v").findings.map((f) => f.code),
    ["MISSING_IF_EXISTS", "DROP_VIEW"]
  );
});

// ── rewrites and long locks ──────────────────────────────────────────────────

test("a column type change is high; a column that is merely called `type` is not a type change", () => {
  assert.deepEqual(codes(lint("alter table orders alter column total type numeric(12,2)", EXISTING)), ["ALTER_COLUMN_TYPE:high"]);
  assert.deepEqual(codes(lint("alter table orders alter total set data type bigint", EXISTING)), ["ALTER_COLUMN_TYPE:high"]);
  assert.deepEqual(codes(lint("alter table orders alter column type set not null", EXISTING)), ["SET_NOT_NULL:high"]);
});

test("a volatile DEFAULT on ADD COLUMN is high; a stable one is not", () => {
  assert.deepEqual(codes(lint("alter table orders add column token uuid default gen_random_uuid()", EXISTING)), ["ADD_COLUMN_VOLATILE_DEFAULT:high"]);
  assert.deepEqual(codes(lint("alter table orders add column created timestamptz default now()", EXISTING)), []);
});

test("ADD COLUMN NOT NULL without DEFAULT warns on an existing table only", () => {
  assert.deepEqual(codes(lint("alter table orders add column c int not null", EXISTING)), ["ADD_COLUMN_NOT_NULL_NO_DEFAULT:warning"]);
  assert.deepEqual(codes(lint("alter table orders add column c int not null default 0", EXISTING)), []);
  assert.deepEqual(codes(lint("create table fresh (a int); alter table fresh add column c int not null", EXISTING)), []);
});

test("a STORED generated column is high", () => {
  assert.deepEqual(
    codes(lint("alter table orders add column t2 numeric generated always as (total * 2) stored", EXISTING)),
    ["ADD_COLUMN_STORED_GENERATED:high"]
  );
});

test("renames are high, except a constraint rename", () => {
  assert.deepEqual(codes(lint("alter table orders rename to purchase_orders", EXISTING)), ["RENAME_TABLE:high"]);
  assert.deepEqual(codes(lint("alter table orders rename column note to memo", EXISTING)), ["RENAME_COLUMN:high"]);
  assert.deepEqual(codes(lint("alter table orders rename constraint a to b", EXISTING)), []);
});

test("SET LOGGED/UNLOGGED and tablespace moves are high", () => {
  assert.deepEqual(codes(lint("alter table orders set unlogged", EXISTING)), ["SET_LOGGED_UNLOGGED:high"]);
  assert.deepEqual(codes(lint("alter table orders set tablespace fast", EXISTING)), ["SET_TABLESPACE:high"]);
  assert.deepEqual(codes(lint("alter table all in tablespace a set tablespace b")), ["SET_TABLESPACE:high"]);
});

test("a non-concurrent index build warns, and is high on a large table", () => {
  assert.deepEqual(codes(lint("create index on orders (note)", EXISTING)), ["CREATE_INDEX_NON_CONCURRENT:warning"]);
  const large: LintContext = { ...EXISTING, rowEstimate: (t) => (t === "public.orders" ? LARGE_TABLE_ROWS * 2 : undefined) };
  assert.deepEqual(codes(lint("create index i on only orders (note)", large)), ["CREATE_INDEX_NON_CONCURRENT:high"]);
  assert.deepEqual(codes(lint("create index concurrently i on orders (note)", large, true)), []);
  assert.deepEqual(codes(lint("create table fresh (a int); create index on fresh (a)", large)), []);
});

test("a validating constraint warns; NOT VALID does not", () => {
  assert.deepEqual(
    codes(lint("alter table orders add constraint fk foreign key (cid) references app.customers (id)", EXISTING)),
    ["ADD_CONSTRAINT_VALIDATING:warning"]
  );
  assert.deepEqual(
    codes(lint("alter table orders add constraint fk foreign key (cid) references app.customers (id) not valid", EXISTING)),
    []
  );
  assert.deepEqual(codes(lint("alter table orders add constraint pos check (total >= 0)", EXISTING)), ["ADD_CONSTRAINT_VALIDATING:warning"]);
});

test("DETACH PARTITION without CONCURRENTLY warns", () => {
  assert.deepEqual(codes(lint("alter table p detach partition p_2025")), ["DETACH_PARTITION_BLOCKING:warning"]);
  assert.deepEqual(codes(lint("alter table p detach partition p_2025 concurrently", undefined, true)), []);
});

// ── privilege and ownership ──────────────────────────────────────────────────

test("SECURITY DEFINER and CREATE EXTENSION are high", () => {
  assert.deepEqual(
    codes(lint("create function f() returns int language sql security definer as $$ select 1 $$")),
    ["SECURITY_DEFINER:high"]
  );
  assert.deepEqual(codes(lint("alter function f() security definer")), ["SECURITY_DEFINER:high"]);
  assert.deepEqual(codes(lint("create extension if not exists pg_trgm")), ["CREATE_EXTENSION:high"]);
});

test("GRANT, REVOKE, POLICY and turning row-level security off are PRIVILEGE_CHANGE", () => {
  for (const sql of [
    "grant execute on function f(int) to aria_review",
    "revoke all on function f(int) from public",
    "create policy p on orders for select using (true)",
    "alter policy p on orders to reporting",
    "drop policy if exists p on orders",
    "alter table orders disable row level security",
    "alter table orders no force row level security"
  ]) {
    assert.deepEqual(codes(lint(sql)), ["PRIVILEGE_CHANGE:high"], sql);
  }
  // Turning it ON narrows access; that needs no acknowledgement.
  assert.deepEqual(codes(lint("alter table orders enable row level security")), []);
  assert.deepEqual(codes(lint("alter table orders force row level security")), []);
});

const ROLES: LintContext = {
  ownerRoles: new Map([
    ["aria", { superuser: false, createRole: false, bypassRls: false, replication: false }],
    ["big", { superuser: false, createRole: true, bypassRls: true, replication: false }]
  ])
};

test("OWNER TO is PRIVILEGE_CHANGE, and blocked for a role that is missing or reaches past grants", () => {
  assert.deepEqual(codes(lint("alter function f(int) owner to aria", ROLES)), ["PRIVILEGE_CHANGE:high"]);
  const big = lint("alter function f(int) owner to big", ROLES);
  assert.deepEqual(codes(big), ["PRIVILEGE_CHANGE:high", "OWNER_ROLE_PRIVILEGED:blocked"]);
  assert.match(big.blocked[0]?.message ?? "", /CREATEROLE, BYPASSRLS/);
  // Allowlisted, but not created in this database.
  assert.deepEqual(codes(lint("alter function f(int) owner to aria", { ownerRoles: new Map() })), ["PRIVILEGE_CHANGE:high", "OWNER_ROLE_UNKNOWN:blocked"]);
  // No database (ddl_create): the role cannot be checked, so only the acknowledgement remains.
  assert.deepEqual(codes(lint("alter function f(int) owner to big")), ["PRIVILEGE_CHANGE:high"]);
});

test("AUTHORIZATION gets the same role checks as OWNER TO", () => {
  assert.deepEqual(codes(lint("create schema review_jobs authorization aria", ROLES)), ["PRIVILEGE_CHANGE:high"]);
  assert.deepEqual(codes(lint("create schema review_jobs authorization big", ROLES)), ["PRIVILEGE_CHANGE:high", "OWNER_ROLE_PRIVILEGED:blocked"]);
  assert.deepEqual(codes(lint("create schema review_jobs authorization aria", { ownerRoles: new Map() })), ["PRIVILEGE_CHANGE:high", "OWNER_ROLE_UNKNOWN:blocked"]);
  assert.deepEqual(codes(lint("create schema review_jobs", ROLES)), []);
});

test("a role the acting role cannot SET ROLE to is blocked, naming both", () => {
  const acting: LintContext = { ...ROLES, actingRole: { name: "aria", canBecome: new Set(["aria"]) } };
  assert.deepEqual(codes(lint("alter table t owner to aria", acting)), ["PRIVILEGE_CHANGE:high"]);
  const notMember = lint("create schema review_jobs authorization aria_review", {
    ownerRoles: new Map([["aria_review", { superuser: false, createRole: false, bypassRls: false, replication: false }]]),
    actingRole: { name: "aria", canBecome: new Set(["aria"]) }
  });
  assert.deepEqual(codes(notMember), ["PRIVILEGE_CHANGE:high", "OWNER_ROLE_NOT_MEMBER:blocked"]);
  assert.match(notMember.blocked[0]?.message ?? "", /runs as aria, which cannot SET ROLE aria_review/);
});

test("data changes are DATA_CHANGE, and an UPDATE / DELETE with no WHERE says so", () => {
  const insert = lint("insert into t select id from s");
  assert.deepEqual(codes(insert), ["DATA_CHANGE:high"]);
  assert.doesNotMatch(insert.findings[0]?.message ?? "", /every row/);
  assert.match(lint("update t set a = 1").findings[0]?.message ?? "", /no WHERE: every row/);
  assert.doesNotMatch(lint("update t set a = (select 1 where true) where id = 1").findings[0]?.message ?? "", /every row/);
  assert.match(lint("delete from t").findings[0]?.message ?? "", /every row/);
  assert.deepEqual(lint("insert into t values (1); update t set a = 2 where a = 1").requiredAcknowledgements, ["DATA_CHANGE"]);
});

test("a DO block is DO_BLOCK", () => {
  assert.deepEqual(codes(lint("do $$ begin insert into t select 1; end $$")), ["DO_BLOCK:high"]);
});

test("ALTER TYPE … ADD VALUE is informational", () => {
  assert.deepEqual(codes(lint("alter type mood add value 'happy'")), ["ALTER_TYPE_ADD_VALUE:info"]);
});

// ── context and aggregation ──────────────────────────────────────────────────

test("a table outside existingTables gets no table-scoped finding", () => {
  assert.deepEqual(codes(lint("alter table unknown_t drop column a", EXISTING)), []);
  // No context at all: everything counts as existing.
  assert.deepEqual(codes(lint("alter table unknown_t drop column a")), ["DROP_COLUMN:high"]);
});

test("names resolve through defaultSchema, and quoted names keep their case", () => {
  const ctx: LintContext = { existingTables: new Set(["app.Orders"]), defaultSchema: "app" };
  assert.deepEqual(codes(lint('alter table "Orders" drop column a', ctx)), ["DROP_COLUMN:high"]);
  assert.deepEqual(codes(lint("alter table orders drop column a", ctx)), []);
});

test("requiredAcknowledgements lists each high code once, in first-seen order", () => {
  const result = lint(
    "alter table orders drop column a; alter table orders drop column b; drop table if exists orders; create extension if not exists x",
    EXISTING
  );
  assert.deepEqual(result.requiredAcknowledgements, ["DROP_COLUMN", "DROP_TABLE", "CREATE_EXTENSION"]);
  assert.deepEqual(result.findings.filter((f) => f.code === "DROP_COLUMN").map((f) => f.statementIndex), [0, 1]);
});
