/**
 * Read-only SQL guardrails.
 *
 * MECHANISM ONLY. This module never ships a forbidden-token list — the caller
 * supplies a dialect policy. That is deliberate: the platform audit found three
 * hand-copied variants of this logic whose token lists had silently diverged
 * (Postgres forbade 18 tokens, the OpenObserve copy 13). Parameterizing the
 * policy makes divergence an explicit, reviewable data change instead of an
 * invisible fork.
 */

import type { PlatformError, Result } from "@mcp/core";
import { err, ok, validationError } from "@mcp/core";

export interface SqlDialectPolicy {
  /** Dialect label used in error details, e.g. "postgres". */
  readonly name: string;
  /** Bare words that may not appear anywhere outside a string or comment. */
  readonly forbiddenTokens: readonly string[];
  /** Statement must begin with one of these, e.g. ["select", "with"]. */
  readonly allowedLeadingKeywords: readonly string[];
  /** Permit exactly one trailing semicolon. Default true. */
  readonly allowTrailingSemicolon?: boolean;
  /** Reject statements longer than this many characters. Default 100_000. */
  readonly maxLength?: number;
}

export interface SqlValidationSuccess {
  /** The statement with any single trailing semicolon removed. */
  readonly sanitizedSql: string;
  readonly dialect: string;
}

export type SqlValidation = Result<SqlValidationSuccess, PlatformError>;

export interface SqlScan {
  /** Literals and comments replaced by spaces; offsets and newlines preserved. */
  readonly cleaned: string;
  /** True when a literal or comment was never closed. */
  readonly unterminated: boolean;
}

/** Opening delimiter of a dollar-quoted string: `$$` or `$tag$`. */
const DOLLAR_TAG = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/;

/**
 * Blank out string literals and comments so token scanning cannot be defeated
 * by hiding a keyword inside a quoted value.
 *
 * Handles, in order of how easily each defeats a naive scanner:
 *   - dollar-quoted strings (`$$…$$`, `$tag$…$tag$`) — Postgres-specific and
 *     the reason this function exists in its current form. An apostrophe inside
 *     `$$…$$` would otherwise open a phantom single-quoted string that swallows
 *     the rest of the statement, hiding a second statement from every check.
 *   - escape strings (`E'…\'…'`), where a backslash escapes the delimiter
 *   - standard literals with doubled-quote escaping (`'it''s'`)
 *   - line and block comments
 *
 * `$1`-style parameter placeholders are left alone: the tag pattern requires a
 * closing `$`, which a placeholder does not have.
 */
export function scanSql(sql: string): SqlScan {
  let output = "";
  let index = 0;
  let unterminated = false;

  const blankTo = (end: number): void => {
    const stop = Math.min(end, sql.length);
    for (let cursor = index; cursor < stop; cursor += 1) {
      output += sql[cursor] === "\n" ? "\n" : " ";
    }
    index = stop;
  };

  while (index < sql.length) {
    const char = sql[index] as string;
    const next = index + 1 < sql.length ? (sql[index + 1] as string) : "";

    // Line comment: -- ... end of line
    if (char === "-" && next === "-") {
      const end = sql.indexOf("\n", index);
      blankTo(end === -1 ? sql.length : end);
      continue;
    }

    // Block comment: /* ... */
    if (char === "/" && next === "*") {
      const end = sql.indexOf("*/", index + 2);
      if (end === -1) {
        unterminated = true;
        blankTo(sql.length);
      } else {
        blankTo(end + 2);
      }
      continue;
    }

    // Dollar-quoted string: $$ ... $$ or $tag$ ... $tag$
    if (char === "$") {
      const match = DOLLAR_TAG.exec(sql.slice(index));
      if (match !== null) {
        const tag = match[0];
        const end = sql.indexOf(tag, index + tag.length);
        if (end === -1) {
          unterminated = true;
          blankTo(sql.length);
        } else {
          blankTo(end + tag.length);
        }
        continue;
      }
    }

    // Single- or double-quoted literal / quoted identifier
    if (char === "'" || char === '"') {
      const quote = char;
      // E'...' enables backslash escapes for the delimiter.
      const isEscapeString =
        quote === "'" && index > 0 && (sql[index - 1] === "E" || sql[index - 1] === "e");
      let closed = false;

      output += " ";
      index += 1;

      while (index < sql.length) {
        const current = sql[index] as string;

        if (isEscapeString && current === "\\" && index + 1 < sql.length) {
          output += "  ";
          index += 2;
          continue;
        }
        // Doubled quote is an escaped quote, not a terminator.
        if (current === quote && sql[index + 1] === quote) {
          output += "  ";
          index += 2;
          continue;
        }
        if (current === quote) {
          output += " ";
          index += 1;
          closed = true;
          break;
        }
        output += current === "\n" ? "\n" : " ";
        index += 1;
      }

      if (!closed) {
        unterminated = true;
      }
      continue;
    }

    output += char;
    index += 1;
  }

  return { cleaned: output, unterminated };
}

