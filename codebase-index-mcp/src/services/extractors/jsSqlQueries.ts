/**
 * TypeScript/JavaScript → SQL (MCP-ISSUE-082): the tables, columns and functions a query string
 * names, as `SQL_QUERY` edges that `resolveSqlEdges` binds BY NAME — labelled `name_resolved`,
 * confidence 0.6, never exact.
 *
 * Two places a query's text is read from, both static:
 *
 * 1. **The first argument of `<x>.query(…)` / `<x>.query<T>(…)`** — a string literal, a template
 *    literal, a `+` concatenation of them, an identifier naming a `const` of the SAME file whose
 *    value is one of those, or a member of a same-file const object literal (`read.statement` where
 *    `const read = { statement: \`select …\` }`). Clause: `ts query literal` / `ts query const NAME via
 *    NAME (file:line)` / `ts query const read.statement via read.statement (file:line)` — the
 *    `via CONST (file:line)` names where the text was read, the same spelling an imported const uses.
 *    An IMPORTED identifier (`import { INSERT_X } from './x-sql.js'`, renamed `import { A as B }`, or
 *    `ns.INSERT_X` through `import * as ns`) cannot be read from this file: it becomes an anchor
 *    token `sqlconst:<specifier>#<exported name>`, clause `ts query imported const B (line N)`, that
 *    `resolveSqlEdges` follows to the declaring module's const (release I4). A function call or any
 *    other expression is not followed.
 * 2. **A SQL-shaped `const`** — `const INSERT_X = \`insert into …\`` — anywhere in the file, from the
 *    const's own symbol (an exported const is a `variable` symbol; otherwise the enclosing symbol).
 *    In a codebase that keeps its statements in `*-sql.ts` files and passes them by name, this is the
 *    only place the text and the table name meet. "SQL-shaped" is the start of the value:
 *    `select` / `insert into` / `update` / `delete from` / `with` / `merge into` / `truncate`.
 *    Clause: `ts sql const NAME`.
 * 3. **A function that names a SQL-shaped const of its own file** — `one(SELECT_USAGE_IN_PERIOD, …)`
 *    through a wrapper, or a list handed to a transaction helper: the enclosing function uses that
 *    query. Same file only (an imported const is not followed). Clause: `ts uses sql const NAME`.
 *
 * Template substitutions: a `${NAME}` naming a same-file const with a static value is inlined (the
 * `const MESSAGE = 'conversation_store.conversation_message'` pattern); any other `${…}` becomes a
 * placeholder. Only the static parts are scanned, and a placeholder in a TABLE position is a named
 * gap — a `sql_gap` symbol at the literal's line — never a guess.
 *
 * The scan is `scanSqlReferences` over the SQL lexer's tokens, with columns claimed only where
 * unambiguous (see `sqlQueryScan.ts`).
 */

import type Parser from "tree-sitter";

import type { EdgeRecord, SymbolRecord } from "../../types/index.js";
import type { ExtractInput } from "./extractorTypes.js";
import { findEnclosingSymbolId, makeSymbolId } from "./extractorPrimitives.js";
import { lexSql } from "./sqlLexer.js";
import { scanSqlReferences } from "./sqlQueryScan.js";
import { SQL_CONST_TOKEN_PREFIX, SQL_IMPORTED_CONST_CLAUSE, SQL_TOKEN_CONFIDENCE, SQL_TOKEN_PREFIX, SQL_UNRESOLVED_REASON_PREFIX } from "./sqlExtractor.js";

const SQL_SHAPE = /^\s*(?:select\b|insert\s+into\b|update\s+\S+\s+set\b|update\b|delete\s+from\b|with\b|merge\s+into\b|truncate\b)/i;
const WRAPPERS = new Set(["parenthesized_expression", "as_expression", "satisfies_expression", "non_null_expression"]);
const MAX_CONST_DEPTH = 4;
/** A query text this long is generated, not written; it is not scanned. */
const MAX_QUERY_CHARS = 50_000;

type StaticText = { text: string; dynamic: number };

