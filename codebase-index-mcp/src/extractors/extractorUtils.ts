import { createHash } from "node:crypto";
import type Parser from "tree-sitter";
import type { EdgeRecord, RouteRecord, SymbolRecord } from "../types.js";
import type { ExtractInput } from "./extractorTypes.js";

// ============================================================================
// ID & Hashing
// ============================================================================

export function stableId(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 24);
}

// ============================================================================
// String Utilities
// ============================================================================

export function stripQuotes(value: string): string {
  return value.replace(/^['\"]|['\"]$/g, "").trim();
}

export function normalizeEndpointPath(raw: string): string {
  const trimmed = stripQuotes(raw).trim();
  if (!trimmed) {
    return "/";
  }

  let candidate = trimmed;
  if (/^https?:\/\//i.test(candidate)) {
    try {
      const parsed = new URL(candidate);
      candidate = parsed.pathname || "/";
    } catch {
      // Keep raw candidate when URL parsing fails.
    }
  }

  const noQuery = candidate.split("?")[0]?.split("#")[0] ?? candidate;
  const normalized = noQuery.replace(/\\/g, "/").replace(/\/{2,}/g, "/").trim();
  const withLeadingSlash = normalized.startsWith("/") ? normalized : `/${normalized}`;
  return withLeadingSlash.toLowerCase();
}

export function extractFirstStringLiteral(input: string): string | null {
  const match = /["']([^"']+)["']/.exec(input);
  return match?.[1] ?? null;
}

// ============================================================================
// Route Utilities
// ============================================================================

export function toEndpointContractId(httpMethod: RouteRecord["httpMethod"], routeTemplate: string): string {
  return `endpoint:${httpMethod.toUpperCase()}:${normalizeEndpointPath(routeTemplate)}`;
}

export function normalizeRouteToken(template: string, className: string, methodName: string): string {
  return template
    .replace(/\[controller\]/gi, className.replace(/controller$/i, ""))
    .replace(/\[action\]/gi, methodName);
}

export function combineRouteTemplate(classPrefix: string, methodTemplate: string | null, className: string, methodName: string): string {
  const normalizedClass = normalizeRouteToken(classPrefix, className, methodName);
  if (!methodTemplate) {
    return normalizedClass;
  }
  const normalizedMethod = normalizeRouteToken(methodTemplate, className, methodName);
  const combined = `${normalizedClass}/${normalizedMethod}`.replace(/\/{2,}/g, "/");
  return combined.startsWith("/") ? combined : `/${combined}`;
}

export function dedupeRoutes(routes: RouteRecord[]): RouteRecord[] {
  const seen = new Set<string>();
  const output: RouteRecord[] = [];

  for (const route of routes) {
    const key = `${route.repoId}:${route.httpMethod}:${route.routeTemplate}:${route.handlerSymbolId}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push(route);
  }

  return output;
}

// ============================================================================
// C# Utilities
// ============================================================================

export function extractCSharpUsingNamespace(node: Parser.SyntaxNode): string | null {
  const nameNode = node.childForFieldName("name");
  const raw = (nameNode?.text ?? node.text)
    .replace(/^\s*global\s+using\s+/i, "")
    .replace(/^\s*using\s+/i, "")
    .replace(/\s*=\s*.+$/, "")
    .replace(/;\s*$/, "")
    .trim();

  if (!raw || raw.length < 2 || !raw.includes(".")) {
    return null;
  }

  return raw;
}

export function mapUsingNamespaceToNugetContract(namespaceImport: string): string | null {
  const normalized = namespaceImport.trim();
  // Contract bridge lane for CommunicationHub package family.
  if (/^SSNet\.CommunicationHub\.Messaging(\.|$)/i.test(normalized)) {
    return "nuget:ssnet.communicationhub.messaging";
  }

  return null;
}

export function normalizeCSharpTypeName(raw: string): string {
  return raw
    .replace(/\s*<.*>$/, "")
    .replace(/\s*\[\s*\]\s*$/, "")
    .trim();
}

export function isLikelyCSharpInterfaceName(rawTypeName: string): boolean {
  const normalized = normalizeCSharpTypeName(rawTypeName);
  return /^I[A-Z]/.test(normalized);
}

export function findEnclosingCSharpTypeName(node: Parser.SyntaxNode): string | undefined {
  const CLASS_TYPES = new Set(["class_declaration", "struct_declaration", "interface_declaration", "record_declaration"]);
  let current: Parser.SyntaxNode | null = node.parent;

  while (current) {
    if (CLASS_TYPES.has(current.type)) {
      const nameNode = current.childForFieldName("name");
      if (nameNode) {
        return nameNode.text.trim();
      }
    }
    current = current.parent;
  }

  return undefined;
}

export function findEnclosingCSharpSymbolId(node: Parser.SyntaxNode, input: ExtractInput): string | null {
  const FUNCTION_TYPES = new Set([
    "method_declaration",
    "constructor_declaration",
    "property_declaration",
    "class_declaration",
    "struct_declaration"
  ]);
  let current: Parser.SyntaxNode | null = node.parent;

  while (current) {
    if (FUNCTION_TYPES.has(current.type)) {
      const nameNode = current.childForFieldName("name");
      if (nameNode) {
        return stableId(`${input.repoId}:${input.filePath}:${nameNode.text}:${current.startPosition.row + 1}`);
      }
    }
    current = current.parent;
  }

  return null;
}

export function extractCSharpHttpDependencyContract(invocationNode: Parser.SyntaxNode): {
  httpMethod: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
  endpoint: string;
} | null {
  const functionNode = invocationNode.childForFieldName("function");
  if (!functionNode || functionNode.type !== "member_access_expression") {
    return null;
  }

  const methodNameNode = functionNode.childForFieldName("name");
  if (!methodNameNode) {
    return null;
  }

  const methodName = methodNameNode.text.trim();
  const httpMethodMap: Record<string, "GET" | "POST" | "PUT" | "DELETE" | "PATCH"> = {
    GetAsync: "GET",
    PostAsync: "POST",
    PutAsync: "PUT",
    DeleteAsync: "DELETE",
    PatchAsync: "PATCH"
  };

  const httpMethod = httpMethodMap[methodName];
  if (!httpMethod) {
    return null;
  }

  const argsNode = invocationNode.childForFieldName("arguments");
  if (!argsNode) {
    return null;
  }

  const firstArg = argsNode.namedChildren[0];
  if (!firstArg) {
    return null;
  }

  let endpoint = firstArg.text.trim();
  if (firstArg.type === "string_literal" || firstArg.type === "verbatim_string_literal") {
    endpoint = stripQuotes(endpoint);
  } else if (firstArg.type === "interpolated_string_expression") {
    endpoint = firstArg.text.replace(/^\$@?["']|["']$/g, "").trim();
  }

  if (!endpoint || endpoint.length < 2) {
    return null;
  }

  return { httpMethod, endpoint };
}

// ============================================================================
// Scope Utilities
// ============================================================================

export function collectCSharpEnclosingMemberTypeMap(scopeNode: Parser.SyntaxNode): Map<string, string> {
  const typeMap = new Map<string, string>();
  const CLASS_TYPES = new Set(["class_declaration", "struct_declaration", "record_declaration"]);

  let current: Parser.SyntaxNode | null = scopeNode.parent;
  while (current) {
    if (CLASS_TYPES.has(current.type)) {
      const bodyNode = current.childForFieldName("body");
      if (bodyNode) {
        for (const member of bodyNode.namedChildren) {
          if (member.type === "field_declaration" || member.type === "property_declaration") {
            const typeNode = member.childForFieldName("type");
            const declaratorNode = member.descendantsOfType("variable_declarator")[0];
            const nameNode = declaratorNode?.childForFieldName("name") ?? member.childForFieldName("name");

            if (typeNode && nameNode) {
              const typeName = normalizeCSharpTypeName(typeNode.text.trim());
              const memberName = nameNode.text.trim();
              if (typeName && memberName) {
                typeMap.set(memberName, typeName);
              }
            }
          }
        }
      }
      break;
    }
    current = current.parent;
  }

  return typeMap;
}

export function collectCSharpScopeTypeMap(scopeNode: Parser.SyntaxNode): Map<string, string> {
  const typeMap = new Map<string, string>();

  const localDeclarations = scopeNode.descendantsOfType("local_declaration_statement");
  for (const decl of localDeclarations) {
    const typeNode = decl.childForFieldName("type");
    const declaratorNode = decl.descendantsOfType("variable_declarator")[0];
    const nameNode = declaratorNode?.childForFieldName("name");

    if (typeNode && nameNode) {
      const typeName = normalizeCSharpTypeName(typeNode.text.trim());
      const varName = nameNode.text.trim();
      if (typeName && varName) {
        typeMap.set(varName, typeName);
      }
    }
  }

  const parameters = scopeNode.descendantsOfType("parameter");
  for (const param of parameters) {
    const typeNode = param.childForFieldName("type");
    const nameNode = param.childForFieldName("name");

    if (typeNode && nameNode) {
      const typeName = normalizeCSharpTypeName(typeNode.text.trim());
      const paramName = nameNode.text.trim();
      if (typeName && paramName) {
        typeMap.set(paramName, typeName);
      }
    }
  }

  const enclosingMemberTypes = collectCSharpEnclosingMemberTypeMap(scopeNode);
  for (const [name, type] of enclosingMemberTypes) {
    if (!typeMap.has(name)) {
      typeMap.set(name, type);
    }
  }

  return typeMap;
}

// ============================================================================
// Edge Utilities
// ============================================================================

export function dedupeEdges(edges: EdgeRecord[]): EdgeRecord[] {
  const seen = new Set<string>();
  const output: EdgeRecord[] = [];

  for (const edge of edges) {
    const key = `${edge.repoId}:${edge.fromId}:${edge.toId}:${edge.type}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push(edge);
  }

  return output;
}

export function dedupeSymbols(symbols: SymbolRecord[]): SymbolRecord[] {
  const seen = new Set<string>();
  const output: SymbolRecord[] = [];

  for (const symbol of symbols) {
    const key = `${symbol.repoId}:${symbol.symbolId}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push(symbol);
  }

  return output;
}

export function resolveIntraFileEdges(edges: EdgeRecord[], symbols: SymbolRecord[]): EdgeRecord[] {
  if (edges.length === 0 || symbols.length === 0) {
    return edges;
  }

  const callTargetByName = new Map<string, SymbolRecord>();
  const typeTargetByName = new Map<string, SymbolRecord>();
  const interfaceByName = new Map<string, SymbolRecord>();
  const propertyTargetByName = new Map<string, SymbolRecord>();

  for (const symbol of symbols) {
    if ((symbol.kind === "function" || symbol.kind === "method" || symbol.kind === "constructor" || symbol.kind === "class") && !callTargetByName.has(symbol.name)) {
      callTargetByName.set(symbol.name, symbol);
    }
    if ((symbol.kind === "class" || symbol.kind === "interface" || symbol.kind === "struct" || symbol.kind === "type") && !typeTargetByName.has(symbol.name)) {
      typeTargetByName.set(symbol.name, symbol);
    }
    if (symbol.kind === "interface" && !interfaceByName.has(symbol.name)) {
      interfaceByName.set(symbol.name, symbol);
    }
    if (symbol.kind === "property" && !propertyTargetByName.has(symbol.name)) {
      propertyTargetByName.set(symbol.name, symbol);
    }
  }

  return edges.map((edge) => {
    if (edge.type === "CALLS" && edge.toId.startsWith("callee:")) {
      const calleeName = edge.toId.slice(7);
      const target = callTargetByName.get(calleeName);
      if (target) {
        return {
          ...edge,
          toId: target.symbolId,
          confidence: edge.confidence ?? 0.9,
          reason: edge.reason ?? "resolved callee same-file"
        };
      }
    }

    if (edge.type === "TYPE_REF" && edge.toId.startsWith("type:")) {
      const rawTypeName = edge.toId.slice(5);
      const typeName = rawTypeName.split(".").pop() ?? rawTypeName;
      const target = typeTargetByName.get(typeName);
      if (target) {
        return {
          ...edge,
          toId: target.symbolId,
          confidence: edge.confidence ?? 0.9,
          reason: edge.reason ?? "resolved type reference same-file"
        };
      }
    }

    if (edge.type === "IMPLEMENTS" && edge.toId.startsWith("iface:")) {
      const ifaceName = edge.toId.slice(6);
      const target = interfaceByName.get(ifaceName);
      if (target) {
        return {
          ...edge,
          toId: target.symbolId,
          confidence: edge.confidence ?? 0.95,
          reason: edge.reason ?? "resolved interface same-file"
        };
      }
    }

    if ((edge.type === "PROPERTY_REF" || edge.type === "PROPERTY_WRITE") && edge.toId.startsWith("property:")) {
      const token = edge.toId.slice("property:".length);
      const memberName = token.split(".").pop() ?? token;
      const target = propertyTargetByName.get(memberName);
      if (target) {
        return {
          ...edge,
          toId: target.symbolId,
          confidence: edge.confidence ?? 0.85,
          reason: edge.reason ?? "resolved property same-file"
        };
      }
    }

    return edge;
  });
}

export function applyCallEdgeCap(edges: EdgeRecord[], maxCallEdgesPerFile: number): EdgeRecord[] {
  if (maxCallEdgesPerFile <= 0) {
    return edges;
  }

  const output: EdgeRecord[] = [];
  let callCount = 0;
  for (const edge of edges) {
    if (edge.type !== "CALLS") {
      output.push(edge);
      continue;
    }
    if (callCount >= maxCallEdgesPerFile) {
      continue;
    }
    callCount += 1;
    output.push(edge);
  }
  return output;
}

export function applyEdgeConfidenceFilter(edges: EdgeRecord[], minEdgeConfidence: number): EdgeRecord[] {
  if (minEdgeConfidence <= 0) {
    return edges;
  }

  return edges.filter((edge) => {
    const confidence = getEffectiveEdgeConfidence(edge);
    return confidence >= minEdgeConfidence;
  });
}

export function getEffectiveEdgeConfidence(edge: EdgeRecord): number {
  if (typeof edge.confidence === "number") {
    return edge.confidence;
  }

  if (edge.toId.startsWith("callee:")) {
    return 0.4;
  }
  if (edge.toId.startsWith("import:")) {
    return 0.5;
  }
  if (edge.toId.startsWith("type:")) {
    return 0.45;
  }
  if (edge.toId.startsWith("property:")) {
    return 0.5;
  }

  if (edge.type === "CALLS") {
    return 1.0;
  }
  if (edge.type === "IMPORTS") {
    return 0.95;
  }
  if (edge.type === "TYPE_REF") {
    return 0.9;
  }
  if (edge.type === "PROPERTY_REF") {
    return 0.85;
  }
  if (edge.type === "PROPERTY_WRITE") {
    return 0.82;
  }

  return 1.0;
}

export function emitTypeRefEdge(
  input: ExtractInput,
  fromSymbolId: string,
  rawTypeName: string,
  edges: EdgeRecord[]
): void {
  const normalized = normalizeCSharpTypeName(rawTypeName);
  if (!normalized || normalized.length < 2) {
    return;
  }

  edges.push({
    repoId: input.repoId,
    fromId: fromSymbolId,
    toId: `type:${normalized}`,
    type: "TYPE_REF"
  });
}

export function emitPropertyAccessEdge(
  input: ExtractInput,
  fromSymbolId: string,
  propertyToken: string,
  isWrite: boolean,
  edges: EdgeRecord[]
): void {
  if (!propertyToken || propertyToken.length < 2) {
    return;
  }

  edges.push({
    repoId: input.repoId,
    fromId: fromSymbolId,
    toId: `property:${propertyToken}`,
    type: isWrite ? "PROPERTY_WRITE" : "PROPERTY_REF"
  });
}

// ============================================================================
// AST Utilities
// ============================================================================

export function findEnclosingSymbolId(node: Parser.SyntaxNode, input: ExtractInput): string | null {
  const FUNCTION_TYPES = new Set([
    "function_declaration",
    "function_expression",
    "arrow_function",
    "method_definition"
  ]);
  let current: Parser.SyntaxNode | null = node.parent;

  while (current) {
    if (FUNCTION_TYPES.has(current.type)) {
      const nameNode = current.childForFieldName("name");
      if (nameNode) {
        return stableId(`${input.repoId}:${input.filePath}:${nameNode.text}:${current.startPosition.row + 1}`);
      }
      return stableId(`${input.repoId}:${input.filePath}:anonymous:${current.startPosition.row + 1}`);
    }
    current = current.parent;
  }

  return null;
}

export function extractSignature(node: Parser.SyntaxNode, maxLen = 300): string {
  const raw = node.text.split("\n")[0]?.trim() ?? "";
  if (raw.length <= maxLen) {
    return raw;
  }
  return raw.slice(0, maxLen) + "...";
}

export function lineFromOffset(source: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < source.length; i++) {
    if (source[i] === "\n") {
      line += 1;
    }
  }
  return line;
}

export function findSymbolIdByName(symbols: SymbolRecord[], name: string): string | null {
  for (const symbol of symbols) {
    if (symbol.name === name) {
      return symbol.symbolId;
    }
  }
  return null;
}

// ============================================================================
// JavaScript Utilities
// ============================================================================

/**
 * JS/TS runtime built-in method names that will never resolve to a user-defined symbol.
 */
export const BUILTIN_SKIP_NAMES = new Set<string>([
  // Array prototype
  "map", "filter", "forEach", "find", "findIndex", "reduce", "reduceRight",
  "some", "every", "flat", "flatMap", "sort", "reverse", "splice", "slice",
  "push", "pop", "shift", "unshift", "concat", "join", "indexOf", "lastIndexOf",
  "includes", "fill", "copyWithin", "at", "findLast", "findLastIndex", "toSorted",
  "toReversed", "toSpliced", "with",
  // String prototype
  "trim", "trimStart", "trimEnd", "trimLeft", "trimRight",
  "replace", "replaceAll", "split", "substring", "slice", "padStart", "padEnd",
  "toLowerCase", "toUpperCase", "toLocaleLowerCase", "toLocaleUpperCase",
  "charAt", "charCodeAt", "codePointAt", "repeat", "normalize",
  "startsWith", "endsWith", "includes", "indexOf", "lastIndexOf",
  "match", "matchAll", "search", "localeCompare",
  // Object / general
  "toString", "valueOf", "toJSON", "hasOwnProperty", "isPrototypeOf",
  // Promise / async
  "then", "catch", "finally", "resolve", "reject", "all", "allSettled", "race", "any",
  // Set / Map / WeakMap
  "has", "add", "delete", "clear", "size", "entries", "keys", "values",
  // Console
  "log", "warn", "error", "info", "debug", "trace", "assert", "dir", "table",
  // JSON
  "parse", "stringify",
  // Math
  "floor", "ceil", "round", "abs", "max", "min", "sqrt", "pow", "random", "sign", "trunc",
  // Number
  "toFixed", "toPrecision", "toExponential", "isNaN", "isFinite", "isInteger", "parseInt", "parseFloat",
  // Primitive constructor calls
  "String", "Number", "Boolean",
  // DB driver externals
  "prepare", "exec", "transaction", "pragma", "checkpoint", "backup",
  "bind", "pluck", "expand", "raw", "iterate", "columns",
  // Node fs/path
  "existsSync", "readFileSync", "writeFileSync", "mkdirSync", "readdirSync",
  "statSync", "unlinkSync", "renameSync", "copyFileSync",
  // tree-sitter APIs
  "childForFieldName", "descendantsOfType",
  // transactional callback aliases
  "tx",
]);

/**
 * Node.js built-in module names for classifying IMPORTS edges.
 */
export const NODE_BUILTINS = new Set<string>([
  "assert", "async_hooks", "buffer", "child_process", "cluster", "console",
  "constants", "crypto", "dgram", "diagnostics_channel", "dns", "domain",
  "events", "fs", "http", "http2", "https", "inspector", "module",
  "net", "os", "path", "perf_hooks", "process", "punycode", "querystring",
  "readline", "repl", "stream", "string_decoder", "sys", "timers",
  "tls", "trace_events", "tty", "url", "util", "v8", "vm", "wasi",
  "worker_threads", "zlib",
]);

export const JS_STATIC_RECEIVER_NAMES = new Set<string>([
  "Array", "Date", "JSON", "Math", "Number", "Object", "Promise", "Reflect", "RegExp", "String", "Symbol"
]);

export const JS_EXTERNAL_LIKE_RECEIVER_NAMES = new Set<string>([
  "db", "stmt", "statement", "tx", "txn", "trx", "query", "client", "pool", "cache", "map", "headers",
  "req", "res", "fs", "path", "process", "env"
]);

export const JS_EXTERNAL_LIKE_METHOD_NAMES = new Set<string>(["get", "set", "run", "all"]);

export const JS_DB_FLUENT_METHOD_NAMES = new Set<string>(["get", "set", "run", "all", "iterate", "pluck", "raw", "columns"]);

export const JS_NOISE_RECEIVER_TYPES = new Set<string>([
  "array",
  "object",
  "number",
  "string",
  "template_string",
  "regex",
  "null",
  "true",
  "false",
  "new_expression",
  "parenthesized_expression",
  "binary_expression",
  "unary_expression",
  "conditional_expression"
]);

export function shouldSkipJavaScriptMemberCall(functionNode: Parser.SyntaxNode, callee: string): boolean {
  if (BUILTIN_SKIP_NAMES.has(callee)) {
    return true;
  }

  const receiver = functionNode.childForFieldName("object");
  if (!receiver) {
    return false;
  }

  if (JS_NOISE_RECEIVER_TYPES.has(receiver.type)) {
    return true;
  }

  if (receiver.type === "identifier" && JS_STATIC_RECEIVER_NAMES.has(receiver.text.trim())) {
    return true;
  }

  if (receiver.type === "identifier" && JS_EXTERNAL_LIKE_METHOD_NAMES.has(callee)) {
    const receiverName = receiver.text.trim().toLowerCase();
    if (JS_EXTERNAL_LIKE_RECEIVER_NAMES.has(receiverName)) {
      return true;
    }
  }

  if (JS_DB_FLUENT_METHOD_NAMES.has(callee)) {
    if (receiver.type === "call_expression") {
      const receiverText = receiver.text.toLowerCase();
      if (receiverText.includes("prepare(") || receiverText.includes("transaction(")) {
        return true;
      }
    }

    if (receiver.type === "member_expression") {
      const receiverText = receiver.text.toLowerCase();
      if (receiverText.includes(".db") || receiverText.includes(".stmt") || receiverText.includes(".statement")) {
        return true;
      }
    }
  }

  return false;
}
