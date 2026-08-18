/**
 * JavaScript/TypeScript declarations → symbols.
 *
 * Split out of `jsExtractor.ts` when the lane grew past a single pass. One rule governs everything
 * here: a symbol id is minted only by `makeSymbolId`, and the row it is keyed on is the row of the
 * node this pass walks — `findEnclosingSymbolId` reconstructs the same string from the other side,
 * and the two must agree byte for byte.
 */

import type Parser from "tree-sitter";

import type { SymbolRecord } from "../../types/index.js";
import type { ExtractInput } from "./extractorTypes.js";

import { boundFunctionSymbolId, extractSignature, makeSymbolId } from "./extractorUtils.js";

/**
 * Declaration node → the kind it is registered under. Members are handled separately.
 *
 * `Map`, not an object literal: the key is an arbitrary grammar node name, and a plain object
 * answers `obj["constructor"]` with `Object.prototype.constructor` — truthy, and not a kind.
 */
const DECLARATION_KINDS = new Map<string, SymbolRecord["kind"]>([
  ["function_declaration", "function"],
  ["generator_function_declaration", "function"],
  ["class_declaration", "class"],
  ["abstract_class_declaration", "class"],
  ["interface_declaration", "interface"],
  ["type_alias_declaration", "type"],
  // TypeScript has no `enum` in the kind union; an enum is a named type like any other, and adding a
  // kind would ripple into every kind list in SQL for no query anyone runs today.
  ["enum_declaration", "type"]
]);

/** Type declarations that can own a member, and the kind each is registered under. */
const OWNER_KINDS = new Map<string, SymbolRecord["kind"]>([
  ["class_declaration", "class"],
  ["abstract_class_declaration", "class"],
  ["interface_declaration", "interface"],
  ["enum_declaration", "type"]
]);

/**
 * A class expression (`const Widget = class {...}`) is registered while walking its
 * `lexical_declaration`, so its id is keyed on the *declaration's* row — same rule as a bound arrow
 * function. Returns null for a genuinely anonymous class expression, which is not a symbol.
 */
function boundClassSymbolId(classNode: Parser.SyntaxNode, input: ExtractInput): string | null {
  const declarator = classNode.parent;
  if (declarator?.type !== "variable_declarator") return null;
  const nameNode = declarator.childForFieldName("name");
  if (!nameNode || nameNode.type !== "identifier") return null;
  const declaration = declarator.parent;
  if (declaration?.type !== "lexical_declaration") return null;
  return makeSymbolId(input, "class", nameNode.text, declaration.startPosition.row);
}

/**
 * The id of the type declaration that owns `node`, or null when the node is not inside one.
 *
 * Stops at the first owner, so a member of a nested class belongs to the nested class. A
 * `property_signature` inside an inline object type (`function f(): { a: string }`) or a type alias
 * finds no owner and is therefore not registered — indexing those would fill the graph with
 * structural noise that no caller asks for.
 */
export function enclosingOwnerSymbolId(node: Parser.SyntaxNode, input: ExtractInput): string | null {
  let current: Parser.SyntaxNode | null = node.parent;

  while (current) {
    const kind = OWNER_KINDS.get(current.type);
    if (kind) {
      const nameNode = current.childForFieldName("name");
      return nameNode ? makeSymbolId(input, kind, nameNode.text, current.startPosition.row) : null;
    }
    if (current.type === "class") {
      return boundClassSymbolId(current, input);
    }
    current = current.parent;
  }

  return null;
}

/** The NAME of the type declaration that owns `node` — the qualifier a property token needs. */
export function enclosingOwnerTypeName(node: Parser.SyntaxNode): string | null {
  let current: Parser.SyntaxNode | null = node.parent;

  while (current) {
    if (OWNER_KINDS.has(current.type)) {
      return current.childForFieldName("name")?.text.trim() ?? null;
    }
    if (current.type === "class") {
      const declarator = current.parent;
      if (declarator?.type !== "variable_declarator") return null;
      return declarator.childForFieldName("name")?.text.trim() ?? null;
    }
    current = current.parent;
  }

  return null;
}

/**
 * The id of the *registered* symbol that most closely encloses `node`.
 *
 * `findEnclosingSymbolId` answers the same question for call sites, where only a callable owner is
 * meaningful. A type reference has finer owners: the annotation on a class field belongs to that
 * field, not to the class, and attributing it upward would make `find_impact_files` report the whole
 * type as affected by a change to one member. Returns null when nothing enclosing was registered, so
 * the caller can fall back to the module symbol.
 */
export function nearestDeclaredSymbolId(node: Parser.SyntaxNode, input: ExtractInput): string | null {
  let current: Parser.SyntaxNode | null = node.parent;

  while (current) {
    const nameNode = current.childForFieldName("name");

    switch (current.type) {
      // The two signature forms are only registered when a real type declaration owns them (see
      // the member pass below), so minting an id for one without an owner produces an edge whose
      // source does not exist. `public_field_definition` and `method_definition` are always
      // registered, owner or not.
      case "property_signature":
        if (nameNode && enclosingOwnerSymbolId(current, input)) {
          return makeSymbolId(input, "property", nameNode.text, current.startPosition.row);
        }
        break;

      case "public_field_definition":
        if (nameNode) return makeSymbolId(input, "property", nameNode.text, current.startPosition.row);
        break;

      case "method_signature":
      case "abstract_method_signature":
        if (nameNode && enclosingOwnerSymbolId(current, input)) {
          return makeSymbolId(input, "method", nameNode.text, current.startPosition.row);
        }
        break;

      case "method_definition":
        if (nameNode) {
          const kind = nameNode.text === "constructor" ? "constructor" : "method";
          return makeSymbolId(input, kind, nameNode.text, current.startPosition.row);
        }
        break;

      case "arrow_function":
      case "function_expression": {
        const bound = boundFunctionSymbolId(current, input);
        if (bound) return bound;
        break;
      }

      default: {
        const declarationKind = DECLARATION_KINDS.get(current.type);
        if (declarationKind && nameNode) {
          return makeSymbolId(input, declarationKind, nameNode.text, current.startPosition.row);
        }
        if (current.type === "class") {
          const bound = boundClassSymbolId(current, input);
          if (bound) return bound;
        }
      }
    }

    current = current.parent;
  }

  return null;
}

