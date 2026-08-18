/**
 * TypeScript type references and property access.
 *
 * `TYPE_REF` for JS/TS did not exist: type annotations, generic arguments and `new X()` produced no
 * edge of any kind, so a DTO or a Zod-inferred type referenced only through annotations had zero
 * incoming references and `dead_code_scan` reported it dead — correctly by its own rule, over edges
 * that were never written.
 *
 * The shared `collectTypeNames` in `extractorEdges` cannot be reused: it is written against the C#
 * grammar, where a type name is an `identifier`. In TypeScript it is a `type_identifier`, which
 * falls through that switch to the descend-one-level default and reaches a leaf with no named
 * children — so every name is dropped silently. Same reasoning as
 * `docs/decisions/0002-sql-guardrail-token-lists.md`: one mechanism, one list per dialect.
 */

import type Parser from "tree-sitter";

import type { EdgeRecord } from "../../types/index.js";
import type { ExtractInput } from "./extractorTypes.js";

import { emitPropertyAccessEdge, emitTypeRefEdge } from "./extractorUtils.js";
import { enclosingOwnerTypeName, nearestDeclaredSymbolId } from "./jsSymbols.js";

/**
 * Type names that are language built-ins, so never a repo symbol. `predefined_type` covers most of
 * them at the grammar level; these are the ones the grammar reports as an ordinary type_identifier.
 */
const TS_BUILTIN_TYPES = new Set([
  "Array", "ReadonlyArray", "Promise", "Map", "Set", "WeakMap", "WeakSet", "Date", "RegExp",
  "Error", "Function", "Object", "String", "Number", "Boolean", "Symbol", "BigInt", "JSON", "Math",
  "Record", "Partial", "Required", "Readonly", "Pick", "Omit", "Exclude", "Extract", "NonNullable",
  "Parameters", "ReturnType", "InstanceType", "Awaited", "Iterable", "Iterator", "AsyncIterable",
  "Generator", "AsyncGenerator", "ArrayBuffer", "Uint8Array", "Buffer", "URL", "URLSearchParams"
]);

/** Nodes that carry no type name at all — skipped rather than descended into. */
const TYPE_LEAVES_TO_SKIP = new Set([
  "predefined_type",
  "literal_type",
  "template_literal_type",
  "this_type",
  "type_query", // `typeof x` names a value, not a type
  "index_type_query"
]);

/** Collect every repo-meaningful type name a TypeScript type expression mentions. */
export function collectTypeScriptTypeNames(node: Parser.SyntaxNode | null | undefined, out: string[]): void {
  if (!node || TYPE_LEAVES_TO_SKIP.has(node.type)) return;

  switch (node.type) {
    case "type_identifier": {
      const text = node.text.trim();
      if (text && !TS_BUILTIN_TYPES.has(text)) out.push(text);
      return;
    }

    case "nested_type_identifier": {
      // `ns.Contract` — only the right-most segment names a type.
      const last = node.namedChildren[node.namedChildren.length - 1];
      collectTypeScriptTypeNames(last, out);
      return;
    }

    case "generic_type": {
      // Both halves matter: `Repository<User>` references the repository AND the entity, and the
      // entity frequently has no other reference anywhere.
      for (const child of node.namedChildren) collectTypeScriptTypeNames(child, out);
      return;
    }

    default:
      for (const child of node.namedChildren) collectTypeScriptTypeNames(child, out);
  }
}

/**
 * Names bound by `<T>` on any declaration enclosing `node`.
 *
 * A type parameter is spelled exactly like a type reference, so `function unwrap<TValue>(b:
 * Box<TValue>): TValue` produced two `type:TValue` edges that can never resolve to anything: the
 * name is local to the signature. In a generics-heavy repo that is pure inflation of the
 * `unresolvedRatio` that `health_check` reports and that this workspace's MCP policy treats as a
 * fallback trigger above 0.3 — a metric moved by edges that carry no navigational signal at all.
 */
function enclosingTypeParameterNames(node: Parser.SyntaxNode): Set<string> {
  const names = new Set<string>();
  let current: Parser.SyntaxNode | null = node;

  while (current) {
    for (const child of current.namedChildren) {
      if (child.type !== "type_parameters") continue;
      for (const parameter of child.namedChildren) {
        if (parameter.type !== "type_parameter") continue;
        const name = parameter.childForFieldName("name")?.text.trim();
        if (name) names.add(name);
      }
    }
    current = current.parent;
  }

  return names;
}

