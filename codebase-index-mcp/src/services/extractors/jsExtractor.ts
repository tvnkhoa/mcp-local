import type Parser from "tree-sitter";

import type { EdgeRecord, RouteRecord, SymbolRecord } from "../../types/index.js";
import type { ExtractInput } from "./extractorTypes.js";

import {
  stableId,
  extractSignature,
  findEnclosingSymbolId,
  stripQuotes,
  lineFromOffset,
  findSymbolIdByName,
  dedupeRoutes,
  shouldSkipJavaScriptMemberCall,
  BUILTIN_SKIP_NAMES,
  NODE_BUILTINS
} from "./extractorUtils.js";

export function extractJavaScriptSymbolsImpl(
  input: ExtractInput,
  root: Parser.SyntaxNode,
  symbols: SymbolRecord[],
  edges: EdgeRecord[],
  moduleSymbolId: string
): void {
  for (const node of root.descendantsOfType(["import_statement", "call_expression"])) {
    if (node.type === "import_statement") {
      const source = node.childForFieldName("source");
      if (source) {
        const dependency = stripQuotes(source.text);
        if (dependency) {
          const isNodeBuiltin = dependency.startsWith("node:") || NODE_BUILTINS.has(dependency);
          edges.push({
            repoId: input.repoId,
            fromId: moduleSymbolId,
            toId: `import:${dependency}`,
            type: "IMPORTS",
            confidence: isNodeBuiltin ? 0.8 : dependency.startsWith(".") ? undefined : 0.8,
            reason: isNodeBuiltin ? "node_builtin" : dependency.startsWith(".") ? undefined : "npm_package"
          });
        }
      }
    } else if (node.type === "call_expression") {
      const functionNode = node.childForFieldName("function");
      let callee = "";
      let shouldSkip = false;
      if (functionNode?.type === "identifier") {
        callee = functionNode.text.trim();
      } else if (functionNode?.type === "member_expression") {
        const prop = functionNode.childForFieldName("property");
        if (prop?.type === "property_identifier") {
          callee = prop.text.trim();
          shouldSkip = shouldSkipJavaScriptMemberCall(functionNode, callee);
        }
      }
      if (callee && !shouldSkip && !BUILTIN_SKIP_NAMES.has(callee)) {
        const fromId = findEnclosingSymbolId(node, input) ?? moduleSymbolId;
        edges.push({ repoId: input.repoId, fromId, toId: `callee:${callee}`, type: "CALLS" });
      }
    }
  }

  for (const node of root.descendantsOfType([
    "function_declaration",
    "class_declaration",
    "interface_declaration",
    "type_alias_declaration",
    "enum_declaration",
    "method_definition",
    "abstract_class_declaration"
  ])) {
    const nameNode = node.childForFieldName("name");
    if (!nameNode) continue;
    let kind: SymbolRecord["kind"] = "unknown";
    if (node.type === "function_declaration") kind = "function";
    else if (node.type === "class_declaration" || node.type === "abstract_class_declaration") kind = "class";
    else if (node.type === "interface_declaration") kind = "interface";
    else if (node.type === "type_alias_declaration" || node.type === "enum_declaration") kind = "type";
    else if (node.type === "method_definition") kind = "method";

    symbols.push({
      repoId: input.repoId,
      symbolId: stableId(`${input.repoId}:${input.filePath}:${kind}:${nameNode.text}:${node.startPosition.row}`),
      filePath: input.filePath,
      name: nameNode.text,
      kind,
      line: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      signature: extractSignature(node)
    });
  }

  for (const node of root.descendantsOfType(["lexical_declaration"])) {
    const parent = node.parent;
    const isExported = parent?.type === "export_statement";
    if (!isExported && parent?.type !== "program") continue;

    for (const declarator of node.descendantsOfType(["variable_declarator"])) {
      const nameNode = declarator.childForFieldName("name");
      const valueNode = declarator.childForFieldName("value");
      if (!nameNode || nameNode.type !== "identifier" || !valueNode) continue;
      const isFunction = valueNode.type === "arrow_function" || valueNode.type === "function";

      if (isFunction) {
        const sig = extractSignature(declarator).replace(/^(const|let|var)\s+/, "");
        symbols.push({
          repoId: input.repoId,
          symbolId: stableId(`${input.repoId}:${input.filePath}:function:${nameNode.text}:${node.startPosition.row}`),
          filePath: input.filePath,
          name: nameNode.text,
          kind: "function",
          line: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          signature: sig
        });
      } else if (isExported) {
        const valPreview = valueNode.text.split("\n")[0].slice(0, 80);
        symbols.push({
          repoId: input.repoId,
          symbolId: stableId(`${input.repoId}:${input.filePath}:variable:${nameNode.text}:${node.startPosition.row}`),
          filePath: input.filePath,
          name: nameNode.text,
          kind: "variable",
          line: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          signature: `const ${nameNode.text} = ${valPreview}`
        });
      }
    }
  }
}

export function extractJavaScriptRoutesImpl(
  input: ExtractInput,
  symbols: SymbolRecord[],
  moduleSymbolId: string
): RouteRecord[] {
  const routes: RouteRecord[] = [];
  const routeRegex = /\b(app|router|fastify)\s*\.\s*(get|post|put|delete|patch)\s*\(\s*(["'`])([^"'`]+)\3\s*(?:,\s*([A-Za-z_$][A-Za-z0-9_$]*))?/gi;

  let match: RegExpExecArray | null;
  while ((match = routeRegex.exec(input.source)) !== null) {
    const method = (match[2] ?? "").toUpperCase() as RouteRecord["httpMethod"];
    const template = match[4] ?? "/";
    const handlerName = match[5] ?? "";
    const line = lineFromOffset(input.source, match.index);
    const handlerSymbolId = handlerName ? (findSymbolIdByName(symbols, handlerName) ?? moduleSymbolId) : moduleSymbolId;

    routes.push({
      repoId: input.repoId,
      filePath: input.filePath,
      controllerSymbolId: moduleSymbolId,
      handlerSymbolId,
      httpMethod: method,
      routeTemplate: template.startsWith("/") ? template : `/${template}`,
      line
    });
  }

  return dedupeRoutes(routes);
}
