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

export function extractCSharpSymbolsImpl(
  input: ExtractInput,
  root: Parser.SyntaxNode,
  symbols: SymbolRecord[],
  edges: EdgeRecord[],
  moduleSymbolId: string
): void {
  for (const node of root.descendantsOfType(["using_directive"])) {
    const usingNamespace = extractCSharpUsingNamespace(node);
    if (!usingNamespace) continue;
    edges.push({ repoId: input.repoId, fromId: moduleSymbolId, toId: `import:${usingNamespace}`, type: "IMPORTS" });
    const packageContractId = mapUsingNamespaceToNugetContract(usingNamespace);
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
    symbols.push({ repoId: input.repoId, symbolId, filePath: input.filePath, name: nameNode.text, kind, line: node.startPosition.row + 1, signature: extractSignature(node) });
  }

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
    
    // Try to infer the declaring type
    const scopeTypeMap = collectCSharpScopeTypeMap(node);
    let declaringType: string | undefined;

    if (expressionNode.type === "identifier") {
      const receiverName = expressionNode.text.trim();
      declaringType = scopeTypeMap.get(receiverName);
    } else if (expressionNode.type === "this_expression") {
      declaringType = findEnclosingCSharpTypeName(node);
    }

    const propertyToken = declaringType ? `${declaringType}.${propertyName}` : propertyName;
    const fromId = findEnclosingCSharpSymbolId(node, input) ?? moduleSymbolId;
    
    emitPropertyAccessEdge(input, fromId, propertyToken, isWrite, edges);
  }

  // Extract property assignments from object initializers
  // Pattern: new ClassName { PropertyName = value, ... }
  for (const initNode of root.descendantsOfType(["initializer_expression"])) {
    // Check if this is an object initializer (parent is object_creation_expression)
    const parent = initNode.parent;
    if (!parent || parent.type !== "object_creation_expression") continue;

    // Get the type being initialized
    const typeNode = parent.childForFieldName("type");
    if (!typeNode) continue;

    const typeName = typeNode.text.trim().replace(/<.*>/, "").trim();
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
