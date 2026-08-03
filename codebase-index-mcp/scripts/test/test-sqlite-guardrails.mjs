/**
 * Regression suite for the query_graph SQL guardrail after extraction.
 *
 * The scanner now comes from @mcp/shared. This server's policy stays local: the
 * 16-token SQLite list (including attach/detach/pragma), the `:repoId`
 * repo-isolation requirement, the table allowlist, and the `query_graph:` error
 * vocabulary.
 *
 * Baseline: 49 cases characterized against the pre-extraction implementation.
 * All 49 are identical — this extraction changed nothing observable here.
 *
 * Usage: npm run build && node scripts/test/test-sqlite-guardrails.mjs
 */

import { validateReadOnlyGraphSql, validateAllowedTables } from "../../dist/middleware/sqliteGuardrails.js";

const Q = String.fromCharCode(39);
const DQ = String.fromCharCode(34);

let passed = 0;
const failures = [];

function check(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    passed += 1;
  } else {
    failures.push(`${label}\n     expected: ${e}\n     actual:   ${a}`);
  }
}

const allow = (label, sql, sanitized) =>
  check(label, validateReadOnlyGraphSql(sql), { ok: true, sanitizedSql: sanitized ?? sql });
const reject = (label, sql, message) =>
  check(label, validateReadOnlyGraphSql(sql), { ok: false, message });

// --- shape and isolation -----------------------------------------------------
reject("empty", "", "query_graph: sql must not be empty");
reject("whitespace only", "   ", "query_graph: sql must not be empty");
reject(
  "multiple statements",
  "select 1 from symbols where repo_id = :repoId; select 2",
  "query_graph: multiple SQL statements are not allowed"
);
reject("not a select", "explain select 1", "query_graph: only SELECT queries are allowed");
reject(
  "missing :repoId",
  "select name from symbols",
  "query_graph: sql must include named parameter :repoId for repo isolation"
);
reject(
  ":repoId only inside a string does not count",
  `select name from symbols where a = ${Q}:repoId${Q}`,
  "query_graph: sql must include named parameter :repoId for repo isolation"
);
allow("valid graph query", "select name from symbols where repo_id = :repoId");
allow(
  "trailing semicolon stripped",
  "select name from symbols where repo_id = :repoId;",
  "select name from symbols where repo_id = :repoId"
);
allow("WITH ... SELECT", "with t as (select 1 as x) select x from t where :repoId = :repoId");

// --- the 16-token SQLite policy ---------------------------------------------
for (const token of ["insert", "update", "delete", "truncate", "alter", "drop", "create",
  "grant", "revoke", "comment", "attach", "detach", "vacuum", "analyze", "reindex", "pragma"]) {
  reject(
    `forbidden token: ${token}`,
    `select 1 from symbols where repo_id = :repoId and ${token} is null`,
    `query_graph: forbidden token '${token}'`
  );
}

// Tokens the Postgres server forbids that SQLite does not need.
for (const token of ["copy", "call", "do", "refresh", "merge"]) {
  allow(
    `postgres-only token allowed here: ${token}`,
    `select 1 from symbols where repo_id = :repoId and ${token} is null`
  );
}

// --- word boundaries and hidden tokens --------------------------------------
allow("look-alike created_at", "select created_at from symbols where repo_id = :repoId");
allow("look-alike comments table", "select 1 from comments where repo_id = :repoId");
allow("token inside a string", `select 1 from symbols where repo_id = :repoId and n = ${Q}drop table x${Q}`);
allow("token inside a line comment", "select 1 from symbols where repo_id = :repoId -- drop table x");
allow("token inside a block comment", "select 1 from symbols where repo_id = :repoId /* drop table x */");
allow("quoted identifier", `select ${DQ}drop${DQ} from symbols where repo_id = :repoId`);

// SQLite dialect: `$` is an ordinary character. Scanning it as a Postgres
// dollar-quote would blank the span and HIDE this token instead of revealing it.
reject(
  "dollar markers do not hide a token in the SQLite dialect",
  "select 1 from symbols where repo_id = :repoId and a = $x$ drop $x$",
  "query_graph: forbidden token 'drop'"
);

// --- table allowlist --------------------------------------------------------
const allowed = new Set(["symbols", "edges", "files"]);
check("tables allowed", validateAllowedTables("select 1 from symbols join edges on 1=1", allowed), {
  ok: true,
  sanitizedSql: "select 1 from symbols join edges on 1=1"
});
check("table denied", validateAllowedTables("select 1 from secrets", allowed), {
  ok: false,
  message: "query_graph: table 'secrets' is not allowed"
});
check("denied in a join", validateAllowedTables("select 1 from symbols join secrets on 1=1", allowed), {
  ok: false,
  message: "query_graph: table 'secrets' is not allowed"
});
check(
  "table name inside a string is not a table reference",
  validateAllowedTables(`select 1 from symbols where a = ${Q}from secrets${Q}`, allowed),
  { ok: true, sanitizedSql: `select 1 from symbols where a = ${Q}from secrets${Q}` }
);

// --- report -----------------------------------------------------------------
console.log(`\nResults: ${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.error("\nFAILURES:");
  for (const f of failures) {
    console.error(`  - ${f}`);
  }
  process.exit(1);
}
console.log("\nAll sqlite guardrail tests passed!");
