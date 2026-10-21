/**
 * Token-level SQL reference scanner (MCP-ISSUE-082).
 *
 * Reads table, column and function NAMES out of a query the AST parser is not given or cannot read:
 * a string literal passed to `client.query(…)` in TypeScript, a PL/pgSQL function body, a `DO` block,
 * a policy's `USING (…)` expression. It works on the tokens of `sqlLexer.ts`, so a name inside a
 * string literal or a comment is never read as a reference.
 *
 * What it claims, and nothing more:
 *
 * - **tables** — the name after `FROM` / `JOIN` (every item of a comma-separated `FROM` list),
 *   `INSERT INTO` / `MERGE INTO`, `UPDATE` (not `FOR UPDATE`, `DO UPDATE`, `ON UPDATE`),
 *   `DELETE FROM`, `TRUNCATE [TABLE]`, `LOCK TABLE` and a statement-level `TABLE x`. A CTE name is
 *   not a table. A name after `FROM` followed by `(` is a set-returning function, not a table.
 * - **functions** — `name(` where `name` is not a keyword, a type in a cast, or a built-in
 *   (`count`, `coalesce`, `now`, …): only a name a migration could have created is worth a token.
 * - **columns, only where unambiguous** — `INSERT INTO t (a, b)`, `UPDATE t SET a = …, b = …`, and
 *   the plain-identifier items of `SELECT a, b FROM t` when the statement reads exactly ONE table and
 *   has no subquery. A multi-table statement makes no column claim at all: `a` could belong to any
 *   of them, and a guessed owner is a confident wrong answer.
 *
 * A placeholder word (`__cbi_dyn_N__`, put in place of a `${…}` the caller could not evaluate) in a
 * table position is reported as a `dynamic` reference — a named gap, never a guess.
 */

import type { SqlToken } from "./sqlLexer.js";

export type SqlRefKind = "table" | "column" | "function" | "dynamic";

export type SqlRef = {
  kind: SqlRefKind;
  /**
   * The name as written, dot-joined: `audit_events`, `conversation_store.conversation_message`,
   * and for a column `<table as written>.<column>`. Unquoted parts are lowercased (PostgreSQL folds
   * them); quoted parts keep their case.
   */
  name: string;
  /** Offset of the reference's first token in the scanned text. */
  offset: number;
  /** The clause that made the claim: `from`, `join`, `insert into`, `update`, `set`, `select list`, `call`, … */
  clause: string;
};

export const DYNAMIC_PLACEHOLDER = /^__cbi_dyn_\d+__$/;

/** Words that end an alias position or can never be a table / function name. */
const KEYWORDS = new Set([
  "select", "from", "where", "join", "inner", "left", "right", "full", "outer", "cross", "natural", "on", "using",
  "group", "order", "by", "having", "limit", "offset", "fetch", "for", "union", "intersect", "except", "all",
  "distinct", "as", "and", "or", "not", "in", "is", "null", "true", "false", "case", "when", "then", "else", "end",
  "exists", "any", "some", "between", "like", "ilike", "similar", "insert", "into", "values", "update", "set",
  "delete", "returning", "with", "recursive", "materialized", "lateral", "only", "table", "window", "over",
  "partition", "filter", "within", "default", "do", "nothing", "conflict", "constraint", "begin", "commit",
  "rollback", "declare", "if", "elsif", "loop", "while", "return", "perform", "execute", "raise", "notice",
  "exception", "language", "returns", "create", "alter", "drop", "grant", "revoke", "to", "cascade", "restrict",
  "array", "row", "interval", "cast", "collate", "asc", "desc", "nulls", "first", "last", "lock", "truncate",
  "merge", "matched", "share", "nowait", "skip", "locked", "key", "no", "of", "tablesample", "ordinality",
  "current_date", "current_time", "current_timestamp", "current_user", "session_user", "localtime", "localtimestamp",
  "new", "old", "foreach", "slice", "strict", "get", "diagnostics", "found", "continue", "exit", "query",
  "check", "references", "primary", "foreign", "unique", "exclude", "generated", "always", "identity", "stored"
]);

