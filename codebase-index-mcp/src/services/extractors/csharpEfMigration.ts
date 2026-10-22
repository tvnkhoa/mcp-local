import type Parser from "tree-sitter";

import type { EdgeRecord, SymbolRecord } from "../../types/index.js";
import type { ExtractInput } from "./extractorTypes.js";
import { makeSymbolId } from "./extractorPrimitives.js";
import { extractSql } from "./sqlExtractor.js";

/**
 * Release M2: the SQL an EF Core migration runs that the model does not state — `migrationBuilder.Sql("…")` in
 * `Up()` / `Down()` (partial and expression indexes, functions, triggers, backfills) — and, release M1, the
 * `DropTable` / `DropColumn` / `DropIndex` operations of `Up()`.
 *
 * ## One SQL reader
 *
 * The string goes through the `.sql` lane's own `extractSql`, so a `CREATE UNIQUE INDEX … WHERE …` here becomes the
 * same `sql_index` a migration file would give, at THIS file's line: the text is padded so each piece of the string
 * sits on the line it is written on. An EF drop operation is spelled as the equivalent SQL (`DROP INDEX "x";`) at the
 * call's line and read the same way, so it yields the same `sql_statement` + `sql_drop` a `.sql` drop does.
 *
 * ## Order
 *
 * The file is a numbered migration (`20260805110155_X.cs`), so what it defines is tier 3, sequenced by that
 * timestamp (`graph/sqlDefinitions.ts`). `Down()` is a rollback: its symbols say `[EF down]` right after the
 * signature's separator and rank tier 0, never current while an `Up()` site exists. Drop operations in `Down()`
 * are not read — rolling back a create is not the schema going forward. The ModelSnapshot (tier 4) stays the
 * current site of every name it maps.
 *
 * ## Statically resolved, or a gap
 *
 * The argument is read when it is a string literal (regular, verbatim, raw), an interpolated string whose holes
 * are `const string` fields of the migration class (`$@"CREATE INDEX {IndexName} …"`), or a `+` of those. Anything
 * else — a local, a call, `nameof`, a non-const field, a format specifier, a multi-line const in a hole (it would
 * shift every line after it) — is a `sql_gap` at the call's line naming why. Never a silent skip.
 */

type Piece = { text: string; row: number; column: number };

const EF_DROP_OPS = new Set(["DropTable", "DropColumn", "DropIndex"]);

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** A regular C# string's escapes; `\n` / `\r` / `\t` become a space so the text keeps its line count. */
function unescapeRegular(text: string): string {
  return text.replace(/\\(.)/g, (_, c: string) => (c === "n" || c === "r" || c === "t" ? " " : c === "0" ? " " : c));
}

/** Text of the class's `const string` fields, resolved; a field that cannot be resolved is absent. */
function readConsts(cls: Parser.SyntaxNode): Map<string, string> {
  const raw = new Map<string, Parser.SyntaxNode>();
  for (const field of cls.namedChildren.find((c) => c.type === "declaration_list")?.namedChildren ?? []) {
    if (field.type !== "field_declaration") continue;
    if (!field.namedChildren.some((m) => m.type === "modifier" && m.text === "const")) continue;
    const decl = field.namedChildren.find((c) => c.type === "variable_declaration");
    if (!decl || decl.namedChildren[0]?.text !== "string") continue;
    for (const v of decl.namedChildren.filter((c) => c.type === "variable_declarator")) {
      const name = v.namedChildren[0];
      const value = v.namedChildren[v.namedChildren.length - 1];
      if (name?.type === "identifier" && value && value !== name) raw.set(name.text, value);
    }
  }
  const resolved = new Map<string, string>();
  const resolving = new Set<string>();
  const valueOf = (node: Parser.SyntaxNode): string | null => {
    const pieces = piecesOf(node, (id) => {
      if (resolved.has(id)) return resolved.get(id)!;
      const n = raw.get(id);
      if (!n || resolving.has(id)) return null;
      resolving.add(id);
      const v = valueOf(n);
      resolving.delete(id);
      if (v !== null) resolved.set(id, v);
      return v;
    });
    return typeof pieces === "string" ? null : pieces.map((p) => p.text).join("");
  };
  for (const [id, node] of raw) {
    if (resolved.has(id)) continue;
    resolving.add(id);
    const v = valueOf(node);
    resolving.delete(id);
    if (v !== null) resolved.set(id, v);
  }
  return resolved;
}

/**
 * The pieces of a string expression with their source positions, or the reason it cannot be read statically.
 * `lookup` resolves a hole's identifier to a const's text.
 */
