import fs from "node:fs";

import Parser from "tree-sitter";

import type { GraphStore } from "../store/graphStore.js";
import { parseCSharpOnDemand } from "../extractors/treeSitterExtractor.js";
import type { PreviewCandidateHunk } from "../refactor/refactorTypes.js";
import type { RefactorRiskFlag } from "../types.js";
import {
  normalizeRelativePath,
  sha256,
  assertSafeRepoFilePath,
  inferLanguageFromPath,
  isGeneratedFilePath,
  offsetToLine,
  pathStartsWithAny
} from "../refactor/refactorUtils.js";
import { collectCSharpScopeTypeMap } from "../extractors/extractorUtils.js";

/**
 * ENH-029-A — `change_value_representation`.
 *
 * The recurring "promote a property literal to an enum member" refactor (e.g. `HandledBy = "ai"`
 * → `HandledBy = ConversationHandledBy.Ai`; `Equal("ai", x.HandledBy)` → `Equal(ConversationHandledBy.Ai, …)`).
 * Previously this forced hand-written regex + capture groups, which is exactly what tripped MCP-ISSUE-029.
 *
 * This locates the literal sites via the C# AST (no user-authored backreference) and rewrites the
 * literal token to the mapped enum member. The resulting hunks feed the existing
 * preview → apply → rollback pipeline unchanged, so the rewrite stays preview-gated and reversible.
 */

export type ValueRepresentationInput = {
  /** Property identifier whose literal values are being promoted, e.g. "HandledBy". */
  property: string;
  /** Owner type that scopes the rewrite, e.g. "Conversation". Cross-type sites are skipped. */
  requiredOwnerType: string;
  /** Literal value (unquoted) → replacement expression, e.g. { "ai": "ConversationHandledBy.Ai" }. */
  valueMap: Record<string, string>;
  /** When false, only assignment/initializer write-sites are rewritten (no ==/!= or argument sites). */
  includeComparisons?: boolean;
};

const CSHARP_STRING_NODE_TYPES = new Set(["string_literal", "verbatim_string_literal"]);
const COMPARISON_OPERATORS = new Set(["==", "!="]);
const PER_FILE_MATCH_CAP = 2000;
const GLOBAL_MATCH_CAP = 5000;

/** Unquoted inner text of a regular/verbatim C# string literal, or null if not a plain string literal. */
function stringLiteralValue(node: Parser.SyntaxNode): string | null {
  if (!CSHARP_STRING_NODE_TYPES.has(node.type)) return null;
  const raw = node.text;
  if (node.type === "verbatim_string_literal") {
    // @"..." — inner "" escapes a literal quote.
    const inner = raw.replace(/^@"/, "").replace(/"$/, "");
    return inner.replace(/""/g, '"');
  }
  // Regular "..." — reject if it carries escapes we would mis-map (keep matching simple & safe).
  const inner = raw.replace(/^"/, "").replace(/"$/, "");
  if (inner.includes("\\")) return null;
  return inner;
}

/** Property identifier this node resolves to (member-access `recv.Prop` → "Prop"; bare `Prop` → "Prop"). */
function accessedPropertyName(node: Parser.SyntaxNode): string | null {
  if (node.type === "member_access_expression") {
    const name = node.childForFieldName("name");
    return name ? name.text.trim() : null;
  }
  if (node.type === "identifier") {
    return node.text.trim();
  }
  return null;
}

/** Receiver identifier of a member access (`recv.Prop` → "recv"), or null. */
function memberAccessReceiverName(node: Parser.SyntaxNode): string | null {
  if (node.type !== "member_access_expression") return null;
  const recv = node.childForFieldName("expression");
  return recv && recv.type === "identifier" ? recv.text.trim() : null;
}

/** Nearest enclosing object_creation_expression type name (`new Conversation { … }` → "Conversation"). */
function enclosingObjectCreationType(node: Parser.SyntaxNode): string | null {
  let current: Parser.SyntaxNode | null = node.parent;
  while (current) {
    if (current.type === "object_creation_expression") {
      const typeNode = current.childForFieldName("type");
      return typeNode ? typeNode.text.trim() : null;
    }
    // An initializer belongs to the object_creation that directly precedes it; don't escape the statement.
    if (current.type === "block" || current.type === "method_declaration") break;
    current = current.parent;
  }
  return null;
}

type OwnerVerdict = "verified" | "unknown" | "cross_type";

/**
 * Decide whether a property access belongs to `requiredOwnerType`.
 * - object-initializer: type comes from the enclosing `new T { … }`.
 * - member access `recv.Prop`: receiver type from the method scope type map (param/local/field).
 * Returns "cross_type" only when a *known* owner type differs — those sites are dropped, never rewritten.
 */
