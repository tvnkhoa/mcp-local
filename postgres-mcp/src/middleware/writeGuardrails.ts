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
      /**
       * The statement carries its own RETURNING. Rollback capture needs to own that
       * clause (it appends `returning *, xmin`), so this makes rollback unsupported.
       */
      hasReturning: boolean;
      /**
       * `ON CONFLICT … DO UPDATE` specifically — **not** `DO NOTHING`. DO UPDATE can
       * modify a row that already existed, and RETURNING hands that row back
       * indistinguishable from a freshly inserted one, so deleting it on rollback
       * would destroy data the write never created. DO NOTHING is safe: its RETURNING
       * yields only rows that were actually inserted.
       */
      hasOnConflictUpdate: boolean;
      /**
       * Columns assigned by an UPDATE's SET list, `[]` for INSERT/DELETE, and **`null`
       * when the list could not be parsed with confidence**. A caller using this to decide
       * whether a primary key is being assigned must read `null` as "unknown" and refuse —
       * never as "no PK columns". Unquoted names are folded to lower case the way Postgres
       * folds them, so they compare directly against `pg_attribute.attname`.
       */
      setColumns: string[] | null;
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

/**
 * A SET target read as one identifier and folded the way Postgres folds it — an unquoted
 * name to lower case, a quoted one kept verbatim (with a doubled quote unescaped) — or
 * `null` when the text is not a lone identifier.
 *
 * The `null` case is load-bearing, not defensive. Boundaries come from the masked text but
 * the text itself is sliced from the ORIGINAL, so anything the mask blanked is still
 * present here. A block comment between `set` and the column name would otherwise be read
 * as part of the name, which matches no primary key and so quietly disarms the guard that
 * refuses rollback for a PK-assigning UPDATE. Postgres does not accept a qualified SET
 * target (`update t set t.a = 1` is an error), so a lone identifier is the whole of the
 * valid grammar and rejecting anything else costs nothing correct.
 */
function readIdent(raw: string): string | null {
  const trimmed = raw.trim();
  if (/^"(?:[^"]|"")+"$/.test(trimmed)) {
    return trimmed.slice(1, -1).replace(/""/g, '"');
  }
  // Postgres unquoted identifiers: a letter (any alphabet) or underscore, then letters,
  // digits, underscores or dollar signs.
  if (/^[\p{L}_][\p{L}\p{N}_$]*$/u.test(trimmed)) {
    return trimmed.toLowerCase();
  }
  return null;
}

/**
 * Ranges between commas that sit at parenthesis depth 0.
 *
 * Ranges, not substrings: every boundary in this parser is found in the masked text
 * (where literals and comments are blanked) and then applied to the original, which
 * is the same length. Splitting the original directly would break on a comma inside
 * a string value — `set note = 'a, b'`.
 */
function splitTopLevelRanges(masked: string, start: number, end: number): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let depth = 0;
  let from = start;
  for (let i = start; i < end; i += 1) {
    const char = masked[i];
    if (char === "(") {
      depth += 1;
    } else if (char === ")") {
      depth = Math.max(0, depth - 1);
    } else if (char === "," && depth === 0) {
      ranges.push([from, i]);
      from = i + 1;
    }
  }
  ranges.push([from, end]);
  return ranges;
}

/** Index of the first depth-0 `char` in `masked[start, end)`, or -1. */
function indexAtTopLevel(masked: string, start: number, end: number, char: string): number {
  let depth = 0;
  for (let i = start; i < end; i += 1) {
    const current = masked[i];
    // Tested before the depth bookkeeping, so searching for "(" finds the opening
    // paren itself rather than stepping over it.
    if (current === char && depth === 0) {
      return i;
    }
    if (current === "(") {
      depth += 1;
    } else if (current === ")") {
      depth = Math.max(0, depth - 1);
    }
  }
  return -1;
}

/**
 * Index of the first depth-0 occurrence of one of `keywords`, or `masked.length`.
 * Depth matters: the `from` in `where id in (select id from other)` does not end the
 * SET list, and treating it as the end would truncate the parsed column list.
 */
function findAtTopLevel(masked: string, from: number, keywords: RegExp): number {
  let depth = 0;
  for (let i = from; i < masked.length; i += 1) {
    const char = masked[i] as string;
    if (char === "(") {
      depth += 1;
      continue;
    }
    if (char === ")") {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth !== 0) {
      continue;
    }
    const prev = i > 0 ? (masked[i - 1] as string) : " ";
    if (!/[\w$]/.test(prev) && keywords.test(masked.slice(i))) {
      return i;
    }
  }
  return masked.length;
}

const SET_LIST_END = /^(from|where|returning)\b/i;

/**
 * Column names assigned by an UPDATE's SET list, or `null` if any target could not be
 * read as a lone identifier — see {@link readIdent} for why that distinction matters.
 *
 * Boundaries are found in `masked` (same length as the original, literals and
 * comments blanked) and the text is then sliced out of the ORIGINAL, so a quoted
 * identifier like `"Name"` survives — `masked` has blanked it.
 */
function extractSetColumns(originalSql: string, masked: string): string[] | null {
  const setMatch = /\bset\b/i.exec(masked);
  if (!setMatch) {
    return [];
  }
  const start = setMatch.index + setMatch[0].length;
  const end = findAtTopLevel(masked, start, SET_LIST_END);

  const columns: string[] = [];
  for (const [from, to] of splitTopLevelRanges(masked, start, end)) {
    const eq = indexAtTopLevel(masked, from, to, "=");
    if (eq < 0) {
      continue;
    }
    const open = indexAtTopLevel(masked, from, eq, "(");
    if (open >= 0) {
      // Multi-column form: `set (a, b) = (row(...))` / `= (select …)`.
      const close = masked.lastIndexOf(")", eq);
      if (close <= open) {
        return null;
      }
      for (const [innerFrom, innerTo] of splitTopLevelRanges(masked, open + 1, close)) {
        const name = readIdent(originalSql.slice(innerFrom, innerTo));
        if (name === null) {
          return null;
        }
        columns.push(name);
      }
      continue;
    }
    const name = readIdent(originalSql.slice(from, eq));
    if (name === null) {
      return null;
    }
    columns.push(name);
  }
  return columns;
}

/**
 * True for `ON CONFLICT … DO UPDATE` only. The conflict action is whichever of
 * `DO UPDATE` / `DO NOTHING` comes first after `ON CONFLICT`.
 */
function hasOnConflictDoUpdate(masked: string): boolean {
  const conflict = /\bon\s+conflict\b/i.exec(masked);
  if (!conflict) {
    return false;
  }
  const action = /\bdo\s+(update|nothing)\b/i.exec(masked.slice(conflict.index + conflict[0].length));
  return action !== null && action[1].toLowerCase() === "update";
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

  return {
    ok: true,
    statementType,
    sanitizedSql: noTrailingSemicolon,
    target,
    hasWhere,
    hasReturning: /\breturning\b/i.test(stripped),
    hasOnConflictUpdate: statementType === "insert" && hasOnConflictDoUpdate(stripped),
    setColumns: statementType === "update" ? extractSetColumns(noTrailingSemicolon, stripped) : []
  };
}