function emitTypeNames(
  input: ExtractInput,
  fromSymbolId: string,
  typeNode: Parser.SyntaxNode | null | undefined,
  edges: EdgeRecord[]
): void {
  if (!typeNode) return;
  const names: string[] = [];
  collectTypeScriptTypeNames(typeNode, names);
  if (names.length === 0) return;

  const typeParameters = enclosingTypeParameterNames(typeNode);
  for (const name of names) {
    if (typeParameters.has(name)) continue;
    emitTypeRefEdge(input, fromSymbolId, name, edges);
  }
}

export function extractJavaScriptTypeRefs(
  input: ExtractInput,
  root: Parser.SyntaxNode,
  edges: EdgeRecord[],
  moduleSymbolId: string
): void {
  // Annotations cover parameters, fields, properties, locals and return types in one pass — they are
  // all `type_annotation` in this grammar.
  for (const node of root.descendantsOfType(["type_annotation", "type_arguments"])) {
    const fromId = nearestDeclaredSymbolId(node, input) ?? moduleSymbolId;
    emitTypeNames(input, fromId, node, edges);
  }

  // `new Widget(...)` is a reference to Widget, and produced nothing before.
  for (const node of root.descendantsOfType(["new_expression"])) {
    const constructor = node.childForFieldName("constructor");
    if (!constructor) continue;
    const name =
      constructor.type === "identifier"
        ? constructor.text.trim()
        : constructor.type === "member_expression"
          ? (constructor.childForFieldName("property")?.text.trim() ?? "")
          : "";
    if (!name || TS_BUILTIN_TYPES.has(name)) continue;
    emitTypeRefEdge(input, nearestDeclaredSymbolId(node, input) ?? moduleSymbolId, name, edges);
  }

  // Heritage type arguments: `class A extends Base<Payload>` references Payload too.
  for (const node of root.descendantsOfType(["extends_clause", "implements_clause", "extends_type_clause"])) {
    const fromId = nearestDeclaredSymbolId(node, input) ?? moduleSymbolId;
    for (const child of node.namedChildren.filter((c) => c.type === "type_arguments" || c.type === "generic_type")) {
      emitTypeNames(input, fromId, child, edges);
    }
  }
}

/**
 * `PROPERTY_REF` / `PROPERTY_WRITE`, restricted to `this.<member>`.
 *
 * Deliberately narrow. JavaScript is dense with member access, and emitting an edge for every `a.b`
 * would add far more rows than signal — the receiver is untyped, so the token could not be qualified
 * and every access would collapse onto a bare member name shared across unrelated types. A `this`
 * receiver is the one case where the owning type is known from syntax alone, which is what makes the
 * `Owner.member` token trustworthy. Wider receivers become available once a scope type map exists.
 */
export function extractJavaScriptPropertyEdges(
  input: ExtractInput,
  root: Parser.SyntaxNode,
  edges: EdgeRecord[],
  moduleSymbolId: string
): void {
  /** Member name of a `this.x` access, or null for any other receiver. */
  function thisMemberName(node: Parser.SyntaxNode): string | null {
    if (node.type !== "member_expression") return null;
    const object = node.childForFieldName("object");
    if (object?.type !== "this") return null;
    const property = node.childForFieldName("property");
    return property?.type === "property_identifier" ? property.text.trim() || null : null;
  }

  const writeSites = new Set<number>();

  for (const node of root.descendantsOfType(["assignment_expression", "augmented_assignment_expression"])) {
    const left = node.childForFieldName("left");
    if (!left) continue;
    const member = thisMemberName(left);
    if (!member) continue;

    writeSites.add(left.startIndex);
    const ownerType = enclosingOwnerTypeName(left);
    const token = ownerType ? `${ownerType}.${member}` : member;
    const right = node.childForFieldName("right");
    emitPropertyAccessEdge(
      input,
      nearestDeclaredSymbolId(node, input) ?? moduleSymbolId,
      token,
      true,
      edges,
      right ? right.text.split("\n")[0].slice(0, 200) : undefined
    );
  }

  for (const node of root.descendantsOfType(["member_expression"])) {
    // The write side already recorded this exact span; a write is not also a read.
    if (writeSites.has(node.startIndex)) continue;
    const member = thisMemberName(node);
    if (!member) continue;
    // `this.method()` is a call, and the CALLS pass already covers it.
    if (node.parent?.type === "call_expression" && node.parent.childForFieldName("function")?.id === node.id) continue;

    const ownerType = enclosingOwnerTypeName(node);
    emitPropertyAccessEdge(
      input,
      nearestDeclaredSymbolId(node, input) ?? moduleSymbolId,
      ownerType ? `${ownerType}.${member}` : member,
      false,
      edges
    );
  }
}
