/**
 * B-13 / MCP-ISSUE-043 — the owner prover.
 *
 * "Which type owns the member referenced at this site?" used to be answered by a regex prefix scan
 * (`findEnclosingTypeNameByScan`): last `new T {` before the offset, else last `class X` before the
 * offset. That answers a *different* question — which class the code sits in — and the two coincide
 * only at a declaration site. So `requiredOwnerType:"Codec"` matched the declaration inside `Codec`
 * and rejected both external `Codec.Normalize(...)` call sites, naming each caller's own class as the
 * inferred owner. The guarded tool was strictly weaker than the unguarded one.
 *
 * This module answers it from the C# AST instead, and is the ONLY place the question is answered:
 * `refactorPreviewBuild` (refactor_replace_preview, refactor_symbol_migration) and
 * `analysis/valueRepresentation` (change_value_representation) both route through it.
 *
 * Three verdicts, no silent drops:
 * - `verified`   — a name was resolved and it is in the required set.
 * - `cross_type` — a name was resolved and it is NOT in the required set. Safe to reject.
 * - `unknown`    — nothing could be resolved. The caller keeps the site and flags it
 *                  `ambiguous_target` (which blocks apply), rather than dropping it.
 *
 * C# only. Every other language keeps the historical scan under rule `enclosing_type_fallback`,
 * because no on-demand TS/JS parse or scope-type map exists to prove anything with — and because a
 * scan proves nothing, a non-C# mismatch is downgraded to `unknown` rather than `cross_type`. A
 * regex guess must never be able to reject a site.
 */

import Parser from "tree-sitter";

import type { GraphStore } from "../../repositories/graphStore.js";
import { parseCSharpOnDemand } from "../extractors/treeSitterExtractor.js";
import {
  collectCSharpScopeTypeMap,
  findEnclosingCSharpTypeName,
  normalizeCSharpTypeName
} from "../extractors/csharpScope.js";
import { findEnclosingTypeNameByScan, inferLanguageFromPath } from "./refactorUtils.js";

export type OwnerVerdict = "verified" | "cross_type" | "unknown";

export type OwnerProof = {
  verdict: OwnerVerdict;
  /** Best available owner name. Non-null on verified/cross_type; may be non-null on unknown as a hint. */
  ownerType: string | null;
  /** Which rule produced the verdict — reported to the caller so a refusal is legible. */
  rule: string;
};

const TYPE_DECLARATION_NODES = new Set([
  "class_declaration",
  "struct_declaration",
  "interface_declaration",
  "record_declaration",
  "record_struct_declaration",
  "enum_declaration"
]);

/** Declaration nodes whose `name` field is the member being declared (not a usage site). */
const MEMBER_DECLARATION_NODES = new Set([
  "method_declaration",
  "property_declaration",
  "event_declaration",
  "constructor_declaration",
  "destructor_declaration",
  "delegate_declaration",
  "indexer_declaration",
  "local_function_statement"
]);

const SCOPE_ROOT_NODES = new Set([
  "method_declaration",
  "constructor_declaration",
  "local_function_statement",
  "property_declaration",
  "accessor_declaration"
]);

/** C# modifiers/keywords that can precede a declared type in a member signature. */
const CSHARP_MEMBER_MODIFIERS = new Set([
  "public", "private", "protected", "internal", "static", "readonly", "const", "volatile",
  "virtual", "override", "abstract", "sealed", "extern", "partial", "async", "unsafe",
  "new", "required", "ref", "event", "file", "fixed"
]);

// ---------------------------------------------------------------------------
// Repo-level index: the two graph facts the prover needs, loaded lazily and cached.
// ---------------------------------------------------------------------------

/**
 * Repo-scoped lookups behind the two rules that need to know more than one file:
 * - `static_type_receiver` / `qualified_type_receiver`: is this receiver a TYPE name, not a variable?
 * - `receiver_member_type` (two-hop): what type does member `B` on type `T` declare?
 *
 * Both are lazy — a preview that never reaches those rules issues no query — and both are cached
 * for the life of the preview build.
 */
