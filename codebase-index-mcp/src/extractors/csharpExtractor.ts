import type Parser from "tree-sitter";

import type { ExtractInput } from "./extractorTypes.js";
import type { EdgeRecord, RouteRecord, SymbolRecord } from "../types.js";

import {
  stableId,
  extractSignature,
  findEnclosingCSharpSymbolId,
  extractCSharpUsingNamespace,
  mapUsingNamespaceToNugetContract,
  extractCSharpHttpDependencyContract,
  toEndpointContractId,
  dedupeRoutes,
  normalizeEndpointPath,
  extractFirstStringLiteral,
  combineRouteTemplate,
  emitPropertyAccessEdge,
  collectCSharpScopeTypeMap,
  findEnclosingCSharpTypeName,
  emitTypeRefEdge
} from "./extractorUtils.js";

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
    if (functionNode.type === "identifier") calleeName = functionNode.text;
    else if (functionNode.type === "member_access_expression") {
      const nameNode = functionNode.childForFieldName("name");
      const expressionNode = functionNode.childForFieldName("expression");
      if (nameNode) calleeName = nameNode.text;
      if (expressionNode && expressionNode.type === "identifier") receiverName = expressionNode.text;
    }
    if (!calleeName) continue;
    const fromId = findEnclosingCSharpSymbolId(node, input) ?? moduleSymbolId;
    edges.push({ repoId: input.repoId, fromId, toId: `callee:${calleeName}`, type: "CALLS" });
    const endpointContract = extractCSharpHttpDependencyContract(node);
    if (endpointContract) {
      edges.push({ repoId: input.repoId, fromId, toId: toEndpointContractId(endpointContract.httpMethod, endpointContract.endpoint), type: "DEPENDS_ON", confidence: 0.92, reason: "http endpoint contract" });
    }
    if (receiverName && /^[A-Z]/.test(receiverName)) {
      edges.push({ repoId: input.repoId, fromId, toId: `callee:${receiverName}.${calleeName}`, type: "CALLS" });
    }
  }

  // Build a map of class/struct/interface symbolId by line for parentSymbolId resolution
  const typeSymbolByLine = new Map<number, string>();

  for (const node of root.descendantsOfType(["class_declaration", "interface_declaration", "method_declaration", "property_declaration", "constructor_declaration", "struct_declaration", "enum_declaration", "namespace_declaration", "record_declaration"])) {
    const nameNode = node.childForFieldName("name");
    if (!nameNode) continue;
    let kind: SymbolRecord["kind"] = "unknown";
    if (node.type === "method_declaration") kind = "method";
    else if (node.type === "interface_declaration") kind = "interface";
    else if (node.type === "class_declaration") kind = "class";
    else if (node.type === "property_declaration") kind = "property";
    else if (node.type === "constructor_declaration") kind = "constructor";
    else if (node.type === "struct_declaration") kind = "struct";
    else if (node.type === "namespace_declaration") kind = "module";
    else if (node.type === "enum_declaration") kind = "type";
    else if (node.type === "record_declaration") kind = "class";
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
              const parentKind = parent.type === "interface_declaration" ? "interface"
                : parent.type === "struct_declaration" ? "struct"
                : "class";
              parentSymbolId = stableId(`${input.repoId}:${input.filePath}:${parentKind}:${parentNameNode.text}:${parent.startPosition.row}`);
            }
            break;
          }
          parent = parent.parent;
        }
      }
    }

    // Track type symbols for later member resolution
    if (kind === "class" || kind === "struct" || kind === "interface") {
      typeSymbolByLine.set(node.startPosition.row, symbolId);
    }

    symbols.push({ repoId: input.repoId, symbolId, filePath: input.filePath, name: nameNode.text, kind, line: node.startPosition.row + 1, signature: extractSignature(node), parentSymbolId });
  }

  // Extract json_key symbols from [JsonPropertyName("...")] attributes (ISSUE-005)
  extractJsonKeySymbols(input, root, symbols);

  // Extract property access edges (PROPERTY_REF and PROPERTY_WRITE)
  // This includes object initializers, member access expressions, and assignments
  extractPropertyAccessEdges(input, root, edges, moduleSymbolId);
}

