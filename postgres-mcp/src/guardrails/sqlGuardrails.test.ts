/**
 * Regression suite for the SQL guardrail extraction.
 *
 * The scanner now comes from @mcp/shared. These tests pin this server's own
 * policy — its 18-token list, its exact error messages, and the Postgres dialect
 * switches — because all three are part of the `run_read_query` contract.
 *
 * Baseline: 49 cases characterized against the pre-extraction implementation.
 * 46 are identical; the 3 that changed are the dollar-quote / escape-string
 * bypasses pinned at the bottom, which now reject.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { hasMultipleStatements, stripStringsAndComments, validateReadOnlySql } from "./sqlGuardrails.js";

const Q = String.fromCharCode(39);
const DQ = String.fromCharCode(34);
const BS = String.fromCharCode(92);

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
  assert.equal(ok("select id, name from users"), "select id, name from users");
  assert.equal(ok("with t as (select 1 as x) select x from t"), "with t as (select 1 as x) select x from t");
  assert.equal(ok("SELECT ID FROM USERS"), "SELECT ID FROM USERS");
});

test("strips exactly one trailing semicolon from sanitizedSql", () => {
  assert.equal(ok("select 1;"), "select 1");
  // Only the semicolon and what follows it is removed — whitespace BEFORE the
  // semicolon survives. Pinned because it is pre-existing observable behaviour.
  assert.equal(ok("select 1 ; "), "select 1 ");
});

test("error messages are part of the contract", () => {
  assert.equal(rejected(""), "SQL cannot be empty.");
  assert.equal(rejected("   "), "SQL cannot be empty.");
  assert.equal(rejected("select 1; select 2"), "Only one SQL statement is allowed.");
  assert.equal(rejected("explain select 1"), "Only SELECT or WITH ... SELECT queries are allowed.");
});

test("check order: the SELECT gate fires before the token gate", () => {
  // A bare write statement never reaches the token list, so the message names the
  // shape problem rather than the token. Changing this order would change the
  // error every client sees for the most common mistake.
  assert.equal(rejected("update users set a = 1"), "Only SELECT or WITH ... SELECT queries are allowed.");
  assert.equal(rejected("delete from users"), "Only SELECT or WITH ... SELECT queries are allowed.");
  assert.equal(rejected("drop table users"), "Only SELECT or WITH ... SELECT queries are allowed.");
  // A forbidden token inside an otherwise valid SELECT is what the token gate is for.
  assert.equal(rejected("select 1 from t where drop is null"), "Forbidden SQL token detected: drop.");
});

test("the Postgres 18-token list is enforced", () => {
  // Order matters: these are checked in list order, and the message names the token.
  for (const token of ["insert", "update", "delete", "truncate", "alter", "drop", "create",
    "grant", "revoke", "comment", "copy", "call", "do", "vacuum", "analyze", "reindex",
    "refresh", "merge"]) {
    assert.equal(
      rejected(`select 1 from t where ${token} is null`),
      `Forbidden SQL token detected: ${token}.`,
      `token ${token} should be forbidden`
    );
  }
});

test("SQLite-only tokens are NOT in the Postgres list", () => {
  // attach/detach/pragma are codebase-index-mcp's policy, not this server's.
  for (const token of ["attach", "detach", "pragma"]) {
    assert.equal(ok(`select 1 from t where ${token} is null`), `select 1 from t where ${token} is null`);
  }
});

test("token look-alikes are not rejected (word boundaries)", () => {
  assert.equal(ok("select created_at from users"), "select created_at from users");
  assert.equal(ok("select 1 from user_updates"), "select 1 from user_updates");
  assert.equal(ok("select 1 from comments"), "select 1 from comments");
});

test("tokens hidden in strings and comments are allowed through", () => {
  ok(`select 1 from t where name = ${Q}drop table users${Q}`);
  ok("select 1 -- drop table users");
  ok("select 1 /* drop table users */ from t");
  ok(`select ${DQ}drop${DQ} from t`);
  ok(`select ${Q}it${Q}${Q}s fine${Q} from t`);
});

test("exported helpers keep their raw-SQL signature (writeGuardrails depends on it)", () => {
  assert.equal(hasMultipleStatements("select 1"), false);
  assert.equal(hasMultipleStatements("select 1;"), false);
  assert.equal(hasMultipleStatements("select 1; select 2"), true);
  assert.equal(hasMultipleStatements(`select ${Q};${Q}`), false, "semicolon inside a literal is not a separator");
  assert.equal(stripStringsAndComments(`select ${Q}abc${Q}`).includes("abc"), false);
});

// --- The three documented behaviour deltas -----------------------------------
// Postgres dollar-quoted and escape strings are now scanned. Before extraction
// each of these was ALLOWED: the apostrophe inside opened a phantom literal that
// swallowed the rest of the statement, hiding the second statement from every
// check. Not exploitable end-to-end (the subquery wrap and the read-only
// transaction both stop it) but the guard was not doing its job.

test("DELTA: dollar-quoted bypass now rejects", () => {
  assert.equal(rejected(`select $$${Q}$$; drop table users`), "Only one SQL statement is allowed.");
});

test("DELTA: tagged dollar-quote bypass now rejects", () => {
  assert.equal(rejected(`select $x$${Q}$x$; drop table users`), "Only one SQL statement is allowed.");
});

test("DELTA: escape-string bypass now rejects", () => {
  assert.equal(rejected(`select E${Q}${BS}${Q}${Q} ; drop table users`), "Only one SQL statement is allowed.");
});

test("legitimate dollar-quoted and parameter syntax still works", () => {
  // $1 placeholders are not dollar-quote tags (no closing $).
  ok("select 1 from t where id = $1");
  // A dollar-quoted literal with no hidden statement is fine.
  ok(`select $$plain text$$ as note`);
});
