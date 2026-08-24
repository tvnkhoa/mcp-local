/**
 * Tests for the write-statement parser.
 *
 * These three parsed facts decide whether `write_preview` offers rollback at all
 * (`writeHandlers.ts`), and getting one wrong costs data: a missed
 * `ON CONFLICT DO UPDATE` made rollback delete a pre-existing row (PG-WRT-002), and a
 * missed PK assignment made rollback a silent no-op that still reported success
 * (PG-WRT-003).
 *
 * The parser works on the literal-and-comment-blanked text from `@mcp/shared`'s
 * scanner, which is length-preserving, and slices identifiers out of the ORIGINAL at
 * those indices. Both halves of that arrangement are pinned below: keywords hidden
 * inside string values must not match, and quoted identifiers must survive.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { validateWriteSql } from "./writeGuardrails.js";

/** The parse half of the result, for a statement expected to be valid. */
function parse(sql: string, allowFullTable = false) {
  const result = validateWriteSql(sql, allowFullTable);
  assert.equal(result.ok, true, `expected ${sql} to validate`);
  if (!result.ok) {
    throw new Error("unreachable");
  }
  return result;
}

// ── ON CONFLICT: DO UPDATE is the dangerous one, DO NOTHING is safe ───────────

test("hasOnConflictUpdate is true only for DO UPDATE", () => {
  const cases: Array<[string, boolean]> = [
    ["insert into t (id) values (1)", false],
    ["insert into t (id) values (1) on conflict do nothing", false],
    ["insert into t (id) values (1) on conflict (id) do nothing", false],
    ["insert into t (id) values (1) on conflict (id) do update set n = excluded.n", true],
    ["insert into t (id) values (1) on conflict on constraint t_pkey do update set n = 1", true],
    // A partial-index conflict target carries its own WHERE before the action.
    ["insert into t (id) values (1) on conflict (id) where id > 0 do update set n = 1", true],
    ["INSERT INTO t (id) VALUES (1) ON CONFLICT (id) DO UPDATE SET n = 1", true],
    // Line break between the words.
    ["insert into t (id) values (1)\n  on conflict (id)\n  do update set n = 1", true]
  ];
  for (const [sql, expected] of cases) {
    assert.equal(parse(sql).hasOnConflictUpdate, expected, sql);
  }
});

test("a conflict action hidden in a string value or comment does not count", () => {
  assert.equal(parse("insert into t (note) values ('on conflict do update')").hasOnConflictUpdate, false);
  assert.equal(parse("insert into t (note) values ('x') -- on conflict do update").hasOnConflictUpdate, false);
  assert.equal(parse("insert into t (note) values ($$on conflict do update$$)").hasOnConflictUpdate, false);
  // Real DO NOTHING, with the word "update" only inside a value.
  assert.equal(
    parse("insert into t (note) values ('do update') on conflict do nothing").hasOnConflictUpdate,
    false
  );
});

test("hasOnConflictUpdate is false for non-INSERT statements", () => {
  assert.equal(parse("update t set n = 1 where id = 1").hasOnConflictUpdate, false);
  assert.equal(parse("delete from t where id = 1").hasOnConflictUpdate, false);
});

// ── RETURNING: we must own that clause to capture undo data ───────────────────

test("hasReturning sees a real RETURNING and ignores one in a literal", () => {
  assert.equal(parse("delete from t where id = 1").hasReturning, false);
  assert.equal(parse("delete from t where id = 1 returning id").hasReturning, true);
  assert.equal(parse("update t set n = 1 where id = 1 RETURNING *").hasReturning, true);
  assert.equal(parse("update t set n = 'returning' where id = 1").hasReturning, false);
  assert.equal(parse("update t set n = 1 where id = 1 /* returning * */").hasReturning, false);
});

// ── SET columns ──────────────────────────────────────────────────────────────