function extractPropertyAccessEdges(
  input: ExtractInput,
  root: Parser.SyntaxNode,
  edges: EdgeRecord[],
  moduleSymbolId: string
): void {
  // Extract property reads from member_access_expression
  for (const node of root.descendantsOfType(["member_access_expression"])) {
    const nameNode = node.childForFieldName("name");
    const expressionNode = node.childForFieldName("expression");
    if (!nameNode || !expressionNode) continue;

    const propertyName = nameNode.text.trim();
    if (!propertyName || propertyName.length < 2) continue;

    // Skip if this is a method call (parent is invocation_expression)
    if (node.parent?.type === "invocation_expression" && node.parent.childForFieldName("function") === node) {
      continue;
    }

    // Determine if this is a write or read
    const isWrite = isPropertyWrite(node);
    
    // Extract the full member access chain for nested properties
    // Example: conv.IdentityState.CrmCustomerId
    // Emit edges for:
    // 1. Conversation.IdentityState (if conv type is known)
    // 2. IdentityState.CrmCustomerId
    // 3. CrmCustomerId (fallback)
    const memberChain = extractMemberAccessChain(node);
    const scopeTypeMap = collectCSharpScopeTypeMap(node);
    const fromId = findEnclosingCSharpSymbolId(node, input) ?? moduleSymbolId;
    
    // Emit edges for each level of the chain
    emitNestedPropertyEdges(input, fromId, node, memberChain, scopeTypeMap, isWrite, edges);
  }

  // Extract property assignments from object initializers
  // Pattern: new ClassName { PropertyName = value, ... }
  for (const initNode of root.descendantsOfType(["initializer_expression"])) {
    // Try to infer the type being initialized from various contexts
    const typeName = inferObjectInitializerType(initNode);
    if (!typeName) continue;

    // Extract all assignment expressions inside the initializer
    for (const assignment of initNode.descendantsOfType(["assignment_expression"])) {
      const leftNode = assignment.childForFieldName("left");
      if (!leftNode || leftNode.type !== "identifier") continue;

      const propertyName = leftNode.text.trim();
      if (!propertyName) continue;

      const propertyToken = `${typeName}.${propertyName}`;
      const fromId = findEnclosingCSharpSymbolId(initNode, input) ?? moduleSymbolId;
      
      // Object initializer assignments are writes
      emitPropertyAccessEdge(input, fromId, propertyToken, true, edges);
    }
  }
}

/**
 * Extract the full member access chain from a member_access_expression node.
 * Example: conv.IdentityState.CrmCustomerId → ["conv", "IdentityState", "CrmCustomerId"]
 */
function extractMemberAccessChain(node: Parser.SyntaxNode): string[] {
  const chain: string[] = [];
  let current: Parser.SyntaxNode | null = node;

  while (current && current.type === "member_access_expression") {
    const nameNode = current.childForFieldName("name");
    if (nameNode) {
      chain.unshift(nameNode.text.trim());
    }
    current = current.childForFieldName("expression");
  }

  // Add the base identifier or this expression
  if (current) {
    if (current.type === "identifier") {
      chain.unshift(current.text.trim());
    } else if (current.type === "this_expression") {
      chain.unshift("this");
    }
  }

  return chain;
}

/**
 * Emit property edges for nested member access chains.
 * For conv.IdentityState.CrmCustomerId, emit:
 * 1. Conversation.IdentityState (if conv type is Conversation)
 * 2. IdentityState.CrmCustomerId
 * 3. CrmCustomerId (fallback)
 */