export function extractJavaScriptSqlQueries(
  input: ExtractInput,
  root: Parser.SyntaxNode,
  symbols: SymbolRecord[],
  edges: EdgeRecord[],
  moduleSymbolId: string
): void {
  // Cheap gate: a file with neither a `.query(` nor a SQL verb in a string cannot contribute. The type
  // arguments may nest (`.query<Record<string, unknown>>(`) — a `[^>]*` here dropped every such file
  // whose SQL lives in another module (release I4: wec.aria's store-notifications.ts).
  if (!/\.query\s*(?:<[^()]{0,300}?>)?\s*\(/.test(input.source) &&!/['"`]\s*(?:select|insert|update|delete|with|merge|truncate)\b/i.test(input.source)) return;

  const knownIds = new Set(symbols.map((s) => s.symbolId));
  const consts = new Map<string, { value: Parser.SyntaxNode; declarator: Parser.SyntaxNode; declaration: Parser.SyntaxNode }>();
  for (const declaration of root.descendantsOfType(["lexical_declaration"])) {
    if (!declaration.text.startsWith("const")) continue;
    for (const declarator of declaration.namedChildren.filter((c) => c.type === "variable_declarator")) {
      const name = declarator.childForFieldName("name");
      const value = declarator.childForFieldName("value");
      if (name?.type === "identifier" && value && !consts.has(name.text)) consts.set(name.text, { value, declarator, declaration });
    }
  }

  // Value imports by local name: `import { A as B } from './x'` → B ↦ (./x, A); `import * as ns` → ns ↦
  // (./x, *). Type-only imports name no value.
  const imports = new Map<string, { specifier: string; imported: string }>();
  for (const statement of root.descendantsOfType(["import_statement"])) {
    if (/^import\s+type\b/.test(statement.text)) continue;
    const source = statement.childForFieldName("source");
    const specifier = source ? source.text.slice(1, -1) : "";
    if (!specifier) continue;
    for (const spec of statement.descendantsOfType(["import_specifier"])) {
      if (/^type\s/.test(spec.text)) continue;
      const imported = spec.childForFieldName("name")?.text;
      const local = spec.childForFieldName("alias")?.text ?? imported;
      if (imported && local) imports.set(local, { specifier, imported });
    }
    for (const ns of statement.descendantsOfType(["namespace_import"])) {
      const local = ns.namedChildren.find((c) => c.type === "identifier")?.text;
      if (local) imports.set(local, { specifier, imported: "*" });
    }
  }

  let placeholderSeq = 0;
  const memo = new Map<string, StaticText | null>();

  const evalNode = (node: Parser.SyntaxNode, depth: number): StaticText | null => {
    let n = node;
    while (WRAPPERS.has(n.type) && n.namedChildren[0]) n = n.namedChildren[0];
    if (n.type === "string") return { text: n.text.slice(1, -1), dynamic: 0 };
    if (n.type === "template_string") {
      let text = "";
      let dynamic = 0;
      let cursor = n.startIndex + 1;
      for (const sub of n.namedChildren.filter((c) => c.type === "template_substitution")) {
        text += input.source.slice(cursor, sub.startIndex);
        const inner = sub.namedChildren[0];
        const inlined = inner?.type === "identifier" ? evalConst(inner.text, depth + 1) : null;
        if (inlined && inlined.dynamic === 0) text += inlined.text;
        else {
          text += ` __cbi_dyn_${String(placeholderSeq++)}__ `;
          dynamic += 1;
        }
        cursor = sub.endIndex;
      }
      text += input.source.slice(cursor, n.endIndex - 1);
      return { text, dynamic };
    }
    if (n.type === "binary_expression" && n.childForFieldName("operator")?.text === "+") {
      const left = n.childForFieldName("left");
      const right = n.childForFieldName("right");
      const l = left ? evalNode(left, depth) : null;
      const r = right ? evalNode(right, depth) : null;
      if (!l || !r) return null;
      return { text: l.text + r.text, dynamic: l.dynamic + r.dynamic };
    }
    if (n.type === "identifier") return evalConst(n.text, depth + 1);
    return null;
  };

  const evalConst = (name: string, depth: number): StaticText | null => {
    if (depth > MAX_CONST_DEPTH) return null;
    if (memo.has(name)) return memo.get(name)!;
    memo.set(name, null); // cycle guard
    const entry = consts.get(name);
    const result = entry ? evalNode(entry.value, depth) : null;
    memo.set(name, result);
    return result;
  };

  const edgeKeys = new Set<string>();
  const scan = (text: StaticText, fromId: string, clause: string, at: Parser.SyntaxNode): void => {
    if (text.text.length > MAX_QUERY_CHARS) return;
    const line = at.startPosition.row + 1;
    const refs = scanSqlReferences(lexSql(text.text), { columns: true });
    for (const r of refs) {
      if (r.kind === "dynamic") {
        const name = `gap: dynamic table name in query (${clause})`;
        const symbolId = makeSymbolId(input, "sql_gap", name, at.startPosition.row);
        if (!knownIds.has(symbolId)) {
          knownIds.add(symbolId);
          symbols.push({
            repoId: input.repoId,
            symbolId,
            filePath: input.filePath,
            name,
            kind: "sql_gap",
            line,
            endLine: at.endPosition.row + 1,
            signature: `not read: the ${r.clause} position is a \${…} substitution the graph cannot evaluate`,
            parentSymbolId: fromId === moduleSymbolId ? undefined : fromId
          });
        }
        continue;
      }
      const prefix = r.kind === "table" ? SQL_TOKEN_PREFIX.table : r.kind === "column" ? SQL_TOKEN_PREFIX.column : SQL_TOKEN_PREFIX.function;
      const toId = `${prefix}${r.name}`;
      const key = `${fromId}\u0000${toId}`;
      if (edgeKeys.has(key)) continue;
      edgeKeys.add(key);
      edges.push({
        repoId: input.repoId,
        fromId,
        toId,
        type: "SQL_QUERY",
        confidence: SQL_TOKEN_CONFIDENCE,
        reason: `${SQL_UNRESOLVED_REASON_PREFIX}${clause} ${r.clause} (line ${String(line)})`
      });
    }
  };

  /** An imported query const at a `.query(` site: the anchor the resolver follows. */
  const anchor = (fromId: string, local: string, specifier: string, imported: string, at: Parser.SyntaxNode): void => {
    const toId = `${SQL_CONST_TOKEN_PREFIX}${specifier}#${imported}`;
    const key = `${fromId}\u0000${toId}`;
    if (edgeKeys.has(key)) return;
    edgeKeys.add(key);
    edges.push({
      repoId: input.repoId,
      fromId,
      toId,
      type: "SQL_QUERY",
      confidence: SQL_TOKEN_CONFIDENCE,
      reason: `${SQL_UNRESOLVED_REASON_PREFIX}${SQL_IMPORTED_CONST_CLAUSE}${local} (line ${String(at.startPosition.row + 1)})`
    });
  };

  /** `obj.prop` where `obj` is a same-file const object literal with a static `prop`. */
  const evalMember = (node: Parser.SyntaxNode): StaticText | null => {
    const object = node.childForFieldName("object");
    const property = node.childForFieldName("property");
    if (object?.type !== "identifier" || !property) return null;
    let value = consts.get(object.text)?.value ?? null;
    while (value && WRAPPERS.has(value.type) && value.namedChildren[0]) value = value.namedChildren[0];
    if (value?.type !== "object") return null;
    for (const pair of value.namedChildren.filter((c) => c.type === "pair")) {
      const key = pair.childForFieldName("key");
      const keyText = key?.type === "string" ? key.text.slice(1, -1) : key?.text;
      if (keyText !== property.text) continue;
      const v = pair.childForFieldName("value");
      return v ? evalNode(v, 1) : null;
    }
    return null;
  };

  // (1) `.query(` call sites.
  for (const call of root.descendantsOfType(["call_expression"])) {
    let fn = call.childForFieldName("function");
    // tree-sitter-typescript reads `await client.query<T>(…)` as a call whose function is the
    // await expression (the type arguments bind late); the member is one level down.
    while (fn && (fn.type === "await_expression" || fn.type === "non_null_expression" || fn.type === "parenthesized_expression")) fn = fn.namedChildren[0] ?? null;
    if (fn?.type !== "member_expression") continue;
    if (fn.childForFieldName("property")?.text !== "query") continue;
    const first = call.childForFieldName("arguments")?.namedChildren[0];
    if (!first) continue;
    const fromId = findEnclosingSymbolId(call, input) ?? moduleSymbolId;
    if (first.type === "identifier") {
      if (!consts.has(first.text)) {
        const imported = imports.get(first.text);
        if (imported && imported.imported !== "*") anchor(fromId, first.text, imported.specifier, imported.imported, call);
        continue;
      }
      const text = evalConst(first.text, 0);
      if (text) scan(text, fromId, `ts query const ${first.text} via ${first.text} (${input.filePath}:${String(consts.get(first.text)!.declaration.startPosition.row + 1)})`, call);
      continue;
    }
    if (first.type === "member_expression") {
      const object = first.childForFieldName("object");
      const property = first.childForFieldName("property");
      if (object?.type !== "identifier" || !property) continue;
      if (!consts.has(object.text)) {
        const ns = imports.get(object.text);
        if (ns?.imported === "*") anchor(fromId, `${object.text}.${property.text}`, ns.specifier, property.text, call);
        continue;
      }
      const member = evalMember(first);
      if (member) scan(member, fromId, `ts query const ${object.text}.${property.text} via ${object.text}.${property.text} (${input.filePath}:${String(consts.get(object.text)!.declaration.startPosition.row + 1)})`, call);
      continue;
    }
    const text = evalNode(first, 0);
    if (text) scan(text, fromId, "ts query literal", first);
  }

  // (2) SQL-shaped consts, from the const's own symbol.
  const sqlConsts = new Map<string, StaticText>();
  for (const [name, entry] of consts) {
    const text = evalConst(name, 0);
    if (!text || !SQL_SHAPE.test(text.text)) continue;
    sqlConsts.set(name, text);
    const variableId = makeSymbolId(input, "variable", name, entry.declaration.startPosition.row);
    const fromId = knownIds.has(variableId) ? variableId : findEnclosingSymbolId(entry.declarator, input) ?? moduleSymbolId;
    scan(text, fromId, `ts sql const ${name}`, entry.declarator);
  }

  // (3) A function of the same file that names a SQL-shaped const — passes it to a wrapper
  // (`one(SELECT_X, …)`), a transaction helper, an array of statements — uses that query. Only a
  // reference inside a function or method counts: a module-level list of statements is not a use.
  if (sqlConsts.size === 0) return;
  for (const id of root.descendantsOfType(["identifier"])) {
    const text = sqlConsts.get(id.text);
    if (!text) continue;
    const parent = id.parent;
    if (parent?.type === "variable_declarator" && parent.childForFieldName("name")?.startIndex === id.startIndex) continue;
    const fromId = findEnclosingSymbolId(id, input);
    if (!fromId) continue;
    scan(text, fromId, `ts uses sql const ${id.text}`, id);
  }
}
