/**
 * Read-only SQL guardrail for the `query_graph` tool.
 *
 * The scanner, statement splitter, token matcher and SELECT predicate are shared
 * with postgres-mcp and observe-mcp via `@mcp/shared`. What stays local is this
 * server's own policy: the SQLite token list, the `:repoId` requirement, the
 * table allowlist, the `query_graph:` error vocabulary — and the structural repo
 * isolation (CTE shadowing, schema-qualifier ban, bytecode audit) that the
 * `:repoId` text check alone never provided.
 */

import {
  findForbiddenToken,
  hasMultipleStatements as cleanedHasMultipleStatements,
  isSelectLike,
  stripStringsAndComments as scanAndStrip,
  type SqlScanOptions
} from "@mcp/shared";

/**
 * SQLite has neither dollar-quoted strings nor `E'…'` escape strings, so both
 * scanner modes are off: treating `$` or a leading `E` as string syntax would
 * blank out real statement text and could mask a forbidden token rather than
 * reveal it. Keeps this guard byte-identical to its pre-extraction behaviour.
 */
const SQLITE_SCAN: SqlScanOptions = {
  dollarQuotedStrings: false,
  escapeStrings: false
};

const FORBIDDEN_TOKENS = [
  "insert",
  "update",
  "delete",
  "truncate",
  "alter",
  "drop",
  "create",
  "grant",
  "revoke",
  "comment",
  "attach",
  "detach",
  "vacuum",
  "analyze",
  "reindex",
  "pragma"
] as const;

export type SqlGuardrailResult =
  | { ok: true; sanitizedSql: string }
  | { ok: false; message: string };

function stripStringsAndComments(sql: string): string {
  return scanAndStrip(sql, SQLITE_SCAN);
}

function hasMultipleStatements(sql: string): boolean {
  return cleanedHasMultipleStatements(stripStringsAndComments(sql));
}

export function validateReadOnlyGraphSql(sql: string): SqlGuardrailResult {
  const trimmed = sql.trim();
  const cleaned = stripStringsAndComments(trimmed);
  if (!trimmed) {
    return { ok: false, message: "query_graph: sql must not be empty" };
  }

  if (hasMultipleStatements(trimmed)) {
    return { ok: false, message: "query_graph: multiple SQL statements are not allowed" };
  }

  // Tested on the stripped statement, unlike the other two servers: a leading
  // comment must not decide whether this looks like a SELECT.
  if (!isSelectLike(cleaned)) {
    return { ok: false, message: "query_graph: only SELECT queries are allowed" };
  }

  const forbidden = findForbiddenToken(stripStringsAndComments(trimmed), FORBIDDEN_TOKENS);
  if (forbidden !== undefined) {
    return { ok: false, message: `query_graph: forbidden token '${forbidden}'` };
  }

  // Validate on stripped SQL so ':repoId' inside strings/comments cannot bypass isolation checks.
  // Kept for contract compatibility. It is NOT what isolates repos — `buildRepoScopedGraphSql` and
  // `findOutOfScopeRead` are; see "Repo isolation, enforced" below.
  if (!/:repoId\b/.test(cleaned)) {
    return { ok: false, message: "query_graph: sql must include named parameter :repoId for repo isolation" };
  }

  const qualifier = findSchemaQualifier(trimmed);
  if (qualifier !== undefined) {
    return {
      ok: false,
      message: `query_graph: schema-qualified names ('${qualifier}.') are not allowed; name graph tables unqualified`
    };
  }

  return { ok: true, sanitizedSql: trimmed.replace(/;\s*$/, "") };
}

// ── Repo isolation, enforced ────────────────────────────────────────────────
//
// The `:repoId` check above proves only that the parameter appears somewhere. `... where repo_id =
// :repoId or 1=1`, a UNION, or a join to a second table with no repo filter all satisfy it and read
// every repository in the database. Isolation is therefore enforced structurally, in three parts:
//
//   1. **Shadowing.** The statement is wrapped in a `WITH` clause that defines one CTE per graph
//      table, named exactly like the table and filtered to the caller's repo. An unqualified
//      `symbols` resolves to the CTE before it can resolve to `main.symbols`, wherever it appears:
//      a join, a subquery, a UNION arm, or the user's own nested `WITH`.
//   2. **No schema qualifiers.** `main.symbols` names the real table and walks past the CTE, so any
//      `main.` / `temp.` qualifier is refused. That is decided by a SQLite-faithful tokenizer, not a
//      regex, because SQLite accepts `"main".x`, `[main].x`, `` `main`.x ``, `'main'.x` and comments
//      between the two halves.
//   3. **Bytecode audit.** The wrapped statement is compiled with `EXPLAIN` and every b-tree it opens
//      is checked against the root pages of the allowed tables and their indexes. That catches what
//      shadowing cannot: an unlisted table (`sqlite_master`, `docs`), a virtual table or table-valued
//      function (`pragma_database_list`, `symbols_fts`), or any write cursor. It is the authorizer
//      better-sqlite3 does not expose.
//
// The CTEs are `not materialized`, so SQLite flattens each into the outer query and the repo_id
// predicate meets the `(repo_id, …)` indexes — scoping costs one predicate, not a table copy.

