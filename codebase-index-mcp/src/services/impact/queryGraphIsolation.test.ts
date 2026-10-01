import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";

import { initGraphSchema } from "../../repositories/schema.js";
import { runReadOnlyGraphQueryImpl } from "./impactRepoSummaries.js";
import {
  QUERY_GRAPH_TABLE_SCOPES,
  QueryGraphScopeError,
  findSchemaQualifier,
  validateAllowedTables,
  validateReadOnlyGraphSql
} from "../../middleware/sqliteGuardrails.js";

/**
 * `query_graph` repo isolation, end to end over the real schema.
 *
 * The guard used to check only that `:repoId` appeared in the SQL text, so `... or 1=1`, a UNION
 * arm, or a join to a second, unfiltered table read every repo in the database. Each case below is
 * one of those escapes, run through the same pipeline as the handler — text guard, table
 * allowlist, then the scoped runner — against a database holding two repos. A case passes only if
 * the other repo's marker never comes back, whether by refusal or by an empty scoped result.
 */

const MINE = "mine";
const OTHER = "other";
const SECRET = "OTHER_REPO_SECRET";

function db(): Database.Database {
  const conn = new Database(":memory:");
  initGraphSchema(conn);
  const now = new Date().toISOString();
  for (const repo of [MINE, OTHER]) {
    const marker = repo === OTHER ? SECRET : "mine_symbol";
    conn.prepare("insert into repositories (repo_id, repo_path, updated_at) values (?, ?, ?)").run(repo, `/r/${repo}`, now);
    conn.prepare("insert into files (repo_id, path, content_hash, language, updated_at) values (?, ?, ?, ?, ?)")
      .run(repo, `${marker}.ts`, "h", "typescript", now);
    conn.prepare("insert into symbols (repo_id, symbol_id, file_path, name, kind, line) values (?, ?, ?, ?, ?, ?)")
      .run(repo, `${repo}-s1`, `${marker}.ts`, marker, "function", 1);
    conn.prepare("insert into edges (repo_id, from_id, to_id, type, confidence, reason) values (?, ?, ?, ?, ?, ?)")
      .run(repo, `${repo}-s1`, `${repo}-s1`, "CALLS", 1, marker);
    conn.prepare(
      `insert into refactor_previews (preview_id, repo_id, find_pattern, replace_expression, mode,
         ambiguity_threshold_percent, created_at, expires_at, digest, status, total_matches,
         affected_file_count, risk_ambiguous_count, risk_cross_type_count, risk_generated_count)
       values (?, ?, ?, ?, 'literal', 0, ?, ?, 'd', 'ready', 1, 1, 0, 0, 0)`
    ).run(`${repo}-p1`, repo, marker, marker, now, now);
    conn.prepare(
      `insert into refactor_preview_hunks (preview_id, hunk_id, file_path, line, start_offset, end_offset,
         before_text, after_text, replacement_text, confidence, risk_flags, file_hash_before)
       values (?, 'h1', ?, 1, 0, 1, ?, ?, ?, 1, '[]', 'h')`
    ).run(`${repo}-p1`, `${marker}.ts`, marker, marker, marker);
  }
  conn.prepare("insert into cross_repo_deps (from_repo_id, from_symbol_id, to_repo_id, to_symbol_id, type) values (?, ?, ?, ?, ?)")
    .run(OTHER, SECRET, "third", "x", "CALLS");
  return conn;
}

const ALLOWED = new Set(Object.keys(QUERY_GRAPH_TABLE_SCOPES));

/** The handler's pipeline. Returns the rows, or the refusal message. */
function run(conn: Database.Database, sql: string, params: Record<string, string> = {}): { rows: Record<string, unknown>[] } | { refused: string } {
  const text = validateReadOnlyGraphSql(sql);
  if (!text.ok) return { refused: text.message };
  const tables = validateAllowedTables(text.sanitizedSql, ALLOWED);
  if (!tables.ok) return { refused: tables.message };
  try {
    return { rows: runReadOnlyGraphQueryImpl(conn, tables.sanitizedSql, { ...params, repoId: MINE }, 100, 5000).rows };
  } catch (err) {
    if (err instanceof QueryGraphScopeError) return { refused: err.message };
    // A compile error is also "did not escape", but say which so a regression is diagnosable.
    return { refused: `sqlite: ${(err as Error).message}` };
  }
}

function assertNoLeak(label: string, result: ReturnType<typeof run>): void {
  if ("rows" in result) {
    assert.ok(!JSON.stringify(result.rows).includes(SECRET), `${label}: leaked another repo's rows: ${JSON.stringify(result.rows)}`);
    assert.ok(!JSON.stringify(result.rows).includes(`"${OTHER}"`), `${label}: leaked another repo's id: ${JSON.stringify(result.rows)}`);
  }
}

test("a valid scoped query still returns the caller's rows", () => {
  const conn = db();
  const result = run(conn, "select name from symbols where repo_id = :repoId");
  assert.deepEqual(result, { rows: [{ name: "mine_symbol" }] });
});

