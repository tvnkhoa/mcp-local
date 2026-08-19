/**
 * The read-only guardrail for `run_read_query` and `profile_table`.
 *
 * Mechanism comes from `@mcp/shared/sql` — the literal/comment scanner, the statement splitter, the
 * token matcher, the SELECT predicate. What is local is the part that is genuinely T-SQL: the
 * scanner's dialect switches, the token list, the four-part-name rule, and the error vocabulary,
 * which is part of this tool's contract.
 *
 * The token list is deliberately different from `postgres-mcp`'s. Per ADR-0002 that difference has
 * to be argued rather than inherited, and it is: see `docs/decisions/0004-tsql-guardrail-policy.md`.
 */

import {
  findForbiddenToken,
  hasMultipleStatements as cleanedHasMultipleStatements,
  isSelectLike,
  scanSql,
  type SqlScanOptions
} from "@mcp/shared";

/**
 * The three dialect switches, all three of which differ from the Postgres defaults.
 *
 * Getting these wrong does not merely change behaviour, it *weakens* the guard. `scanSql` blanks
 * out whatever it believes is a string, so claiming a syntax the engine lacks erases real statement
 * text — and a forbidden token sitting in the erased span disappears from the token check.
 *
 *  - `dollarQuotedStrings` — Postgres `$$…$$`. T-SQL has no such form; `$` is an ordinary
 *    character (and a legal identifier character). Must be OFF.
 *  - `escapeStrings` — Postgres `E'…\'…'`. T-SQL does not treat a backslash as an escape inside a
 *    string literal at all. Must be OFF.
 *  - `bracketQuotedIdentifiers` — T-SQL `[Update]`. Must be ON, or every legal read of a column
 *    whose name is a reserved word is refused. Added to `@mcp/shared` for this server.
 */
const TSQL_SCAN: SqlScanOptions = {
  dollarQuotedStrings: false,
  escapeStrings: false,
  bracketQuotedIdentifiers: true
};

/**
 * The same scan with brackets left intact, for the checks that reason about object *names*.
 *
 * Blanking `[…]` is right for the token check and wrong for the shape checks, and conflating the
 * two was a real bypass: with brackets blanked, `[srv].[db].[dbo].[t]` contains no word characters
 * at all, so the four-part-name pattern matched nothing and a linked-server read sailed through.
 * Name-shape checks run on {@link normalizeNames} instead.
 */
const TSQL_SCAN_KEEP_BRACKETS: SqlScanOptions = {
  dollarQuotedStrings: false,
  escapeStrings: false,
  bracketQuotedIdentifiers: false
};

/** A whole bracketed identifier, `]]` included, so it can be treated as one name part. */
const BRACKETED = /\[(?:[^\]]|\]\])*\]/g;

/**
 * Reduce each bracketed identifier to a single placeholder word.
 *
 * Not simply "strip the brackets": a bracketed name may legally contain a dot, and removing the
 * delimiters would turn `[my.db].dbo.t` — two parts — into something that reads as three. Replacing
 * the whole identifier with one word keeps the *part count* honest in both directions.
 */
function normalizeNames(sql: string): string {
  return scanSql(sql, TSQL_SCAN_KEEP_BRACKETS).cleaned.replace(BRACKETED, "x");
}

/**
 * Bare words that may not appear outside a string, comment, or bracketed identifier.
 *
 * Grouped by what each group actually prevents, because a flat list invites additions nobody can
 * justify later.
 */
const FORBIDDEN_TOKENS = [
  // Data and schema change.
  "insert",
  "update",
  "delete",
  "truncate",
  "merge",
  "alter",
  "drop",
  "create",
  "grant",
  "revoke",
  "deny",
  // `SELECT … INTO #t` creates a table. It is the one write that does not start with a write verb.
  "into",
  // Anything that runs something else. The exec lane does not come through this validator — it
  // takes a routine name and typed parameters, never statement text.
  "exec",
  "execute",
  "sp_executesql",
  // Reaching another server. The audit that motivated this server measured ZERO uses of these
  // across 2,106 SQL files, so forbidding them costs nothing and removes the whole class of
  // "read a remote system through the database" from the tool's reach.
  "openquery",
  "openrowset",
  "opendatasource",
  "openxml",
  // Instance administration and denial of service.
  "shutdown",
  "dbcc",
  "backup",
  "restore",
  "kill",
  "waitfor",
  "reconfigure",
  "sp_configure",
  "xp_cmdshell",
  "bulk"
] as const;

/**
 * A four-part name — `server.database.schema.object` — reaches a linked server.
 *
 * Not expressible as a token, so it is matched as a shape. Note what this must NOT catch: the
 * three-part name `Database.dbo.Table`, which is how every cross-catalog read in the target
 * deployment is written (~4,000 occurrences). Blocking that would make the server useless, so the
 * pattern requires a fourth segment and is anchored on word boundaries.
 *
 * Known and accepted false positive: `Database.schema.Table.Column` is also legal T-SQL and is
 * indistinguishable from a linked-server reference by shape alone. A survey of the 2,106-file SQL
 * corpus this server was designed against found **no** real four-part object reference — every
 * match was a permission code or a hostname inside a string literal, and literals are blanked
 * before this test runs. The error message names the one-line workaround.
 */