/** Thrown when a statement would read outside the caller's repo. Maps to InvalidParams. */
export class QueryGraphScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QueryGraphScopeError";
  }
}

/** Bound by the runner, never by the caller: the caller's params are spread first and lose. */
export const SCOPE_REPO_PARAM = "__scope_repo_id";

const SCOPE = `@${SCOPE_REPO_PARAM}`;

/**
 * The repo filter for every table `query_graph` may read. Its keys ARE the table allowlist.
 * Child tables without a `repo_id` column are scoped through the parent row that has one.
 * `cross_repo_deps` keeps a row when either side is the caller's repo: the other side's ids are
 * what `get_cross_repo_impact` already returns for that repo.
 */
export const QUERY_GRAPH_TABLE_SCOPES: Readonly<Record<string, string>> = {
  repositories: `repo_id = ${SCOPE}`,
  files: `repo_id = ${SCOPE}`,
  symbols: `repo_id = ${SCOPE}`,
  edges: `repo_id = ${SCOPE}`,
  index_runs: `repo_id = ${SCOPE}`,
  routes: `repo_id = ${SCOPE}`,
  cross_repo_deps: `from_repo_id = ${SCOPE} or to_repo_id = ${SCOPE}`,
  refactor_previews: `repo_id = ${SCOPE}`,
  refactor_preview_hunks: `preview_id in (select preview_id from main.refactor_previews where repo_id = ${SCOPE})`,
  refactor_applies: `repo_id = ${SCOPE}`,
  refactor_apply_changes: `apply_id in (select apply_id from main.refactor_applies where repo_id = ${SCOPE})`,
  refactor_apply_hunks: `apply_id in (select apply_id from main.refactor_applies where repo_id = ${SCOPE})`,
  refactor_rollbacks: `apply_id in (select apply_id from main.refactor_applies where repo_id = ${SCOPE})`,
  vec_symbol_map: `repo_id = ${SCOPE}`
};

type SqliteToken = { kind: "word" | "string" | "dot" | "other"; value: string };

/** SQLite's own whitespace set (tokenize.c). `\s` is wider and would split what SQLite joins. */
const SQLITE_SPACE = new Set([" ", "\t", "\n", "\f", "\r"]);

function isIdentStart(ch: string): boolean {
  return /[A-Za-z_]/.test(ch) || ch.charCodeAt(0) >= 0x80;
}

function isIdentPart(ch: string): boolean {
  return /[A-Za-z0-9_$]/.test(ch) || ch.charCodeAt(0) >= 0x80;
}

/**
 * Tokenize the way SQLite does, as far as identifiers, strings, comments and `.` are concerned.
 * Quoted identifiers and string literals both come back with their quotes removed: SQLite accepts
 * a single-quoted string where an identifier is expected, so `'main'.symbols` is a qualifier too.
 */