function piecesOf(node: Parser.SyntaxNode, lookup: (id: string) => string | null): Piece[] | string {
  const at = (n: Parser.SyntaxNode, offset: number): { row: number; column: number } => ({ row: n.startPosition.row, column: n.startPosition.column + offset });
  switch (node.type) {
    case "string_literal": {
      const content = node.namedChildren.filter((c) => c.type === "string_literal_content" || c.type === "escape_sequence").map((c) => c.text).join("");
      return [{ text: unescapeRegular(content), ...at(node, 1) }];
    }
    case "verbatim_string_literal":
      return [{ text: node.text.replace(/^@"|"$/g, "").replace(/""/g, '"'), ...at(node, 2) }];
    case "raw_string_literal": {
      const content = node.namedChildren.find((c) => c.type === "raw_string_content");
      return content ? [{ text: content.text, ...at(content, 0) }] : [];
    }
    case "interpolated_string_expression": {
      const start = node.namedChildren.find((c) => c.type === "interpolation_start")?.text ?? "$\"";
      const verbatim = start.includes("@");
      const raw = start.includes("\"\"\"");
      const out: Piece[] = [];
      for (const part of node.namedChildren) {
        if (part.type === "string_content") {
          const text = raw ? part.text : verbatim ? part.text.replace(/""/g, '"') : unescapeRegular(part.text);
          out.push({ text: text.replace(/\{\{/g, "{").replace(/\}\}/g, "}"), ...at(part, 0) });
        } else if (part.type === "escape_sequence") {
          out.push({ text: unescapeRegular(part.text), ...at(part, 0) });
        } else if (part.type === "interpolation") {
          const inner = part.namedChildren.filter((c) => c.type !== "interpolation_brace");
          if (inner.length !== 1 || inner[0]!.type !== "identifier") return `interpolation {${part.text.slice(1, -1)}} is not a const`;
          const value = lookup(inner[0]!.text);
          if (value === null) return `interpolation {${inner[0]!.text}} is not a const string of this class`;
          if (value.includes("\n")) return `interpolation {${inner[0]!.text}} is a multi-line const`;
          out.push({ text: value, ...at(part, 0) });
        }
      }
      return out;
    }
    case "binary_expression": {
      const [left, right] = [node.namedChildren[0], node.namedChildren[node.namedChildren.length - 1]];
      const op = node.children.find((c) => !c.isNamed)?.text;
      if (!left || !right || op !== "+") return `operator ${op ?? "?"} in the argument`;
      const l = piecesOf(left, lookup);
      if (typeof l === "string") return l;
      const r = piecesOf(right, lookup);
      if (typeof r === "string") return r;
      return [...l, ...r];
    }
    case "parenthesized_expression":
      return node.namedChildren[0] ? piecesOf(node.namedChildren[0], lookup) : "empty parentheses";
    case "identifier": {
      const value = lookup(node.text);
      if (value === null) return `${node.text} is not a const string of this class`;
      if (value.includes("\n")) return `${node.text} is a multi-line const`;
      return [{ text: value, row: node.startPosition.row, column: node.startPosition.column }];
    }
    default:
      return `${node.type.replace(/_/g, " ")} in the argument`;
  }
}

/** Lay the pieces out on their own lines and columns, so the SQL reader's lines are this file's lines. */
function layOut(pieces: Piece[]): string {
  let out = "";
  let row = 0;
  let column = 0;
  for (const p of pieces) {
    if (p.row > row) {
      // A `+` across lines: the newline is SQL whitespace, unless it would split one word in two.
      const joinsWord = /\w$/.test(out) && /^\w/.test(p.text);
      if (!joinsWord) {
        out += "\n".repeat(p.row - row) + " ".repeat(p.column);
        row = p.row;
        column = p.column;
      }
    } else if (out === "" && p.column > column) {
      out += " ".repeat(p.column - column);
    }
    out += p.text;
    const lines = p.text.split("\n");
    row += lines.length - 1;
    column = lines.length > 1 ? lines[lines.length - 1]!.length : column + p.text.length;
  }
  return out;
}

/** `name: "x"` → x; a positional argument by index. */
function argumentsOf(call: Parser.SyntaxNode): { named: Map<string, Parser.SyntaxNode>; positional: Parser.SyntaxNode[] } {
  const named = new Map<string, Parser.SyntaxNode>();
  const positional: Parser.SyntaxNode[] = [];
  for (const arg of call.childForFieldName("arguments")?.namedChildren.filter((a) => a.type === "argument") ?? []) {
    const kids = arg.namedChildren;
    const colon = arg.children.some((c) => !c.isNamed && c.text === ":");
    if (colon && kids.length >= 2 && kids[0]!.type === "identifier") named.set(kids[0]!.text, kids[kids.length - 1]!);
    else if (kids[0]) positional.push(kids[kids.length - 1]!);
  }
  return { named, positional };
}

