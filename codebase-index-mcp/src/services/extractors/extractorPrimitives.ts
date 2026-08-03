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

export function findEnclosingSymbolId(node: Parser.SyntaxNode, input: ExtractInput): string | null {
  const FUNCTION_TYPES = new Set([
    "function_declaration",
    "function_expression",
    "arrow_function",
    "method_definition"
  ]);
  let current: Parser.SyntaxNode | null = node.parent;

  while (current) {
    if (FUNCTION_TYPES.has(current.type)) {
      const nameNode = current.childForFieldName("name");
      if (nameNode) {
        return stableId(`${input.repoId}:${input.filePath}:${nameNode.text}:${current.startPosition.row + 1}`);
      }
      return stableId(`${input.repoId}:${input.filePath}:anonymous:${current.startPosition.row + 1}`);
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
