/**
 * Read-only SQL guard for the raw-query escape hatch.
 *
 * OpenObserve's `_search` only accepts SELECT, but we validate defensively so a
 * bad query is rejected before it leaves the process. The scanner, statement
 * splitter, token matcher and SELECT predicate are shared with postgres-mcp and
 * codebase-index-mcp via `@mcp/shared`; the token list and error vocabulary stay
 * local because they are this server's contract.
 */

import {
  findForbiddenToken,
  hasMultipleStatements as cleanedHasMultipleStatements,
  isSelectLike,
  stripStringsAndComments as scanAndStrip,
  type SqlScanOptions
} from "@mcp/shared";

/**
 * OpenObserve queries are parsed by DataFusion, which has neither dollar-quoted
 * strings nor `E'…'` escape strings. Scanning for them would blank out real
 * statement text — `$` and a stray `E` before a quote are ordinary characters
 * here — so both are off. This keeps the guard byte-identical to its behaviour
 * before extraction.
 */
const DATAFUSION_SCAN: SqlScanOptions = {
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
  "copy",
  "call",
  "vacuum",
  "merge"
] as const;

export type GuardrailResult = {
  ok: true;
  sanitizedSql: string;
} | {
  ok: false;
  error: { code: "validation_error"; message: string };
};

export function stripStringsAndComments(sql: string): string {
  return scanAndStrip(sql, DATAFUSION_SCAN);
}

export function hasMultipleStatements(sql: string): boolean {
  return cleanedHasMultipleStatements(stripStringsAndComments(sql));
}

export function validateReadOnlySql(inputSql: string): GuardrailResult {
  const sql = inputSql.trim();

  if (!sql) {
    return { ok: false, error: { code: "validation_error", message: "SQL cannot be empty." } };
  }
  if (hasMultipleStatements(sql)) {
    return { ok: false, error: { code: "validation_error", message: "Only one SQL statement is allowed." } };
  }

  const noTrailingSemicolon = sql.replace(/;\s*$/, "");
  if (!isSelectLike(noTrailingSemicolon)) {
    return {
      ok: false,
      error: { code: "validation_error", message: "Only SELECT or WITH ... SELECT queries are allowed." }
    };
  }

  const forbidden = findForbiddenToken(stripStringsAndComments(noTrailingSemicolon), FORBIDDEN_TOKENS);
  if (forbidden !== undefined) {
    return {
      ok: false,
      error: { code: "validation_error", message: `Forbidden SQL token detected: ${forbidden}.` }
    };
  }

  return { ok: true, sanitizedSql: noTrailingSemicolon };
}