function push(
  symbols: SymbolRecord[],
  input: ExtractInput,
  kind: SymbolRecord["kind"],
  name: string,
  node: Parser.SyntaxNode,
  parentSymbolId?: string | null,
  signature?: string
): void {
  symbols.push({
    repoId: input.repoId,
    symbolId: makeSymbolId(input, kind, name, node.startPosition.row),
    filePath: input.filePath,
    name,
    kind,
    line: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    signature: signature ?? extractSignature(node),
    ...(parentSymbolId ? { parentSymbolId } : {})
  });
}

export function extractJavaScriptSymbols(
  input: ExtractInput,
  root: Parser.SyntaxNode,
  symbols: SymbolRecord[]
): void {
  // ── Top-level and nested declarations ────────────────────────────────────────────────────
  for (const node of root.descendantsOfType([...DECLARATION_KINDS.keys()])) {
    const nameNode = node.childForFieldName("name");
    if (!nameNode) continue;
    push(symbols, input, DECLARATION_KINDS.get(node.type) ?? "unknown", nameNode.text, node);
  }

  // ── Class and interface members ──────────────────────────────────────────────────────────
  // `parentSymbolId` is what makes a member reachable from its type: the receiver-aware branches in
  // `edgeResolverCalls` and the interface fan-out both key on it, and without it they were dead
  // code for every TypeScript repo.
  for (const node of root.descendantsOfType([
    "method_definition",
    "public_field_definition",
    "method_signature",
    "abstract_method_signature",
    "property_signature"
  ])) {
    const nameNode = node.childForFieldName("name");
    if (!nameNode) continue;
    const owner = enclosingOwnerSymbolId(node, input);
    // A signature outside a real type declaration is structural typing, not a member.
    if (!owner && (node.type === "property_signature" || node.type === "method_signature")) continue;

    const name = nameNode.text;
    const isMethodShaped =
      node.type === "method_definition" ||
      node.type === "method_signature" ||
      node.type === "abstract_method_signature";
    const kind: SymbolRecord["kind"] = isMethodShaped
      ? name === "constructor"
        ? "constructor"
        : "method"
      : "property";

    push(symbols, input, kind, name, node, owner);
  }

  // ── Enum members ─────────────────────────────────────────────────────────────────────────
  // Two shapes: `On = "on"` is an enum_assignment, a bare `On` is a property_identifier directly
  // under the body.
  for (const body of root.descendantsOfType(["enum_body"])) {
    const owner = enclosingOwnerSymbolId(body, input);
    for (const member of body.namedChildren) {
      const nameNode =
        member.type === "enum_assignment"
          ? member.childForFieldName("name")
          : member.type === "property_identifier"
            ? member
            : null;
      if (!nameNode) continue;
      push(symbols, input, "property", nameNode.text, member, owner);
    }
  }

  // ── Bound function / class expressions, and exported constants ───────────────────────────
  for (const node of root.descendantsOfType(["lexical_declaration"])) {
    const isExported = node.parent?.type === "export_statement";

    // Direct children only. `descendantsOfType` here also reached declarators belonging to a
    // *nested* lexical_declaration and registered them under this declaration's row, which is not
    // the row `findEnclosingSymbolId` reconstructs — the id matched nothing. A declaration's own
    // declarators are its named children (`const a = 1, b = 2`).
    for (const declarator of node.namedChildren.filter((child) => child.type === "variable_declarator")) {
      const nameNode = declarator.childForFieldName("name");
      const valueNode = declarator.childForFieldName("value");
      if (!nameNode || nameNode.type !== "identifier" || !valueNode) continue;

      const isFunction =
        valueNode.type === "arrow_function" ||
        valueNode.type === "function" ||
        valueNode.type === "function_expression";

      if (isFunction) {
        // Registered wherever it sits, not only at module scope. A `const handler = () => {}` inside
        // another function is still a call-graph node, and every call in its body already resolves
        // its enclosing id to this symbol — leaving it unregistered orphaned those edges.
        push(
          symbols,
          input,
          "function",
          nameNode.text,
          node,
          null,
          extractSignature(declarator).replace(/^(const|let|var)\s+/, "")
        );
      } else if (valueNode.type === "class" || valueNode.type === "class_expression") {
        // `const Widget = class {...}` is a class, not a variable — `find_implementations` and the
        // heritage pass both need it under the class kind.
        push(symbols, input, "class", nameNode.text, node, null, extractSignature(declarator));
      } else if (isExported) {
        const valPreview = valueNode.text.split("\n")[0].slice(0, 80);
        push(symbols, input, "variable", nameNode.text, node, null, `const ${nameNode.text} = ${valPreview}`);
      }
    }
  }
}