export type OwnerRepoIndex = {
  /** True when `name` is a C# type declared in this repo. */
  isTypeName(name: string): boolean;
  /** Declared type of member `memberName` on owner type `ownerType`, or null. */
  memberDeclaredType(ownerType: string, memberName: string): string | null;
};

export function createOwnerRepoIndex(store: GraphStore, repoId: string): OwnerRepoIndex {
  let typeNames: Set<string> | null = null;
  const memberCache = new Map<string, Map<string, string>>();

  return {
    isTypeName(name: string): boolean {
      const normalized = normalizeCSharpTypeName(name).toLowerCase();
      if (!normalized) return false;
      if (!typeNames) {
        typeNames = new Set(store.listCSharpTypeNames(repoId).map((x) => x.toLowerCase()));
      }
      return typeNames.has(normalized);
    },
    memberDeclaredType(ownerType: string, memberName: string): string | null {
      const memberKey = memberName.toLowerCase();
      let byOwner = memberCache.get(memberKey);
      if (!byOwner) {
        byOwner = new Map<string, string>();
        for (const row of store.listMemberDeclarations(repoId, memberName)) {
          if (!row.parentName || !row.signature) continue;
          const declared = declaredTypeFromSignature(row.signature, row.name);
          if (declared) byOwner.set(row.parentName.toLowerCase(), declared);
        }
        memberCache.set(memberKey, byOwner);
      }
      return byOwner.get(normalizeCSharpTypeName(ownerType).toLowerCase()) ?? null;
    }
  };
}

/**
 * Declared type of a member, read off the persisted signature (the first line of the declaration,
 * e.g. `public ConversationAssignmentState Assignment { get; set; }` → `ConversationAssignmentState`).
 *
 * Cut the declaration head at the first `{`, `=`, `(` or `;`, drop modifiers, drop the trailing token
 * that repeats the member name, and take what is left. Searching for the member name directly does
 * not work: `public Codec Codec { get; }` is legal C#, and the first match is the *type*.
 *
 * Returns null for any shape it cannot read — a tuple type, a bare name, a missing type. A guess here
 * would become a wrong `verified`, which is the exact class of defect B-13 exists to remove.
 */