/** Convenience wrapper around {@link scanSql} returning only the cleaned text. */
export function stripStringsAndComments(sql: string): string {
  return scanSql(sql).cleaned;
}

/** True when the statement contains more than one statement separator. */
export function hasMultipleStatements(cleanedSql: string, allowTrailingSemicolon = true): boolean {
  const trimmed = cleanedSql.trim();
  const count = (trimmed.match(/;/g) ?? []).length;
  if (count === 0) {
    return false;
  }
  if (count === 1 && allowTrailingSemicolon && trimmed.endsWith(";")) {
    return trimmed.slice(0, -1).trim().includes(";");
  }
  return true;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Word-boundary matcher for a policy token.
 *
 * Tokens are escaped, so a policy may legitimately list something like
 * `pg_read_file(` or `dblink(` without the regex metacharacters turning every
 * query into an unhandled SyntaxError. Boundaries are applied only on the sides
 * where the token actually starts or ends with a word character.
 */
function tokenPattern(token: string): RegExp {
  const prefix = /^\w/.test(token) ? "\\b" : "";
  const suffix = /\w$/.test(token) ? "\\b" : "";
  return new RegExp(`${prefix}${escapeRegExp(token)}${suffix}`, "i");
}

/** First forbidden token present in the cleaned statement, if any. */
export function findForbiddenToken(
  cleanedSql: string,
  forbiddenTokens: readonly string[]
): string | undefined {
  for (const token of forbiddenTokens) {
    if (tokenPattern(token).test(cleanedSql)) {
      return token;
    }
  }
  return undefined;
}

/** True when the statement starts with one of the permitted keywords. */
export function startsWithAllowedKeyword(
  cleanedSql: string,
  allowedLeadingKeywords: readonly string[]
): boolean {
  const trimmed = cleanedSql.trim().toLowerCase();
  return allowedLeadingKeywords.some((keyword) =>
    new RegExp(`^${escapeRegExp(keyword.toLowerCase())}\\b`).test(trimmed)
  );
}

export type ReadOnlySqlValidator = (sql: string) => SqlValidation;

/**
 * Build a validator bound to one dialect policy.
 *
 * Order of checks matters: shape errors are reported before token errors so the
 * caller gets the most actionable message.
 */
export function createReadOnlySqlValidator(policy: SqlDialectPolicy): ReadOnlySqlValidator {
  if (policy.allowedLeadingKeywords.length === 0) {
    throw new Error("createReadOnlySqlValidator: allowedLeadingKeywords must not be empty");
  }
  const allowTrailingSemicolon = policy.allowTrailingSemicolon ?? true;
  const maxLength = policy.maxLength ?? 100_000;

  return (sql: string): SqlValidation => {
    if (typeof sql !== "string" || sql.trim() === "") {
      return err(validationError("SQL cannot be empty.", { dialect: policy.name }));
    }
    if (sql.length > maxLength) {
      return err(
        validationError(`SQL exceeds the maximum length of ${maxLength} characters.`, {
          dialect: policy.name,
          length: sql.length
        })
      );
    }

    const scan = scanSql(sql);
    const trimmed = scan.cleaned.trim();

    // An unclosed literal or comment means the scanner could not see the whole
    // statement, so no downstream check can be trusted. Refuse rather than
    // guess — the database would reject it as a syntax error anyway.
    if (scan.unterminated) {
      return err(
        validationError("SQL contains an unterminated string literal or comment.", {
          dialect: policy.name
        })
      );
    }

    if (trimmed === "") {
      return err(validationError("SQL contains no executable statement.", { dialect: policy.name }));
    }

    if (hasMultipleStatements(trimmed, allowTrailingSemicolon)) {
      return err(validationError("Only one SQL statement is allowed.", { dialect: policy.name }));
    }

    if (!startsWithAllowedKeyword(trimmed, policy.allowedLeadingKeywords)) {
      const allowed = policy.allowedLeadingKeywords.join(" / ").toUpperCase();
      return err(
        validationError(`Only ${allowed} queries are allowed.`, { dialect: policy.name })
      );
    }

    const forbidden = findForbiddenToken(trimmed, policy.forbiddenTokens);
    if (forbidden !== undefined) {
      return err(
        validationError(`Forbidden SQL token detected: ${forbidden}.`, {
          dialect: policy.name,
          token: forbidden
        })
      );
    }

    const withoutTrailingSemicolon = sql.trim().endsWith(";") ? sql.trim().slice(0, -1).trim() : sql.trim();

    return ok({ sanitizedSql: withoutTrailingSemicolon, dialect: policy.name });
  };
}
