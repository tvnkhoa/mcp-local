/**
 * C# symbol extraction: type and member declarations, plus the bus contract edges
 * (PUBLISHES/CONSUMES) that a message-driven .NET service has instead of direct calls.
 */

import type Parser from "tree-sitter";
import type { ExtractInput } from "./extractorTypes.js";
import type { EdgeRecord, SymbolRecord } from "../types.js";
import {
  collectCSharpScopeTypeMap,
  emitTypeRefEdgesFromTypeNode,
  extractCSharpHttpDependencyContract,
  extractCSharpUsingNamespace,
  extractFirstStringLiteral,
  extractSignature,
  findEnclosingCSharpSymbolId,
  findEnclosingCSharpTypeName,
  isLikelyCSharpInterfaceName,
  isSameNode,
  mapUsingNamespaceToNugetContract,
  stableId,
  toEndpointContractId
} from "./extractorUtils.js";
import { extractPropertyAccessEdges } from "./csharpPropertyEdges.js";
import { extractCSharpBodyTypeRefs } from "./csharpTypeRefs.js";

/**
 * Map a C# type-declaration node to a SymbolRecord kind. (ISSUE-015)
 * `record_declaration` covers both `record X` and `record struct X` (the latter carries a
 * `struct` modifier child); they are labeled `record` / `record struct` rather than collapsed
 * to `class`, so tools keying on `kind` (codegen, template selection, get_feature_bundle) see
 * the real type. Used for both symbol emission and parentSymbolId resolution so IDs stay aligned.
 */
function csharpTypeKindForNode(node: Parser.SyntaxNode): SymbolRecord["kind"] {
  switch (node.type) {
    case "interface_declaration":
      return "interface";
    case "struct_declaration":
      return "struct";
    case "record_declaration":
      return node.children.some((ch) => ch.type === "struct") ? "record struct" : "record";
    default:
      return "class";
  }
}

/** C# type-like kinds that anchor members and act as type/call resolution targets. */
const CSHARP_TYPE_KINDS = new Set<SymbolRecord["kind"]>(["class", "struct", "interface", "record", "record struct"]);

// ── ISSUE-020: message-bus producer/consumer edge extraction ──────────────────
// MassTransit/MediatR handlers are reached via DI/reflection, so there is no static CALLS
// edge from a `Publish<T>`/`Send<T>` callsite to the `IConsumer<T>`/handler of the same T.
// We emit unresolved `contract:<T>` tokens on both sides (PUBLISHES from the publish callsite,
// CONSUMES from the handler type) and match them by contract name in a second pass
// (resolvePublishesConsumesEdges) so trace_execution_flow / get_call_chain can cross the bus.

// Handler base interfaces whose FIRST generic arg is the message/request contract.
const BUS_CONSUMER_INTERFACES = new Set(["IConsumer", "IRequestHandler", "INotificationHandler"]);
// Methods that publish/send a contract onto the bus (explicit generic or `new T(...)` arg).
const BUS_PUBLISH_METHODS = /^(Publish|Send)(Async)?$/;

/**
 * Strip namespace qualifier + nested generics from a type token: `Foo.Bar<Baz>` → `Bar`.
 * Returns null for tokens too short to be a real contract name (the bar both callers want).
 */
function normalizeContractName(raw: string): string | null {
  let t = raw.trim().replace(/<.*>$/, "").trim();
  const dot = t.lastIndexOf(".");
  if (dot >= 0) t = t.slice(dot + 1);
  t = t.trim();
  return t.length >= 2 ? t : null;
}

/** The bare method name of a call target, dropping any generic arg list. */
function methodNameOf(node: Parser.SyntaxNode): string {
  if (node.type === "generic_name") {
    const id = node.namedChildren.find((c) => c.type === "identifier");
    return id?.text ?? node.text.replace(/<.*>$/, "");
  }
  return node.text;
}

/** First generic type argument of a `generic_name` node (the message/request contract). */
function genericFirstTypeArg(node: Parser.SyntaxNode | null | undefined): string | null {
  if (!node || node.type !== "generic_name") return null;
  const targs = node.childForFieldName("type_arguments") ?? node.namedChildren.find((c) => c.type === "type_argument_list");
  const first = targs?.namedChildren[0];
  if (!first) return null;
  return normalizeContractName(first.text);
}