function emitNestedPropertyEdges(
  input: ExtractInput,
  fromId: string,
  node: Parser.SyntaxNode,
  memberChain: string[],
  scopeTypeMap: Map<string, string>,
  isWrite: boolean,
  edges: EdgeRecord[]
): void {
  if (memberChain.length === 0) return;

  // For single-level access (e.g., conv.Property), use original logic
  if (memberChain.length === 2) {
    const [receiver, property] = memberChain;
    let declaringType: string | undefined;

    if (receiver === "this") {
      declaringType = findEnclosingCSharpTypeName(node);
    } else {
      declaringType = scopeTypeMap.get(receiver);
    }

    const propertyToken = declaringType ? `${declaringType}.${property}` : property;
    emitPropertyAccessEdge(input, fromId, propertyToken, isWrite, edges);
    return;
  }

  // For nested access (e.g., conv.IdentityState.CrmCustomerId)
  // Emit edges for each pair in the chain
  for (let i = 0; i < memberChain.length - 1; i++) {
    const left = memberChain[i];
    const right = memberChain[i + 1];

    if (i === 0) {
      // First level: try to resolve base type
      let baseType: string | undefined;
      if (left === "this") {
        baseType = findEnclosingCSharpTypeName(node);
      } else {
        baseType = scopeTypeMap.get(left);
      }

      if (baseType) {
        // Emit: BaseType.Property
        emitPropertyAccessEdge(input, fromId, `${baseType}.${right}`, i === memberChain.length - 2 && isWrite, edges);
      } else {
        // Fallback: emit unqualified
        emitPropertyAccessEdge(input, fromId, right, i === memberChain.length - 2 && isWrite, edges);
      }
    } else {
      // Subsequent levels: emit as Type.Property pairs
      // Example: IdentityState.CrmCustomerId
      emitPropertyAccessEdge(input, fromId, `${left}.${right}`, i === memberChain.length - 2 && isWrite, edges);
    }
  }

  // Also emit the final property name as fallback
  const finalProperty = memberChain[memberChain.length - 1];
  if (finalProperty) {
    emitPropertyAccessEdge(input, fromId, finalProperty, isWrite, edges);
  }
}

/**
 * Infer the type name from an object initializer expression.
 * Handles multiple contexts:
 * - Direct: new Type { ... }
 * - Argument: Method(new Type { ... })
 * - Collection: new List<Type> { new Type { ... } }
 * - Return: return new Type { ... }
 * - Assignment: var x = new Type { ... }
 */
function inferObjectInitializerType(initNode: Parser.SyntaxNode): string | null {
  const parent = initNode.parent;
  if (!parent) return null;

  // Context 1: Direct object creation - new Type { ... }
  if (parent.type === "object_creation_expression") {
    const typeNode = parent.childForFieldName("type");
    if (typeNode) {
      return typeNode.text.trim().replace(/<.*>/, "").trim();
    }
  }

  // Context 2: Argument - Method(new Type { ... })
  // The parent is object_creation_expression, grandparent is argument
  if (parent.type === "object_creation_expression" && parent.parent?.type === "argument") {
    const typeNode = parent.childForFieldName("type");
    if (typeNode) {
      return typeNode.text.trim().replace(/<.*>/, "").trim();
    }
  }

  // Context 3: Collection initializer - new List<Type> { new Type { ... }, ... }
  // The parent is object_creation_expression, grandparent is initializer_expression
  if (parent.type === "object_creation_expression" && parent.parent?.type === "initializer_expression") {
    const typeNode = parent.childForFieldName("type");
    if (typeNode) {
      return typeNode.text.trim().replace(/<.*>/, "").trim();
    }
  }

  // Context 4: Return statement - return new Type { ... }
  if (parent.type === "object_creation_expression" && parent.parent?.type === "return_statement") {
    const typeNode = parent.childForFieldName("type");
    if (typeNode) {
      return typeNode.text.trim().replace(/<.*>/, "").trim();
    }
  }

  // Context 5: Variable assignment - var x = new Type { ... }
  if (parent.type === "object_creation_expression") {
    const typeNode = parent.childForFieldName("type");
    if (typeNode) {
      return typeNode.text.trim().replace(/<.*>/, "").trim();
    }
  }

  return null;
}