/** Emit what the migration's `Sql` calls and `Up()` drop operations say. Returns false for any other file. */
export function extractEfMigrationImpl(input: ExtractInput, root: Parser.SyntaxNode, moduleSymbolId: string, symbols: SymbolRecord[], edges: EdgeRecord[]): boolean {
  let found = false;
  for (const cls of root.descendantsOfType("class_declaration")) {
    const bases = cls.namedChildren.find((c) => c.type === "base_list");
    if (!bases || !bases.namedChildren.some((b) => b.text === "Migration" || b.text.endsWith(".Migration"))) continue;
    found = true;
    const className = cls.childForFieldName("name")?.text ?? "?";
    const consts = readConsts(cls);
    const lookup = (id: string): string | null => consts.get(id) ?? null;
    for (const method of cls.descendantsOfType("method_declaration")) {
      const methodName = method.childForFieldName("name")?.text;
      if (methodName !== "Up" && methodName !== "Down") continue;
      const down = methodName === "Down";
      const param = method.childForFieldName("parameters")?.namedChildren[0]?.childForFieldName("name")?.text ?? "migrationBuilder";
      const body = method.childForFieldName("body");
      if (!body) continue;
      const suffix = ` [EF migration ${className}]`;
      const read = (sql: string, op: string): void => {
        const result = extractSql({ ...input, source: sql, language: "sql" }, moduleSymbolId, { detailPrefix: down ? "[EF down] " : "", detailSuffix: `${suffix}${op}` });
        symbols.push(...result.symbols);
        edges.push(...result.edges);
      };
      const gap = (call: Parser.SyntaxNode, why: string): void => {
        const row = call.startPosition.row;
        const name = `gap: migrationBuilder.Sql (${why.length > 80 ? `${why.slice(0, 79)}…` : why})`;
        symbols.push({
          repoId: input.repoId,
          symbolId: makeSymbolId(input, "sql_gap", name, row),
          filePath: input.filePath,
          name,
          kind: "sql_gap",
          line: row + 1,
          endLine: call.endPosition.row + 1,
          signature: `${down ? "[EF down] " : ""}not read: ${why}${suffix}`
        });
      };
      for (const call of body.descendantsOfType("invocation_expression")) {
        const fn = call.childForFieldName("function");
        if (fn?.type !== "member_access_expression" || fn.childForFieldName("expression")?.text !== param) continue;
        const op = fn.childForFieldName("name")?.text ?? "";
        const { named, positional } = argumentsOf(call);
        if (op === "Sql") {
          const arg = named.get("sql") ?? positional[0];
          if (!arg) {
            gap(call, "no argument");
            continue;
          }
          const pieces = piecesOf(arg, lookup);
          if (typeof pieces === "string") gap(call, pieces);
          else read(layOut(pieces), "");
          continue;
        }
        if (down || !EF_DROP_OPS.has(op)) continue;
        const str = (key: string, index: number): string | null => {
          const node = named.get(key) ?? positional[index];
          if (!node) return null;
          const p = piecesOf(node, lookup);
          return typeof p === "string" ? null : p.map((x) => x.text).join("");
        };
        const name = str("name", 0);
        if (!name) {
          gap(call, `${op} with a name that is not a constant`);
          continue;
        }
        const schema = op === "DropColumn" ? str("schema", 2) : op === "DropIndex" ? str("schema", 2) : str("schema", 1);
        const qualify = (n: string): string => (schema ? `${quoteIdent(schema)}.${quoteIdent(n)}` : quoteIdent(n));
        let sql: string;
        if (op === "DropColumn") {
          const table = str("table", 1);
          if (!table) {
            gap(call, "DropColumn with a table that is not a constant");
            continue;
          }
          sql = `ALTER TABLE ${qualify(table)} DROP COLUMN ${quoteIdent(name)};`;
        } else {
          sql = `${op === "DropTable" ? "DROP TABLE" : "DROP INDEX"} ${qualify(name)};`;
        }
        // The equivalent SQL at the call's own line and column.
        read(`${"\n".repeat(call.startPosition.row)}${" ".repeat(call.startPosition.column)}${sql}`, ` (${op})`);
      }
    }
  }
  return found;
}