export function declaredTypeFromSignature(signature: string, memberName: string): string | null {
  const head = signature
    .replace(/^\s*(\[[^\]]*\]\s*)+/, "") // attributes
    .split(/[{(;]|=>|=/)[0] ?? "";

  const tokens = head
    .split(/\s+/)
    .map((x) => x.trim())
    .filter((x) => x.length > 0 && !CSHARP_MEMBER_MODIFIERS.has(x.toLowerCase()));

  // The trailing token is the member itself (possibly `Map<T>` for a generic method) — not its type.
  const last = tokens.at(-1);
  if (last && normalizeCSharpTypeName(last).toLowerCase() === memberName.toLowerCase()) tokens.pop();

  const candidate = tokens.at(-1);
  if (!candidate) return null;

  const normalized = normalizeCSharpTypeName(candidate.replace(/\?$/, ""));
  // A nullable/generic/array form normalizes fine; anything else non-identifier is not a type token.
  if (!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(normalized)) return null;
  return normalized.split(".").pop() ?? normalized;
}

// ---------------------------------------------------------------------------
// Per-file context
// ---------------------------------------------------------------------------

export type OwnerFileContext = {
  language: string;
  content: string;
  /** Null for non-C# files, and for a C# file the parser declined (>32KB cap / parse timeout). */
  tree: Parser.Tree | null;
  parseAttempted: boolean;
  repoIndex: OwnerRepoIndex | null;
  scopeForNode(node: Parser.SyntaxNode): Map<string, string>;
};

/**
 * Build the per-file context. `tree` may be supplied by a caller that has already parsed the file
 * (`valueRepresentation` does) so a file is never parsed twice.
 */
export function createOwnerFileContext(
  filePath: string,
  content: string,
  repoIndex: OwnerRepoIndex | null,
  tree?: Parser.Tree | null
): OwnerFileContext {
  const language = inferLanguageFromPath(filePath);
  let resolvedTree: Parser.Tree | null = tree ?? null;
  let parseAttempted = tree !== undefined;
  if (language === "csharp" && !resolvedTree && !parseAttempted) {
    resolvedTree = parseCSharpOnDemand(content, filePath);
    parseAttempted = true;
  }

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

  return { language, content, tree: resolvedTree, parseAttempted, repoIndex, scopeForNode };
}

/**
 * Map locally-declared variables to their concrete type. The shared scope-map helper reads the type
 * off `local_declaration_statement`, but in this grammar the type lives under `variable_declaration`
 * (and is `var`/`implicit_type` for inferred locals), so locals are missed entirely. Walk
 * `variable_declaration` directly: prefer the explicit declared type, falling back to the `new T()`
 * initializer's type for `var` locals — which is what most assignment/comparison receivers use.
 *
 * Moved here from `analysis/valueRepresentation.ts` (B-13) so one prover serves both lanes.
 */
export function collectLocalDeclaredTypes(scopeRoot: Parser.SyntaxNode): Map<string, string> {
  const map = new Map<string, string>();
  for (const vd of scopeRoot.descendantsOfType("variable_declaration")) {
    const declaredType = vd.childForFieldName("type")?.text.trim();
    const isInferred = !declaredType || declaredType === "var";
    for (const declarator of vd.descendantsOfType("variable_declarator")) {
      const name = declarator.childForFieldName("name")?.text.trim();
      if (!name) continue;
      const created = objectCreationTypeName(declarator.namedChildren.find((c) => c.type === "object_creation_expression"));
      const concrete = isInferred ? created : declaredType;
      if (concrete) map.set(name, normalizeCSharpTypeName(concrete));
    }
  }
  return map;
}

/** Type name of an `object_creation_expression` (`new T(...)` → "T"). */
export function objectCreationTypeName(node: Parser.SyntaxNode | undefined): string | undefined {
  if (!node || node.type !== "object_creation_expression") return undefined;
  const typeField = node.childForFieldName("type")?.text.trim();
  if (typeField) return typeField;
  // Fallback: first named child is the type identifier in grammars without a `type` field.
  const first = node.namedChildren[0];
  return first && (first.type === "identifier" || first.type.endsWith("_name")) ? first.text.trim() : undefined;
}

/** Enclosing method/constructor/accessor node used as the scope root for type inference. */
export function enclosingScopeRoot(node: Parser.SyntaxNode): Parser.SyntaxNode {
  let current: Parser.SyntaxNode | null = node;
  while (current) {
    if (SCOPE_ROOT_NODES.has(current.type)) return current;
    if (!current.parent) return current;
    current = current.parent;
  }
  return node;
}

/** Nearest enclosing object_creation type (`new Conversation { … }` → "Conversation"), or null. */
export function enclosingObjectCreationType(node: Parser.SyntaxNode): string | null {
  let current: Parser.SyntaxNode | null = node.parent;
  while (current) {
    if (current.type === "object_creation_expression") {
      const typeNode = current.childForFieldName("type");
      return typeNode ? normalizeCSharpTypeName(typeNode.text.trim()) : null;
    }
    // An initializer belongs to the object_creation that directly precedes it; don't escape the statement.
    if (current.type === "block" || current.type === "method_declaration") break;
    current = current.parent;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/** Resolve the owner for the site covering `[startOffset, endOffset)`. */
export function resolveOwnerAt(
  ctx: OwnerFileContext,
  startOffset: number,
  endOffset: number,
  required: string[]
): OwnerProof {
  if (ctx.language !== "csharp") {
    // No prover exists for this language, so the scan may report a name but can never *prove* one:
    // it takes the last `class X` before the offset with no scope check, no comment/string
    // skipping, and no awareness of `interface`, `type`, a namespace or a top-level function.
    //
    // A guess must therefore never reach `cross_type` — that verdict makes `refactorPreviewBuild`
    // drop the site into `rejectedSites`, which is the guard reporting "proven different owner"
    // about something it never proved, and is exactly the defect MCP-ISSUE-043 was filed for.
    // `unknown` keeps the site, flagged `ambiguous_target`, so it is visible and cannot apply.
    const scanned = findEnclosingTypeNameByScan(ctx.content, startOffset);
    const proof = decide(scanned, required, "enclosing_type_fallback");
    return proof.verdict === "cross_type"
      ? { verdict: "unknown", ownerType: proof.ownerType, rule: "enclosing_type_fallback" }
      : proof;
  }
  if (!ctx.tree) {
    const scanned = findEnclosingTypeNameByScan(ctx.content, startOffset);
    return { verdict: "unknown", ownerType: scanned, rule: "parse_unavailable" };
  }

  const node = smallestNamedNodeCovering(ctx.tree.rootNode, startOffset, Math.max(startOffset + 1, endOffset));
  if (!node) {
    return withScanHint({ verdict: "unknown", ownerType: null, rule: "site_not_an_identifier" }, ctx, startOffset);
  }
  // A regex/literal match can land on an arbitrary span. Only an identifier that exactly covers the
  // match names a member; anything else is a span we cannot attribute.
  if (node.type !== "identifier" || node.startIndex !== startOffset) {
    const enclosing = findEnclosingCSharpTypeName(node) ?? null;
    return withScanHint({ verdict: "unknown", ownerType: enclosing, rule: "site_not_an_identifier" }, ctx, startOffset);
  }

  return withScanHint(resolveOwnerForNode(ctx, node, required), ctx, startOffset);
}

/**
 * On an `unknown` verdict with no name at all, fill `ownerType` with the enclosing type from the text
 * scan — as a **hint**, not a proof.
 *
 * This keeps `hunk.ownerType` meaning what it always meant ("enclosing type, best effort") so the
 * confidence formula and `disallowOwnerTypes` behave as before. Without it, a C# rename in `text` mode
 * would lose 0.25 confidence at every unprovable site and fall under the 0.8 apply threshold — a site
 * that used to apply cleanly would suddenly need `includeLowConfidence: true`. The verdict, the risk
 * flag and `ambiguousReasons` are what distinguish a proof from a guess; the field does not.
 */
function withScanHint(proof: OwnerProof, ctx: OwnerFileContext, startOffset: number): OwnerProof {
  if (proof.verdict !== "unknown" || proof.ownerType) return proof;
  return { ...proof, ownerType: findEnclosingTypeNameByScan(ctx.content, startOffset) };
}

/** Resolve the owner for an identifier / member-access node already located by the caller. */
export function resolveOwnerForNode(
  ctx: OwnerFileContext,
  node: Parser.SyntaxNode,
  required: string[]
): OwnerProof {
  // `valueRepresentation` hands us a whole member_access_expression; other callers hand us the
  // identifier. Both are accepted.
  const access = node;
  const parent = access.parent;

  // (1) Declaration site — the one case where the enclosing type IS the owner.
  const isMemberDeclarationName =
    (parent && MEMBER_DECLARATION_NODES.has(parent.type) && parent.childForFieldName("name")?.id === access.id) ||
    (parent?.type === "variable_declarator" && isFieldDeclarator(parent));
  if (isMemberDeclarationName) {
    const enclosing = findEnclosingCSharpTypeName(access) ?? null;
    return enclosing
      ? decide(enclosing, required, "declaration_site", "declaration_site_mismatch")
      : { verdict: "unknown", ownerType: null, rule: "no_enclosing_type" };
  }
  if (parent && TYPE_DECLARATION_NODES.has(parent.type) && parent.childForFieldName("name")?.id === access.id) {
    // The site names a TYPE, not a member of one. "Owner" is the type itself.
    return decide(access.text.trim(), required, "type_declaration_site", "type_declaration_site_mismatch");
  }

  // (2) Member access — `recv.M`. This is where the old scan was wrong.
  const isMemberAccessName =
    access.type === "member_access_expression" ||
    (parent?.type === "member_access_expression" && parent.childForFieldName("name")?.id === access.id);
  if (isMemberAccessName) {
    const memberAccess = access.type === "member_access_expression" ? access : parent!;
    return resolveReceiverOwner(ctx, memberAccess, required);
  }

  // (3) Bare identifier inside `new T { M = … }` → the constructed type owns it.
  if (isInitializerMember(access)) {
    const ctorType = enclosingObjectCreationType(access);
    return ctorType
      ? decide(ctorType, required, "initializer_type_match", "initializer_type_mismatch")
      : { verdict: "unknown", ownerType: null, rule: "no_enclosing_object_creation" };
  }

  // (4) Bare `M(...)` or bare `M` inside a type body → implicit `this`.
  const enclosing = findEnclosingCSharpTypeName(access) ?? null;
  if (enclosing) {
    return decide(enclosing, required, "implicit_this", "implicit_this_mismatch");
  }
  return { verdict: "unknown", ownerType: null, rule: "no_enclosing_type" };
}

/** Owner of `recv.M`, from the type of `recv`. */
function resolveReceiverOwner(
  ctx: OwnerFileContext,
  memberAccess: Parser.SyntaxNode,
  required: string[]
): OwnerProof {
  const receiver = memberAccess.childForFieldName("expression");
  if (!receiver) return { verdict: "unknown", ownerType: null, rule: "receiver_not_identifier" };

  // `this` / `base` are anonymous nodes in this grammar (not `this_expression`), and are still
  // returned by childForFieldName("expression").
  if (receiver.type === "this" || receiver.type === "this_expression") {
    const enclosing = findEnclosingCSharpTypeName(memberAccess) ?? null;
    return enclosing
      ? decide(enclosing, required, "implicit_this", "implicit_this_mismatch")
      : { verdict: "unknown", ownerType: null, rule: "no_enclosing_type" };
  }

  if (receiver.type === "base" || receiver.type === "base_expression") {
    const base = enclosingBaseTypeName(memberAccess);
    return base
      ? decide(base, required, "base_type_receiver", "base_type_receiver_mismatch")
      : { verdict: "unknown", ownerType: null, rule: "base_type_unknown" };
  }

  if (receiver.type === "identifier") {
    const name = receiver.text.trim();
    const declared = ctx.scopeForNode(memberAccess).get(name);
    if (declared) {
      return decide(normalizeCSharpTypeName(declared), required, "receiver_type_match", "receiver_type_mismatch");
    }
    // Not a variable in scope. A repo-declared type here means a static member access — the shape
    // that made B-13 unfixable by scanning: `Codec.Normalize(...)` from a class that is not Codec.
    if (ctx.repoIndex?.isTypeName(name)) {
      return decide(normalizeCSharpTypeName(name), required, "static_type_receiver", "static_type_receiver_mismatch");
    }
    return { verdict: "unknown", ownerType: null, rule: "receiver_type_not_in_scope" };
  }

  if (receiver.type === "member_access_expression" || receiver.type === "qualified_name") {
    // (a) `A.B.Codec.M` — a namespace-qualified static access; the last segment is the type.
    const lastSegment = receiver.childForFieldName("name")?.text.trim() ?? null;
    if (lastSegment && ctx.repoIndex?.isTypeName(lastSegment)) {
      return decide(normalizeCSharpTypeName(lastSegment), required, "qualified_type_receiver", "qualified_type_receiver_mismatch");
    }
    // (b) `a.B.M` — two hops: type `a`, then the declared type of member `B` on it. This is
    //     MCP-ISSUE-043 Scenario B, the owned-entity shape the guarded lane exists for.
    const inner = receiver.childForFieldName("expression");
    if (inner?.type === "identifier" && lastSegment) {
      const innerType = ctx.scopeForNode(receiver).get(inner.text.trim())
        ?? (ctx.repoIndex?.isTypeName(inner.text.trim()) ? inner.text.trim() : null);
      const hopType = innerType ? ctx.repoIndex?.memberDeclaredType(innerType, lastSegment) ?? null : null;
      if (hopType) {
        return decide(normalizeCSharpTypeName(hopType), required, "receiver_member_type", "receiver_member_type_mismatch");
      }
    }
    return { verdict: "unknown", ownerType: null, rule: "receiver_path_unresolved" };
  }

  // Invocation results, casts, element access, conditional access, `(expr).M` — not typeable here.
  return { verdict: "unknown", ownerType: null, rule: "receiver_not_identifier" };
}

/** First entry of the enclosing type's base list (`class X : Base, IY` → "Base"). */
function enclosingBaseTypeName(node: Parser.SyntaxNode): string | null {
  let current: Parser.SyntaxNode | null = node.parent;
  while (current) {
    if (TYPE_DECLARATION_NODES.has(current.type)) {
      const baseList = current.namedChildren.find((x) => x.type === "base_list");
      const first = baseList?.namedChildren[0];
      return first ? normalizeCSharpTypeName(first.text.trim()) : null;
    }
    current = current.parent;
  }
  return null;
}

/** True when this identifier is the left side of an assignment inside an `initializer_expression`. */
function isInitializerMember(node: Parser.SyntaxNode): boolean {
  const parent = node.parent;
  if (!parent) return false;
  if (parent.type === "initializer_expression") return true;
  if (parent.type === "assignment_expression" && parent.childForFieldName("left")?.id === node.id) {
    return parent.parent?.type === "initializer_expression";
  }
  return false;
}

/** True when a `variable_declarator` belongs to a field/event declaration rather than a local. */
function isFieldDeclarator(declarator: Parser.SyntaxNode): boolean {
  let current: Parser.SyntaxNode | null = declarator.parent;
  while (current) {
    if (current.type === "field_declaration" || current.type === "event_field_declaration") return true;
    if (current.type === "local_declaration_statement" || current.type === "block") return false;
    current = current.parent;
  }
  return false;
}

/** Smallest named node whose span covers `[start, end)`. */
function smallestNamedNodeCovering(root: Parser.SyntaxNode, start: number, end: number): Parser.SyntaxNode | null {
  let node: Parser.SyntaxNode | null = root.descendantForIndex(start, Math.max(start, end - 1));
  while (node && !node.isNamed) {
    node = node.parent;
  }
  return node;
}

/**
 * Turn a resolved name into a verdict against the required set.
 *
 * An empty required set means the caller wants the name without a constraint (`refactor_replace_preview`
 * with no `allowOwnerTypes`), so any resolved name is `verified` — the guard is what applies the
 * constraint, not the prover.
 */
function decide(
  ownerType: string | null,
  required: string[],
  matchRule: string,
  mismatchRule: string = matchRule
): OwnerProof {
  if (!ownerType) return { verdict: "unknown", ownerType: null, rule: matchRule };
  if (required.length === 0) return { verdict: "verified", ownerType, rule: matchRule };
  const matches = required.some((x) => normalizeCSharpTypeName(x).toLowerCase() === ownerType.toLowerCase());
  return matches
    ? { verdict: "verified", ownerType, rule: matchRule }
    : { verdict: "cross_type", ownerType, rule: mismatchRule };
}

/** Why a rule could not prove the owner — or how it proved it — in terms a caller can act on. */
export function describeOwnerRule(rule: string): string {
  switch (rule) {
    case "receiver_not_identifier":
      return "the receiver is an expression result (invocation, cast, element access); only an identifier, `this`, `base` or a qualified type path can be typed";
    case "receiver_type_not_in_scope":
      return "the receiver's declared type is not in the method scope map (parameter, local, field, property) and is not a type declared in this repo";
    case "receiver_path_unresolved":
      return "a nested receiver path (e.g. a.B.Prop): neither the last segment as a repo type nor the two-hop member type resolved";
    case "no_enclosing_object_creation":
      return "a bare assignment outside a `new T { … }` initializer — including `with` expressions";
    case "no_enclosing_type":
      return "the site is not inside a type declaration, so there is no implicit `this` to attribute it to";
    case "site_not_an_identifier":
      return "the matched span is not a whole identifier (a regex match over punctuation or a partial token), so it names no member";
    case "parse_unavailable":
      return "the C# parser declined this file (over the size cap or a parse timeout); the owner shown is the enclosing type from a text scan, not a proof";
    case "enclosing_type_fallback":
      return "no AST prover exists for this language; the owner shown is the enclosing type from a text scan, not a proof — a mismatch cannot reject the site, only mark it ambiguous";
    case "base_type_unknown":
      return "a `base.Member` access whose enclosing type declares no base list";
    default:
      return rule;
  }
}