/** Built-in functions and type names that appear as `name(`. Never a migration-created function. */
const BUILTINS = new Set([
  "count", "sum", "avg", "min", "max", "coalesce", "nullif", "greatest", "least", "now", "array_agg", "string_agg",
  "json_agg", "jsonb_agg", "json_build_object", "jsonb_build_object", "json_build_array", "jsonb_build_array",
  "to_json", "to_jsonb", "row_to_json", "json_object_agg", "jsonb_object_agg", "jsonb_set", "jsonb_insert",
  "jsonb_array_elements", "jsonb_array_elements_text", "json_array_elements", "jsonb_each", "jsonb_each_text",
  "jsonb_object_keys", "jsonb_typeof", "jsonb_array_length", "jsonb_strip_nulls", "jsonb_path_query",
  "lower", "upper", "length", "char_length", "octet_length", "date_trunc", "date_bin", "date_part", "extract",
  "unnest", "generate_series", "set_config", "current_setting", "gen_random_uuid", "uuid_generate_v4", "encode",
  "decode", "digest", "md5", "sha256", "abs", "round", "floor", "ceil", "ceiling", "mod", "power", "sqrt",
  "make_interval", "make_date", "make_timestamptz", "to_char", "to_date", "to_timestamp", "to_number",
  "array_length", "array_position", "array_remove", "array_append", "array_cat", "array_to_string",
  "string_to_array", "cardinality", "row_number", "rank", "dense_rank", "percent_rank", "cume_dist", "ntile",
  "lag", "lead", "first_value", "last_value", "nth_value", "bool_or", "bool_and", "every", "regexp_replace",
  "regexp_match", "regexp_matches", "regexp_split_to_array", "split_part", "concat", "concat_ws", "format",
  "left", "right", "replace", "position", "substring", "substr", "trim", "btrim", "ltrim", "rtrim", "lpad", "rpad",
  "overlay", "starts_with", "strpos", "reverse", "repeat", "translate", "initcap", "quote_ident", "quote_literal",
  "quote_nullable", "to_tsvector", "to_tsquery", "plainto_tsquery", "phraseto_tsquery", "websearch_to_tsquery",
  "ts_rank", "ts_rank_cd", "ts_headline", "setweight", "pg_notify", "pg_advisory_xact_lock", "pg_advisory_lock",
  "pg_try_advisory_xact_lock", "pg_advisory_unlock", "hashtext", "age", "clock_timestamp", "statement_timestamp",
  "transaction_timestamp", "timezone", "justify_interval", "isfinite", "random", "trunc", "sign", "exp", "ln",
  "log", "pi", "width_bucket", "percentile_cont", "percentile_disc", "mode", "stddev", "variance", "corr",
  "pg_typeof", "current_schema", "has_table_privilege", "has_schema_privilege", "has_function_privilege",
  "pg_has_role", "txid_current", "pg_backend_pid", "nextval", "currval", "setval", "lastval", "num_nonnulls",
  "num_nulls", "array_fill", "array_upper", "array_lower", "array_dims", "jsonb_populate_record",
  "jsonb_to_record", "jsonb_to_recordset", "json_populate_record", "row", "values", "exists", "in", "any", "all",
  "some", "not", "coalesce", "numeric", "decimal", "varchar", "char", "character", "bit", "varbit", "timestamp",
  "timestamptz", "time", "timetz", "interval", "float", "double", "int", "integer", "bigint", "smallint", "text",
  "uuid", "vector", "halfvec", "bool", "boolean", "date", "jsonb", "json", "bytea", "inet", "cidr", "tsvector",
  "tsrange", "tstzrange", "daterange", "int4range", "int8range", "numrange", "point", "polygon", "box", "circle",
  "format_type", "obj_description", "col_description", "pg_get_functiondef", "pg_get_indexdef", "pg_size_pretty",
  "pg_total_relation_size", "pg_relation_size", "pg_column_size", "pg_sleep", "raise_exception", "sqlstate",
  "l2_distance", "cosine_distance", "inner_product", "vector_dims", "l2_normalize", "if", "case", "cast",
  "filter", "over", "within", "lateral", "using", "on", "returns", "table", "setof", "args", "array",
  "to_regclass", "to_regproc", "to_regtype", "to_regrole", "to_regnamespace", "pg_get_serial_sequence",
  "jsonb_path_exists", "array_agg", "xmlagg", "error", "format_type", "row_security_active"
]);

/** Openers whose `FROM` is part of the call's own syntax: `extract(epoch FROM t)`, `substring(x FROM 2)`. */
const FROM_INSIDE_CALL = new Set(["extract", "substring", "trim", "overlay", "position", "btrim"]);

type QName = { parts: string[]; next: number; start: number };

function isNamePart(t: SqlToken | undefined): t is SqlToken {
  return t !== undefined && (t.kind === "word" || t.kind === "qident");
}

