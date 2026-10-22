/**
 * The SQL lane (MCP-ISSUE-082): PostgreSQL `.sql` files — migrations, seeds, checks.
 *
 * Not tree-sitter. Each file is split into statements by the SQL-aware splitter in `sqlLexer.ts`
 * (dollar quotes, comments, strings, psql meta-commands), and each statement goes through three
 * readers in order:
 *
 * 1. **`pgsql-ast-parser`** (pure JS, MIT) — the AST for what it reads: `CREATE TABLE`, `ALTER TABLE`,
 *    `CREATE INDEX`, `CREATE VIEW`, `CREATE FUNCTION`, `CREATE TYPE … AS ENUM`, DML, `DO`, `COMMENT`.
 * 2. **A token recognizer per statement head**, for the PostgreSQL the parser does not read and a
 *    migration directory is full of: `GRANT` / `REVOKE`, `CREATE POLICY` / `ALTER POLICY` /
 *    `DROP POLICY`, `CREATE TRIGGER`, `CREATE OR REPLACE FUNCTION` with options the parser rejects,
 *    `ALTER TABLE … ENABLE ROW LEVEL SECURITY`, `ALTER TYPE … ADD VALUE`, `ALTER DEFAULT PRIVILEGES`,
 *    `CREATE ROLE`, `COMMENT ON COLUMN … IS 'a' 'b'`, partition DDL. Each is a small explicit grammar
 *    over the lexer's tokens; a symbol it creates says `[token-read]` in its signature.
 * 3. **A named gap** — a statement neither reader recognises becomes a `sql_gap` symbol at its line,
 *    named by its first words (`gap: create publication foo`), with the parser's message in the
 *    signature. Counted, queryable, never a crash and never a silent drop.
 *
 * psql meta-commands (`\set ON_ERROR_STOP on`) are not SQL and produce nothing. Transaction control,
 * `SET` and other statements that define or touch no object are recognised and produce nothing.
 *
 * ## Symbols
 *
 * `sql_table`, `sql_column` (child of its table when the table is created in the same statement),
 * `sql_view`, `sql_index`, `sql_function`, `sql_type`, `sql_role`, `sql_schema`, `sql_sequence`,
 * `sql_policy`, `sql_trigger` — **one symbol per DEFINITION SITE**. A table created in
 * `archive/0004` and again in the `0001` baseline is two symbols, and `ALTER TABLE t ADD COLUMN c` puts
 * a `sql_column` at the ALTER — so "where is column c defined" lists every site. A by-name reference
 * binds to ONE of them, the current definition (release I3, `graph/sqlDefinitions.ts`); the others
 * are reported as `alsoDefinedAt`, and each keeps the outbound edges of its own body.
 *
 * `sql_statement` — a statement that TOUCHES an object without defining it: `ALTER TABLE`, `GRANT`,
 * `REVOKE`, `DROP`, top-level DML, `ALTER TYPE`, `ALTER POLICY`. Its own symbol so "who touches table
 * X" lists each ALTER and each GRANT with its file and line, and a GRANT's name says which role gets
 * which privileges (`grant select, insert on audit_events to aria_turn`). `COMMENT ON` is
 * documentation, not a touch: its edge comes from the file's module symbol, with the line in the
 * reason.
 *
 * The signature of a definition starts with its QUALIFIED name and ` — `
 * (`conversation_store.conversation_message — table (6 columns)`). That prefix is what the resolver
 * matches on; the symbol's `name` stays the bare name so `search_symbols("conversation_message")`
 * finds it. An unqualified definition takes the schema of a preceding `SET search_path` in its file.
 *
 * ## Edges — every target is a TOKEN until the post-phase (`edgeResolverSql.ts`)
 *
 * - `SQL_USES` — a SQL construct reads, writes, alters, indexes, drops or comments an object: a
 *   view's or function's body, a policy's expression, an index's table and columns, a trigger's table
 *   and function, an ALTER's table and columns.
 * - `SQL_REFERENCES` — a foreign key, from the referencing column (or the statement when the column
 *   is defined elsewhere) to the referenced table and column.
 * - `SQL_GRANT` — a `GRANT` / `REVOKE` / `ALTER DEFAULT PRIVILEGES` statement to each object it names
 *   (privileges in the reason) and to each grantee role.
 * - `SQL_QUERY` — TypeScript → SQL, emitted by `jsSqlQueries.ts`, not here.
 * - `SQL_MIGRATION_ORDER` — file → predecessor file, written by the post-phase from the filename
 *   sequence (a file does not know its siblings).
 *
 * Token prefixes: `sqltable:`, `sqlcolumn:`, `sqlfunc:`, `sqlrole:`, `sqltype:`, `sqlschema:`,
 * `sqlindex:`, `sqlseq:`, `sqlpolicy:`, `sqltrigger:` + the name as written, dot-joined. The reason
 * carries the clause (`alter`, `fk public.a.b`, `grant select,insert`, `reads (plpgsql body, tokenized)`).
 */

import { astVisitor, parse } from "pgsql-ast-parser";
import type { CreateColumnDef, QName, Statement, TableConstraint } from "pgsql-ast-parser";

import type { EdgeRecord, SymbolRecord } from "../../types/index.js";
import type { ExtractInput } from "./extractorTypes.js";
import { makeSymbolId } from "./extractorPrimitives.js";
import { LineIndex, firstWords, lexSql, splitSqlStatements, type SqlStatement, type SqlToken } from "./sqlLexer.js";
import { readQName, scanSqlReferences, skipParens, type SqlRef } from "./sqlQueryScan.js";

export const SQL_SYMBOL_KINDS = [
  "sql_table", "sql_column", "sql_view", "sql_index", "sql_function", "sql_type", "sql_role", "sql_schema",
  "sql_sequence", "sql_policy", "sql_trigger", "sql_statement", "sql_gap", "sql_drop"
] as const;
export type SqlSymbolKind = (typeof SQL_SYMBOL_KINDS)[number];

export const SQL_EDGE_TYPES = ["SQL_USES", "SQL_REFERENCES", "SQL_GRANT", "SQL_QUERY", "SQL_MIGRATION_ORDER"] as const;
export type SqlEdgeType = (typeof SQL_EDGE_TYPES)[number];

export type SqlTokenKind = "table" | "column" | "function" | "role" | "type" | "schema" | "index" | "sequence" | "policy" | "trigger";

export const SQL_TOKEN_PREFIX: Record<SqlTokenKind, string> = {
  table: "sqltable:",
  column: "sqlcolumn:",
  function: "sqlfunc:",
  role: "sqlrole:",
  type: "sqltype:",
  schema: "sqlschema:",
  index: "sqlindex:",
  sequence: "sqlseq:",
  policy: "sqlpolicy:",
  trigger: "sqltrigger:"
};

/**
 * Release I4: `<x>.query(B)` where `B` is IMPORTED — the anchor token `sqlconst:<specifier>#<exported
 * name>`, from the calling symbol. `resolveSqlEdges` follows it to the declaring module's const and
 * gives the caller that const's SQL targets; the anchor itself binds to the const's `variable` symbol.
 */
export const SQL_CONST_TOKEN_PREFIX = "sqlconst:";
/** Clause of an anchor, and the head of every edge derived from one (`… via A (file:line) …`). */
export const SQL_IMPORTED_CONST_CLAUSE = "ts query imported const ";
/** Clause head of a SQL-shaped const's own declaration scan (`jsSqlQueries.ts` rule 2). */
export const SQL_CONST_DECLARATION_CLAUSE = "ts sql const ";

/** Reason prefix of an edge whose token no definition has (yet) matched. */
export const SQL_UNRESOLVED_REASON_PREFIX = "unresolved sql token: ";
/** Confidence of an unresolved SQL token edge. */
export const SQL_TOKEN_CONFIDENCE = 0.5;
/** Separates the qualified name from the description in a definition's signature. */
export const SQL_SIGNATURE_SEPARATOR = " — ";

const MAX_SIGNATURE = 200;
/** Release M2: an index signature carries its columns and filter (the ground truth compares them), so it may run longer. */
const MAX_INDEX_SIGNATURE = 500;
const MAX_STATEMENT_NAME = 140;
/** The AST parser is a chart parser; a statement this long goes to the token readers directly. */
const MAX_AST_STATEMENT_CHARS = 40_000;

export type SqlExtractStats = { statements: number; astParsed: number; tokenRead: number; ignored: number; gaps: number; meta: number };
export type SqlExtractResult = { symbols: SymbolRecord[]; edges: EdgeRecord[]; stats: SqlExtractStats };

/** Words after which a statement defines or touches nothing in the graph. */
const IGNORED_HEADS = new Set([
  "begin", "commit", "rollback", "start", "end", "savepoint", "release", "set", "reset", "show", "analyze", "analyse",
  "vacuum", "checkpoint", "notify", "listen", "unlisten", "discard", "load", "abort", "prepare", "deallocate",
  "security", "cluster", "reindex"
]);

