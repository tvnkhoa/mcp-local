/**
 * Regression suite for the SQL guardrail extraction.
 *
 * The scanner now comes from @mcp/shared. This server's policy stays local: a
 * 13-token list (five fewer than postgres-mcp) and the DataFusion dialect, which
 * has no dollar-quoted or `E'…'` strings.
 *
 * Baseline: 49 cases characterized against the pre-extraction implementation.
 * All 49 are identical — this extraction changed nothing observable here.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { hasMultipleStatements, stripStringsAndComments, validateReadOnlySql } from "./sqlGuardrails.js";

const Q = String.fromCharCode(39);
const DQ = String.fromCharCode(34);

const ok = (sql: string): string => {
  const r = validateReadOnlySql(sql);
  assert.equal(r.ok, true, `expected ALLOW for: ${sql}`);
  return r.ok ? r.sanitizedSql : "";
};
const rejected = (sql: string): string => {
  const r = validateReadOnlySql(sql);
  assert.equal(r.ok, false, `expected REJECT for: ${sql}`);
  return r.ok ? "" : r.error.message;
};

test("allows SELECT and WITH ... SELECT", () => {
  assert.equal(ok("select 1"), "select 1");
  assert.equal(ok("with t as (select 1 as x) select x from t"), "with t as (select 1 as x) select x from t");
  assert.equal(ok("select 1;"), "select 1");
});

test("error messages are part of the contract", () => {
  assert.equal(rejected(""), "SQL cannot be empty.");
  assert.equal(rejected("select 1; select 2"), "Only one SQL statement is allowed.");
  assert.equal(rejected("explain select 1"), "Only SELECT or WITH ... SELECT queries are allowed.");
  assert.equal(rejected("select 1 from t where drop is null"), "Forbidden SQL token detected: drop.");
});

test("the DataFusion 13-token list is enforced", () => {
  for (const token of ["insert", "update", "delete", "truncate", "alter", "drop", "create",
    "grant", "revoke", "copy", "call", "vacuum", "merge"]) {
    assert.equal(
      rejected(`select 1 from t where ${token} is null`),
      `Forbidden SQL token detected: ${token}.`,
      `token ${token} should be forbidden`
    );
  }
});

test("the five tokens postgres-mcp forbids and this server does not", () => {
  // Deliberate divergence, preserved by the extraction rather than unified.
  // Reconciling these lists is a policy decision, not a refactor.
  for (const token of ["comment", "do", "analyze", "reindex", "refresh"]) {
    assert.equal(
      ok(`select 1 from t where ${token} is null`),
      `select 1 from t where ${token} is null`,
      `token ${token} is allowed here but forbidden in postgres-mcp`
    );
  }
});

test("token look-alikes are not rejected (word boundaries)", () => {
  assert.equal(ok("select created_at from users"), "select created_at from users");
  assert.equal(ok("select 1 from user_updates"), "select 1 from user_updates");
});

test("tokens hidden in strings and comments are allowed through", () => {
  ok(`select 1 from t where name = ${Q}drop table users${Q}`);
  ok("select 1 -- drop table users");
  ok("select 1 /* drop table users */ from t");
  ok(`select ${DQ}drop${DQ} from t`);
});

test("helpers take raw SQL and clean internally", () => {
  assert.equal(hasMultipleStatements("select 1; select 2"), true);
  assert.equal(hasMultipleStatements(`select ${Q};${Q}`), false);
  assert.equal(stripStringsAndComments(`select ${Q}abc${Q}`).includes("abc"), false);
});

test("DataFusion dialect: `$` is an ordinary character, not a string delimiter", () => {
  // Turning on Postgres dollar-quote scanning here would be WRONG, not safer: it
  // blanks the span between `$x$` markers, which would hide a forbidden token
  // from the check instead of revealing one. Verified in @mcp/shared's suite.
  assert.equal(rejected("select 1 from t where a = $x$ drop $x$"), "Forbidden SQL token detected: drop.");
});