/** Read `a`, `a.b`, `"A"."b"` starting at `i`. Returns null when `tokens[i]` is not a name. */
export function readQName(tokens: SqlToken[], i: number): QName | null {
  const first = tokens[i];
  if (!isNamePart(first)) return null;
  const parts = [first.value];
  let j = i + 1;
  while (tokens[j]?.kind === "punct" && tokens[j]!.value === "." && isNamePart(tokens[j + 1])) {
    parts.push(tokens[j + 1]!.value);
    j += 2;
  }
  return { parts, next: j, start: first.start };
}

function isPunct(t: SqlToken | undefined, value: string): boolean {
  return t?.kind === "punct" && t.value === value;
}

function isWord(t: SqlToken | undefined, value: string): boolean {
  return t?.kind === "word" && t.value === value;
}

/** Skip an optional alias after a table name: `t`, `t x`, `t AS x`, `t AS x (a, b)`. */
function skipAlias(tokens: SqlToken[], i: number): number {
  let j = i;
  if (isWord(tokens[j], "as")) j += 1;
  const alias = tokens[j];
  if (alias && (alias.kind === "qident" || (alias.kind === "word" && !KEYWORDS.has(alias.value)))) {
    j += 1;
    if (isPunct(tokens[j], "(")) j = skipParens(tokens, j);
  }
  return j;
}

/** The alias a table item carries, if any (for `SELECT x.a FROM t x`). */
function aliasAt(tokens: SqlToken[], i: number): string | null {
  let j = i;
  if (isWord(tokens[j], "as")) j += 1;
  const alias = tokens[j];
  if (alias && (alias.kind === "qident" || (alias.kind === "word" && !KEYWORDS.has(alias.value)))) return alias.value;
  return null;
}

/** `tokens[i]` is `(`; returns the index after its matching `)`. */
export function skipParens(tokens: SqlToken[], i: number): number {
  let depth = 0;
  for (let j = i; j < tokens.length; j += 1) {
    if (isPunct(tokens[j], "(")) depth += 1;
    else if (isPunct(tokens[j], ")")) {
      depth -= 1;
      if (depth === 0) return j + 1;
    }
  }
  return tokens.length;
}

/** Identifier list inside parentheses at `i` (`(a, b, "C")`), plain names only. */
function readIdentList(tokens: SqlToken[], i: number): { names: { name: string; offset: number }[]; next: number } {
  const names: { name: string; offset: number }[] = [];
  const end = skipParens(tokens, i);
  let expectName = true;
  for (let j = i + 1; j < end - 1; j += 1) {
    const t = tokens[j]!;
    if (isPunct(t, ",")) {
      expectName = true;
      continue;
    }
    if (expectName && isNamePart(t) && (isPunct(tokens[j + 1], ",") || j + 1 === end - 1)) {
      names.push({ name: t.value, offset: t.start });
    }
    expectName = false;
  }
  return { names, next: end };
}

function cteNamesOf(tokens: SqlToken[]): Set<string> {
  const names = new Set<string>();
  for (let i = 0; i + 2 < tokens.length; i += 1) {
    const t = tokens[i]!;
    if (!isNamePart(t)) continue;
    const prev = tokens[i - 1];
    if (!(isWord(prev, "with") || isWord(prev, "recursive") || isPunct(prev, ","))) continue;
    let j = i + 1;
    if (isPunct(tokens[j], "(")) j = skipParens(tokens, j);
    if (!isWord(tokens[j], "as")) continue;
    j += 1;
    if (isWord(tokens[j], "not")) j += 1;
    if (isWord(tokens[j], "materialized")) j += 1;
    if (isPunct(tokens[j], "(")) names.add(t.value);
  }
  return names;
}

/**
 * Scan `tokens` for table, function and (when `columns`) unambiguous column references.
 * Never throws.
 */