test("existing query shapes keep working: joins, aggregates, user CTEs, recursive CTEs, trailing comments", () => {
  const conn = db();
  const join = run(conn, `select s.name, e.reason from edges e
    join symbols s on s.repo_id = e.repo_id and s.symbol_id = e.from_id
    where e.repo_id = :repoId and e.type = 'CALLS'`);
  assert.deepEqual(join, { rows: [{ name: "mine_symbol", reason: "mine_symbol" }] });

  const agg = run(conn, "select kind, count(*) as cnt from symbols where repo_id = :repoId group by kind");
  assert.deepEqual(agg, { rows: [{ kind: "function", cnt: 1 }] });

  // The handler's text allowlist refuses a CTE name it does not know (`t`), as it always has, so a
  // user `WITH` is exercised on the runner directly: the scoping wrapper must not break it.
  const direct = (sql: string) => runReadOnlyGraphQueryImpl(conn, sql, { repoId: MINE }, 100, 5000).rows;
  assert.deepEqual(direct("with t as (select name from symbols) select name from t"), [{ name: "mine_symbol" }]);
  assert.deepEqual(
    direct("with recursive r(n) as (select 1 union all select n + 1 from r where n < 3) select count(*) as c from r"),
    [{ c: 3 }]
  );
  // The runner refuses a qualifier on its own, without the handler's text guard in front of it.
  assert.throws(() => direct("with t as (select * from main.symbols) select name from t"), QueryGraphScopeError);

  const comment = run(conn, "select name from symbols where repo_id = :repoId -- trailing comment");
  assert.deepEqual(comment, { rows: [{ name: "mine_symbol" }] });

  const child = run(conn, `select h.hunk_id from refactor_preview_hunks h
    join refactor_previews p on p.preview_id = h.preview_id where p.repo_id = :repoId`);
  assert.deepEqual(child, { rows: [{ hunk_id: "h1" }] });
});

test("OR 1=1 cannot widen the scope", () => {
  const conn = db();
  const result = run(conn, "select name, repo_id from symbols where repo_id = :repoId or 1=1");
  assert.deepEqual(result, { rows: [{ name: "mine_symbol", repo_id: MINE }] });
});

test("a caller-supplied repoId-like param cannot widen the scope", () => {
  const conn = db();
  const result = run(conn, "select name from symbols where repo_id = :other or :repoId = :repoId", { other: OTHER, __scope_repo_id: OTHER });
  assert.deepEqual(result, { rows: [{ name: "mine_symbol" }] });
});

test("UNION arms are scoped too", () => {
  const conn = db();
  const result = run(conn, "select name from symbols where repo_id = :repoId union all select reason from edges union all select path from files");
  assertNoLeak("union", result);
  assert.ok("rows" in result && result.rows.length === 3);
});

test("a second, unfiltered table in a join or subquery is scoped", () => {
  const conn = db();
  assertNoLeak("comma join", run(conn, "select f.path from symbols s, files f where s.repo_id = :repoId"));
  assertNoLeak("subquery", run(conn, "select (select group_concat(name) from symbols) as all_names where :repoId = :repoId"));
  assertNoLeak("exists", run(conn, "select repo_id from repositories where :repoId = :repoId"));
  assertNoLeak("child table", run(conn, "select before_text from refactor_preview_hunks where :repoId = :repoId"));
  const deps = run(conn, "select from_symbol_id from cross_repo_deps where :repoId = :repoId");
  assert.deepEqual(deps, { rows: [] });
});

test("a user CTE that shadows a graph table still reads the scoped table", () => {
  const conn = db();
  const result = run(conn, "with files as (select * from symbols) select name from files where :repoId = :repoId");
  assert.deepEqual(result, { rows: [{ name: "mine_symbol" }] });
});

test("schema-qualified names cannot reach the real table, in any quoting", () => {
  const conn = db();
  for (const sql of [
    "select name from main.symbols where :repoId = :repoId",
    "select name from \"main\".symbols where :repoId = :repoId",
    "select name from [main] . symbols where :repoId = :repoId",
    "select name from `MAIN`.symbols where :repoId = :repoId",
    "select name from 'main'.symbols where :repoId = :repoId",
    "select name from main /* gap */ . symbols where :repoId = :repoId",
    "select name from symbols where :repoId = :repoId union select name from main.symbols",
    "select name from temp.symbols where :repoId = :repoId"
  ]) {
    const result = run(conn, sql);
    assert.ok("refused" in result, `${sql} should be refused, got ${JSON.stringify(result)}`);
    assertNoLeak(sql, result);
  }
});

test("sqlite_master, unlisted tables and table-valued functions are refused", () => {
  const conn = db();
  for (const sql of [
    "select name, sql from sqlite_master where :repoId = :repoId",
    "select name from symbols, sqlite_schema where :repoId = :repoId",
    "select * from symbols where :repoId = :repoId union select name, 1, 1, 1, 1, 1, 1, 1, 1 from \"docs\"",
    "select * from pragma_database_list where :repoId = :repoId",
    "select s.name from symbols s, pragma_table_info('symbols') p where :repoId = :repoId",
    "select * from symbols_fts where :repoId = :repoId"
  ]) {
    const result = run(conn, sql);
    assert.ok("refused" in result, `${sql} should be refused, got ${JSON.stringify(result)}`);
  }
});

test("findSchemaQualifier ignores look-alikes in strings, comments and column qualifiers", () => {
  assert.equal(findSchemaQualifier("select s.name from symbols s where s.kind = 'main.x' -- main.y"), undefined);
  assert.equal(findSchemaQualifier("select domain.x from symbols domain /* temp.z */"), undefined);
  assert.equal(findSchemaQualifier("select 1.5, maintainer from t"), undefined);
  assert.equal(findSchemaQualifier("select * from Main.t"), "Main");
  assert.equal(findSchemaQualifier("select * from \"te\"\"mp\".t"), undefined);
});
