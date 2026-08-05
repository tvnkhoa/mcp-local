import fs from "node:fs";

import Parser from "tree-sitter";

import type { GraphStore } from "../../repositories/graphStore.js";
import { parseCSharpOnDemand } from "../extractors/treeSitterExtractor.js";
import type { PreviewCandidateHunk } from "../refactor/refactorTypes.js";
import type { RefactorRiskFlag } from "../../types/index.js";
import {
  normalizeRelativePath,
  sha256,
  assertSafeRepoFilePath,
  inferLanguageFromPath,
  isGeneratedFilePath,
  offsetToLine,
  pathStartsWithAny
} from "../refactor/refactorUtils.js";
import {
  createOwnerFileContext,
  createOwnerRepoIndex,
  describeOwnerRule,
  resolveOwnerForNode
} from "../refactor/ownerResolver.js";

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
): {
  hunks: PreviewCandidateHunk[];
  affectedFiles: string[];
  /** Sites dropped because the owner is known to be a different type. */
  rejectedSites: { filePath: string; line: number; rule: string; detail: string }[];
  /** Sites kept but flagged `ambiguous_target`, with the rule that could not prove the owner. */
  ambiguousReasons: { filePath: string; line: number; rule: string; detail: string }[];
} {
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
  const rejectedSites: { filePath: string; line: number; rule: string; detail: string }[] = [];
  const ambiguousReasons: { filePath: string; line: number; rule: string; detail: string }[] = [];
  // Repo-level facts the prover needs for static and two-hop receivers; queried lazily on first use.
  const ownerRepoIndex = createOwnerRepoIndex(store, repoId);
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
    // B-13: one prover for both refactor lanes. It reuses the tree parsed above (no second parse) and
    // memoizes the scope type map per enclosing method, as this function used to do inline.
    const ownerContext = createOwnerFileContext(filePath, content, ownerRepoIndex, tree);

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

      const owner = resolveOwnerForNode(ownerContext, site.access, [input.requiredOwnerType]);
      const line = offsetToLine(content, literal.startIndex);
      if (owner.verdict === "cross_type") {
        // known-different owner — never rewrite, but say so rather than dropping it silently
        rejectedSites.push({
          filePath,
          line,
          rule: owner.rule,
          detail: `inferred owner '${owner.ownerType ?? "unknown"}' != required '${input.requiredOwnerType}'`
        });
        continue;
      }

      const riskFlags: RefactorRiskFlag[] = [];
      if (generated) riskFlags.push("generated_file");
      if (owner.verdict === "unknown") {
        riskFlags.push("ambiguous_target");
        // `ambiguous_target` blocks apply unconditionally (isApplyRunnableHunk rejects on any risk
        // flag), so the caller needs to know WHICH rule could not prove the owner.
        ambiguousReasons.push({ filePath, line, rule: owner.rule, detail: describeOwnerRule(owner.rule) });
      }

      let confidence = owner.verdict === "verified" ? 0.95 : 0.7;
      if (generated) confidence -= 0.2;
      confidence = Math.max(0, Math.min(1, Number(confidence.toFixed(2))));

      hunks.push({
        filePath,
        line,
        startOffset: literal.startIndex,
        endOffset: literal.endIndex,
        beforeText: content.slice(literal.startIndex, literal.endIndex),
        afterText: replacement,
        ownerType: owner.verdict === "verified" ? input.requiredOwnerType : null,
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
    affectedFiles: [...affected].sort((a, b) => a.localeCompare(b)),
    rejectedSites,
    ambiguousReasons
  };
}