function tokenizeSqlite(sql: string): SqliteToken[] {
  const tokens: SqliteToken[] = [];
  const n = sql.length;
  let i = 0;
  while (i < n) {
    const ch = sql[i]!;
    if (SQLITE_SPACE.has(ch)) {
      i += 1;
      continue;
    }
    if (ch === "-" && sql[i + 1] === "-") {
      const end = sql.indexOf("\n", i + 2);
      i = end === -1 ? n : end + 1;
      continue;
    }
    if (ch === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      i = end === -1 ? n : end + 2;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      let j = i + 1;
      let value = "";
      while (j < n) {
        if (sql[j] === ch) {
          if (sql[j + 1] === ch) {
            value += ch;
            j += 2;
            continue;
          }
          break;
        }
        value += sql[j];
        j += 1;
      }
      tokens.push({ kind: ch === "'" ? "string" : "word", value });
      i = j + 1;
      continue;
    }
    if (ch === "[") {
      const end = sql.indexOf("]", i + 1);
      const stop = end === -1 ? n : end;
      tokens.push({ kind: "word", value: sql.slice(i + 1, stop) });
      i = stop + 1;
      continue;
    }
    if (isIdentStart(ch)) {
      let j = i + 1;
      while (j < n && isIdentPart(sql[j]!)) j += 1;
      tokens.push({ kind: "word", value: sql.slice(i, j) });
      i = j;
      continue;
    }
    // Numbers stop at the first letter, so `1.main.x` still surfaces `main` as a word. Over-splitting
    // can only make the qualifier check stricter, never looser.
    if (/[0-9]/.test(ch) || (ch === "." && /[0-9]/.test(sql[i + 1] ?? ""))) {
      let j = i + 1;
      while (j < n && /[0-9.]/.test(sql[j]!)) j += 1;
      tokens.push({ kind: "other", value: sql.slice(i, j) });
      i = j;
      continue;
    }
    if (ch === ":" || ch === "@" || ch === "$" || ch === "?") {
      let j = i + 1;
      while (j < n && isIdentPart(sql[j]!)) j += 1;
      tokens.push({ kind: "other", value: sql.slice(i, j) });
      i = j;
      continue;
    }
    tokens.push({ kind: ch === "." ? "dot" : "other", value: ch });
    i += 1;
  }
  return tokens;
}

/** Schema names a qualifier could use. `attach` is a forbidden token, so no others can exist. */
const SCHEMA_NAMES = new Set(["main", "temp", "temporary"]);

/** The first schema qualifier (`main.`, `"temp".`, …) in the statement, if any. */
export function findSchemaQualifier(sql: string): string | undefined {
  const tokens = tokenizeSqlite(sql);
  for (let k = 0; k + 1 < tokens.length; k += 1) {
    const token = tokens[k]!;
    if (
      (token.kind === "word" || token.kind === "string") &&
      tokens[k + 1]!.kind === "dot" &&
      SCHEMA_NAMES.has(token.value.toLowerCase())
    ) {
      return token.value;
    }
  }
  return undefined;
}

/**
 * Wrap a validated statement so every graph table it names is the caller's repo only, and so its
 * row count is bounded. `existingTables` limits the CTE list to tables present in this database:
 * a CTE over a missing table (`vec_symbol_map` on a bare schema) fails to compile even unused.
 * The newlines keep a trailing `-- comment` in the user's SQL from swallowing the closing paren.
 */
export function buildRepoScopedGraphSql(sql: string, existingTables: ReadonlySet<string>, limitParam: string): string {
  const ctes = Object.entries(QUERY_GRAPH_TABLE_SCOPES)
    .filter(([table]) => existingTables.has(table))
    .map(([table, predicate]) => `${table} as not materialized (select * from main.${table} where ${predicate})`);
  const withClause = ctes.length > 0 ? `with ${ctes.join(",\n")}\n` : "";
  return `${withClause}select * from (\n${sql}\n) as mcp_query limit @${limitParam}`;
}

/** One row of `EXPLAIN` output, as better-sqlite3 returns it. */
export type ExplainRow = { opcode: string; p2: number; p3: number };

/**
 * Audit compiled bytecode: every b-tree cursor must be a read cursor on an allowed table or one of
 * its indexes in `main`. Returns the refusal message, or undefined when the plan is in scope.
 * Ephemeral, sorter, pseudo and auto-index cursors hold intermediate results and are not checked.
 */
export function findOutOfScopeRead(
  plan: readonly ExplainRow[],
  allowedRootPages: ReadonlyMap<number, string>
): string | undefined {
  for (const row of plan) {
    switch (row.opcode) {
      case "OpenWrite":
        return "query_graph: the statement opens a write cursor";
      case "VOpen":
        return "query_graph: virtual tables and table-valued functions (pragma_*, *_fts, json_each) are not allowed";
      case "OpenRead":
      case "ReopenIdx":
        if (row.p3 !== 0 || !allowedRootPages.has(row.p2)) {
          return "query_graph: the statement reads a table outside the allowed graph tables";
        }
        break;
      default:
        break;
    }
  }
  return undefined;
}

export function validateAllowedTables(sql: string, allowedTables: Set<string>): SqlGuardrailResult {
  const cleaned = stripStringsAndComments(sql).toLowerCase();
  const tableRefs = [...cleaned.matchAll(/\b(?:from|join)\s+([a-z_][a-z0-9_]*)\b/g)].map((m) => m[1]);

  for (const tableName of tableRefs) {
    if (tableName !== undefined && !allowedTables.has(tableName)) {
      return { ok: false, message: `query_graph: table '${tableName}' is not allowed.` };
    }
  }

  return { ok: true, sanitizedSql: sql };
}