/**
 * The symbolId of the type declaration enclosing a node, or null at file scope.
 *
 * Mirrors the parentSymbolId walk in the main loop, including its use of `csharpTypeKindForNode` —
 * the kind is part of the stableId, so a record resolved as "class" would produce an id matching no
 * emitted symbol and the edge would dangle. (ISSUE-015 is the same trap.)
 */
function enclosingTypeSymbolId(node: Parser.SyntaxNode, input: ExtractInput): string | null {
  let current: Parser.SyntaxNode | null = node.parent;
  while (current) {
    if (
      current.type === "class_declaration" ||
      current.type === "struct_declaration" ||
      current.type === "interface_declaration" ||
      current.type === "record_declaration"
    ) {
      const nameNode = current.childForFieldName("name");
      if (!nameNode) return null;
      const kind = csharpTypeKindForNode(current);
      return stableId(`${input.repoId}:${input.filePath}:${kind}:${nameNode.text}:${current.startPosition.row}`);
    }
    current = current.parent;
  }
  return null;
}

/**
 * TYPE_REF for the declared type of every field.
 *
 * Fields are not emitted as symbols, so they never appeared in the declaration walk and their types
 * were invisible. In a .NET service this is where injected dependencies live
 * (`private readonly IOrderService _orders;`) — the single most common way one type names another.
 * Attributed to the enclosing type, since there is no field symbol to attribute to.
 */
function emitFieldTypeRefs(
  input: ExtractInput,
  root: Parser.SyntaxNode,
  edges: EdgeRecord[]
): void {
  for (const field of root.descendantsOfType(["field_declaration", "event_field_declaration"])) {
    const owner = enclosingTypeSymbolId(field, input);
    if (!owner) continue;
    // The type sits on the inner variable_declaration, not on field_declaration itself.
    const decl =
      field.childForFieldName("declaration") ??
      field.namedChildren.find((c) => c.type === "variable_declaration");
    emitTypeRefEdgesFromTypeNode(input, owner, decl?.childForFieldName("type"), edges);
  }
}

/**
 * TYPE_REF for each declared parameter type of a method or constructor.
 *
 * Constructor parameters are where a .NET class names its injected service interfaces, and method
 * parameters are where request/command DTOs appear — both invisible before MCP-ISSUE-034.
 */
function emitParameterTypeRefs(
  input: ExtractInput,
  fromSymbolId: string,
  node: Parser.SyntaxNode,
  edges: EdgeRecord[]
): void {
  // A record's positional parameter_list carries NO field name in this grammar, so
  // childForFieldName("parameters") returns null for it — hence the by-type fallback. Methods and
  // constructors do name the field.
  const params =
    node.childForFieldName("parameters") ??
    node.namedChildren.find((c) => c.type === "parameter_list");
  if (!params) return;
  for (const param of params.namedChildren) {
    // `parameter` covers the ordinary case; a `_parameter`-ish wrapper or an attribute list is
    // skipped by looking only for the type field.
    if (param.type !== "parameter") continue;
    emitTypeRefEdgesFromTypeNode(input, fromSymbolId, param.childForFieldName("type"), edges);
  }
}

/** When a publish has no explicit generic, infer the contract from a `new T(...)`/`new T{...}` first arg. */
function inferContractFromFirstArg(invocation: Parser.SyntaxNode): string | null {
  const args = invocation.childForFieldName("arguments");
  if (!args) return null;
  const firstArg = args.namedChildren.find((c) => c.type === "argument") ?? args.namedChildren[0];
  const expr = firstArg?.namedChildren[0] ?? firstArg;
  if (expr?.type !== "object_creation_expression") return null;
  const typeNode = expr.childForFieldName("type");
  if (!typeNode) return null;
  return normalizeContractName(typeNode.text);
}

// JSON attribute names that carry a serialized key literal
const JSON_KEY_ATTRIBUTE_NAMES = new Set([
  "JsonPropertyName",
  "JsonProperty",
  "JsonPropertyNameAttribute",
  "JsonPropertyAttribute"
]);

