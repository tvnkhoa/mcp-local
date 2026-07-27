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
  let out = "";
  let i = 0;

  while (i < sql.length) {
    const c = sql[i];
    const next = sql[i + 1];

    if (c === "'" || c === '"') {
      const quote = c;
      out += " ";
      i += 1;
      while (i < sql.length) {
        if (sql[i] === quote) {
          if (sql[i + 1] === quote) {
            i += 2;
            continue;
          }
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }

    if (c === "-" && next === "-") {
      i += 2;
      while (i < sql.length && sql[i] !== "\n") {
        i += 1;
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
        i += 1;
      }
      out += " ";
      continue;
    }

    out += c;
    i += 1;
  }

  return out;
}

function hasMultipleStatements(sql: string): boolean {
  const cleaned = stripStringsAndComments(sql).trim();
  if (!cleaned) {
    return false;
  }

  const semicolonCount = (cleaned.match(/;/g) || []).length;
  if (semicolonCount === 0) {
    return false;
  }

  if (semicolonCount === 1 && cleaned.endsWith(";")) {
    return cleaned.slice(0, -1).includes(";");
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

export function validateReadOnlyGraphSql(sql: string): SqlGuardrailResult {
  const trimmed = sql.trim();
  const cleaned = stripStringsAndComments(trimmed);
  if (!trimmed) {
    return { ok: false, message: "query_graph: sql must not be empty" };
  }

  if (hasMultipleStatements(trimmed)) {
    return { ok: false, message: "query_graph: multiple SQL statements are not allowed" };
  }

  if (!/^\s*(with\b[\s\S]*?\bselect\b|select\b)/i.test(cleaned)) {
    return { ok: false, message: "query_graph: only SELECT queries are allowed" };
  }

  const forbidden = findForbiddenToken(trimmed);
  if (forbidden) {
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
    if (!allowedTables.has(tableName)) {
      return { ok: false, message: `query_graph: table '${tableName}' is not allowed` };
    }
  }

  return { ok: true, sanitizedSql: sql };
}