export function scanSqlReferences(tokens: SqlToken[], options: { columns?: boolean } = {}): SqlRef[] {
  const refs: SqlRef[] = [];
  const ctes = cteNamesOf(tokens);
  const tableItems: { name: string; alias: string | null }[] = [];
  /** Word before each open paren, innermost last — for `extract(… FROM …)`. */
  const parenOpeners: (string | null)[] = [];
  let joins = 0;

  const pushTable = (q: QName, clause: string): void => {
    if (q.parts.some((p) => DYNAMIC_PLACEHOLDER.test(p))) {
      refs.push({ kind: "dynamic", name: q.parts.join("."), offset: q.start, clause });
      return;
    }
    if (q.parts.length === 1 && ctes.has(q.parts[0]!)) return;
    if (q.parts.length === 1 && KEYWORDS.has(q.parts[0]!)) return;
    refs.push({ kind: "table", name: q.parts.join("."), offset: q.start, clause });
  };

  const pushFunction = (q: QName, clause: string): void => {
    const last = q.parts[q.parts.length - 1]!;
    if (q.parts.length === 1 && (KEYWORDS.has(last) || BUILTINS.has(last))) return;
    if (q.parts[0] === "pg_catalog" || q.parts[0] === "information_schema") return;
    if (q.parts.some((p) => DYNAMIC_PLACEHOLDER.test(p))) return;
    refs.push({ kind: "function", name: q.parts.join("."), offset: q.start, clause });
  };

  /** Read a table position at `i`; returns the index after the name (and alias), or `i` when none. */
  const tablePosition = (i: number, clause: string, recordItem: boolean, allowCall = false): number => {
    let j = i;
    while (isWord(tokens[j], "only") || isWord(tokens[j], "lateral")) j += 1;
    const q = readQName(tokens, j);
    if (!q) return i;
    if (allowCall && isPunct(tokens[q.next], "(")) {
      // A set-returning function in FROM: the name is consumed here; its arguments are scanned on.
      pushFunction(q, `${clause} (set-returning call)`);
      return q.next;
    }
    pushTable(q, clause);
    if (recordItem) tableItems.push({ name: q.parts.join("."), alias: aliasAt(tokens, q.next) });
    return q.next;
  };

  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i]!;
    const prev = tokens[i - 1];

    if (isPunct(t, "(")) {
      parenOpeners.push(prev && prev.kind === "word" ? prev.value : null);
      continue;
    }
    if (isPunct(t, ")")) {
      parenOpeners.pop();
      continue;
    }
    if (t.kind !== "word" && t.kind !== "qident") continue;

    if (t.kind === "word") {
      switch (t.value) {
        case "from": {
          if (isWord(prev, "distinct")) break;
          const opener = parenOpeners[parenOpeners.length - 1];
          if (opener && FROM_INSIDE_CALL.has(opener)) break;
          // A FROM list: `from a x, b y` — each item until something that is not `, name`.
          let j = i + 1;
          for (;;) {
            const after = tablePosition(j, "from", true, true);
            if (after === j) break;
            j = skipAlias(tokens, after);
            if (!isPunct(tokens[j], ",")) break;
            j += 1;
          }
          i = Math.max(i, j - 1);
          continue;
        }
        case "join": {
          joins += 1;
          const after = tablePosition(i + 1, "join", true, true);
          if (after !== i + 1) i = after - 1;
          continue;
        }
        case "into":
          if (isWord(prev, "insert") || isWord(prev, "merge")) {
            const start = i + 1;
            const after = tablePosition(start, `${prev!.value} into`, false);
            if (after === start) continue;
            i = after - 1;
            const q = readQName(tokens, isWord(tokens[start], "only") ? start + 1 : start);
            // INSERT takes `AS alias` only, and never a column list on the alias — the list is the target columns.
            const j = isWord(tokens[after], "as") && isNamePart(tokens[after + 1]) ? after + 2 : after;
            if (q && isPunct(tokens[j], "(")) {
              // The column list is a list of names, never calls: step over it whole.
              const list = readIdentList(tokens, j);
              if (options.columns) {
                for (const c of list.names) refs.push({ kind: "column", name: `${q.parts.join(".")}.${c.name}`, offset: c.offset, clause: "insert columns" });
              }
              i = list.next - 1;
            }
          }
          continue;
        case "update": {
          if (prev && (isWord(prev, "for") || isWord(prev, "do") || isWord(prev, "on") || isWord(prev, "key") || isWord(prev, "no") || isWord(prev, "of"))) break;
          const q = readQName(tokens, isWord(tokens[i + 1], "only") ? i + 2 : i + 1);
          const start = i + 1;
          const after = tablePosition(start, "update", false);
          if (after === start) continue;
          i = after - 1;
          if (q && options.columns) {
            let j = skipAlias(tokens, after);
            if (isWord(tokens[j], "set")) {
              j += 1;
              // `SET a = …, b = …` — a name followed by `=` at depth 0 starts each item.
              let depth = 0;
              let expectColumn = true;
              for (; j < tokens.length; j += 1) {
                const s = tokens[j]!;
                if (isPunct(s, "(")) depth += 1;
                else if (isPunct(s, ")")) {
                  if (depth === 0) break;
                  depth -= 1;
                } else if (depth === 0 && s.kind === "word" && (s.value === "where" || s.value === "from" || s.value === "returning")) break;
                else if (depth === 0 && isPunct(s, ",")) {
                  expectColumn = true;
                  continue;
                } else if (depth === 0 && expectColumn && isNamePart(s) && isPunct(tokens[j + 1], "=")) {
                  refs.push({ kind: "column", name: `${q.parts.join(".")}.${s.value}`, offset: s.start, clause: "update set" });
                }
                expectColumn = false;
              }
            }
          }
          continue;
        }
        case "table":
          if (prev === undefined || isWord(prev, "truncate") || isWord(prev, "lock") || isPunct(prev, ";")) {
            tablePosition(i + 1, prev === undefined || isPunct(prev, ";") ? "table" : `${prev.value} table`, false);
          }
          continue;
        case "references": {
          // DDL inside a body: `references t (col)` names a table, never calls one.
          const q = readQName(tokens, i + 1);
          if (q) {
            pushTable(q, "references");
            i = (isPunct(tokens[q.next], "(") ? skipParens(tokens, q.next) : q.next) - 1;
          }
          continue;
        }
        case "truncate":
          if (!isWord(tokens[i + 1], "table")) {
            let j = i + 1;
            for (;;) {
              const after = tablePosition(j, "truncate", false);
              if (after === j || !isPunct(tokens[after], ",")) break;
              j = after + 1;
            }
          }
          continue;
        default:
          break;
      }
    }

    // A function call: `name(` / `schema.name(`, not a cast target (`::numeric(10,2)`).
    const q = readQName(tokens, i);
    // Not an alias with a column list either: `unnest(…) AS p(a, b)`, `f(…) p(a, b)`.
    if (q && isPunct(tokens[q.next], "(") && !isPunct(prev, "::") && !isPunct(prev, ".") && !isWord(prev, "as") && !isWord(prev, "on") && !isPunct(prev, ")")) {
      pushFunction(q, "call");
      i = q.next - 1;
      continue;
    }
    if (q) i = q.next - 1;
  }

  // Select-list columns, only when the statement reads exactly one table and holds no subquery.
  if (options.columns) {
    const tables = refs.filter((r) => r.kind === "table");
    const subqueries = tokens.filter((t, k) => isWord(t, "select") && isPunct(tokens[k - 1], "(")).length;
    const distinctTables = new Set(tables.map((r) => r.name));
    if (distinctTables.size === 1 && joins === 0 && subqueries === 0 && tableItems.length === 1 && !refs.some((r) => r.kind === "dynamic")) {
      const item = tableItems[0]!;
      const qualifiers = new Set([item.name, item.name.split(".").pop()!, ...(item.alias ? [item.alias] : [])]);
      for (const col of selectListColumns(tokens)) {
        if (col.qualifier && !qualifiers.has(col.qualifier)) continue;
        refs.push({ kind: "column", name: `${item.name}.${col.name}`, offset: col.offset, clause: "select list" });
      }
    }
  }
  return refs;
}