function clip(text: string, max = MAX_SIGNATURE): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max)}...`;
}

/** Render tokens back to text for a name or signature — string literals elided, never stored. */
function renderTokens(tokens: SqlToken[]): string {
  let out = "";
  for (const t of tokens) {
    const text =
      t.kind === "word" ? t.value
        : t.kind === "qident" ? `"${t.value}"`
          : t.kind === "string" || t.kind === "dollar" ? "'…'"
            : t.value;
    const glue = out === "" || t.value === "," || t.value === ")" || t.value === "." || out.endsWith("(") || out.endsWith(".") ? "" : " ";
    out += glue + text;
  }
  return out;
}

function isWord(t: SqlToken | undefined, ...values: string[]): boolean {
  return t?.kind === "word" && values.includes(t.value);
}

function isPunct(t: SqlToken | undefined, value: string): boolean {
  return t?.kind === "punct" && t.value === value;
}

function qnameText(q: { name: string; schema?: string | undefined }): string {
  return q.schema ? `${q.schema}.${q.name}` : q.name;
}

/** Per-file state carried across statements. */
type FileContext = {
  input: ExtractInput;
  idInput: ExtractInput;
  moduleSymbolId: string;
  source: string;
  lines: LineIndex;
  symbols: SymbolRecord[];
  edges: EdgeRecord[];
  edgeKeys: Set<string>;
  /** Appended to every symbol's signature while reading statements inside a DO body. */
  detailSuffix: string;
  /** Release M2: put right after the qualified name's separator — `[EF down] ` for an EF migration's Down(), so clipping never hides it. */
  detailPrefix: string;
  /** Release M1: `sql_drop` ids already emitted (a name dropped twice in one statement is one site). */
  dropIds: Set<string>;
  /** First schema of the last `SET search_path`, when it is not `public` / `pg_catalog`. */
  searchPath: string | null;
  /** Tables defined in this file, by qualified name → symbol id (for column parents). */
  tables: Map<string, string>;
  /** Columns defined in this file, `<qualified table>.<column>` → symbol id (FK sources). */
  columns: Map<string, string>;
  stats: SqlExtractStats;
};

/** Release M2: how an embedded caller (EF `migrationBuilder.Sql`) labels what it hands in. */
export type SqlExtractOptions = { detailPrefix?: string; detailSuffix?: string };

export function extractSql(input: ExtractInput, moduleSymbolId: string, options: SqlExtractOptions = {}): SqlExtractResult {
  const lines = new LineIndex(input.source);
  const ctx: FileContext = {
    input,
    idInput: { repoId: input.repoId, filePath: input.filePath, language: "sql", source: "" },
    moduleSymbolId,
    source: input.source,
    lines,
    symbols: [],
    edges: [],
    edgeKeys: new Set(),
    detailSuffix: options.detailSuffix ?? "",
    detailPrefix: options.detailPrefix ?? "",
    dropIds: new Set(),
    searchPath: null,
    tables: new Map(),
    columns: new Map(),
    stats: { statements: 0, astParsed: 0, tokenRead: 0, ignored: 0, gaps: 0, meta: 0 }
  };

  for (const statement of splitSqlStatements(input.source, lines)) {
    if (statement.kind === "meta") {
      ctx.stats.meta += 1;
      continue;
    }
    ctx.stats.statements += 1;
    handleStatement(ctx, statement);
  }
  return { symbols: ctx.symbols, edges: ctx.edges, stats: ctx.stats };
}

// ─── emit helpers ──────────────────────────────────────────────────────────────────────────────

/** Qualify an unqualified name by the file's `search_path`, when one was set. */
function qualify(ctx: FileContext, name: string): string {
  if (name.includes(".") || !ctx.searchPath) return name;
  return `${ctx.searchPath}.${name}`;
}

function defineSymbol(
  ctx: FileContext,
  kind: SqlSymbolKind,
  name: string,
  offset: number,
  endOffset: number,
  qualified: string | null,
  detail: string,
  parentSymbolId?: string
): string {
  const line = ctx.lines.lineAt(offset);
  const symbolId = makeSymbolId(ctx.idInput, kind, name, line - 1);
  const described = `${ctx.detailPrefix}${detail}${ctx.detailSuffix}`;
  const signature = qualified !== null ? `${qualified}${SQL_SIGNATURE_SEPARATOR}${described}` : described;
  ctx.symbols.push({
    repoId: ctx.input.repoId,
    symbolId,
    filePath: ctx.input.filePath,
    name,
    kind,
    line,
    endLine: ctx.lines.lineAt(Math.max(offset, endOffset - 1)),
    signature: clip(signature, kind === "sql_index" ? MAX_INDEX_SIGNATURE : MAX_SIGNATURE),
    ...(parentSymbolId ? { parentSymbolId } : {})
  });
  return symbolId;
}

/** The signature head of a `sql_drop`: `<qualified> — dropped <token kind>: …` (`sqlDefinitions.ts` parses it back). */
export const SQL_DROP_DETAIL = /^(?:\[EF down\] )?dropped (\w+): /;

/**
 * Release M1: one dropped object at one drop site — `DROP TABLE a, b` is two, `ALTER TABLE t DROP COLUMN x, DROP
 * COLUMN y` is two (at each column's own line). Not a definition: nothing binds to it as one. `graph/sqlDefinitions.ts`
 * orders it with the definitions of its name, and the latest event decides whether the name is dropped.
 */
function dropSite(ctx: FileContext, kind: SqlTokenKind, written: string, offset: number, endOffset: number, how: string, parentId?: string): void {
  if (!written) return;
  const parts = written.split(".");
  const bare = parts[parts.length - 1]!;
  const qualified = kind === "role" || kind === "schema" ? written : qualify(ctx, written);
  const id = makeSymbolId(ctx.idInput, "sql_drop", `${kind}:${qualified}`, ctx.lines.lineAt(offset) - 1);
  if (ctx.dropIds.has(id)) return;
  ctx.dropIds.add(id);
  const line = ctx.lines.lineAt(offset);
  ctx.symbols.push({
    repoId: ctx.input.repoId,
    symbolId: id,
    filePath: ctx.input.filePath,
    name: bare,
    kind: "sql_drop",
    line,
    endLine: ctx.lines.lineAt(Math.max(offset, endOffset - 1)),
    signature: clip(`${qualified}${SQL_SIGNATURE_SEPARATOR}${ctx.detailPrefix}dropped ${kind}: ${how}${ctx.detailSuffix}`),
    ...(parentId ? { parentSymbolId: parentId } : {})
  });
}

/** Index columns and filter as written (source text, whitespace flattened), for the index signature. */
function indexShape(columns: string[], method: string | null, where: string | null): string {
  return ` (${columns.join(", ")})${method && method.toLowerCase() !== "btree" ? ` using ${method.toLowerCase()}` : ""}${where ? ` where ${clip(where, 300)}` : ""}`;
}

function ref(ctx: FileContext, fromId: string, kind: SqlTokenKind, name: string, type: SqlEdgeType, clause: string): void {
  if (!name) return;
  const toId = `${SQL_TOKEN_PREFIX[kind]}${kind === "role" ? name : qualify(ctx, name)}`;
  const key = `${fromId}\u0000${toId}\u0000${type}`;
  if (ctx.edgeKeys.has(key)) return;
  ctx.edgeKeys.add(key);
  ctx.edges.push({
    repoId: ctx.input.repoId,
    fromId,
    toId,
    type,
    confidence: SQL_TOKEN_CONFIDENCE,
    reason: `${SQL_UNRESOLVED_REASON_PREFIX}${clause}`
  });
}

/** A `sql_statement` symbol for a statement that touches objects without defining one. */
function statementSymbol(ctx: FileContext, statement: SqlStatement, name: string, detail: string): string {
  return defineSymbol(ctx, "sql_statement", clip(name, MAX_STATEMENT_NAME), statement.start, statement.end, null, detail);
}

function gap(ctx: FileContext, statement: SqlStatement, why: string): void {
  ctx.stats.gaps += 1;
  defineSymbol(ctx, "sql_gap", `gap: ${firstWords(statement, 4)}`, statement.start, statement.end, null, `not read: ${clip(why, 160)}`);
}

/** Emit the references a scan found, from `fromId`, labelled with `label`. */
function emitScanRefs(ctx: FileContext, fromId: string, refs: SqlRef[], label: string): void {
  for (const r of refs) {
    if (r.kind === "table") ref(ctx, fromId, "table", r.name, "SQL_USES", `${r.clause} (${label})`);
    else if (r.kind === "function") ref(ctx, fromId, "function", r.name, "SQL_USES", `${r.clause} (${label})`);
    else if (r.kind === "column") ref(ctx, fromId, "column", r.name, "SQL_USES", `${r.clause} (${label})`);
  }
}

// ─── dispatch ──────────────────────────────────────────────────────────────────────────────────

function handleStatement(ctx: FileContext, statement: SqlStatement): void {
  const head = statement.tokens[0];
  if (!head) return;
  trackSearchPath(ctx, statement);

  let ast: Statement | null = null;
  let parseError = "";
  if (statement.text.length <= MAX_AST_STATEMENT_CHARS) {
    try {
      const parsed = parse(statement.text, { locationTracking: true });
      if (parsed.length === 1) ast = parsed[0]!;
      else if (parsed.length === 0) return;
      else parseError = `${String(parsed.length)} statements in one`;
    } catch (error) {
      parseError = String((error as Error).message ?? error).split("\n")[0] ?? "syntax error";
    }
  } else {
    parseError = "statement too long for the AST parser";
  }

  if (ast && handleAst(ctx, statement, ast)) {
    ctx.stats.astParsed += 1;
    return;
  }
  const outcome = handleTokens(ctx, statement);
  if (outcome === "read") {
    ctx.stats.tokenRead += 1;
    return;
  }
  if (outcome === "ignored") {
    ctx.stats.ignored += 1;
    return;
  }
  gap(ctx, statement, parseError || "no reader for this statement");
}

/** AST reader, then token readers; never a gap (for statements inside a DO body). */
function readStatement(ctx: FileContext, statement: SqlStatement): TokenOutcome {
  try {
    const parsed = statement.text.length <= MAX_AST_STATEMENT_CHARS ? parse(statement.text, { locationTracking: true }) : [];
    if (parsed.length === 1 && handleAst(ctx, statement, parsed[0]!)) return "read";
  } catch {
    /* fall through to the token readers */
  }
  return handleTokens(ctx, statement);
}

function trackSearchPath(ctx: FileContext, statement: SqlStatement): void {
  const t = statement.tokens;
  let values: SqlToken[] = [];
  if (isWord(t[0], "set") && (isWord(t[1], "search_path") || (isWord(t[1], "local", "session") && isWord(t[2], "search_path")))) {
    const at = t.findIndex((x) => isWord(x, "to") || isPunct(x, "="));
    values = at < 0 ? [] : t.slice(at + 1);
  } else {
    // `select set_config('search_path', 'x, public', false)` — pg_dump writes this one.
    const call = t.findIndex((x, k) => isWord(x, "set_config") && isPunct(t[k + 1], "("));
    if (call >= 0 && t[call + 2]?.kind === "string" && t[call + 2]!.value === "search_path" && t[call + 4]?.kind === "string") {
      values = lexSql(t[call + 4]!.value);
    }
  }
  if (values.length === 0 && !(isWord(t[0], "reset") && isWord(t[1], "search_path"))) return;
  const first = values.find((v) => (v.kind === "word" || v.kind === "qident" || v.kind === "string") && v.value !== "" && v.value !== "pg_catalog" && v.value !== "$user");
  const schema = first ? first.value.split(",")[0]!.trim() : null;
  ctx.searchPath = schema && schema !== "public" && schema !== "default" ? schema : null;
}

// ─── the AST reader ────────────────────────────────────────────────────────────────────────────

type AstRefs = { tables: string[]; functions: string[] };

/** Tables and functions an AST reads, CTE names excluded. */
function astRefs(node: Statement): AstRefs {
  const tables: string[] = [];
  const functions: string[] = [];
  const ctes = new Set<string>();
  const visitor = astVisitor((map) => ({
    tableRef: (t) => {
      tables.push(qnameText(t));
    },
    with: (w) => {
      for (const b of w.bind) ctes.add(b.alias.name);
      map.super().with(w);
    },
    withRecursive: (w) => {
      ctes.add(w.alias.name);
      map.super().withRecursive(w);
    },
    call: (c) => {
      functions.push(qnameText(c.function));
      map.super().call(c);
    },
    fromCall: (f) => {
      functions.push(qnameText(f.function));
      map.super().fromCall(f);
    }
  }));
  try {
    visitor.statement(node);
  } catch {
    /* a visitor gap on an exotic node costs references, never the statement */
  }
  // The scanner's keyword/built-in filter decides what is a migration-made function.
  const known = new Set(scanSqlReferences(lexSql(functions.map((f) => `${f}()`).join(" "))).filter((r) => r.kind === "function").map((r) => r.name));
  return { tables: tables.filter((t) => !ctes.has(t)), functions: functions.filter((f) => known.has(f)) };
}

function emitAstRefs(ctx: FileContext, fromId: string, refs: AstRefs, clause: string): void {
  for (const t of refs.tables) ref(ctx, fromId, "table", t, "SQL_USES", clause);
  for (const f of refs.functions) ref(ctx, fromId, "function", f, "SQL_USES", clause === "reads" ? "calls" : `${clause} (call)`);
}

function locOffset(ctx: FileContext, statement: SqlStatement, node: { _location?: { start: number; end: number } } | undefined): number {
  return statement.start + (node?._location?.start ?? 0);
}

function handleAst(ctx: FileContext, statement: SqlStatement, ast: Statement): boolean {
  switch (ast.type) {
    case "create table": {
      const name = qualify(ctx, qnameText(ast.name));
      const columnDefs = ast.columns.filter((c): c is CreateColumnDef => c.kind === "column");
      const tableId = defineSymbol(ctx, "sql_table", ast.name.name, statement.start, statement.end, name, `table (${String(columnDefs.length)} columns)`);
      ctx.tables.set(name, tableId);
      for (const col of ast.columns) {
        if (col.kind === "like table") ref(ctx, tableId, "table", qnameText(col.like), "SQL_USES", "like");
      }
      for (const col of columnDefs) defineColumnAst(ctx, statement, name, col, tableId);
      for (const c of ast.constraints ?? []) tableConstraint(ctx, name, c, tableId);
      for (const parent of ast.inherits ?? []) ref(ctx, tableId, "table", qnameText(parent), "SQL_USES", "inherits");
      return true;
    }
    case "create view":
    case "create materialized view": {
      const name = qualify(ctx, qnameText(ast.name));
      const viewId = defineSymbol(ctx, "sql_view", ast.name.name, statement.start, statement.end, name, ast.type === "create view" ? "view" : "materialized view");
      emitAstRefs(ctx, viewId, astRefs(ast.query), "view reads");
      return true;
    }
    case "create index": {
      const table = qnameText(ast.table);
      const indexName = ast.indexName?.name ?? `${ast.table.name}_index_l${String(statement.line)}`;
      const sourceOf = (node: { _location?: { start: number; end: number } } | undefined | null): string | null =>
        node?._location ? statement.text.slice(node._location.start, node._location.end).replace(/\s+/g, " ").trim() : null;
      const shape = indexShape(
        ast.expressions.map((e) => `${sourceOf(e.expression) ?? "?"}${e.opclass ? ` ${qnameText(e.opclass)}` : ""}`),
        ast.using?.name ?? null,
        sourceOf(ast.where)
      );
      const indexId = defineSymbol(ctx, "sql_index", indexName, statement.start, statement.end, qualify(ctx, ast.indexName ? (ast.table.schema ? `${ast.table.schema}.${indexName}` : indexName) : indexName), `${ast.unique ? "unique index" : "index"} on ${table}${shape}`);
      ref(ctx, indexId, "table", table, "SQL_USES", "index on");
      for (const e of ast.expressions) {
        if (e.expression.type === "ref") ref(ctx, indexId, "column", `${table}.${e.expression.name}`, "SQL_USES", "index column");
      }
      return true;
    }
    case "create function": {
      const name = qualify(ctx, qnameText(ast.name));
      const language = ast.language?.name?.toLowerCase() ?? "sql";
      const fnId = defineSymbol(ctx, "sql_function", ast.name.name, statement.start, statement.end, name, `function (${String(ast.arguments.length)} args) language ${language}`);
      if (ast.code !== undefined) functionBody(ctx, fnId, ast.code, language, statement);
      return true;
    }
    case "create enum":
    case "create composite type": {
      const name = qualify(ctx, qnameText(ast.name));
      defineSymbol(ctx, "sql_type", ast.name.name, statement.start, statement.end, name, ast.type === "create enum" ? `enum (${String(ast.values.length)} values)` : "composite type");
      return true;
    }
    case "alter enum": {
      const id = statementSymbol(ctx, statement, `alter type ${qnameText(ast.name)}`, ast.change.type === "add value" ? "add value" : "rename");
      ref(ctx, id, "type", qnameText(ast.name), "SQL_USES", `alter type (${ast.change.type})`);
      return true;
    }
    case "create schema": {
      defineSymbol(ctx, "sql_schema", ast.name.name, statement.start, statement.end, ast.name.name, "schema");
      return true;
    }
    case "create sequence": {
      const name = qualify(ctx, qnameText(ast.name));
      defineSymbol(ctx, "sql_sequence", ast.name.name, statement.start, statement.end, name, "sequence");
      return true;
    }
    case "alter table": {
      const table = qnameText(ast.table);
      const what = ast.changes.map((c) => c.type).join(", ");
      const id = statementSymbol(ctx, statement, `alter table ${table}`, `alter table: ${what}`);
      ref(ctx, id, "table", table, "SQL_USES", `alter (${what})`);
      const qualifiedTable = qualify(ctx, table);
      for (const change of ast.changes) {
        switch (change.type) {
          case "add column":
            defineColumnAst(ctx, statement, qualifiedTable, change.column, ctx.tables.get(qualifiedTable));
            break;
          case "alter column":
            ref(ctx, id, "column", `${table}.${change.column.name}`, "SQL_USES", change.type);
            break;
          case "drop column": {
            ref(ctx, id, "column", `${table}.${change.column.name}`, "SQL_USES", change.type);
            const at = locOffset(ctx, statement, change.column);
            dropSite(ctx, "column", `${table}.${change.column.name}`, at, at + change.column.name.length, `alter table ${table} drop column`, id);
            break;
          }
          case "rename column":
            ref(ctx, id, "column", `${table}.${change.column.name}`, "SQL_USES", `rename column to ${change.to.name}`);
            break;
          case "add constraint":
            tableConstraint(ctx, qualifiedTable, change.constraint, id);
            break;
          case "owner":
            ref(ctx, id, "role", change.to.name, "SQL_GRANT", "owner");
            break;
          default:
            break;
        }
      }
      return true;
    }
    case "comment": {
      const lineNo = statement.line;
      if (ast.on.type === "column") {
        const c = ast.on.column;
        ref(ctx, ctx.moduleSymbolId, "column", `${c.schema ? `${c.schema}.` : ""}${c.table}.${c.column}`, "SQL_USES", `comment on column (line ${String(lineNo)})`);
      } else {
        const kind: SqlTokenKind = ast.on.type === "index" ? "index" : ast.on.type === "type" ? "type" : ast.on.type === "trigger" ? "trigger" : ast.on.type === "database" ? "schema" : "table";
        ref(ctx, ctx.moduleSymbolId, kind, qnameText(ast.on.name), "SQL_USES", `comment on ${ast.on.type} (line ${String(lineNo)})`);
      }
      return true;
    }
    case "insert":
    case "update":
    case "delete":
    case "select":
    case "with":
    case "with recursive":
    case "union":
    case "union all":
    case "values": {
      const refs = astRefs(ast);
      if (refs.tables.length === 0 && refs.functions.length === 0) return true;
      const verb = ast.type === "insert" ? "insert into" : ast.type === "update" ? "update" : ast.type === "delete" ? "delete from" : "select";
      const firstTable = refs.tables[0];
      const id = statementSymbol(ctx, statement, firstTable ? `${verb} ${firstTable}` : clip(renderTokens(statement.tokens.slice(0, 8))), `${verb} (top-level dml)`);
      emitAstRefs(ctx, id, refs, ast.type === "select" || ast.type === "values" ? "reads" : `${verb}`);
      return true;
    }
    case "drop table":
    case "drop index":
    case "drop sequence":
    case "drop type":
    case "drop trigger": {
      const kind: SqlTokenKind = ast.type === "drop table" ? "table" : ast.type === "drop index" ? "index" : ast.type === "drop sequence" ? "sequence" : ast.type === "drop type" ? "type" : "trigger";
      const id = statementSymbol(ctx, statement, `${ast.type} ${ast.names.map(qnameText).join(", ")}`, ast.type);
      for (const n of ast.names) ref(ctx, id, kind, qnameText(n), "SQL_USES", ast.type);
      // `drop trigger t ON tbl` is not something this parser reads; it reaches `dropTrigger` with its table.
      if (kind !== "trigger") for (const n of ast.names) dropSite(ctx, kind, qnameText(n), statement.start, statement.end, ast.type, id);
      return true;
    }
    case "drop function": {
      const id = statementSymbol(ctx, statement, `drop function ${qnameText(ast.name)}`, "drop function");
      ref(ctx, id, "function", qnameText(ast.name), "SQL_USES", "drop function");
      dropSite(ctx, "function", qnameText(ast.name), statement.start, statement.end, "drop function", id);
      return true;
    }
    case "truncate table": {
      const id = statementSymbol(ctx, statement, `truncate ${ast.tables.map(qnameText).join(", ")}`, "truncate");
      for (const n of ast.tables) ref(ctx, id, "table", qnameText(n), "SQL_USES", "truncate");
      return true;
    }
    case "do": {
      doBlock(ctx, statement);
      return true;
    }
    case "begin":
    case "commit":
    case "rollback":
    case "start transaction":
    case "set":
    case "set timezone":
    case "set names":
    case "show":
    case "create extension":
    case "tablespace":
    case "prepare":
    case "deallocate":
    case "raise":
      return true;
    default:
      // Parsed, but a shape this reader does not map (`alter index`, `alter sequence`, `refresh`):
      // let the token readers try, then gap.
      return false;
  }
}

function defineColumnAst(ctx: FileContext, statement: SqlStatement, qualifiedTable: string, col: CreateColumnDef, parentId: string | undefined): void {
  const offset = locOffset(ctx, statement, col);
  const typeText = dataTypeText(col.dataType);
  const columnId = defineSymbol(ctx, "sql_column", col.name.name, offset, offset + col.name.name.length, `${qualifiedTable}.${col.name.name}`, `column ${typeText}`, parentId);
  ctx.columns.set(`${qualifiedTable}.${col.name.name}`, columnId);
  for (const c of col.constraints ?? []) {
    if (c.type === "reference") {
      const target = qnameText(c.foreignTable);
      ref(ctx, columnId, "table", target, "SQL_REFERENCES", `fk ${qualifiedTable}.${col.name.name}`);
      for (const fc of c.foreignColumns ?? []) ref(ctx, columnId, "column", `${target}.${fc.name}`, "SQL_REFERENCES", `fk ${qualifiedTable}.${col.name.name}`);
    }
  }
}

function dataTypeText(dt: CreateColumnDef["dataType"]): string {
  if (dt.kind === "array") return `${dataTypeText(dt.arrayOf)}[]`;
  return qnameText(dt as QName);
}

function tableConstraint(ctx: FileContext, qualifiedTable: string, c: TableConstraint, fallbackFromId: string): void {
  if (c.type === "foreign key") {
    const target = qnameText(c.foreignTable);
    const local = c.localColumns.map((n) => n.name);
    const fromIds = local.map((n) => ctx.columns.get(`${qualifiedTable}.${n}`));
    const clause = `fk ${qualifiedTable}(${local.join(",")})`;
    if (fromIds.every((id) => id !== undefined) && fromIds.length > 0) {
      for (const fromId of fromIds as string[]) {
        ref(ctx, fromId, "table", target, "SQL_REFERENCES", clause);
        for (const fc of c.foreignColumns) ref(ctx, fromId, "column", `${target}.${fc.name}`, "SQL_REFERENCES", clause);
      }
    } else {
      ref(ctx, fallbackFromId, "table", target, "SQL_REFERENCES", clause);
      for (const fc of c.foreignColumns) ref(ctx, fallbackFromId, "column", `${target}.${fc.name}`, "SQL_REFERENCES", clause);
      for (const n of local) ref(ctx, fallbackFromId, "column", `${qualifiedTable}.${n}`, "SQL_USES", "fk column");
    }
    return;
  }
  const columns = "columns" in c && Array.isArray((c as { columns?: unknown }).columns) ? ((c as { columns: { name: string }[] }).columns) : [];
  for (const col of columns) ref(ctx, fallbackFromId, "column", `${qualifiedTable}.${col.name}`, "SQL_USES", `${c.type} constraint`);
}

// ─── function and DO bodies ────────────────────────────────────────────────────────────────────

/**
 * A function body: `LANGUAGE sql` is parsed statement by statement with the AST parser (a statement
 * it rejects is token-scanned, and says so); every other language is token-scanned whole.
 */
function functionBody(ctx: FileContext, fnId: string, code: string, language: string, statement: SqlStatement): void {
  if (language === "sql") {
    for (const inner of splitSqlStatements(code)) {
      if (inner.kind !== "sql") continue;
      let refs: AstRefs | null = null;
      try {
        const parsed = parse(inner.text);
        refs = { tables: [], functions: [] };
        for (const p of parsed) {
          const r = astRefs(p);
          refs.tables.push(...r.tables);
          refs.functions.push(...r.functions);
        }
      } catch {
        refs = null;
      }
      if (refs) emitAstRefs(ctx, fnId, refs, "reads");
      else emitScanRefs(ctx, fnId, scanSqlReferences(inner.tokens), "sql body, tokenized");
    }
    return;
  }
  void statement;
  emitScanRefs(ctx, fnId, scanSqlReferences(lexSql(code)), `${language} body, tokenized`);
}

/**
 * A `DO` block. PL/pgSQL is not SQL, but the DDL a migration guards inside one is: `if not exists
 * (…) then create role x nologin; end if;`, `create policy …` behind an existence check, an
 * `alter table` in a loop body. Every inner statement that starts a statement (after `;`, `then`,
 * `else`, `loop`, `begin`) with a DDL head goes through the same readers as a top-level statement
 * — its symbols say `[do block]`. An inner statement no reader recognises is PL/pgSQL control
 * flow, not a gap. What is left (reads in conditions, DML in the body) is token-scanned onto one
 * `do block` statement symbol, labelled `tokenized`. Dynamic SQL (`execute format(…)`) is a
 * string and is not read.
 */
function doBlock(ctx: FileContext, statement: SqlStatement): void {
  const body = statement.tokens.find((t) => t.kind === "dollar" || t.kind === "string");
  if (!body) return;
  if (body.kind !== "dollar") {
    // A single-quoted body: offsets inside it are not file offsets; scan it as one block.
    const refs = scanSqlReferences(lexSql(body.value)).filter((r) => !/^(pg_catalog.|information_schema.|pg_)/.test(r.name));
    if (refs.length > 0) emitScanRefs(ctx, statementSymbol(ctx, statement, `do block (line ${String(statement.line)})`, "do block"), refs, "do block, tokenized");
    return;
  }
  const bodyStart = body.bodyStart ?? body.start;
  const tokens = lexSql(ctx.source, bodyStart, bodyStart + body.value.length);
  const inner: boolean[] = new Array<boolean>(tokens.length).fill(false);
  let defined = 0;
  const previousSuffix = ctx.detailSuffix;
  ctx.detailSuffix = " [do block]";
  try {
    for (let i = 0; i < tokens.length; i += 1) {
      const prev = tokens[i - 1];
      const atStart = prev === undefined || isPunct(prev, ";") || isWord(prev, "then", "else", "loop", "begin");
      if (!atStart || !isWord(tokens[i], "create", "grant", "revoke", "alter", "comment", "drop")) continue;
      let j = i;
      while (j < tokens.length && !isPunct(tokens[j], ";")) j += 1;
      const sub = tokens.slice(i, j);
      if (sub.length < 2) continue;
      const start = sub[0]!.start;
      const end = sub[sub.length - 1]!.end;
      const innerStatement: SqlStatement = {
        kind: "sql",
        text: ctx.source.slice(start, end),
        start,
        end,
        line: ctx.lines.lineAt(start),
        endLine: ctx.lines.lineAt(Math.max(start, end - 1)),
        tokens: sub
      };
      const before = ctx.symbols.length + ctx.edges.length;
      if (readStatement(ctx, innerStatement) !== "unknown") {
        for (let k = i; k < j; k += 1) inner[k] = true;
        if (ctx.symbols.length + ctx.edges.length > before) defined += 1;
      }
      i = j;
    }
  } finally {
    ctx.detailSuffix = previousSuffix;
  }
  // What the block reads or writes outside those statements, without the catalog lookups that guard them.
  const rest = tokens.filter((_, k) => !inner[k]);
  const refs = scanSqlReferences(rest).filter((r) => !/^(pg_catalog.|information_schema.|pg_)/.test(r.name));
  if (refs.length > 0) {
    const id = statementSymbol(ctx, statement, `do block (line ${String(statement.line)})`, `do block${defined > 0 ? `, ${String(defined)} inner statement(s) read` : ""}`);
    emitScanRefs(ctx, id, refs, "do block, tokenized");
  }
}

// ─── the token readers ─────────────────────────────────────────────────────────────────────────

type TokenOutcome = "read" | "ignored" | "unknown";

function handleTokens(ctx: FileContext, statement: SqlStatement): TokenOutcome {
  const t = statement.tokens;
  const w0 = t[0]?.kind === "word" ? t[0].value : "";
  const w1 = t[1]?.kind === "word" ? t[1].value : "";

  if (w0 === "grant" || w0 === "revoke") return grantOrRevoke(ctx, statement, 0, null) !== null ? "read" : "unknown";
  if (w0 === "alter" && w1 === "default" && isWord(t[2], "privileges")) return defaultPrivileges(ctx, statement) ? "read" : "unknown";
  if (w0 === "create") {
    let i = 1;
    if (isWord(t[i], "or") && isWord(t[i + 1], "replace")) i += 2;
    while (isWord(t[i], "temp", "temporary", "unlogged", "global", "local", "recursive", "materialized", "unique", "constraint", "trusted", "procedural")) i += 1;
    const what = t[i]?.kind === "word" ? t[i]!.value : "";
    switch (what) {
      case "function":
      case "procedure":
        return createFunctionTokens(ctx, statement, i) ? "read" : "unknown";
      case "policy":
        return createPolicy(ctx, statement, i) ? "read" : "unknown";
      case "trigger":
        return createTrigger(ctx, statement, i) ? "read" : "unknown";
      case "table":
        return createTableTokens(ctx, statement, i) ? "read" : "unknown";
      case "index":
        return createIndexTokens(ctx, statement, i) ? "read" : "unknown";
      case "view":
        return createViewTokens(ctx, statement, i) ? "read" : "unknown";
      case "role":
      case "user":
      case "group":
        return simpleDefinition(ctx, statement, i + 1, "sql_role", "role") ? "read" : "unknown";
      case "schema":
        return simpleDefinition(ctx, statement, i + 1, "sql_schema", "schema") ? "read" : "unknown";
      case "sequence":
        return simpleDefinition(ctx, statement, i + 1, "sql_sequence", "sequence") ? "read" : "unknown";
      case "domain":
      case "type":
        return simpleDefinition(ctx, statement, i + 1, "sql_type", what) ? "read" : "unknown";
      case "extension":
      case "cast":
      case "operator":
      case "collation":
      case "aggregate":
      case "language":
        return "ignored";
      default:
        return "unknown";
    }
  }
  if (w0 === "alter") {
    switch (w1) {
      case "table":
        return alterTableTokens(ctx, statement) ? "read" : "unknown";
      case "type":
      case "domain":
        return alterObject(ctx, statement, "type") ? "read" : "unknown";
      case "function":
      case "procedure":
      case "routine":
        return alterObject(ctx, statement, "function") ? "read" : "unknown";
      case "schema":
        return alterObject(ctx, statement, "schema") ? "read" : "unknown";
      case "sequence":
        return alterObject(ctx, statement, "sequence") ? "read" : "unknown";
      case "index":
        return alterObject(ctx, statement, "index") ? "read" : "unknown";
      case "view":
      case "materialized":
        return alterObject(ctx, statement, "table") ? "read" : "unknown";
      case "role":
      case "user":
      case "group":
        return alterObject(ctx, statement, "role") ? "read" : "unknown";
      case "policy":
        return policyTouch(ctx, statement, "alter policy") ? "read" : "unknown";
      default:
        return "unknown";
    }
  }
  if (w0 === "drop") {
    if (w1 === "policy") return policyTouch(ctx, statement, "drop policy") ? "read" : "unknown";
    if (w1 === "trigger") return dropTrigger(ctx, statement) ? "read" : "unknown";
    const kinds: Record<string, SqlTokenKind> = { table: "table", view: "table", function: "function", procedure: "function", type: "type", domain: "type", index: "index", sequence: "sequence", schema: "schema", role: "role", materialized: "table" };
    const kind = kinds[w1];
    if (kind) return dropTokens(ctx, statement, kind) ? "read" : "unknown";
    return "unknown";
  }
  if (w0 === "comment" && w1 === "on") return commentTokens(ctx, statement) ? "read" : "unknown";
  if (["select", "insert", "update", "delete", "with", "merge", "truncate", "values", "table"].includes(w0)) {
    const refs = scanSqlReferences(t);
    const first = refs.find((r) => r.kind === "table");
    if (refs.length === 0) return "ignored";
    const id = statementSymbol(ctx, statement, first ? `${w0 === "insert" ? "insert into" : w0} ${first.name}` : clip(renderTokens(t.slice(0, 8))), `${w0} (top-level dml) [token-read]`);
    emitScanRefs(ctx, id, refs, "tokenized");
    return "read";
  }
  if (w0 === "do") {
    doBlock(ctx, statement);
    return "read";
  }
  if (IGNORED_HEADS.has(w0) || w0 === "lock") return "ignored";
  return "unknown";
}

/** `name` at `i` (optionally after `IF NOT EXISTS`), as a qualified name. */
function nameAfter(t: SqlToken[], i: number): { q: ReturnType<typeof readQName>; at: number } {
  let j = i;
  if (isWord(t[j], "if") && isWord(t[j + 1], "not") && isWord(t[j + 2], "exists")) j += 3;
  if (isWord(t[j], "if") && isWord(t[j + 1], "exists")) j += 2;
  if (isWord(t[j], "only")) j += 1;
  return { q: readQName(t, j), at: j };
}

function simpleDefinition(ctx: FileContext, statement: SqlStatement, i: number, kind: SqlSymbolKind, label: string): boolean {
  const { q } = nameAfter(statement.tokens, i);
  if (!q) return false;
  const name = q.parts[q.parts.length - 1]!;
  const qualified = kind === "sql_role" || kind === "sql_schema" ? q.parts.join(".") : qualify(ctx, q.parts.join("."));
  defineSymbol(ctx, kind, name, statement.start, statement.end, qualified, `${label} [token-read]`);
  return true;
}

/** Privileges up to `ON` / `TO`: `select, insert`, `update (a, b)`, `all privileges`. */
function readPrivileges(t: SqlToken[], i: number): { privileges: string[]; columns: string[]; next: number } {
  const privileges: string[] = [];
  const columns: string[] = [];
  let j = i;
  while (j < t.length && !isWord(t[j], "on", "to", "from")) {
    const tok = t[j]!;
    if (isPunct(tok, "(")) {
      const end = skipParens(t, j);
      for (let k = j + 1; k < end - 1; k += 1) if (t[k]!.kind === "word" || t[k]!.kind === "qident") columns.push(t[k]!.value);
      j = end;
      continue;
    }
    if (tok.kind === "word" && tok.value !== "privileges") privileges.push(tok.value);
    j += 1;
  }
  return { privileges, columns, next: j };
}

const GRANT_OBJECT_KIND: Record<string, SqlTokenKind> = {
  table: "table", sequence: "sequence", function: "function", procedure: "function", routine: "function",
  schema: "schema", type: "type", domain: "type"
};

/** `GRANT|REVOKE privs ON [kind] objects TO|FROM roles` and role membership `GRANT r TO s`. */
function grantOrRevoke(ctx: FileContext, statement: SqlStatement, at: number, prefix: string | null): string | null {
  const t = statement.tokens;
  const verb = t[at]!.value;
  let i = at + 1;
  if (verb === "revoke" && isWord(t[i], "grant") && isWord(t[i + 1], "option") && isWord(t[i + 2], "for")) i += 3;
  const { privileges, columns, next } = readPrivileges(t, i);
  i = next;
  const objects: { kind: SqlTokenKind; name: string }[] = [];
  let objectLabel = "";
  if (isWord(t[i], "on")) {
    i += 1;
    let kind: SqlTokenKind = "table";
    if (isWord(t[i], "all") && t[i + 1]?.kind === "word" && isWord(t[i + 2], "in") && isWord(t[i + 3], "schema")) {
      // `ON ALL TABLES IN SCHEMA s` — the schema is the object.
      objectLabel = `all ${t[i + 1]!.value} in schema`;
      i += 4;
      kind = "schema";
    } else if (t[i]?.kind === "word" && GRANT_OBJECT_KIND[t[i]!.value] && (t[i + 1]?.kind === "word" || t[i + 1]?.kind === "qident")) {
      kind = GRANT_OBJECT_KIND[t[i]!.value]!;
      objectLabel = t[i]!.value;
      i += 1;
    } else if (t[i]?.kind === "word" && (t[i]!.value === "tables" || t[i]!.value === "sequences" || t[i]!.value === "functions" || t[i]!.value === "types" || t[i]!.value === "routines")) {
      // ALTER DEFAULT PRIVILEGES … ON TABLES: no named object.
      objectLabel = t[i]!.value;
      i += 1;
    }
    while (i < t.length && !isWord(t[i], "to", "from")) {
      const q = readQName(t, i);
      if (!q) {
        i += 1;
        continue;
      }
      objects.push({ kind, name: q.parts.join(".") });
      i = q.next;
      if (isPunct(t[i], "(")) i = skipParens(t, i); // function argument types
      if (isPunct(t[i], ",")) i += 1;
    }
  }
  if (!isWord(t[i], "to", "from")) return null;
  i += 1;
  const roles: string[] = [];
  while (i < t.length) {
    if (isWord(t[i], "with", "granted", "cascade", "restrict")) break;
    if (isWord(t[i], "group")) {
      i += 1;
      continue;
    }
    const tok = t[i]!;
    if ((tok.kind === "word" || tok.kind === "qident") && !(tok.kind === "word" && tok.value === "public")) roles.push(tok.value);
    i += 1;
    if (isPunct(t[i], ",")) i += 1;
  }

  const privText = privileges.length > 0 ? privileges.join(",") : "all";
  const colText = columns.length > 0 ? `(${columns.join(",")})` : "";
  const isMembership = objects.length === 0 && objectLabel === "" ;
  const target = objects.map((o) => o.name).join(", ") || objectLabel;
  const roleText = roles.join(", ") || "public";
  const name = isMembership
    ? `${prefix ? `${prefix} ` : ""}${verb} role ${privileges.join(", ")} ${verb === "grant" ? "to" : "from"} ${roleText}`
    : `${prefix ? `${prefix} ` : ""}${verb} ${privileges.join(", ")}${colText} on ${objectLabel && objects.length > 0 ? `${objectLabel} ` : ""}${target} ${verb === "grant" ? "to" : "from"} ${roleText}`;
  const id = statementSymbol(ctx, statement, name, `${verb} [token-read]`);
  // A schema-wide object (`on all tables in schema s`, default privileges `on tables`) stays in the
  // clause: the resolver fans such a grant out to the schema's objects of that kind, labelled schema-wide.
  const wide = objectLabel && !GRANT_OBJECT_KIND[objectLabel] ? ` on ${objectLabel}` : "";
  const clause = `${verb} ${privText}${colText}${wide} ${verb === "grant" ? "to" : "from"} ${roleText}`;
  if (isMembership) {
    for (const p of privileges) ref(ctx, id, "role", p, "SQL_GRANT", `${verb} role membership`);
  }
  for (const o of objects) {
    ref(ctx, id, o.kind, o.name, "SQL_GRANT", clause);
    if (o.kind === "table") for (const c of columns) ref(ctx, id, "column", `${o.name}.${c}`, "SQL_GRANT", clause);
  }
  for (const r of roles) ref(ctx, id, "role", r, "SQL_GRANT", `grantee: ${verb} ${privText}${colText} on ${target}`);
  return clause;
}

/** `ALTER DEFAULT PRIVILEGES [FOR ROLE r] [IN SCHEMA s] GRANT|REVOKE …`. */
function defaultPrivileges(ctx: FileContext, statement: SqlStatement): boolean {
  const t = statement.tokens;
  const at = t.findIndex((x) => isWord(x, "grant", "revoke"));
  if (at < 0) return false;
  const schemaAt = t.findIndex((x, k) => isWord(x, "in") && isWord(t[k + 1], "schema"));
  const prefix = schemaAt >= 0 && schemaAt < at ? `alter default privileges in schema ${t[schemaAt + 2]?.value ?? "?"}` : "alter default privileges";
  const clause = grantOrRevoke(ctx, statement, at, prefix);
  if (clause === null) return false;
  if (schemaAt >= 0 && schemaAt < at) {
    const id = ctx.symbols[ctx.symbols.length - 1]!.symbolId;
    for (let k = schemaAt + 2; k < at && (t[k]!.kind === "word" || t[k]!.kind === "qident"); k += 1) {
      ref(ctx, id, "schema", t[k]!.value, "SQL_GRANT", `default privileges: ${clause}`);
      if (!isPunct(t[k + 1], ",")) break;
      k += 1;
    }
  }
  return true;
}

/** `CREATE [OR REPLACE] FUNCTION|PROCEDURE name (args) … AS $$body$$ | BEGIN ATOMIC … END`. */
function createFunctionTokens(ctx: FileContext, statement: SqlStatement, i: number): boolean {
  const t = statement.tokens;
  const q = readQName(t, i + 1);
  if (!q || !isPunct(t[q.next], "(")) return false;
  const argsEnd = skipParens(t, q.next);
  const argCount = countTopLevelItems(t, q.next);
  let language = "sql";
  const langAt = t.findIndex((x, k) => k >= argsEnd && isWord(x, "language"));
  if (langAt >= 0 && t[langAt + 1]) language = t[langAt + 1]!.value.toLowerCase();
  const bodyTok = t.find((x, k) => k >= argsEnd && (x.kind === "dollar" || (x.kind === "string" && isWord(t[k - 1], "as"))));
  const returnsAt = t.findIndex((x, k) => k >= argsEnd && isWord(x, "returns"));
  const returnsName = returnsAt >= 0 ? readQName(t, returnsAt + 1) : null;
  const returns = returnsAt < 0 ? "" : isWord(t[returnsAt + 1], "table") ? "table(…)" : isWord(t[returnsAt + 1], "setof") ? `setof ${t[returnsAt + 2]?.value ?? "?"}` : returnsName ? returnsName.parts.join(".") : "";
  const name = q.parts[q.parts.length - 1]!;
  const fnId = defineSymbol(ctx, "sql_function", name, statement.start, statement.end, qualify(ctx, q.parts.join(".")), `${t[i]!.value} (${String(argCount)} args)${returns ? ` returns ${returns}` : ""} language ${language} [token-read]`);
  if (bodyTok) {
    if (language === "sql") functionBody(ctx, fnId, bodyTok.value, "sql", statement);
    else emitScanRefs(ctx, fnId, scanSqlReferences(bodyTok.kind === "dollar" ? lexSql(ctx.source, bodyTok.bodyStart ?? bodyTok.start, (bodyTok.bodyStart ?? bodyTok.start) + bodyTok.value.length) : lexSql(bodyTok.value)), `${language} body, tokenized`);
  } else {
    const atomic = t.findIndex((x, k) => isWord(x, "begin") && isWord(t[k + 1], "atomic"));
    if (atomic >= 0) emitScanRefs(ctx, fnId, scanSqlReferences(t.slice(atomic + 2)), "sql body (begin atomic), tokenized");
  }
  return true;
}

function countTopLevelItems(t: SqlToken[], openAt: number): number {
  const end = skipParens(t, openAt);
  if (end - openAt <= 2) return 0;
  let depth = 0;
  let count = 1;
  for (let k = openAt + 1; k < end - 1; k += 1) {
    if (isPunct(t[k], "(")) depth += 1;
    else if (isPunct(t[k], ")")) depth -= 1;
    else if (depth === 0 && isPunct(t[k], ",")) count += 1;
  }
  return count;
}

/** `CREATE POLICY name ON table [AS …] [FOR cmd] [TO roles] [USING (…)] [WITH CHECK (…)]`. */
function createPolicy(ctx: FileContext, statement: SqlStatement, i: number): boolean {
  const t = statement.tokens;
  const nameTok = t[i + 1];
  if (!nameTok || (nameTok.kind !== "word" && nameTok.kind !== "qident") || !isWord(t[i + 2], "on")) return false;
  const table = readQName(t, i + 3);
  if (!table) return false;
  const tableName = table.parts.join(".");
  let j = table.next;
  let command = "all";
  const roles: string[] = [];
  let expressionTokens: SqlToken[] = [];
  while (j < t.length) {
    if (isWord(t[j], "as")) j += 2;
    else if (isWord(t[j], "for") && t[j + 1]) {
      command = t[j + 1]!.value;
      j += 2;
    } else if (isWord(t[j], "to")) {
      j += 1;
      while (j < t.length && !isWord(t[j], "using", "with")) {
        const r = t[j]!;
        if ((r.kind === "word" || r.kind === "qident") && r.value !== "public") roles.push(r.value);
        j += 1;
      }
    } else if (isWord(t[j], "using", "check") && isPunct(t[j + 1], "(")) {
      const end = skipParens(t, j + 1);
      expressionTokens = expressionTokens.concat(t.slice(j + 2, end - 1), [{ kind: "punct", value: ";", start: t[end - 1]!.start, end: t[end - 1]!.end }]);
      j = end;
    } else j += 1;
  }
  const qualifiedTable = qualify(ctx, tableName);
  const policyId = defineSymbol(ctx, "sql_policy", nameTok.value, statement.start, statement.end, `${qualifiedTable}.${nameTok.value}`, `policy on ${tableName} for ${command}${roles.length > 0 ? ` to ${roles.join(", ")}` : ""} [token-read]`);
  ref(ctx, policyId, "table", tableName, "SQL_USES", `policy on (for ${command})`);
  for (const r of roles) ref(ctx, policyId, "role", r, "SQL_GRANT", `policy ${nameTok.value} applies to (for ${command} on ${tableName})`);
  emitScanRefs(ctx, policyId, scanSqlReferences(expressionTokens).filter((r) => r.kind !== "column"), "policy expression, tokenized");
  return true;
}

/** `ALTER POLICY name ON table …` / `DROP POLICY [IF EXISTS] name ON table`. */
function policyTouch(ctx: FileContext, statement: SqlStatement, verb: string): boolean {
  const t = statement.tokens;
  let i = 2;
  if (isWord(t[i], "if") && isWord(t[i + 1], "exists")) i += 2;
  const nameTok = t[i];
  if (!nameTok || !isWord(t[i + 1], "on")) return false;
  const table = readQName(t, i + 2);
  if (!table) return false;
  const tableName = table.parts.join(".");
  const id = statementSymbol(ctx, statement, `${verb} ${nameTok.value} on ${tableName}`, `${verb} [token-read]`);
  ref(ctx, id, "table", tableName, "SQL_USES", verb);
  ref(ctx, id, "policy", `${tableName}.${nameTok.value}`, "SQL_USES", verb);
  if (verb === "drop policy") dropSite(ctx, "policy", `${tableName}.${nameTok.value}`, statement.start, statement.end, verb, id);
  return true;
}

/** `CREATE [CONSTRAINT] TRIGGER name {BEFORE|AFTER|INSTEAD OF} events ON table … EXECUTE {FUNCTION|PROCEDURE} f(…)`. */
function createTrigger(ctx: FileContext, statement: SqlStatement, i: number): boolean {
  const t = statement.tokens;
  const nameTok = t[i + 1];
  if (!nameTok) return false;
  const onAt = t.findIndex((x, k) => k > i + 1 && isWord(x, "on"));
  const table = onAt >= 0 ? readQName(t, onAt + 1) : null;
  if (!table) return false;
  const tableName = table.parts.join(".");
  const events = renderTokens(t.slice(i + 2, onAt));
  const triggerId = defineSymbol(ctx, "sql_trigger", nameTok.value, statement.start, statement.end, `${qualify(ctx, tableName)}.${nameTok.value}`, `trigger ${events} on ${tableName} [token-read]`);
  ref(ctx, triggerId, "table", tableName, "SQL_USES", "trigger on");
  const execAt = t.findIndex((x, k) => isWord(x, "execute") && isWord(t[k + 1], "function", "procedure"));
  const fn = execAt >= 0 ? readQName(t, execAt + 2) : null;
  if (fn) ref(ctx, triggerId, "function", fn.parts.join("."), "SQL_USES", "trigger executes");
  return true;
}

function dropTrigger(ctx: FileContext, statement: SqlStatement): boolean {
  const t = statement.tokens;
  let i = 2;
  if (isWord(t[i], "if") && isWord(t[i + 1], "exists")) i += 2;
  const nameTok = t[i];
  if (!nameTok || !isWord(t[i + 1], "on")) return false;
  const table = readQName(t, i + 2);
  if (!table) return false;
  const tableName = table.parts.join(".");
  const id = statementSymbol(ctx, statement, `drop trigger ${nameTok.value} on ${tableName}`, "drop trigger [token-read]");
  ref(ctx, id, "table", tableName, "SQL_USES", "drop trigger");
  ref(ctx, id, "trigger", `${tableName}.${nameTok.value}`, "SQL_USES", "drop trigger");
  dropSite(ctx, "trigger", `${tableName}.${nameTok.value}`, statement.start, statement.end, "drop trigger", id);
  return true;
}

/** Items of a parenthesised list, split at depth-0 commas. */
function topLevelItems(t: SqlToken[], openAt: number): SqlToken[][] {
  const end = skipParens(t, openAt);
  const items: SqlToken[][] = [];
  let current: SqlToken[] = [];
  let depth = 0;
  for (let k = openAt + 1; k < end - 1; k += 1) {
    const tok = t[k]!;
    if (isPunct(tok, "(")) depth += 1;
    else if (isPunct(tok, ")")) depth -= 1;
    if (depth === 0 && isPunct(tok, ",")) {
      items.push(current);
      current = [];
      continue;
    }
    current.push(tok);
  }
  if (current.length > 0) items.push(current);
  return items;
}

/** FK edges from `REFERENCES t [(c, …)]` inside `item`. */
function referencesIn(ctx: FileContext, item: SqlToken[], fromId: string, clause: string): void {
  for (let k = 0; k < item.length; k += 1) {
    if (!isWord(item[k], "references")) continue;
    const q = readQName(item, k + 1);
    if (!q) continue;
    const target = q.parts.join(".");
    ref(ctx, fromId, "table", target, "SQL_REFERENCES", clause);
    if (isPunct(item[q.next], "(")) {
      const end = skipParens(item, q.next);
      for (let m = q.next + 1; m < end - 1; m += 1) {
        if (item[m]!.kind === "word" || item[m]!.kind === "qident") ref(ctx, fromId, "column", `${target}.${item[m]!.value}`, "SQL_REFERENCES", clause);
      }
    }
  }
}

const TABLE_CONSTRAINT_HEADS = new Set(["constraint", "primary", "unique", "check", "foreign", "exclude", "like"]);

/** `CREATE TABLE` the parser rejected: partition DDL, generated columns, exotic defaults. */
function createTableTokens(ctx: FileContext, statement: SqlStatement, i: number): boolean {
  const t = statement.tokens;
  const { q } = nameAfter(t, i + 1);
  if (!q) return false;
  const tableName = q.parts.join(".");
  const qualifiedTable = qualify(ctx, tableName);
  const openAt = t.findIndex((x, k) => k >= q.next && isPunct(x, "("));
  const partitionOfAt = t.findIndex((x, k) => k >= q.next && isWord(x, "partition") && isWord(t[k + 1], "of"));
  const items = openAt >= 0 && (partitionOfAt < 0 || openAt < partitionOfAt) ? topLevelItems(t, openAt) : [];
  const columnItems = items.filter((item) => item[0] && !(item[0].kind === "word" && TABLE_CONSTRAINT_HEADS.has(item[0].value)));
  const partitionBy = t.findIndex((x, k) => isWord(x, "partition") && isWord(t[k + 1], "by"));
  const tableId = defineSymbol(ctx, "sql_table", q.parts[q.parts.length - 1]!, statement.start, statement.end, qualifiedTable, `table (${String(columnItems.length)} columns)${partitionBy >= 0 ? " partitioned" : ""}${partitionOfAt >= 0 ? " partition" : ""} [token-read]`);
  ctx.tables.set(qualifiedTable, tableId);
  if (partitionOfAt >= 0) {
    const parent = readQName(t, partitionOfAt + 2);
    if (parent) ref(ctx, tableId, "table", parent.parts.join("."), "SQL_USES", "partition of");
  }
  for (const item of items) {
    const head = item[0]!;
    if (head.kind === "word" && TABLE_CONSTRAINT_HEADS.has(head.value)) {
      const fk = item.findIndex((x) => isWord(x, "foreign"));
      if (fk >= 0) {
        const open = item.findIndex((x, k) => k > fk && isPunct(x, "("));
        const locals = open >= 0 ? topLevelItems(item, open).map((c) => c[0]?.value ?? "").filter(Boolean) : [];
        const fromIds = locals.map((n) => ctx.columns.get(`${qualifiedTable}.${n}`)).filter((x): x is string => x !== undefined);
        const clause = `fk ${qualifiedTable}(${locals.join(",")})`;
        for (const fromId of fromIds.length > 0 ? fromIds : [tableId]) referencesIn(ctx, item, fromId, clause);
      }
      continue;
    }
    if (head.kind !== "word" && head.kind !== "qident") continue;
    const typeText = renderTokens(item.slice(1, 3));
    const columnId = defineSymbol(ctx, "sql_column", head.value, head.start, head.end, `${qualifiedTable}.${head.value}`, `column ${typeText} [token-read]`, tableId);
    ctx.columns.set(`${qualifiedTable}.${head.value}`, columnId);
    referencesIn(ctx, item, columnId, `fk ${qualifiedTable}.${head.value}`);
  }
  return true;
}

/** `CREATE [UNIQUE] INDEX [CONCURRENTLY] [IF NOT EXISTS] [name] ON [ONLY] table [USING m] (…)`. */
function createIndexTokens(ctx: FileContext, statement: SqlStatement, i: number): boolean {
  const t = statement.tokens;
  const onAt = t.findIndex((x, k) => k > i && isWord(x, "on"));
  if (onAt < 0) return false;
  let nameTok: SqlToken | undefined;
  for (let k = i + 1; k < onAt; k += 1) {
    if (!isWord(t[k], "concurrently", "if", "not", "exists")) nameTok = t[k];
  }
  const { q } = nameAfter(t, onAt + 1);
  if (!q) return false;
  const table = q.parts.join(".");
  const unique = t.slice(0, i).some((x) => isWord(x, "unique"));
  const indexName = nameTok?.value ?? `${q.parts[q.parts.length - 1]!}_index_l${String(statement.line)}`;
  const open = t.findIndex((x, k) => k >= q.next && isPunct(x, "("));
  const usingAt = t.findIndex((x, k) => k >= q.next && (open < 0 || k < open) && isWord(x, "using"));
  const close = open >= 0 ? skipParens(t, open) : -1;
  const whereAt = close >= 0 ? t.findIndex((x, k) => k >= close && isWord(x, "where")) : -1;
  const text = (from: number, to: number): string => ctx.source.slice(from, to).replace(/\s+/g, " ").trim();
  const shape = open >= 0
    ? indexShape(
      topLevelItems(t, open).filter((item) => item.length > 0).map((item) => text(item[0]!.start, item[item.length - 1]!.end)),
      usingAt >= 0 ? (t[usingAt + 1]?.value ?? null) : null,
      whereAt >= 0 && whereAt + 1 < t.length ? text(t[whereAt + 1]!.start, t[t.length - 1]!.end) : null
    )
    : "";
  const indexId = defineSymbol(ctx, "sql_index", indexName, statement.start, statement.end, qualify(ctx, q.parts.length > 1 ? `${q.parts[0]!}.${indexName}` : indexName), `${unique ? "unique index" : "index"} on ${table}${shape} [token-read]`);
  ref(ctx, indexId, "table", table, "SQL_USES", "index on");
  if (open >= 0) {
    for (const item of topLevelItems(t, open)) {
      if (item.length >= 1 && (item[0]!.kind === "word" || item[0]!.kind === "qident") && !isPunct(item[1], "(")) {
        ref(ctx, indexId, "column", `${table}.${item[0]!.value}`, "SQL_USES", "index column");
      }
    }
  }
  return true;
}

function createViewTokens(ctx: FileContext, statement: SqlStatement, i: number): boolean {
  const t = statement.tokens;
  const { q } = nameAfter(t, i + 1);
  if (!q) return false;
  const asAt = t.findIndex((x, k) => k >= q.next && isWord(x, "as"));
  const materialized = t.slice(0, i).some((x) => isWord(x, "materialized"));
  const viewId = defineSymbol(ctx, "sql_view", q.parts[q.parts.length - 1]!, statement.start, statement.end, qualify(ctx, q.parts.join(".")), `${materialized ? "materialized view" : "view"} [token-read]`);
  if (asAt >= 0) emitScanRefs(ctx, viewId, scanSqlReferences(t.slice(asAt + 1)).filter((r) => r.kind !== "column"), "view reads, tokenized");
  return true;
}

/** `ALTER TABLE [IF EXISTS] [ONLY] t …` the parser rejected (`ENABLE ROW LEVEL SECURITY`, partitions). */
function alterTableTokens(ctx: FileContext, statement: SqlStatement): boolean {
  const t = statement.tokens;
  const { q } = nameAfter(t, 2);
  if (!q) return false;
  const table = q.parts.join(".");
  const qualifiedTable = qualify(ctx, table);
  const action = renderTokens(t.slice(q.next, Math.min(t.length, q.next + 5)));
  const id = statementSymbol(ctx, statement, `alter table ${table}`, `alter table: ${clip(action, 80)} [token-read]`);
  ref(ctx, id, "table", table, "SQL_USES", `alter (${clip(action, 60)})`);
  // Each action, split at depth-0 commas.
  const actions: SqlToken[][] = [];
  let current: SqlToken[] = [];
  let depth = 0;
  for (let k = q.next; k < t.length; k += 1) {
    const tok = t[k]!;
    if (isPunct(tok, "(")) depth += 1;
    else if (isPunct(tok, ")")) depth -= 1;
    if (depth === 0 && isPunct(tok, ",")) {
      actions.push(current);
      current = [];
    } else current.push(tok);
  }
  actions.push(current);
  for (const a of actions) {
    if (isWord(a[0], "add") && !isWord(a[1], "constraint", "primary", "unique", "check", "foreign", "exclude")) {
      let k = 1;
      if (isWord(a[k], "column")) k += 1;
      if (isWord(a[k], "if") && isWord(a[k + 1], "not") && isWord(a[k + 2], "exists")) k += 3;
      const col = a[k];
      if (col && (col.kind === "word" || col.kind === "qident")) {
        const columnId = defineSymbol(ctx, "sql_column", col.value, col.start, col.end, `${qualifiedTable}.${col.value}`, `column ${renderTokens(a.slice(k + 1, k + 3))} [alter table add column] [token-read]`, ctx.tables.get(qualifiedTable));
        ctx.columns.set(`${qualifiedTable}.${col.value}`, columnId);
        referencesIn(ctx, a, columnId, `fk ${qualifiedTable}.${col.value}`);
      }
      continue;
    }
    if (isWord(a[0], "alter", "drop", "rename") ) {
      let k = 1;
      if (isWord(a[k], "column")) k += 1;
      if (isWord(a[k], "if") && isWord(a[k + 1], "exists")) k += 2;
      const col = a[k];
      if (col && (col.kind === "word" || col.kind === "qident") && !isWord(col, "constraint", "to")) {
        ref(ctx, id, "column", `${table}.${col.value}`, "SQL_USES", `${a[0]!.value} column`);
        // `drop constraint` is excluded above; `alter`/`rename column` are not drops.
        if (isWord(a[0], "drop")) dropSite(ctx, "column", `${table}.${col.value}`, col.start, col.end, `alter table ${table} drop column`, id);
      }
      continue;
    }
    if (isWord(a[0], "attach", "detach") && isWord(a[1], "partition")) {
      const part = readQName(a, 2);
      if (part) ref(ctx, id, "table", part.parts.join("."), "SQL_USES", `${a[0]!.value} partition`);
      continue;
    }
    if (isWord(a[0], "owner") && isWord(a[1], "to") && a[2]) {
      ref(ctx, id, "role", a[2].value, "SQL_GRANT", "owner");
      continue;
    }
    const fk = a.findIndex((x) => isWord(x, "foreign"));
    if (fk >= 0) {
      const open = a.findIndex((x, k) => k > fk && isPunct(x, "("));
      const locals = open >= 0 ? topLevelItems(a, open).map((c) => c[0]?.value ?? "").filter(Boolean) : [];
      const fromIds = locals.map((n) => ctx.columns.get(`${qualifiedTable}.${n}`)).filter((x): x is string => x !== undefined);
      const clause = `fk ${qualifiedTable}(${locals.join(",")})`;
      for (const fromId of fromIds.length > 0 ? fromIds : [id]) referencesIn(ctx, a, fromId, clause);
      if (fromIds.length === 0) for (const n of locals) ref(ctx, id, "column", `${table}.${n}`, "SQL_USES", "fk column");
    }
  }
  return true;
}

/** `ALTER TYPE|FUNCTION|SCHEMA|SEQUENCE|INDEX|VIEW|ROLE name …` — a touch of one object. */
function alterObject(ctx: FileContext, statement: SqlStatement, kind: SqlTokenKind): boolean {
  const t = statement.tokens;
  let i = 2;
  if (isWord(t[1], "materialized")) i = 3;
  const { q, at } = nameAfter(t, i);
  if (!q) return false;
  void at;
  const name = q.parts.join(".");
  let k = q.next;
  if (isPunct(t[k], "(")) k = skipParens(t, k);
  const action = renderTokens(t.slice(k, Math.min(t.length, k + 6)));
  const id = statementSymbol(ctx, statement, `alter ${t[1]!.value === "materialized" ? "materialized view" : t[1]!.value} ${name}`, `alter: ${clip(action, 80)} [token-read]`);
  ref(ctx, id, kind, name, "SQL_USES", `alter (${clip(action, 60)})`);
  const owner = t.findIndex((x, m) => isWord(x, "owner") && isWord(t[m + 1], "to"));
  if (owner >= 0 && t[owner + 2]) ref(ctx, id, "role", t[owner + 2]!.value, "SQL_GRANT", "owner");
  return true;
}

function dropTokens(ctx: FileContext, statement: SqlStatement, kind: SqlTokenKind): boolean {
  const t = statement.tokens;
  let i = isWord(t[1], "materialized") ? 3 : 2;
  if (isWord(t[i], "concurrently")) i += 1;
  if (isWord(t[i], "if") && isWord(t[i + 1], "exists")) i += 2;
  const names: string[] = [];
  while (i < t.length) {
    const q = readQName(t, i);
    if (!q) break;
    names.push(q.parts.join("."));
    i = q.next;
    if (isPunct(t[i], "(")) i = skipParens(t, i);
    if (!isPunct(t[i], ",")) break;
    i += 1;
  }
  if (names.length === 0) return false;
  const id = statementSymbol(ctx, statement, `drop ${t[1]!.value} ${names.join(", ")}`, `drop ${t[1]!.value} [token-read]`);
  for (const n of names) {
    ref(ctx, id, kind, n, "SQL_USES", `drop ${t[1]!.value}`);
    dropSite(ctx, kind, n, statement.start, statement.end, `drop ${t[1]!.value}`, id);
  }
  return true;
}

const COMMENT_KIND: Record<string, SqlTokenKind> = {
  table: "table", view: "table", column: "column", function: "function", procedure: "function", routine: "function",
  type: "type", domain: "type", schema: "schema", index: "index", sequence: "sequence", role: "role", trigger: "trigger",
  policy: "policy", materialized: "table"
};

/** `COMMENT ON kind target IS …` — documentation; the edge comes from the file's module symbol. */
function commentTokens(ctx: FileContext, statement: SqlStatement): boolean {
  const t = statement.tokens;
  const kindWord = t[2]?.kind === "word" ? t[2].value : "";
  if (kindWord === "extension" || kindWord === "database" || kindWord === "constraint" || kindWord === "operator" || kindWord === "cast") return true;
  const kind = COMMENT_KIND[kindWord];
  if (!kind) return false;
  const start = kindWord === "materialized" ? 4 : 3;
  const q = readQName(t, start);
  if (!q) return false;
  let name = q.parts.join(".");
  if ((kind === "policy" || kind === "trigger") && isWord(t[q.next], "on")) {
    const table = readQName(t, q.next + 1);
    if (table) name = `${table.parts.join(".")}.${name}`;
  }
  ref(ctx, ctx.moduleSymbolId, kind, name, "SQL_USES", `comment on ${kindWord} (line ${String(statement.line)})`);
  return true;
}
