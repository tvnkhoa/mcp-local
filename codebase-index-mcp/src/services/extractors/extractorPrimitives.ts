/**
 * Stable ids, string trimming, and the generic tree-sitter node helpers.
 *
 * Nothing in this part knows a language; everything that does lives in a sibling part. That
 * is also why it is the one part every other extractor imports.
 */

import { createHash } from "node:crypto";
import type Parser from "tree-sitter";
import type { SymbolRecord } from "../../types/index.js";
import type { ExtractInput } from "./extractorTypes.js";

export function stableId(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 24);
}

// ============================================================================
// String Utilities
// ============================================================================

export function stripQuotes(value: string): string {
  return value.replace(/^['\"]|['\"]$/g, "").trim();
}

export function extractFirstStringLiteral(input: string): string | null {
  const match = /["']([^"']+)["']/.exec(input);
  return match?.[1] ?? null;
}

// ============================================================================
// Route Utilities
// ============================================================================

/**
 * The one place a symbol id is minted. Every extractor keys on the same four parts, and the
 * enclosing-symbol lookup below has to reproduce the string byte for byte or the edge it builds
 * points at nothing.
 *
 * That is not hypothetical: the JS lane spelled the id without `kind` and with `row + 1` while
 * registration used `kind` and `row`, so 77% of TypeScript edges carried a `fromId` that matched no
 * symbol. The C# twin (`findEnclosingCSharpSymbolId`) carries a comment warning about exactly this.
 * Call this helper on both sides instead of re-spelling the template.
 *
 * `row` is the tree-sitter 0-indexed `startPosition.row`, NOT the 1-indexed `line` on the record.
 */
export function makeSymbolId(
  input: ExtractInput,
  kind: string,
  name: string,
  row: number
): string {
  return stableId(`${input.repoId}:${input.filePath}:${kind}:${name}:${row}`);
}

/**
 * Node types the JS/TS extractor registers as symbols, mapped to the kind it registers them under.
 *
 * A `Map`, not an object literal: these are looked up by arbitrary grammar node names, and a plain
 * object answers `obj["constructor"]` with `Object.prototype.constructor` — a truthy value that is
 * not a kind. No current node type is named that, but the lookup should not depend on it.
 */
const JS_ENCLOSING_KIND_BY_NODE_TYPE = new Map<string, string>([
  ["function_declaration", "function"],
  ["generator_function_declaration", "function"],
  ["method_definition", "method"],
  ["class_declaration", "class"],
  ["abstract_class_declaration", "class"]
]);

/**
 * A function expression only becomes a symbol when it is bound to a name, and the id is keyed on the
 * *declaration* row, not the arrow's own row — `jsSymbols` registers it while walking
 * `lexical_declaration`. Returns null for a genuinely anonymous callback so the caller can keep
 * walking outward and attribute the call to the nearest named owner.
 */
export function boundFunctionSymbolId(node: Parser.SyntaxNode, input: ExtractInput): string | null {
  const declarator = node.parent;
  if (declarator?.type !== "variable_declarator") return null;
  const nameNode = declarator.childForFieldName("name");
  if (!nameNode || nameNode.type !== "identifier") return null;
  const declaration = declarator.parent;
  if (declaration?.type !== "lexical_declaration") return null;
  return makeSymbolId(input, "function", nameNode.text, declaration.startPosition.row);
}

export function findEnclosingSymbolId(node: Parser.SyntaxNode, input: ExtractInput): string | null {
  let current: Parser.SyntaxNode | null = node.parent;

  while (current) {
    const kind = JS_ENCLOSING_KIND_BY_NODE_TYPE.get(current.type);
    if (kind) {
      const nameNode = current.childForFieldName("name");
      // An unnamed `export default function () {}` registers no symbol; walk outward rather than
      // mint an id for something that was never stored.
      if (nameNode) {
        // A constructor is registered under its own kind, not `method`. Spelling it `method` here
        // put every call in a constructor body on an id that matched nothing.
        const resolvedKind = kind === "method" && nameNode.text === "constructor" ? "constructor" : kind;
        return makeSymbolId(input, resolvedKind, nameNode.text, current.startPosition.row);
      }
    } else if (current.type === "arrow_function" || current.type === "function_expression") {
      const bound = boundFunctionSymbolId(current, input);
      if (bound) return bound;
    }
    current = current.parent;
  }

  return null;
}

export function extractSignature(node: Parser.SyntaxNode, maxLen = 300): string {
  const raw = node.text.split("\n")[0]?.trim() ?? "";
  if (raw.length <= maxLen) {
    return raw;
  }
  return raw.slice(0, maxLen) + "...";
}

export function lineFromOffset(source: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < source.length; i++) {
    if (source[i] === "\n") {
      line += 1;
    }
  }
  return line;
}

export function findSymbolIdByName(symbols: SymbolRecord[], name: string): string | null {
  for (const symbol of symbols) {
    if (symbol.name === name) {
      return symbol.symbolId;
    }
  }
  return null;
}

// ============================================================================
// JavaScript Utilities
// ============================================================================

/**
 * JS/TS runtime built-in method names that will never resolve to a user-defined symbol.
 */