test("setColumns lists the assigned columns", () => {
  assert.deepEqual(parse("update t set a = 1 where id = 1").setColumns, ["a"]);
  assert.deepEqual(parse("update t set a = 1, b = 2 where id = 1").setColumns, ["a", "b"]);
  assert.deepEqual(parse("update t set a=1,b=2 where id=1").setColumns, ["a", "b"]);
});

test("setColumns folds unquoted names and preserves quoted ones, matching Postgres", () => {
  // Unquoted identifiers fold to lower case, so they compare against pg_attribute.attname.
  assert.deepEqual(parse("update t set ID = 1 where id = 1").setColumns, ["id"]);
  assert.deepEqual(parse('update t set "Id" = 1 where id = 1').setColumns, ["Id"]);
  assert.deepEqual(parse('update t set "Odd ""Name""" = 1 where id = 1').setColumns, ['Odd "Name"']);
});

test("setColumns is not confused by commas, equals signs or clause keywords inside values", () => {
  assert.deepEqual(parse("update t set note = 'a, b' where id = 1").setColumns, ["note"]);
  assert.deepEqual(parse("update t set note = 'x=y' where id = 1").setColumns, ["note"]);
  assert.deepEqual(
    parse("update t set note = 'see report from sales where ready' where id = 1").setColumns,
    ["note"]
  );
  assert.deepEqual(parse("update t set note = 'a', flag = true where id = 1").setColumns, ["note", "flag"]);
});

test("setColumns stops at the real end of the SET list, not one nested in a subquery", () => {
  // The `from` and `where` inside the subquery are at depth > 0 and must not end the list.
  assert.deepEqual(
    parse("update t set a = (select max(x) from other where other.id = t.id), b = 2 where t.id = 1").setColumns,
    ["a", "b"]
  );
  // A joined UPDATE's own FROM does end it.
  assert.deepEqual(parse("update t set a = o.a from other o where o.id = t.id").setColumns, ["a"]);
  // So does RETURNING, with no WHERE in between.
  assert.deepEqual(parse("update t set a = 1 where id = 1 returning a").setColumns, ["a"]);
});

test("setColumns understands the multi-column assignment form", () => {
  assert.deepEqual(parse("update t set (a, b) = (1, 2) where id = 1").setColumns, ["a", "b"]);
  assert.deepEqual(
    parse("update t set (a, b) = (select x, y from other where id = 1) where id = 1").setColumns,
    ["a", "b"]
  );
  assert.deepEqual(parse("update t set (a, b) = (1, 2), c = 3 where id = 1").setColumns, ["a", "b", "c"]);
});

test("setColumns is empty for INSERT and DELETE", () => {
  assert.deepEqual(parse("insert into t (a) values (1)").setColumns, []);
  assert.deepEqual(parse("delete from t where id = 1").setColumns, []);
  // `set` appearing only inside an inserted value must not produce columns.
  assert.deepEqual(parse("insert into t (note) values ('set a = 1')").setColumns, []);
});

// ── the pre-existing contract still holds ────────────────────────────────────

test("the existing guardrail verdicts are unchanged", () => {
  assert.deepEqual(validateWriteSql("select 1", false), {
    ok: false,
    error: { code: "NOT_A_WRITE", message: "Use run_read_query for SELECT / WITH ... SELECT statements." }
  });
  assert.deepEqual(validateWriteSql("drop table t", false), {
    ok: false,
    error: {
      code: "DDL_NOT_ALLOWED",
      message: "DDL is not allowed here. Schema changes must go through the migration tools."
    }
  });
  assert.equal(validateWriteSql("update t set a = 1", false).ok, false);
  assert.equal(validateWriteSql("update t set a = 1", true).ok, true);
  assert.equal(validateWriteSql("insert into t values (1); drop table t", false).ok, false);

  const target = parse('update "Schema"."Tbl" set a = 1 where id = 1');
  assert.deepEqual(target.target, { schema: "Schema", table: "Tbl" });
  assert.equal(target.hasWhere, true);
});