function verifyOwner(
  access: Parser.SyntaxNode,
  requiredOwnerType: string,
  scopeForNode: (node: Parser.SyntaxNode) => Map<string, string>
): OwnerVerdict {
  const required = requiredOwnerType.toLowerCase();

  if (access.type === "identifier") {
    // Bare `Prop` inside an object initializer → owner is the constructed type.
    const ctorType = enclosingObjectCreationType(access);
    if (ctorType) return ctorType.toLowerCase() === required ? "verified" : "cross_type";
    return "unknown";
  }

  const receiver = memberAccessReceiverName(access);
  if (!receiver) return "unknown";
  const declaredType = scopeForNode(access).get(receiver);
  if (!declaredType) return "unknown";
  return declaredType.toLowerCase() === required ? "verified" : "cross_type";
}

/** Type name of an `object_creation_expression` (`new T(...)` → "T"). */
function objectCreationTypeName(node: Parser.SyntaxNode | undefined): string | undefined {
  if (!node || node.type !== "object_creation_expression") return undefined;
  const typeField = node.childForFieldName("type")?.text.trim();
  if (typeField) return typeField;
  // Fallback: first named child is the type identifier in grammars without a `type` field.
  const first = node.namedChildren[0];
  return first && (first.type === "identifier" || first.type.endsWith("_name")) ? first.text.trim() : undefined;
}

/**
 * Map locally-declared variables to their concrete type. The shared scope-map helper reads the type
 * off `local_declaration_statement`, but in this grammar the type lives under `variable_declaration`
 * (and is `var`/`implicit_type` for inferred locals), so locals are missed entirely. Walk
 * `variable_declaration` directly: prefer the explicit declared type, falling back to the `new T()`
 * initializer's type for `var` locals — which is what most assignment/comparison receivers use.
 */
function collectLocalDeclaredTypes(scopeRoot: Parser.SyntaxNode): Map<string, string> {
  const map = new Map<string, string>();
  for (const vd of scopeRoot.descendantsOfType("variable_declaration")) {
    const declaredType = vd.childForFieldName("type")?.text.trim();
    const isInferred = !declaredType || declaredType === "var";
    for (const declarator of vd.descendantsOfType("variable_declarator")) {
      const name = declarator.childForFieldName("name")?.text.trim();
      if (!name) continue;
      const created = objectCreationTypeName(declarator.namedChildren.find((c) => c.type === "object_creation_expression"));
      const concrete = isInferred ? created : declaredType;
      if (concrete) map.set(name, concrete);
    }
  }
  return map;
}

/** Enclosing method/constructor node used as the scope root for type inference, or the file root. */
function enclosingScopeRoot(node: Parser.SyntaxNode): Parser.SyntaxNode {
  let current: Parser.SyntaxNode | null = node;
  while (current) {
    if (
      current.type === "method_declaration" ||
      current.type === "constructor_declaration" ||
      current.type === "local_function_statement"
    ) {
      return current;
    }
    if (!current.parent) return current;
    current = current.parent;
  }
  return node;
}

/**
 * Classify how a string-literal node relates to the target property.
 * Returns the property-access node it is bound to (for owner verification) plus the site kind,
 * or null when the literal is not a rewrite candidate.
 */
function classifyLiteralSite(
  literal: Parser.SyntaxNode,
  property: string,
  includeComparisons: boolean
): { access: Parser.SyntaxNode; kind: "assignment" | "comparison" | "argument" } | null {
  const parent = literal.parent;
  if (!parent) return null;

  // (a) assignment / object-initializer write: `lhs = "literal"`
  if (parent.type === "assignment_expression" && parent.childForFieldName("right")?.id === literal.id) {
    const lhs = parent.childForFieldName("left");
    if (lhs && accessedPropertyName(lhs) === property) {
      return { access: lhs, kind: "assignment" };
    }
    return null;
  }

  if (!includeComparisons) return null;

  // (b) equality comparison: `x.Prop == "literal"` (either operand order)
  if (parent.type === "binary_expression") {
    const opNode = parent.child(1);
    if (opNode && COMPARISON_OPERATORS.has(opNode.text)) {
      const left = parent.childForFieldName("left");
      const right = parent.childForFieldName("right");
      const other = left?.id === literal.id ? right : left;
      if (other && accessedPropertyName(other) === property) {
        return { access: other, kind: "comparison" };
      }
    }
    return null;
  }

  // (c) invocation argument: `Equal("literal", x.Prop)` — a sibling argument names the property.
  if (parent.type === "argument" && parent.parent?.type === "argument_list") {
    for (const arg of parent.parent.namedChildren) {
      if (arg.id === parent.id) continue;
      const inner = arg.type === "argument" ? arg.namedChildren[0] : arg;
      if (inner && accessedPropertyName(inner) === property) {
        return { access: inner, kind: "argument" };
      }
    }
  }

  return null;
}