/** Plain-identifier items of a top-level `SELECT … FROM` list: `a`, `a AS x`, `t.a`. */
function selectListColumns(tokens: SqlToken[]): { name: string; qualifier: string | null; offset: number }[] {
  const out: { name: string; qualifier: string | null; offset: number }[] = [];
  const selectAt = tokens.findIndex((t) => isWord(t, "select"));
  if (selectAt < 0) return out;
  let j = selectAt + 1;
  if (isWord(tokens[j], "distinct") || isWord(tokens[j], "all")) j += 1;
  let item: SqlToken[] = [];
  let depth = 0;
  const flush = (): void => {
    // `a` | `a as x` | `a x` | `t.a` | `t.a as x`
    let body = item;
    if (body.length >= 2 && isWord(body[body.length - 2], "as")) body = body.slice(0, -2);
    else if (body.length === 2 && isNamePart(body[0]) && isNamePart(body[1])) body = body.slice(0, 1);
    if (body.length === 1 && isNamePart(body[0]) && !KEYWORDS.has(body[0]!.value)) {
      out.push({ name: body[0]!.value, qualifier: null, offset: body[0]!.start });
    } else if (body.length === 3 && isNamePart(body[0]) && isPunct(body[1], ".") && isNamePart(body[2])) {
      out.push({ name: body[2]!.value, qualifier: body[0]!.value, offset: body[2]!.start });
    }
    item = [];
  };
  for (; j < tokens.length; j += 1) {
    const t = tokens[j]!;
    if (isPunct(t, "(")) depth += 1;
    else if (isPunct(t, ")")) depth -= 1;
    if (depth === 0 && isWord(t, "from")) break;
    if (depth === 0 && isPunct(t, ",")) {
      flush();
      continue;
    }
    item.push(t);
  }
  flush();
  return out;
}
