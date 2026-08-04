/**
 * C# HTTP surface: minimal-API registrations, attribute-routed controllers, and the endpoint
 * contract symbols both produce.
 *
 * Two dialects, one output. Minimal API needs the builder variable tracked across statements
 * (`var g = app.MapGroup("/v1")` then `g.MapPost(...)`); controllers need the attribute texts
 * of a method combined with its class prefix. The contract symbol is what makes an endpoint
 * joinable across repos.
 */

import type Parser from "tree-sitter";
import type { ExtractInput } from "./extractorTypes.js";
import type { RouteRecord, SymbolRecord } from "../../types/index.js";
import {
  combineRouteTemplate,
  dedupeRoutes,
  extractFirstStringLiteral,
  isSameNode,
  normalizeEndpointPath,
  normalizeRouteTemplate,
  stableId,
  toEndpointContractId
} from "./extractorUtils.js";

const MINIMAL_API_HTTP_METHODS: Record<string, RouteRecord["httpMethod"]> = {
  MapGet: "GET",
  MapPost: "POST",
  MapPut: "PUT",
  MapDelete: "DELETE",
  MapPatch: "PATCH",
};

// Known ASP.NET endpoint builder type names (from parameter declarations or type annotations)
const ASPNET_BUILDER_TYPE_NAMES = new Set([
  "WebApplication",
  "IEndpointRouteBuilder",
  "RouteGroupBuilder",
  "IEndpointConventionBuilder",
]);

/**
 * Collect variable names that are ASP.NET endpoint route builders in a given scope subtree.
 * Tracks:
 *   1. Parameters with type WebApplication / IEndpointRouteBuilder / RouteGroupBuilder
 *   2. Local variables assigned from .MapGroup(...) invocations
 *   3. Local variables assigned from WebApplication.Create(...)
 *   4. WebApplicationBuilder vars (from WebApplication.CreateBuilder(...)) used in builder.Build()
 */