function isPropertyWrite(node: Parser.SyntaxNode): boolean {
  const parent = node.parent;
  if (!parent) return false;

  // Check if this is the left side of an assignment
  if (parent.type === "assignment_expression") {
    const leftNode = parent.childForFieldName("left");
    return leftNode === node;
  }

  // Check for compound assignments (+=, -=, etc.)
  if (parent.type === "add_assignment_expression" ||
      parent.type === "subtract_assignment_expression" ||
      parent.type === "multiply_assignment_expression" ||
      parent.type === "divide_assignment_expression") {
    const leftNode = parent.childForFieldName("left");
    return leftNode === node;
  }

  return false;
}

export function extractCSharpRoutesImpl(
  input: ExtractInput,
  root: Parser.SyntaxNode,
  symbols: SymbolRecord[]
): RouteRecord[] {
  const routes: RouteRecord[] = [];
  const classNodes = root.descendantsOfType(["class_declaration"]);

  for (const classNode of classNodes) {
    const className = classNode.childForFieldName("name")?.text ?? "";
    if (!className) continue;

    const classSymbolId = findSymbolIdByNode(symbols, "class", className, classNode.startPosition.row + 1);
    if (!classSymbolId) continue;

    const classAttributes = collectAttachedAttributeTexts(classNode);
    const classRoutePrefix = resolveRoutePrefix(classAttributes, className);

    for (const methodNode of classNode.descendantsOfType(["method_declaration"])) {
      const methodName = methodNode.childForFieldName("name")?.text ?? "";
      if (!methodName) continue;

      const handlerSymbolId = findSymbolIdByNode(symbols, "method", methodName, methodNode.startPosition.row + 1);
      if (!handlerSymbolId) continue;

      const methodAttributes = collectAttachedAttributeTexts(methodNode);
      const httpAttrs = resolveHttpAttributes(methodAttributes);
      if (httpAttrs.length === 0) continue;

      for (const attr of httpAttrs) {
        const routeTemplate = combineRouteTemplate(classRoutePrefix, attr.template, className, methodName);
        routes.push({
          repoId: input.repoId,
          filePath: input.filePath,
          controllerSymbolId: classSymbolId,
          handlerSymbolId,
          httpMethod: attr.method,
          routeTemplate,
          line: methodNode.startPosition.row + 1
        });
      }
    }
  }

  return dedupeRoutes(routes);
}

export function emitEndpointContractSymbolsImpl(
  input: ExtractInput,
  symbols: SymbolRecord[],
  routes: RouteRecord[]
): void {
  for (const route of routes) {
    const contractId = toEndpointContractId(route.httpMethod, route.routeTemplate);
    symbols.push({
      repoId: input.repoId,
      symbolId: stableId(`${input.repoId}:${input.filePath}:endpoint:${route.httpMethod}:${route.routeTemplate}:${route.line}`),
      filePath: input.filePath,
      name: `${route.httpMethod} ${normalizeEndpointPath(route.routeTemplate)}`,
      kind: "module",
      line: route.line,
      signature: contractId
    });
  }
}