const FOUR_PART_NAME = /\b[A-Za-z_]\w*\.[A-Za-z_]\w*\.[A-Za-z_]\w*\.[A-Za-z_]\w*\b/;

export type GuardrailResult =
  | { readonly ok: true; readonly sanitizedSql: string }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } };

function reject(code: string, message: string): GuardrailResult {
  return { ok: false, error: { code, message } };
}

/** Blank out literals, comments and bracketed identifiers using T-SQL rules. */
export function stripStringsAndComments(sql: string): string {
  return scanSql(sql, TSQL_SCAN).cleaned;
}

/** True when more than one statement is present (a single trailing `;` is allowed). */
export function hasMultipleStatements(sql: string): boolean {
  return cleanedHasMultipleStatements(stripStringsAndComments(sql));
}

/**
 * Accept a single read-only T-SQL statement, or explain why not.
 *
 * Check order is deliberate: shape problems are reported before token problems, so the caller gets
 * the most actionable message rather than a confusing one about a keyword.
 */
export function validateReadOnlySql(inputSql: string, maxLength = 100_000): GuardrailResult {
  const sql = typeof inputSql === "string" ? inputSql.trim() : "";

  if (sql === "") {
    return reject("validation_error", "SQL cannot be empty.");
  }
  if (sql.length > maxLength) {
    return reject(
      "validation_error",
      `SQL exceeds the maximum length of ${maxLength} characters.`
    );
  }

  const scan = scanSql(sql, TSQL_SCAN);
  const cleaned = scan.cleaned.trim();

  // An unclosed literal, comment or bracket means the scanner could not see the whole statement,
  // so nothing below can be trusted. Refuse rather than guess — the server would reject it as a
  // syntax error anyway.
  if (scan.unterminated) {
    return reject(
      "validation_error",
      "SQL contains an unterminated string literal, comment, or [bracketed identifier]."
    );
  }
  if (cleaned === "") {
    return reject("validation_error", "SQL contains no executable statement.");
  }
  if (cleanedHasMultipleStatements(cleaned)) {
    return reject("validation_error", "Only one SQL statement is allowed.");
  }

  // `isSelectLike` rather than a leading-keyword test: `WITH c AS (DELETE … OUTPUT deleted.*)
  // SELECT * FROM c` starts with an allowed keyword and is a write. This predicate requires the
  // `WITH` to reach a `SELECT`, and the `delete` token below finishes the job.
  if (!isSelectLike(cleaned)) {
    return reject("validation_error", "Only SELECT / WITH … SELECT queries are allowed.");
  }

  // On the bracket-preserving form: a bracketed segment still counts as a name part here.
  if (FOUR_PART_NAME.test(normalizeNames(sql))) {
    return reject(
      "policy_violation",
      "Four-part names (server.database.schema.object) reach a linked server and are not allowed. " +
        "Three-part names (database.schema.object) on this instance are fine. If you meant " +
        "database.schema.table.column, alias the table and reference alias.column."
    );
  }

  const forbidden = findForbiddenToken(cleaned, FORBIDDEN_TOKENS);
  if (forbidden !== undefined) {
    return reject("validation_error", `Forbidden SQL token detected: ${forbidden}.`);
  }

  return { ok: true, sanitizedSql: sql.endsWith(";") ? sql.slice(0, -1).trim() : sql };
}

/** One name part: a bracketed identifier, or a bare one. */
const NAME_PART = String.raw`(?:\[(?:[^\]]|\]\])*\]|[A-Za-z_]\w*)`;

/** `a.b.c`, capturing the first segment. The lookbehind stops it matching mid-name. */
const THREE_PART_NAME = new RegExp(
  String.raw`(?<![\w\].])(${NAME_PART})\s*\.\s*${NAME_PART}\s*\.\s*${NAME_PART}`,
  "g"
);

function unquoteIdentifier(part: string): string {
  return part.startsWith("[") ? part.slice(1, -1).replace(/]]/g, "]") : part;
}

/**
 * First segments of every three-part name in the statement, lower-cased and deduplicated.
 *
 * **Candidates, not conclusions.** `Database.dbo.Table` and `dbo.Table.Column` are the same shape,
 * so this returns `dbo` too. Deciding which candidates are real catalogs needs the instance's
 * catalog list, which is why the allowlist check lives in the query tool rather than here — a
 * guardrail that refused `dbo.Customer.Name` would be worse than the gap it closes.
 */
export function referencedCatalogCandidates(sql: string): string[] {
  const cleaned = scanSql(sql, TSQL_SCAN_KEEP_BRACKETS).cleaned;
  const found = new Set<string>();
  for (const match of cleaned.matchAll(THREE_PART_NAME)) {
    found.add(unquoteIdentifier(match[1] as string).toLowerCase());
  }
  return [...found];
}