/**
 * Extract [JsonPropertyName("key")] / [JsonProperty("key")] attribute usages
 * and emit them as variable symbols with signature="json_key:<literalValue>".
 * This makes JSON payload contract keys discoverable via search_symbols.
 */
function extractJsonKeySymbols(
  input: ExtractInput,
  root: Parser.SyntaxNode,
  symbols: SymbolRecord[]
): void {
  for (const attrNode of root.descendantsOfType(["attribute"])) {
    const nameNode = attrNode.childForFieldName("name");
    if (!nameNode) continue;
    const attrName = nameNode.text.trim().replace(/Attribute$/, "");
    if (!JSON_KEY_ATTRIBUTE_NAMES.has(attrName) && !JSON_KEY_ATTRIBUTE_NAMES.has(attrName + "Attribute")) continue;

    // Find the first string literal argument
    const argList = attrNode.childForFieldName("arguments");
    if (!argList) continue;
    const literal = extractFirstStringLiteral(argList.text);
    if (!literal) continue;

    // Find the property/field this attribute is attached to
    const attrList = attrNode.parent; // attribute_list
    const target = attrList?.nextNamedSibling;
    const targetName = target?.childForFieldName("name")?.text ?? literal;

    symbols.push({
      repoId: input.repoId,
      symbolId: stableId(`${input.repoId}:${input.filePath}:json_key:${literal}:${attrNode.startPosition.row}`),
      filePath: input.filePath,
      name: targetName,
      kind: "variable",
      line: attrNode.startPosition.row + 1,
      endLine: (target ?? attrNode).endPosition.row + 1,
      signature: `json_key:${literal}`
    });
  }
}

