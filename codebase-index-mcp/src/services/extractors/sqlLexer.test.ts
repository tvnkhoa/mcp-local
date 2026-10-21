import assert from "node:assert/strict";
import test from "node:test";

import { firstWords, lexSql, splitSqlStatements } from "./sqlLexer.js";

test("splitSqlStatements: a ; inside a string, a quoted identifier or a comment does not end a statement", () => {
  const src = [
    "insert into t (a) values ('x; y');", // 1
    'select "odd;name" from t; -- trailing; comment', // 2
    "/* block; comment /* nested; */ still comment; */ select 1;", // 3
    "select E'it\\'s; fine' as v;" // 4
  ].join("\n");
  const statements = splitSqlStatements(src);
  assert.deepEqual(
    statements.map((s) => [s.line, firstWords(s, 2)]),
    [
      [1, "insert into"],
      [2, "select \"odd;name\""],
      [3, "select 1"],
      [4, "select '…'"]
    ]
  );
  assert.equal(statements[0]!.tokens.find((t) => t.kind === "string")!.value, "x; y");
});

test("splitSqlStatements: dollar-quoted bodies (plain and tagged) keep their inner ; and $$", () => {
  const src = [
    "create function f() returns int language plpgsql as $$", // 1
    "begin", // 2
    "  perform 1; return 2;", // 3
    "end $$;", // 4
    "do $body$ begin raise notice '$$ not a close'; end $body$;", // 5
    "select 3;" // 6
  ].join("\n");
  const statements = splitSqlStatements(src);
  assert.equal(statements.length, 3);
  assert.equal(statements[0]!.line, 1);
  assert.equal(statements[0]!.endLine, 4);
  const body = statements[0]!.tokens.find((t) => t.kind === "dollar")!;
  assert.match(body.value, /perform 1; return 2;/);
  assert.equal(statements[1]!.line, 5);
  assert.match(statements[1]!.tokens.find((t) => t.kind === "dollar")!.value, /'\$\$ not a close'/);
  assert.equal(statements[2]!.line, 6);
});

test("splitSqlStatements: psql meta-commands are their own statement kind and end at the line", () => {
  const statements = splitSqlStatements("\\set ON_ERROR_STOP on\nbegin;\n\\i other.sql\ncommit;\n");
  assert.deepEqual(statements.map((s) => s.kind), ["meta", "sql", "meta", "sql"]);
  assert.equal(statements[0]!.text, "\\set ON_ERROR_STOP on");
});

test("splitSqlStatements: COPY … FROM stdin data runs to \\. and is not read as SQL", () => {
  const src = "copy t (a) from stdin;\n1\tx; drop table t;\n\\.\nselect 2;\n";
  const statements = splitSqlStatements(src);
  assert.deepEqual(statements.map((s) => firstWords(s, 2)), ["copy t", "select 2"]);
});

test("splitSqlStatements: BEGIN ATOMIC bodies keep their inner ; (CASE … END inside is not the end)", () => {
  const src = "create function f() returns int begin atomic select case when true then 1 end; select 2; end;\nselect 3;";
  const statements = splitSqlStatements(src);
  assert.equal(statements.length, 2);
  assert.match(statements[0]!.text, /select 2; end$/);
});

test("splitSqlStatements: an unterminated quote runs to the end and never throws", () => {
  const statements = splitSqlStatements("select 'oops;\nselect 1;");
  assert.equal(statements.length, 1);
});

test("lexSql: unquoted words fold to lower case, quoted identifiers keep case, $1 is a param", () => {
  const tokens = lexSql('SELECT "MixedCase", Col FROM Public.T where x = $1');
  assert.deepEqual(
    tokens.map((t) => `${t.kind}:${t.value}`),
    ["word:select", "qident:MixedCase", "punct:,", "word:col", "word:from", "word:public", "punct:.", "word:t", "word:where", "word:x", "punct:=", "param:$1"]
  );
});