function collectRouteBuilderVars(root: Parser.SyntaxNode): Set<string> {
  const builderVars = new Set<string>();
  // Tracks vars that are WebApplicationBuilder (so we can resolve .Build() → WebApplication)
  const webAppBuilderVars = new Set<string>();

  // 1. Collect params with known ASP.NET builder types
  for (const paramNode of root.descendantsOfType(["parameter"])) {
    const typeNode = paramNode.childForFieldName("type");
    const nameNode = paramNode.childForFieldName("name");
    if (!typeNode || !nameNode) continue;
    const typeName = typeNode.text.trim().replace(/<.*>/, "").trim();
    if (ASPNET_BUILDER_TYPE_NAMES.has(typeName)) {
      builderVars.add(nameNode.text.trim());
    }
  }

  // Pass A: resolve WebApplication factory methods and MapGroup assignments
  // tree-sitter C# parses: variable_declarator → identifier, '=', invocation_expression (no named "value" field)
  for (const declNode of root.descendantsOfType(["variable_declarator"])) {
    const nameNode = declNode.childForFieldName("name");
    if (!nameNode) continue;
    const invNode = declNode.children.find((c) => c.type === "invocation_expression");
    if (!invNode) continue;
    const fnNode = invNode.childForFieldName("function");
    if (!fnNode || fnNode.type !== "member_access_expression") continue;
    const callName = fnNode.childForFieldName("name")?.text ?? "";
    const receiverText = fnNode.childForFieldName("expression")?.text?.trim() ?? "";
    if (callName === "MapGroup") {
      // 2. var group = app.MapGroup("/prefix") → group is a route builder
      builderVars.add(nameNode.text.trim());
    } else if (receiverText === "WebApplication" && callName === "Create") {
      // 3. var app = WebApplication.Create(...) → app is a WebApplication
      builderVars.add(nameNode.text.trim());
    } else if (receiverText === "WebApplication" && callName === "CreateBuilder") {
      // 4a. var builder = WebApplication.CreateBuilder(...) → track as WebApplicationBuilder
      webAppBuilderVars.add(nameNode.text.trim());
    }
  }

  // Pass B: resolve builder.Build() → WebApplication
  for (const declNode of root.descendantsOfType(["variable_declarator"])) {
    const nameNode = declNode.childForFieldName("name");
    if (!nameNode) continue;
    const invNode = declNode.children.find((c) => c.type === "invocation_expression");
    if (!invNode) continue;
    const fnNode = invNode.childForFieldName("function");
    if (!fnNode || fnNode.type !== "member_access_expression") continue;
    const callName = fnNode.childForFieldName("name")?.text ?? "";
    const receiverText = fnNode.childForFieldName("expression")?.text?.trim() ?? "";
    if (callName === "Build" && webAppBuilderVars.has(receiverText)) {
      // 4b. var app = builder.Build() → app is a WebApplication
      builderVars.add(nameNode.text.trim());
    }
  }

  return builderVars;
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

    // Minimal API inside class methods (e.g. static void MapEndpoints(WebApplication app))
    const builderVarsInClass = collectRouteBuilderVars(classNode);
    if (builderVarsInClass.size > 0) {
      for (const invNode of classNode.descendantsOfType(["invocation_expression"])) {
        const fnNode = invNode.childForFieldName("function");
        if (!fnNode || fnNode.type !== "member_access_expression") continue;
        const callName = fnNode.childForFieldName("name")?.text ?? "";
        const httpMethod = MINIMAL_API_HTTP_METHODS[callName];
        if (!httpMethod) continue;
        const receiverNode = fnNode.childForFieldName("expression");
        const receiverName = receiverNode?.type === "identifier" ? receiverNode.text.trim() : "";
        if (!receiverName || !builderVarsInClass.has(receiverName)) continue;
        // Resolve group prefix: a local MapGroup var, else the class's declared convention prefix
        // (the builder can arrive as a parameter, which has no declarator to read) — MCP-ISSUE-044.
        const groupPrefix = resolveMapGroupPrefix(classNode, receiverName) ?? resolveConventionRoutePrefix(classNode);
        const argList = invNode.childForFieldName("arguments");
        const rawTemplate = argList ? extractFirstStringLiteral(argList.text) : null;
        if (!rawTemplate) continue;
        const combined = groupPrefix ? `${groupPrefix.replace(/\/$/, "")}/${rawTemplate.replace(/^\//, "")}` : rawTemplate;
        // Normalize only when the result is a real absolute path; a template whose group prefix could
        // not be resolved stays relative rather than pretending to be absolute.
        const routeTemplate = groupPrefix || combined.startsWith("/") ? normalizeRouteTemplate(combined) : combined;
        routes.push({
          repoId: input.repoId,
          filePath: input.filePath,
          controllerSymbolId: classSymbolId,
          // The delegate is the handler. Lambdas have no symbol, so fall back to the enclosing
          // registration method, and only then to the group class (the old behaviour for everything).
          handlerSymbolId:
            resolveDelegateHandlerSymbolId(invNode, symbols) ??
            enclosingMethodSymbolId(invNode, symbols) ??
            classSymbolId,
          httpMethod,
          routeTemplate,
          line: invNode.startPosition.row + 1
        });
      }
    }
  }

  // Also extract Minimal API routes at top-level (outside class, e.g. Program.cs / top-level statements)
  const builderVarsTopLevel = collectRouteBuilderVars(root);
  if (builderVarsTopLevel.size > 0) {
    for (const invNode of root.descendantsOfType(["invocation_expression"])) {
      // Skip invocations inside class declarations (already handled above)
      if (invNode.parent && isInsideClassDeclaration(invNode)) continue;
      const fnNode = invNode.childForFieldName("function");
      if (!fnNode || fnNode.type !== "member_access_expression") continue;
      const callName = fnNode.childForFieldName("name")?.text ?? "";
      const httpMethod = MINIMAL_API_HTTP_METHODS[callName];
      if (!httpMethod) continue;
      const receiverNode = fnNode.childForFieldName("expression");
      const receiverName = receiverNode?.type === "identifier" ? receiverNode.text.trim() : "";
      if (!receiverName || !builderVarsTopLevel.has(receiverName)) continue;
      const groupPrefix = resolveMapGroupPrefix(root, receiverName);
      const argList = invNode.childForFieldName("arguments");
      const rawTemplate = argList ? extractFirstStringLiteral(argList.text) : null;
      if (!rawTemplate) continue;
      const combined = groupPrefix ? `${groupPrefix.replace(/\/$/, "")}/${rawTemplate.replace(/^\//, "")}` : rawTemplate;
      const routeTemplate = groupPrefix || combined.startsWith("/") ? normalizeRouteTemplate(combined) : combined;
      routes.push({
        repoId: input.repoId,
        filePath: input.filePath,
        controllerSymbolId: "",
        // MCP-ISSUE-044: this was the literal string `module:<filePath>`, which is not a symbol id and
        // so could never join `symbols` — `route_map` reported handlerName:null and `find_entry_points`
        // printed the raw placeholder. Use the delegate, else this file's real module symbol.
        handlerSymbolId:
          resolveDelegateHandlerSymbolId(invNode, symbols) ??
          symbols.find((s) => s.kind === "module" && s.filePath === input.filePath)?.symbolId ??
          "",
        httpMethod,
        routeTemplate,
        line: invNode.startPosition.row + 1
      });
    }
  }

  return dedupeRoutes(routes);
}

/** Check if a node is nested inside any class_declaration */
function isInsideClassDeclaration(node: Parser.SyntaxNode): boolean {
  let cur: Parser.SyntaxNode | null = node.parent;
  while (cur) {
    if (cur.type === "class_declaration") return true;
    cur = cur.parent;
  }
  return false;
}

/**
 * Resolve the handler a minimal-API registration actually dispatches to.
 *
 * MCP-ISSUE-044: `handlerSymbolId` used to be the enclosing class, so every route in an endpoint-group
 * file resolved to the same group symbol and route → handler → call-graph was a dead end. The handler
 * is the delegate argument — `groupBuilder.MapPost("{id}/reply", Reply)` dispatches to `Reply`. A method
 * group (bare identifier, or `Handlers.Reply`) names a real symbol; an inline lambda does not, and for
 * that case the caller falls back to the enclosing method, which is where the lambda body lives.
 */