export function emitEndpointContractSymbolsFromCSharpSignaturesImpl(
  input: ExtractInput,
  symbols: SymbolRecord[]
): void {
  const classSymbols = symbols.filter((s) => s.kind === "class");
  const extractClassRoutePrefix = (classSignature: string | undefined): string => {
    const sig = classSignature ?? "";
    const routeMatch = sig.match(/\[\s*Route(?:Attribute)?\s*\(([^\)]*)\)\s*\]/i);
    if (!routeMatch?.[1]) return "";
    return extractFirstStringLiteral(routeMatch[1]) ?? "";
  };

  const resolveMethodClassContext = (methodLine: number): { className: string; classRoutePrefix: string } => {
    if (classSymbols.length === 0) return { className: "Controller", classRoutePrefix: "" };
    const ordered = [...classSymbols].sort((a, b) => a.line - b.line);
    let selected = ordered[0];
    for (const classSymbol of ordered) {
      if (classSymbol.line <= methodLine) selected = classSymbol;
      else break;
    }
    return { className: selected.name, classRoutePrefix: extractClassRoutePrefix(selected.signature) };
  };

  for (const methodSymbol of symbols.filter((s) => s.kind === "method")) {
    const sig = methodSymbol.signature ?? "";
    const httpMatch = sig.match(/\[\s*Http(Get|Post|Put|Delete|Patch)(?:Attribute)?\s*(?:\(([^\)]*)\))?\s*\]/i);
    if (!httpMatch) continue;

    const method = (httpMatch[1] ?? "").toUpperCase() as RouteRecord["httpMethod"];
    const methodTemplate = extractFirstStringLiteral(httpMatch[2] ?? "");
    const ctx = resolveMethodClassContext(methodSymbol.line);
    const routeTemplate = combineRouteTemplate(ctx.classRoutePrefix, methodTemplate, ctx.className, methodSymbol.name);
    const contractId = toEndpointContractId(method, routeTemplate);
    if (symbols.some((s) => s.signature === contractId)) continue;

    symbols.push({
      repoId: input.repoId,
      symbolId: stableId(`${input.repoId}:${input.filePath}:endpoint-fallback:${contractId}:${methodSymbol.line}`),
      filePath: input.filePath,
      name: `${method} ${normalizeEndpointPath(routeTemplate)}`,
      kind: "module",
      line: methodSymbol.line,
      signature: contractId
    });
  }
}

function findSymbolIdByNode(symbols: SymbolRecord[], kind: SymbolRecord["kind"], name: string, line: number): string | null {
  const symbol = symbols.find((s) => s.kind === kind && s.name === name && s.line === line);
  return symbol?.symbolId ?? null;
}

function collectAttachedAttributeTexts(node: Parser.SyntaxNode): string[] {
  const attrs: string[] = [];
  let current = node.previousNamedSibling;
  while (current && current.type === "attribute_list") {
    attrs.unshift(current.text);
    current = current.previousNamedSibling;
  }
  return attrs;
}

function resolveHttpAttributes(
  attributeTexts: string[]
): { method: RouteRecord["httpMethod"]; template: string | null }[] {
  const out: { method: RouteRecord["httpMethod"]; template: string | null }[] = [];
  for (const attrText of attributeTexts) {
    const matches = [...attrText.matchAll(/\[\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?:\(([^\)]*)\))?\s*\]/g)];
    for (const match of matches) {
      const rawName = match[1] ?? "";
      const argText = match[2] ?? "";
      const normalized = rawName.replace(/Attribute$/i, "").toUpperCase();
      const template = extractFirstStringLiteral(argText);
      if (normalized === "HTTPGET") out.push({ method: "GET", template });
      if (normalized === "HTTPPOST") out.push({ method: "POST", template });
      if (normalized === "HTTPPUT") out.push({ method: "PUT", template });
      if (normalized === "HTTPDELETE") out.push({ method: "DELETE", template });
      if (normalized === "HTTPPATCH") out.push({ method: "PATCH", template });
    }
  }
  return out;
}

function resolveRoutePrefix(attributeTexts: string[], className: string): string {
  for (const attrText of attributeTexts) {
    const match = attrText.match(/\[\s*Route\s*(?:\(([^\)]*)\))?\s*\]/i);
    if (!match) continue;
    const template = extractFirstStringLiteral(match[1] ?? "");
    if (template) {
      return template.replace(/\[controller\]/gi, className.replace(/Controller$/i, "")).replace(/\[action\]/gi, "");
    }
  }
  return "";
}
