import assert from "node:assert/strict";
import { test } from "node:test";

import {
  findForbiddenToken,
  hasMultipleStatements,
  isSelectLike,
  scanSql,
  stripStringsAndComments
} from "./sql/index.js";

// --- Regression: SQL guardrail extraction (postgres / observe / codebase-index) ---
// The scanner is now shared by three servers running three different SQL
// dialects. These tests pin the dialect switches, because getting them wrong
// blanks out real statement text instead of hiding a keyword.

const QUOTE = String.fromCharCode(39);
const BACKSLASH = String.fromCharCode(92);

test("sql: dollar-quote scanning is opt-out for non-Postgres dialects", () => {
  const sql = `select $$${QUOTE}$$; drop table users`;

  // Postgres: $$...$$ is a string, so the hidden second statement is revealed.
  const postgres = scanSql(sql, { dollarQuotedStrings: true });
  assert.equal(hasMultipleStatements(postgres.cleaned), true);

  // SQLite / DataFusion: `$` is an ordinary character. The apostrophe therefore
  // opens a literal that runs to end of input, which is the pre-extraction
  // behaviour of those two servers and must be preserved exactly.
  const sqlite = scanSql(sql, { dollarQuotedStrings: false, escapeStrings: false });
  assert.equal(hasMultipleStatements(sqlite.cleaned), false);
  assert.equal(sqlite.unterminated, true);
});

test("sql: escape-string scanning is opt-out too", () => {
  const sql = `select E${QUOTE}${BACKSLASH}${QUOTE}${QUOTE} ; drop table users`;
  assert.equal(hasMultipleStatements(scanSql(sql, { escapeStrings: true }).cleaned), true);
  assert.equal(hasMultipleStatements(scanSql(sql, { escapeStrings: false }).cleaned), false);
});

test("sql: both dialect switches default to on (over-scan fails safe)", () => {
  const sql = `select $$${QUOTE}$$; drop table users`;
  assert.equal(hasMultipleStatements(scanSql(sql).cleaned), true);
  assert.equal(hasMultipleStatements(stripStringsAndComments(sql)), true);
});

test("sql: isSelectLike is stricter than a leading-keyword check", () => {
  assert.equal(isSelectLike("select 1"), true);
  assert.equal(isSelectLike("  SELECT 1"), true);
  assert.equal(isSelectLike("with t as (select 1) select * from t"), true);
  // A leading `with` that never reaches a SELECT is not read-only.
  assert.equal(isSelectLike("with t as (delete from x returning *) update y set a=1"), false);
  assert.equal(isSelectLike("explain select 1"), false);
  assert.equal(isSelectLike("update users set a = 1"), false);
  assert.equal(isSelectLike(""), false);
});

test("sql: token matching is word-bounded and case-insensitive", () => {
  const tokens = ["drop", "create", "comment"];
  assert.equal(findForbiddenToken("select 1 where a = drop", tokens), "drop");
  assert.equal(findForbiddenToken("select 1 WHERE DROP is null", tokens), "drop");
  // Look-alikes must not trip: word boundaries only.
  assert.equal(findForbiddenToken("select created_at from t", tokens), undefined);
  assert.equal(findForbiddenToken("select 1 from comments", tokens), undefined);
  assert.equal(findForbiddenToken("select dropped from t", tokens), undefined);
});

test("sql: enabling a dialect the engine lacks would WEAKEN the guard", () => {
  // This is why the switches exist rather than always-on. On SQLite/DataFusion,
  // `$x$` is not a string delimiter. Scanning for it blanks the span between the
  // markers — and a forbidden token sitting inside that span disappears from the
  // token check entirely. Off is not merely "unchanged", it is correct.
  const sql = "select 1 from t where a = $x$ drop $x$";

  const wrongDialect = stripStringsAndComments(sql, { dollarQuotedStrings: true });
  assert.equal(findForbiddenToken(wrongDialect, ["drop"]), undefined, "token was hidden by over-scanning");

  const rightDialect = stripStringsAndComments(sql, { dollarQuotedStrings: false });
  assert.equal(findForbiddenToken(rightDialect, ["drop"]), "drop");
});

// --- Bracket-quoted identifiers (T-SQL, opt-in) -------------------------------

test("sql: bracket identifiers are opt-in, and off by default", () => {
  const sql = "select [Update], [Delete] from t";

  // Default (Postgres / SQLite / DataFusion): `[` is an ordinary character, so
  // the reserved words stay visible and a read-only guard would refuse them.
  assert.equal(findForbiddenToken(stripStringsAndComments(sql), ["update", "delete"]), "update");

  // T-SQL: the identifiers are blanked out, so the statement reads as the
  // ordinary SELECT it is.
  const tsql = stripStringsAndComments(sql, {
    dollarQuotedStrings: false,
    escapeStrings: false,
    bracketQuotedIdentifiers: true
  });
  assert.equal(findForbiddenToken(tsql, ["update", "delete"]), undefined);
  assert.equal(isSelectLike(tsql), true);
});

test("sql: `]]` inside brackets escapes a literal `]`, it does not terminate", () => {
  // `[a]]b]` is ONE identifier named `a]b`. Treating the first `]` as the
  // terminator would leave `b]` as bare text — and a token hidden there would
  // be read as statement text rather than as part of the name.
  const sql = "select [a]]b] from [drop]] table] where x = 1";
  const cleaned = stripStringsAndComments(sql, { bracketQuotedIdentifiers: true });

  assert.equal(findForbiddenToken(cleaned, ["drop", "table"]), undefined);
  assert.match(cleaned, /where x = 1/);
});

test("sql: an unterminated bracket is reported, not silently swallowed", () => {
  const scan = scanSql("select [Update from t", { bracketQuotedIdentifiers: true });
  assert.equal(scan.unterminated, true);
});

test("sql: bracket scanning does not hide a real statement separator", () => {
  // The separator sits OUTSIDE the identifier, so it must survive scanning.
  const sql = "select [Name] from t; drop table t";
  const cleaned = stripStringsAndComments(sql, { bracketQuotedIdentifiers: true });

  assert.equal(hasMultipleStatements(cleaned), true);
  assert.equal(findForbiddenToken(cleaned, ["drop"]), "drop");
});
