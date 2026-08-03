/**
 * Read-only SQL guardrail for the `query_graph` tool.
 *
 * The scanner, statement splitter, token matcher and SELECT predicate are shared
 * with postgres-mcp and observe-mcp via `@mcp/shared`. What stays local is this
 * server's own policy: the SQLite token list, the `:repoId` repo-isolation
 * requirement, the table allowlist, and the `query_graph:` error vocabulary.
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
  if (!/:repoId\b/.test(cleaned)) {
    return { ok: false, message: "query_graph: sql must include named parameter :repoId for repo isolation" };
  }

  return { ok: true, sanitizedSql: trimmed.replace(/;\s*$/, "") };
}

export function validateAllowedTables(sql: string, allowedTables: Set<string>): SqlGuardrailResult {
  const cleaned = stripStringsAndComments(sql).toLowerCase();
  const tableRefs = [...cleaned.matchAll(/\b(?:from|join)\s+([a-z_][a-z0-9_]*)\b/g)].map((m) => m[1]);

  for (const tableName of tableRefs) {
    if (tableName !== undefined && !allowedTables.has(tableName)) {
      return { ok: false, message: `query_graph: table '${tableName}' is not allowed` };
    }
  }

  return { ok: true, sanitizedSql: sql };
}