/**
 * Build literal→enum rewrite hunks across the indexed C# files in scope.
 * Mirrors `buildSymbolMigrationPreview`'s return shape so the caller can persist + apply identically.
 */
export function buildValueRepresentationPreview(
  store: GraphStore,
  repoPath: string,
  repoId: string,
  input: ValueRepresentationInput,
  scopePaths: string[]
): { hunks: PreviewCandidateHunk[]; affectedFiles: string[] } {
  const includeComparisons = input.includeComparisons !== false;
  const includePaths = (scopePaths ?? []).map((x) => normalizeRelativePath(x));

  const selectedFiles = store
    .listIndexedFiles(repoId)
    .map((x) => normalizeRelativePath(x.path))
    .filter((filePath) => inferLanguageFromPath(filePath) === "csharp")
    .filter((filePath) => pathStartsWithAny(filePath, includePaths))
    .sort((a, b) => a.localeCompare(b));

  const hunks: PreviewCandidateHunk[] = [];
  const affected = new Set<string>();
  let totalMatches = 0;

  for (const filePath of selectedFiles) {
    if (totalMatches >= GLOBAL_MATCH_CAP) break;
    const safeAbsolute = assertSafeRepoFilePath(repoPath, filePath);
    if (!fs.existsSync(safeAbsolute)) continue;

    const content = fs.readFileSync(safeAbsolute, "utf8");
    const fileHashBefore = sha256(content);
    const tree = parseCSharpOnDemand(content, filePath);
    if (!tree) continue; // too large / parse timeout → skip this file
    const generated = isGeneratedFilePath(filePath);

    // Memoize the scope type map per enclosing method node — reused across literals in that method.
    const scopeCache = new Map<number, Map<string, string>>();
    const scopeForNode = (node: Parser.SyntaxNode): Map<string, string> => {
      const root = enclosingScopeRoot(node);
      let map = scopeCache.get(root.id);
      if (!map) {
        map = collectCSharpScopeTypeMap(root, /* includeDiAliases */ false);
        // Overlay locally-declared variable types (the shared helper misses locals in this grammar).
        for (const [name, type] of collectLocalDeclaredTypes(root)) {
          const existing = map.get(name);
          if (!existing || existing.toLowerCase() === "var") map.set(name, type);
        }
        scopeCache.set(root.id, map);
      }
      return map;
    };

    let perFile = 0;
    const literals = tree.rootNode.descendantsOfType([...CSHARP_STRING_NODE_TYPES]);
    for (const literal of literals) {
      if (perFile >= PER_FILE_MATCH_CAP || totalMatches >= GLOBAL_MATCH_CAP) break;
      const value = stringLiteralValue(literal);
      if (value === null) continue;
      const replacement = input.valueMap[value];
      if (replacement === undefined) continue;

      const site = classifyLiteralSite(literal, input.property, includeComparisons);
      if (!site) continue;

      const verdict = verifyOwner(site.access, input.requiredOwnerType, scopeForNode);
      if (verdict === "cross_type") continue; // known-different owner — never rewrite

      const riskFlags: RefactorRiskFlag[] = [];
      if (generated) riskFlags.push("generated_file");
      if (verdict === "unknown") riskFlags.push("ambiguous_target");

      let confidence = verdict === "verified" ? 0.95 : 0.7;
      if (generated) confidence -= 0.2;
      confidence = Math.max(0, Math.min(1, Number(confidence.toFixed(2))));

      hunks.push({
        filePath,
        line: offsetToLine(content, literal.startIndex),
        startOffset: literal.startIndex,
        endOffset: literal.endIndex,
        beforeText: content.slice(literal.startIndex, literal.endIndex),
        afterText: replacement,
        ownerType: verdict === "verified" ? input.requiredOwnerType : null,
        symbolKind: "property",
        confidence,
        riskFlags,
        fileHashBefore
      });
      affected.add(filePath);
      perFile++;
      totalMatches++;
    }
  }

  hunks.sort((a, b) => a.filePath.localeCompare(b.filePath) || a.startOffset - b.startOffset);
  return {
    hunks,
    affectedFiles: [...affected].sort((a, b) => a.localeCompare(b))
  };
}