function resolveDelegateHandlerSymbolId(
  invNode: Parser.SyntaxNode,
  symbols: SymbolRecord[]
): string | null {
  const argList = invNode.childForFieldName("arguments");
  if (!argList) return null;

  const argNodes = argList.namedChildren.filter((c) => c.type === "argument");
  // arg 0 is the route template; the delegate is the next positional argument.
  const delegateArg = argNodes[1]?.namedChildren[0] ?? argNodes[1]?.firstNamedChild;
  if (!delegateArg) return null;

  const handlerName =
    delegateArg.type === "identifier"
      ? delegateArg.text.trim()
      : delegateArg.type === "member_access_expression"
        ? (delegateArg.childForFieldName("name")?.text?.trim() ?? "")
        : "";
  if (!handlerName) return null;

  return symbols.find((s) => s.kind === "method" && s.name === handlerName)?.symbolId ?? null;
}

/** The method_declaration a node sits in, resolved to its symbol id. */
function enclosingMethodSymbolId(node: Parser.SyntaxNode, symbols: SymbolRecord[]): string | null {
  let cur: Parser.SyntaxNode | null = node.parent;
  while (cur) {
    if (cur.type === "method_declaration") {
      const name = cur.childForFieldName("name")?.text ?? "";
      if (!name) return null;
      return findSymbolIdByNode(symbols, "method", name, cur.startPosition.row + 1);
    }
    cur = cur.parent;
  }
  return null;
}

/**
 * Route prefix declared by convention on an endpoint-group class, for the case where the group
 * builder arrives as a PARAMETER and so has no local `MapGroup` declarator to read.
 *
 * MCP-ISSUE-044: `resolveMapGroupPrefix` only handles `var g = app.MapGroup("/v1")`. The endpoint-group
 * pattern instead declares the prefix on the class (`static string? RoutePrefix => "api/v1/conversations"`)
 * and receives an already-grouped `RouteGroupBuilder`, so every template was stored group-relative —
 * `{conversationId}/reply` rather than the real request path. Narrow by design: a static string-valued
 * property named `RoutePrefix`, read only when no MapGroup declarator was found.
 */
function resolveConventionRoutePrefix(classNode: Parser.SyntaxNode): string | null {
  for (const propNode of classNode.descendantsOfType(["property_declaration"])) {
    if ((propNode.childForFieldName("name")?.text ?? "") !== "RoutePrefix") continue;
    const literal = extractFirstStringLiteral(propNode.text);
    if (literal) return literal;
  }
  return null;
}

/**
 * For a variable assigned from MapGroup, resolve the route prefix string arg.
 * e.g. var groupBuilder = app.MapGroup("/v1"); → "/v1"
 */
function resolveMapGroupPrefix(root: Parser.SyntaxNode, varName: string): string | null {
  for (const declNode of root.descendantsOfType(["variable_declarator"])) {
    const nameNode = declNode.childForFieldName("name");
    if (!nameNode || nameNode.text.trim() !== varName) continue;
    // tree-sitter C#: invocation_expression is a direct child, no named "value" field
    const invNode = declNode.children.find((c) => c.type === "invocation_expression");
    if (!invNode) continue;
    const fnNode = invNode.childForFieldName("function");
    if (!fnNode || fnNode.type !== "member_access_expression") continue;
    if ((fnNode.childForFieldName("name")?.text ?? "") !== "MapGroup") continue;
    const argList = invNode.childForFieldName("arguments");
    return argList ? extractFirstStringLiteral(argList.text) : null;
  }
  return null;
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

  // Strategy 1: previousNamedSibling chain (some tree-sitter C# layouts)
  let current = node.previousNamedSibling;
  while (current && current.type === "attribute_list") {
    attrs.unshift(current.text);
    current = current.previousNamedSibling;
  }
  if (attrs.length > 0) return attrs;

  // Strategy 2: attribute_list as first named children of the node itself
  // This is the actual layout in tree-sitter-c-sharp where [HttpGet] appears
  // as a named child of method_declaration / class_declaration before the body
  for (const child of node.namedChildren) {
    if (child.type === "attribute_list") {
      attrs.push(child.text);
    } else if (attrs.length > 0) {
      // Stop at first non-attribute child after we found some
      break;
    } else if (child.type !== "modifier") {
      // Stop if we hit a non-modifier, non-attribute child before finding any attributes
      break;
    }
  }
  if (attrs.length > 0) return attrs;

  // Strategy 3: walk parent's named children before this node
  // Handles declaration_list wrapper and other AST layout variants
  const parent = node.parent;
  if (!parent) return attrs;
  for (const child of parent.namedChildren) {
    if (isSameNode(child, node)) break;
    if (child.type === "attribute_list") attrs.push(child.text);
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
