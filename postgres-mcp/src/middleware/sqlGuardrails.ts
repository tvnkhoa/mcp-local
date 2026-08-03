/**
 * Read-only SQL guardrail for `run_read_query`.
 *
 * The scanner, statement splitter, token matcher and SELECT predicate are shared
 * with observe-mcp and codebase-index-mcp via `@mcp/shared` — they were three
 * hand-copied implementations that had already drifted. What stays local is the
 * part that is genuinely this server's: the Postgres token list, the dialect's
 * string syntax, and the error vocabulary that is part of this tool's contract.
 */

import {
  findForbiddenToken,
  hasMultipleStatements as cleanedHasMultipleStatements,
  isSelectLike,
  stripStringsAndComments as scanAndStrip,
  type SqlScanOptions
} from "@mcp/shared";

/**
 * Postgres has two string forms a naive scanner misses, and both can hide a
 * second statement from every check below:
 *   - `$$…$$` / `$tag$…$tag$` dollar-quoted strings
 *   - `E'…\'…'` escape strings
 * Enabling them here is what closes `SELECT $$'$$; DROP TABLE t`.
 */
const POSTGRES_SCAN: SqlScanOptions = {
  dollarQuotedStrings: true,
  escapeStrings: true
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
  "copy",
  "call",
  "do",
  "vacuum",
  "analyze",
  "reindex",
  "refresh",
  "merge"
] as const;

export type GuardrailError = {
  code: "validation_error";
  message: string;
};

export type GuardrailResult = {
  ok: true;
  sanitizedSql: string;
} | {
  ok: false;
  error: GuardrailError;
};

/** Blank out literals and comments using the Postgres dialect rules. */
export function stripStringsAndComments(sql: string): string {
  return scanAndStrip(sql, POSTGRES_SCAN);
}

/** True when more than one statement is present (one trailing `;` is allowed). */
export function hasMultipleStatements(sql: string): boolean {
  return cleanedHasMultipleStatements(stripStringsAndComments(sql));
}

export function validateReadOnlySql(inputSql: string): GuardrailResult {
  const sql = inputSql.trim();

  if (!sql) {
    return {
      ok: false,
      error: {
        code: "validation_error",
        message: "SQL cannot be empty."
      }
    };
  }

  if (hasMultipleStatements(sql)) {
    return {
      ok: false,
      error: {
        code: "validation_error",
        message: "Only one SQL statement is allowed."
      }
    };
  }

  const noTrailingSemicolon = sql.replace(/;\s*$/, "");
  if (!isSelectLike(noTrailingSemicolon)) {
    return {
      ok: false,
      error: {
        code: "validation_error",
        message: "Only SELECT or WITH ... SELECT queries are allowed."
      }
    };
  }

  const forbidden = findForbiddenToken(stripStringsAndComments(noTrailingSemicolon), FORBIDDEN_TOKENS);
  if (forbidden !== undefined) {
    return {
      ok: false,
      error: {
        code: "validation_error",
        message: `Forbidden SQL token detected: ${forbidden}.`
      }
    };
  }

  return {
    ok: true,
    sanitizedSql: noTrailingSemicolon
  };
}
