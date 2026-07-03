// Read-only SQL guard for the raw-query escape hatch. Ported from
// postgres-mcp/src/sqlGuardrails.ts. OpenObserve's _search only accepts SELECT,
// but we validate defensively so a bad query is rejected before it leaves the process.

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

const SELECT_LIKE = /^\s*(with\b[\s\S]*?\bselect\b|select\b)/i;

export function stripStringsAndComments(sql: string): string {
  let out = "";
  let i = 0;

  while (i < sql.length) {
    const c = sql[i];
    const next = sql[i + 1];

    if (c === "'" || c === '"') {
      const quote = c;
      out += " ";
      i++;
      while (i < sql.length) {
        const ch = sql[i];
        if (ch === quote) {
          if (sql[i + 1] === quote) {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      continue;
    }

    if (c === "-" && next === "-") {
      i += 2;
      while (i < sql.length && sql[i] !== "\n") {
        i++;
      }
      out += " ";
      continue;
    }

    if (c === "/" && next === "*") {
      i += 2;
      while (i < sql.length - 1) {
        if (sql[i] === "*" && sql[i + 1] === "/") {
          i += 2;
          break;
        }
        i++;
      }
      out += " ";
      continue;
    }

    out += c;
    i++;
  }

  return out;
}

export function hasMultipleStatements(sql: string): boolean {
  const cleaned = stripStringsAndComments(sql).trim();
  if (cleaned.length === 0) {
    return false;
  }
  const semicolonCount = (cleaned.match(/;/g) || []).length;
  if (semicolonCount === 0) {
    return false;
  }
  if (semicolonCount === 1 && cleaned.endsWith(";")) {
    return cleaned.slice(0, -1).trim().includes(";");
  }
  return true;
}

function findForbiddenToken(sql: string): string | null {
  const cleaned = stripStringsAndComments(sql).toLowerCase();
  for (const token of FORBIDDEN_TOKENS) {
    if (new RegExp(`\\b${token}\\b`, "i").test(cleaned)) {
      return token;
    }
  }
  return null;
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
  if (!SELECT_LIKE.test(noTrailingSemicolon)) {
    return {
      ok: false,
      error: { code: "validation_error", message: "Only SELECT or WITH ... SELECT queries are allowed." }
    };
  }

  const forbidden = findForbiddenToken(noTrailingSemicolon);
  if (forbidden) {
    return {
      ok: false,
      error: { code: "validation_error", message: `Forbidden SQL token detected: ${forbidden}.` }
    };
  }

  return { ok: true, sanitizedSql: noTrailingSemicolon };
}