export function extractCSharpSymbolsImpl(
  input: ExtractInput,
  root: Parser.SyntaxNode,
  symbols: SymbolRecord[],
  edges: EdgeRecord[],
  moduleSymbolId: string,
  knownPackageNames?: Set<string>
): void {
  for (const node of root.descendantsOfType(["using_directive"])) {
    const usingNamespace = extractCSharpUsingNamespace(node);
    if (!usingNamespace) continue;
    edges.push({ repoId: input.repoId, fromId: moduleSymbolId, toId: `import:${usingNamespace}`, type: "IMPORTS" });
    const packageContractId = mapUsingNamespaceToNugetContract(usingNamespace, knownPackageNames);
    if (packageContractId) {
      edges.push({ repoId: input.repoId, fromId: moduleSymbolId, toId: packageContractId, type: "DEPENDS_ON", confidence: 0.9, reason: "namespace package contract bridge" });
    }
  }

  for (const node of root.descendantsOfType(["invocation_expression"])) {
    const functionNode = node.childForFieldName("function");
    if (!functionNode) continue;
    let calleeName = "";
    let receiverName = "";
    let receiverTypeName = "";
    const scopeTypeMap = collectCSharpScopeTypeMap(node, /* includeDiAliases */ true);
    if (functionNode.type === "identifier") {
      calleeName = functionNode.text;
    } else if (functionNode.type === "member_access_expression") {
      const nameNode = functionNode.childForFieldName("name");
      const expressionNode = functionNode.childForFieldName("expression");
      if (nameNode) calleeName = nameNode.text;
      if (expressionNode) {
        if (expressionNode.type === "identifier") {
          receiverName = expressionNode.text;
          receiverTypeName = scopeTypeMap.get(receiverName) ?? "";
        } else if (expressionNode.type === "this_expression") {
          // this.Method() → use enclosing class type as receiver
          receiverName = findEnclosingCSharpTypeName(node) ?? "";
          receiverTypeName = receiverName;
        }
      }
    }
    // ISSUE-020: producer side — Publish<T>/Send<T>(...) or Publish(new T(...)) → PUBLISHES contract edge.
    // Done before the `!calleeName` guard so bare generic calls (no member receiver) are still captured.
    const nameContainer =
      functionNode.type === "member_access_expression" ? functionNode.childForFieldName("name") : functionNode;
    if (nameContainer && BUS_PUBLISH_METHODS.test(methodNameOf(nameContainer))) {
      const contract = genericFirstTypeArg(nameContainer) ?? inferContractFromFirstArg(node);
      if (contract) {
        const pubFromId = findEnclosingCSharpSymbolId(node, input) ?? moduleSymbolId;
        edges.push({ repoId: input.repoId, fromId: pubFromId, toId: `contract:${contract}`, type: "PUBLISHES", confidence: 0.9, reason: "message bus publish" });
      }
    }
    if (!calleeName) continue;
    const fromId = findEnclosingCSharpSymbolId(node, input) ?? moduleSymbolId;
    // Always emit simple callee edge — resolver uses this for name-based matching.
    edges.push({ repoId: input.repoId, fromId, toId: `callee:${calleeName}`, type: "CALLS" });
    // Additionally emit qualified edge for resolvable receivers:
    // - Uppercase start: static/type calls (e.g. MyService.DoWork)
    // - Underscore prefix: DI field convention (e.g. _campaignService.Execute)
    // - this_expression: resolved to enclosing class name
    // - ISSUE-022: any receiver whose TYPE resolved from the scope map (camelCase primary-ctor
    //   params / locals with known types) — the type name makes the token resolvable, so the
    //   edge-explosion concern (unknown camelCase locals) doesn't apply.
    // Skipping camelCase locals with UNKNOWN types (e.g. result.Value, list.Add) avoids
    // edge explosion on large repos without losing meaningful call graph data.
    // NOTE: UNIQUE INDEX on edges(repo_id, from_id, to_id, type) prevents true duplicates;
    // simple + qualified are different to_id values so both are stored intentionally.
    if (receiverName && (receiverTypeName || /^[A-Z]/.test(receiverName) || receiverName.startsWith("_") || functionNode.childForFieldName("expression")?.type === "this_expression")) {
      const qualifiedReceiverName = receiverTypeName || receiverName;
      edges.push({ repoId: input.repoId, fromId, toId: `callee:${qualifiedReceiverName}.${calleeName}`, type: "CALLS", confidence: 0.75, reason: "qualified call" });
    }
    const endpointContract = extractCSharpHttpDependencyContract(node);
    if (endpointContract) {
      edges.push({ repoId: input.repoId, fromId, toId: toEndpointContractId(endpointContract.httpMethod, endpointContract.endpoint), type: "DEPENDS_ON", confidence: 0.92, reason: "http endpoint contract" });
    }
  }

  // Build a map of class/struct/interface symbolId by line for parentSymbolId resolution
  const typeSymbolByLine = new Map<number, string>();

  for (const node of root.descendantsOfType(["class_declaration", "interface_declaration", "method_declaration", "property_declaration", "constructor_declaration", "struct_declaration", "enum_declaration", "namespace_declaration", "record_declaration"])) {
    const nameNode = node.childForFieldName("name");
    if (!nameNode) continue;
    let kind: SymbolRecord["kind"] = "unknown";
    if (node.type === "method_declaration") kind = "method";
    else if (node.type === "property_declaration") kind = "property";
    else if (node.type === "constructor_declaration") kind = "constructor";
    else if (node.type === "namespace_declaration") kind = "module";
    else if (node.type === "enum_declaration") kind = "type";
    else kind = csharpTypeKindForNode(node); // class / struct / interface / record / record struct
    const symbolId = stableId(`${input.repoId}:${input.filePath}:${kind}:${nameNode.text}:${node.startPosition.row}`);

    // Resolve parentSymbolId for members (method/property/constructor) by finding enclosing type
    let parentSymbolId: string | undefined;
    if (kind === "method" || kind === "property" || kind === "constructor") {
      const enclosingTypeName = findEnclosingCSharpTypeName(node);
      if (enclosingTypeName) {
        // Find the enclosing type symbol already registered in typeSymbolByLine
        // Walk up to find the enclosing class/struct/interface node
        let parent: Parser.SyntaxNode | null = node.parent;
        while (parent) {
          if (parent.type === "class_declaration" || parent.type === "struct_declaration" || parent.type === "interface_declaration" || parent.type === "record_declaration") {
            const parentNameNode = parent.childForFieldName("name");
            if (parentNameNode) {
              // Must mirror csharpTypeKindForNode so the parent's stableId matches the kind it
              // was registered under (records now use record / record struct, not class). (ISSUE-015)
              const parentKind = csharpTypeKindForNode(parent);
              parentSymbolId = stableId(`${input.repoId}:${input.filePath}:${parentKind}:${parentNameNode.text}:${parent.startPosition.row}`);
            }
            break;
          }
          parent = parent.parent;
        }
      }
    }

    // Track type symbols for later member resolution (records included — ISSUE-015)
    if (CSHARP_TYPE_KINDS.has(kind)) {
      typeSymbolByLine.set(node.startPosition.row, symbolId);
    }

    // P1.1: Emit IMPLEMENTS edges for interfaces in base_list
    // AST layout: base_list is a named child of class/struct/record (not a field),
    // and its children are identifier or generic_name nodes directly.
    // record_declaration covers both `record X : ...` and `record struct X : ...`
    // (tree-sitter emits the latter as record_declaration with a `struct` modifier),
    // so CQRS/MediatR request records implementing marker interfaces are captured. (ISSUE-013)
    if (node.type === "class_declaration" || node.type === "struct_declaration" || node.type === "record_declaration") {
      const baseListNodes = node.descendantsOfType(["base_list"]);
      for (const baseList of baseListNodes) {
        // Only process direct base_list (not nested classes).
        //
        // `!==` here, not `isSameNode`, was the last surviving instance of MCP-ISSUE-032, and the most
        // damaging: `.parent` mints a fresh SyntaxNode wrapper whose identity is cached only weakly, so
        // once the cache was collected the comparison reported "different node" for the same node and
        // this `continue` skipped the class ENTIRELY — no IMPLEMENTS edge, no base-list TYPE_REF.
        //
        // Whole classes therefore appeared and disappeared between runs. Measured on
        // ConversationTransitionEventHandlerTests.cs: six repeated extractions of one unchanged file in
        // one process gave 0, 0, 6, 6, 0, 6 IMPLEMENTS edges. Because IMPLEMENTS seeds interface-dispatch
        // CALLS and contract CONSUMES/PUBLISHES resolution, one flipped comparison moved five edge types
        // at once — which is why the drift looked correlated and resisted every ORDER BY fix.
        if (!isSameNode(baseList.parent, node)) continue;
        for (const baseNode of baseList.namedChildren) {
          // Children are identifier, generic_name, or qualified_name
          const typeName = baseNode.text?.trim();
          if (!typeName) continue;
          // Strip generic args: IRepository<T> → IRepository.
          // Greedy `<.*>` spans nested generics (IRequest<Result<ThingDto>> → IRequest),
          // which the non-nested `<[^>]*>` form could not handle. (ISSUE-013)
          const baseName = typeName.replace(/<.*>$/, "").trim();
          if (!baseName) continue;
          // MCP-ISSUE-034: the generic arguments of a base type are references too, and stripping
          // `<...>` above discarded them. `IRequestHandler<CreateOrderCommand, Result>` referenced only
          // the handler interface, so the command and result records — which frequently have no other
          // reference anywhere — looked unreferenced. Emitted for both branches below, in addition to
          // (not instead of) the IMPLEMENTS/CONSUMES edges, which carry different meaning.
          emitTypeRefEdgesFromTypeNode(input, symbolId, baseNode, edges);

          if (isLikelyCSharpInterfaceName(baseName)) {
            edges.push({
              repoId: input.repoId,
              fromId: symbolId,
              toId: `iface:${baseName}`,
              type: "IMPLEMENTS",
              confidence: 0.95,
              reason: "base_list interface"
            });
            // ISSUE-020: consumer side — IConsumer<T>/IRequestHandler<T,_>/INotificationHandler<T>
            // → CONSUMES the first generic arg (the message/request contract). Emitted in addition
            // to the IMPLEMENTS edge; matched to publishers by contract name in resolution.
            if (BUS_CONSUMER_INTERFACES.has(baseName)) {
              const contract = genericFirstTypeArg(baseNode);
              if (contract) {
                edges.push({ repoId: input.repoId, fromId: symbolId, toId: `contract:${contract}`, type: "CONSUMES", confidence: 0.95, reason: "message consumer" });
              }
            }
          }
          else {
            // A non-interface base type: class inheritance (MCP-ISSUE-037).
            //
            // A distinct `EXTENDS` type rather than reusing `IMPLEMENTS`, because the two relations are
            // genuinely different and several tools already read `IMPLEMENTS` as "satisfies an interface
            // contract". C# permits exactly ONE base class and any number of interfaces, so folding them
            // together would make "how many interfaces does this implement" answer wrong — quietly, and
            // in a way nobody would think to check.
            //
            // Until this existed, `class X : SomeBase` produced only a TYPE_REF, and a TYPE_REF carries no
            // hierarchy meaning, so nothing could walk it. That is why every `override` of an abstract
            // member showed zero incoming calls: interface dispatch fans out to implementors, and the
            // identical relationship through a class had no relation to fan out along.
            //
            // `isLikelyCSharpInterfaceName` is a NAME heuristic, so a base class conventionally prefixed
            // with `I` lands in the interface branch instead. Accepted: the resolver treats an
            // unresolvable `iface:` token as an external boundary either way, and the alternative is
            // resolving the base type at extraction, which needs cross-file knowledge this pass lacks.
            edges.push({
              repoId: input.repoId,
              fromId: symbolId,
              toId: `base:${baseName}`,
              type: "EXTENDS",
              confidence: 0.95,
              reason: "base_list class"
            });
          }
          // The base-class TYPE_REF that used to be emitted here is now covered by
          // emitTypeRefEdgesFromTypeNode above, which also reaches the generic arguments.
        }
      }
    }

    // MCP-ISSUE-034: every other type position. Until this existed, the base_list above was the ONLY
    // producer of TYPE_REF edges in the extractor, so the graph recorded inheritance and nothing else
    // — 99% of C# type declarations had no incoming reference, and anything reasoning over TYPE_REF
    // (dead_code_scan, find_impact_files view "surface", type blast radius) was working from an
    // almost-empty relation.
    //
    // Attribution is to the declaring member, matching the base_list convention above (the class owns
    // its base-type reference), so `find_impact_files` reports the method or property that mentions a
    // type rather than only the file.
    if (node.type === "method_declaration") {
      // The return-type field is `returns`, NOT `type` — verified against the grammar by dumping the
      // node's fields. `type` reads as null here, so an earlier version of this silently emitted
      // nothing for return types while parameters worked, which the per-position test caught.
      emitTypeRefEdgesFromTypeNode(input, symbolId, node.childForFieldName("returns"), edges);
      emitParameterTypeRefs(input, symbolId, node, edges);
    } else if (node.type === "property_declaration") {
      emitTypeRefEdgesFromTypeNode(input, symbolId, node.childForFieldName("type"), edges);
    } else if (node.type === "constructor_declaration") {
      // No return type; DI constructors are where service interfaces are referenced.
      emitParameterTypeRefs(input, symbolId, node, edges);
    } else if (node.type === "record_declaration" || node.type === "class_declaration" || node.type === "struct_declaration") {
      // Positional (primary-constructor) parameters: `record CreateOrder(OrderDto Order)`. This is
      // the whole shape of a CQRS command or a DTO, so its parameter types are often the only
      // reference the referenced record has. C# 12 allows the same on class/struct, and
      // `childForFieldName("parameters")` is simply absent when there is no primary constructor.
      emitParameterTypeRefs(input, symbolId, node, edges);
    }

    symbols.push({ repoId: input.repoId, symbolId, filePath: input.filePath, name: nameNode.text, kind, line: node.startPosition.row + 1, endLine: node.endPosition.row + 1, signature: extractSignature(node), parentSymbolId });
  }

  // MCP-ISSUE-034: field types, attributed to the enclosing type.
  emitFieldTypeRefs(input, root, edges);

  // Extract json_key symbols from [JsonPropertyName("...")] attributes (ISSUE-005)
  extractJsonKeySymbols(input, root, symbols);

  // Extract property access edges (PROPERTY_REF and PROPERTY_WRITE)
  // This includes object initializers, member access expressions, and assignments
  extractPropertyAccessEdges(input, root, edges, moduleSymbolId);

  // TYPE_REF for type positions inside method bodies — `new X()`, generic call arguments, static
  // receivers, casts, patterns, catch clauses. The signature positions above cover where a type is
  // declared; this covers where it is used. (MCP-ISSUE-034, second half)
  extractCSharpBodyTypeRefs(input, root, edges, moduleSymbolId);
}
