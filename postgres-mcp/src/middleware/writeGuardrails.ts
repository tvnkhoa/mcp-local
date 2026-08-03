import { hasMultipleStatements, stripStringsAndComments } from "./sqlGuardrails.js";

export type WriteStatementType = "insert" | "update" | "delete";

export interface WriteTarget {
  schema: string;
  table: string;
}

export type WriteGuardrailResult =
  | {
      ok: true;
      statementType: WriteStatementType;
      sanitizedSql: string;
      target: WriteTarget;
      hasWhere: boolean;
    }
  | {
      ok: false;
      error: { code: string; message: string };
    };

function fail(code: string, message: string): WriteGuardrailResult {
  return { ok: false, error: { code, message } };
}

/** Parse a (possibly schema-qualified, possibly quoted) table identifier. */
function parseTableIdentifier(raw: string): WriteTarget | null {
  const cleaned = raw.trim().replace(/"/g, "");
  if (!cleaned) {
    return null;
  }
  const parts = cleaned.split(".");
  if (parts.length === 1) {
    return { schema: "public", table: parts[0] };
  }
  // schema.table (ignore catalog prefix if present)
  return { schema: parts[parts.length - 2], table: parts[parts.length - 1] };
}

function extractTarget(type: WriteStatementType, stripped: string): WriteTarget | null {
  if (type === "insert") {
    const m = /\binsert\s+into\s+([A-Za-z0-9_."]+)/i.exec(stripped);
    return m ? parseTableIdentifier(m[1]) : null;
  }
  if (type === "update") {
    const m = /\bupdate\s+(?:only\s+)?([A-Za-z0-9_."]+)/i.exec(stripped);
    return m ? parseTableIdentifier(m[1]) : null;
  }
  // delete
  const m = /\bdelete\s+from\s+(?:only\s+)?([A-Za-z0-9_."]+)/i.exec(stripped);
  return m ? parseTableIdentifier(m[1]) : null;
}

/**
 * Validate a single-statement DML write (INSERT / UPDATE / DELETE).
 *
 * Rules:
 *  - exactly one statement
 *  - must start with insert / update / delete (DDL is rejected — DDL only flows through migrations)
 *  - UPDATE / DELETE must contain a WHERE clause unless `allowFullTable` is true
 *
 * The WHERE check is a heuristic safety net (it scans the comment/string-stripped
 * text), not a full parser; it exists to block accidental whole-table writes.
 */
export function validateWriteSql(inputSql: string, allowFullTable: boolean): WriteGuardrailResult {
  const sql = inputSql.trim();
  if (!sql) {
    return fail("validation_error", "SQL cannot be empty.");
  }

  if (hasMultipleStatements(sql)) {
    return fail("validation_error", "Only one SQL statement is allowed.");
  }

  const noTrailingSemicolon = sql.replace(/;\s*$/, "");
  const stripped = stripStringsAndComments(noTrailingSemicolon);
  const lead = stripped.trimStart().toLowerCase();

  let statementType: WriteStatementType;
  if (lead.startsWith("insert")) {
    statementType = "insert";
  } else if (lead.startsWith("update")) {
    statementType = "update";
  } else if (lead.startsWith("delete")) {
    statementType = "delete";
  } else if (lead.startsWith("select") || lead.startsWith("with")) {
    return fail("NOT_A_WRITE", "Use run_read_query for SELECT / WITH ... SELECT statements.");
  } else {
    return fail("DDL_NOT_ALLOWED", "DDL is not allowed here. Schema changes must go through the migration tools.");
  }

  // Note: we deliberately do NOT scan for a blocklist of DDL keywords here. The
  // leading-keyword check above pins the statement to INSERT/UPDATE/DELETE, and
  // hasMultipleStatements() already rejects any smuggled second statement, so a
  // standalone DDL/DCL command cannot reach this point. A blanket `\bkeyword\b`
  // scan would instead false-positive on ordinary identifiers (a column named
  // `comment`/`copy`/`analyze`, or `ON CONFLICT DO NOTHING`) and reject valid DML.

  const hasWhere = /\bwhere\b/i.test(stripped);
  if ((statementType === "update" || statementType === "delete") && !hasWhere && !allowFullTable) {
    return fail(
      "MISSING_WHERE",
      `${statementType.toUpperCase()} without a WHERE clause is blocked. Add a WHERE, or pass allowFullTable:true to intentionally affect the whole table.`
    );
  }

  // Extract the target from the ORIGINAL text (not `stripped`) so quoted identifiers
  // like "Schema"."Tbl" survive — stripStringsAndComments blanks double-quotes.
  const target = extractTarget(statementType, noTrailingSemicolon);
  if (!target) {
    return fail("TARGET_NOT_FOUND", "Could not determine the target table for this statement.");
  }

  return { ok: true, statementType, sanitizedSql: noTrailingSemicolon, target, hasWhere };
}
