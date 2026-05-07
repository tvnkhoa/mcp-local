import { createHash } from "node:crypto";

import Parser from "tree-sitter";
import JavaScript from "tree-sitter-javascript";
import TypeScript from "tree-sitter-typescript";
import CSharp from "tree-sitter-c-sharp";

import type { DocMentionRecord, DocRecord, EdgeRecord, RouteRecord, SymbolRecord } from "./types.js";

import { parseMarkdownFile } from "./markdownParser.js";

export type ExtractInput = {
  repoId: string;
  filePath: string;
  language: string;
  source: string;
  performanceProfile?: "standard" | "large" | "very-large";
};

export type ExtractOutput = {
  symbols: SymbolRecord[];
  edges: EdgeRecord[];
  routes?: RouteRecord[];
  docs?: DocRecord[];
  mentions?: DocMentionRecord[];
};

export class ParseTimeoutError extends Error {
  readonly filePath: string;
  readonly timeoutMs: number;

  constructor(filePath: string, timeoutMs: number) {
    super(`parse timeout after ${String(timeoutMs)}ms`);
    this.name = "ParseTimeoutError";
    this.filePath = filePath;
    this.timeoutMs = timeoutMs;
  }
}

export function isParseTimeoutError(error: unknown): error is ParseTimeoutError {
  return error instanceof ParseTimeoutError;
}

const TREE_SITTER_MIN_BUFFER = 512 * 1024;
const TREE_SITTER_MAX_BUFFER = 32 * 1024 * 1024;
const parserCache = new Map<string, Parser>();
const OVERRIDE_MAX_CALL_EDGES_PER_FILE = optionalNumberFromEnv("CODEBASE_INDEX_MAX_CALL_EDGES_PER_FILE");
const OVERRIDE_MIN_EDGE_CONFIDENCE = optionalRatioFromEnv("CODEBASE_INDEX_MIN_EDGE_CONFIDENCE");

/** Per-file parse timeout in milliseconds. Files exceeding this are skipped (module symbol only). */
const PARSE_TIMEOUT_MS = optionalNumberFromEnv("CODEBASE_INDEX_PARSE_TIMEOUT_MS") ?? 5_000;

export function extractGraphData(input: ExtractInput): ExtractOutput {  // Handle markdown separately
  const edgePolicy = resolveEdgePolicy(input.performanceProfile ?? "standard");

  if (input.language === "markdown") {
    return extractMarkdownFile(input);
  }
  const moduleSymbolId = stableId(`${input.repoId}:${input.filePath}:module`);

  const symbols: SymbolRecord[] = [
    {
      repoId: input.repoId,
      symbolId: moduleSymbolId,
      filePath: input.filePath,
      name: input.filePath.split(/[\\/]/).pop() ?? "unknown",
      kind: "module",
      line: 1
    }
  ];

  const parser = getOrCreateParserForLanguage(input.language);
  if (!parser) {
    return { symbols, edges: [] };
  }

  const sourceBytes = Buffer.byteLength(input.source, "utf8");
  if (sourceBytes > TREE_SITTER_MAX_BUFFER) {
    return { symbols, edges: [] };
  }

  parser.setTimeoutMicros(PARSE_TIMEOUT_MS * 1000);
  const tree = parser.parse(input.source, undefined, {
    bufferSize: getTreeSitterBufferSize(sourceBytes)
  });
  parser.setTimeoutMicros(0);

  if (!tree) {
    // Parser timed out — reset so the cached parser is ready for the next file.
    parser.reset();
    throw new ParseTimeoutError(input.filePath, PARSE_TIMEOUT_MS);
  }

  const root = tree.rootNode;
  const edges: EdgeRecord[] = [];
  const routes: RouteRecord[] = [];

  if (input.language === "python") {
    extractPythonSymbolsAndRoutes(input, symbols, edges, routes, moduleSymbolId);
    const resolvedEdges = resolveIntraFileEdges(edges, symbols);
    return {
      symbols: dedupeSymbols(symbols),
      edges: applyEdgeConfidenceFilter(applyCallEdgeCap(dedupeEdges(resolvedEdges), edgePolicy.maxCallEdgesPerFile), edgePolicy.minEdgeConfidence),
      routes: dedupeRoutes(routes)
    };
  }

  // Extract based on language
  if (input.language === "javascript" || input.language === "typescript") {
    extractJavaScriptSymbols(input, root, symbols, edges, moduleSymbolId);
    routes.push(...extractJavaScriptRoutes(input, symbols, moduleSymbolId));
  } else if (input.language === "csharp") {
    extractCSharpSymbols(input, root, symbols, edges, moduleSymbolId);
    routes.push(...extractCSharpRoutes(input, root, symbols));
  }

  const resolvedEdges = resolveIntraFileEdges(edges, symbols);

  return {
    symbols: dedupeSymbols(symbols),
    edges: applyEdgeConfidenceFilter(applyCallEdgeCap(dedupeEdges(resolvedEdges), edgePolicy.maxCallEdgesPerFile), edgePolicy.minEdgeConfidence),
    routes
  };
}

function stableId(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 24);
}

function getOrCreateParserForLanguage(language: string): Parser | null {
  const cached = parserCache.get(language);
  if (cached) {
    return cached;
  }

  const parser = new Parser();
  if (language === "javascript") {
    parser.setLanguage(JavaScript);
    parserCache.set(language, parser);
    return parser;
  }

  if (language === "typescript") {
    parser.setLanguage(TypeScript.typescript);
    parserCache.set(language, parser);
    return parser;
  }

  if (language === "csharp") {
    parser.setLanguage(CSharp);
    parserCache.set(language, parser);
    return parser;
  }

  return null;
}

function getTreeSitterBufferSize(sourceBytes: number): number {
  const adaptive = sourceBytes * 2;
  return Math.min(TREE_SITTER_MAX_BUFFER, Math.max(TREE_SITTER_MIN_BUFFER, adaptive));
}

function stripQuotes(value: string): string {
  return value.replace(/^['\"]|['\"]$/g, "").trim();
}

/**
 * JS/TS runtime built-in method names that will never resolve to a user-defined symbol.
 * Emitting callee: edges for these bloats the graph with noise (low-confidence unresolved edges)
 * without any value for impact analysis. Skipping them improves avg edge confidence dramatically.
 */
const BUILTIN_SKIP_NAMES = new Set<string>([
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
  // Math (commonly called as Math.floor etc but sometimes bare)
  "floor", "ceil", "round", "abs", "max", "min", "sqrt", "pow", "random", "sign", "trunc",
  // Number
  "toFixed", "toPrecision", "toExponential", "isNaN", "isFinite", "isInteger", "parseInt", "parseFloat",
  // Primitive constructor calls used as runtime conversions
  "String", "Number", "Boolean",
  // DB driver externals (better-sqlite3 / pg) — external library, not user symbols
  "prepare", "exec", "transaction", "pragma", "checkpoint", "backup",
  // better-sqlite3 statement
  "bind", "pluck", "expand", "raw", "iterate", "columns",
  // Node fs/path noise
  "existsSync", "readFileSync", "writeFileSync", "mkdirSync", "readdirSync",
  "statSync", "unlinkSync", "renameSync", "copyFileSync",
  // tree-sitter APIs (external runtime objects, never user-defined symbols)
  "childForFieldName", "descendantsOfType",
  // transactional callback aliases (commonly external DB handles)
  "tx",
]);

/**
 * Node.js built-in module names (without the node: prefix) for classifying
 * IMPORTS edges as reason="node_builtin" with elevated confidence=0.8.
 * These will be excluded from unresolvedRatio in reliability summaries.
 */
const NODE_BUILTINS = new Set<string>([
  "assert", "async_hooks", "buffer", "child_process", "cluster", "console",
  "constants", "crypto", "dgram", "diagnostics_channel", "dns", "domain",
  "events", "fs", "http", "http2", "https", "inspector", "module",
  "net", "os", "path", "perf_hooks", "process", "punycode", "querystring",
  "readline", "repl", "stream", "string_decoder", "sys", "timers",
  "tls", "trace_events", "tty", "url", "util", "v8", "vm", "wasi",
  "worker_threads", "zlib",
]);

// Static runtime namespaces where member calls are never project-local symbols.
const JS_STATIC_RECEIVER_NAMES = new Set<string>([
  "Array", "Date", "JSON", "Math", "Number", "Object", "Promise", "Reflect", "RegExp", "String", "Symbol"
]);

const JS_EXTERNAL_LIKE_RECEIVER_NAMES = new Set<string>([
  "db", "stmt", "statement", "tx", "txn", "trx", "query", "client", "pool", "cache", "map", "headers",
  "req", "res", "fs", "path", "process", "env"
]);

const JS_EXTERNAL_LIKE_METHOD_NAMES = new Set<string>(["get", "set", "run", "all"]);

const JS_DB_FLUENT_METHOD_NAMES = new Set<string>(["get", "set", "run", "all", "iterate", "pluck", "raw", "columns"]);

// Receiver expression kinds with very low probability to map to user-defined symbols.
const JS_NOISE_RECEIVER_TYPES = new Set<string>([
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

function shouldSkipJavaScriptMemberCall(functionNode: Parser.SyntaxNode, callee: string): boolean {
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

  // Conservative DB/runtime heuristic: skip only highly-generic methods on known external-like receivers.
  if (receiver.type === "identifier" && JS_EXTERNAL_LIKE_METHOD_NAMES.has(callee)) {
    const receiverName = receiver.text.trim().toLowerCase();
    if (JS_EXTERNAL_LIKE_RECEIVER_NAMES.has(receiverName)) {
      return true;
    }
  }

  // DB fluent chains are external API calls (e.g. db.prepare(...).get()/run()/all()).
  // Keep this narrowly scoped to generic DB method names on call/member receivers.
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

function dedupeEdges(edges: EdgeRecord[]): EdgeRecord[] {
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

function resolveIntraFileEdges(edges: EdgeRecord[], symbols: SymbolRecord[]): EdgeRecord[] {
  if (edges.length === 0 || symbols.length === 0) {
    return edges;
  }

  const callTargetByName = new Map<string, SymbolRecord>();
  const typeTargetByName = new Map<string, SymbolRecord>();
  const interfaceByName = new Map<string, SymbolRecord>();

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

    return edge;
  });
}

function applyCallEdgeCap(edges: EdgeRecord[], maxCallEdgesPerFile: number): EdgeRecord[] {
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

function applyEdgeConfidenceFilter(edges: EdgeRecord[], minEdgeConfidence: number): EdgeRecord[] {
  if (minEdgeConfidence <= 0) {
    return edges;
  }

  return edges.filter((edge) => {
    const confidence = getEffectiveEdgeConfidence(edge);
    return confidence >= minEdgeConfidence;
  });
}

function getEffectiveEdgeConfidence(edge: EdgeRecord): number {
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

  if (edge.type === "CALLS") {
    return 1.0;
  }
  if (edge.type === "IMPORTS") {
    return 0.95;
  }
  if (edge.type === "TYPE_REF") {
    return 0.9;
  }

  return 1.0;
}

function optionalNumberFromEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) {
    return undefined;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return undefined;
  }
  return Math.floor(parsed);
}

function optionalRatioFromEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) {
    return undefined;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    return undefined;
  }
  return Math.min(1, Math.max(0, parsed));
}

function resolveEdgePolicy(profile: "standard" | "large" | "very-large"): {
  maxCallEdgesPerFile: number;
  minEdgeConfidence: number;
} {
  const defaults = defaultEdgePolicy(profile);
  return {
    maxCallEdgesPerFile: OVERRIDE_MAX_CALL_EDGES_PER_FILE ?? defaults.maxCallEdgesPerFile,
    minEdgeConfidence: OVERRIDE_MIN_EDGE_CONFIDENCE ?? defaults.minEdgeConfidence
  };
}

function defaultEdgePolicy(profile: "standard" | "large" | "very-large"): {
  maxCallEdgesPerFile: number;
  minEdgeConfidence: number;
} {
  if (profile === "large") {
    return { maxCallEdgesPerFile: 2500, minEdgeConfidence: 0.4 };
  }
  if (profile === "very-large") {
    return { maxCallEdgesPerFile: 1200, minEdgeConfidence: 0.5 };
  }
  return { maxCallEdgesPerFile: 0, minEdgeConfidence: 0 };
}

function dedupeSymbols(symbols: SymbolRecord[]): SymbolRecord[] {
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

/**
 * Walk up AST to find the nearest enclosing function/method node.
 * Returns the stable symbolId if found, otherwise null.
 */
function findEnclosingSymbolId(node: Parser.SyntaxNode, input: ExtractInput): string | null {
  const FUNCTION_TYPES = new Set([
    "function_declaration",
    "function_expression",
    "arrow_function",
    "method_definition"
  ]);
  let current: Parser.SyntaxNode | null = node.parent;
  while (current) {
    if (FUNCTION_TYPES.has(current.type)) {
      const nameNode =
        current.childForFieldName("name") ??
        current.parent?.childForFieldName("name") ?? // arrow assigned to variable
        null;
      if (nameNode) {
        const kind = current.type === "method_definition" ? "method" : "function";
        return stableId(`${input.repoId}:${input.filePath}:${kind}:${nameNode.text}:${current.startPosition.row}`);
      }
    }
    current = current.parent;
  }
  return null;
}

// JavaScript/TypeScript extractor

/**
 * Extract a compact signature string from a declaration node.
 * Returns text up to the opening brace (or full first line for short nodes).
 */
function extractSignature(node: Parser.SyntaxNode, maxLen = 300): string {
  const text = node.text;
  const braceIdx = text.indexOf("{");
  const raw = braceIdx > 0 ? text.slice(0, braceIdx).trim() : text.split("\n")[0].trim();
  return raw.replace(/\s+/g, " ").slice(0, maxLen);
}

function extractJavaScriptSymbols(
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
        // e.g. this.store.run() → property = "run"
        const prop = functionNode.childForFieldName("property");
        if (prop?.type === "property_identifier") {
          callee = prop.text.trim();
          shouldSkip = shouldSkipJavaScriptMemberCall(functionNode, callee);
        }
      }
      if (callee && !shouldSkip && !BUILTIN_SKIP_NAMES.has(callee)) {
        const fromId = findEnclosingSymbolId(node, input) ?? moduleSymbolId;
        edges.push({
          repoId: input.repoId,
          fromId,
          toId: `callee:${callee}`,
          type: "CALLS"
        });
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
    else if (node.type === "type_alias_declaration") kind = "type";
    else if (node.type === "enum_declaration") kind = "type";
    else if (node.type === "method_definition") kind = "method";

    symbols.push({
      repoId: input.repoId,
      symbolId: stableId(`${input.repoId}:${input.filePath}:${kind}:${nameNode.text}:${node.startPosition.row}`),
      filePath: input.filePath,
      name: nameNode.text,
      kind,
      line: node.startPosition.row + 1,
      signature: extractSignature(node)
    });
  }

  // Exported arrow functions / functions and exported constants
  for (const node of root.descendantsOfType(["lexical_declaration"])) {
    const parent = node.parent;
    const isExported = parent?.type === "export_statement";
    // Only process exported declarations or top-level (for arrow fns)
    if (!isExported && parent?.type !== "program") continue;

    for (const declarator of node.descendantsOfType(["variable_declarator"])) {
      const nameNode = declarator.childForFieldName("name");
      const valueNode = declarator.childForFieldName("value");
      if (!nameNode || nameNode.type !== "identifier") continue;
      if (!valueNode) continue;

      const isFunction = valueNode.type === "arrow_function" || valueNode.type === "function";

      if (isFunction) {
        // arrow function / function expression
        const sig = extractSignature(declarator).replace(/^(const|let|var)\s+/, "");
        symbols.push({
          repoId: input.repoId,
          symbolId: stableId(`${input.repoId}:${input.filePath}:function:${nameNode.text}:${node.startPosition.row}`),
          filePath: input.filePath,
          name: nameNode.text,
          kind: "function",
          line: node.startPosition.row + 1,
          signature: sig
        });
      } else if (isExported) {
        // exported constant / variable (non-function)
        const valPreview = valueNode.text.split("\n")[0].slice(0, 80);
        symbols.push({
          repoId: input.repoId,
          symbolId: stableId(`${input.repoId}:${input.filePath}:variable:${nameNode.text}:${node.startPosition.row}`),
          filePath: input.filePath,
          name: nameNode.text,
          kind: "variable",
          line: node.startPosition.row + 1,
          signature: `const ${nameNode.text} = ${valPreview}`
        });
      }
    }
  }
}

function findSymbolIdByName(symbols: SymbolRecord[], name: string): string | null {
  const hit = symbols.find((s) => s.name === name && (s.kind === "function" || s.kind === "method"));
  return hit?.symbolId ?? null;
}

function extractJavaScriptRoutes(input: ExtractInput, symbols: SymbolRecord[], moduleSymbolId: string): RouteRecord[] {
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

function extractPythonSymbolsAndRoutes(
  input: ExtractInput,
  symbols: SymbolRecord[],
  edges: EdgeRecord[],
  routes: RouteRecord[],
  moduleSymbolId: string
): void {
  const importRegex = /^\s*(?:from\s+([A-Za-z0-9_\.]+)\s+import\s+.+|import\s+([A-Za-z0-9_\.]+))/gm;
  let importMatch: RegExpExecArray | null;
  while ((importMatch = importRegex.exec(input.source)) !== null) {
    const dep = importMatch[1] ?? importMatch[2] ?? "";
    if (dep) {
      edges.push({
        repoId: input.repoId,
        fromId: moduleSymbolId,
        toId: `import:${dep}`,
        type: "IMPORTS"
      });
    }
  }

  const functionByName = new Map<string, string>();
  const classRegex = /^\s*class\s+([A-Za-z_][A-Za-z0-9_]*)\b/gm;
  let classMatch: RegExpExecArray | null;
  while ((classMatch = classRegex.exec(input.source)) !== null) {
    const name = classMatch[1];
    const line = lineFromOffset(input.source, classMatch.index);
    const symbolId = stableId(`${input.repoId}:${input.filePath}:class:${name}:${line - 1}`);
    symbols.push({
      repoId: input.repoId,
      symbolId,
      filePath: input.filePath,
      name,
      kind: "class",
      line,
      signature: `class ${name}`
    });
  }

  const functionRegex = /^\s*(?:async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/gm;
  let functionMatch: RegExpExecArray | null;
  while ((functionMatch = functionRegex.exec(input.source)) !== null) {
    const name = functionMatch[1];
    const line = lineFromOffset(input.source, functionMatch.index);
    const symbolId = stableId(`${input.repoId}:${input.filePath}:function:${name}:${line - 1}`);
    symbols.push({
      repoId: input.repoId,
      symbolId,
      filePath: input.filePath,
      name,
      kind: "function",
      line,
      signature: `${functionMatch[0].trim()}`
    });
    functionByName.set(name, symbolId);
  }

  const routeRegex = /@(router|app)\.(get|post|put|delete|patch)\(([^\)]*)\)\s*[\r\n]+\s*(?:async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/gi;
  let routeMatch: RegExpExecArray | null;
  while ((routeMatch = routeRegex.exec(input.source)) !== null) {
    const method = (routeMatch[2] ?? "").toUpperCase() as RouteRecord["httpMethod"];
    const argText = routeMatch[3] ?? "";
    const handlerName = routeMatch[4] ?? "";
    const line = lineFromOffset(input.source, routeMatch.index);
    const template = extractFirstStringLiteral(argText) ?? "/";
    const handlerSymbolId = functionByName.get(handlerName) ?? moduleSymbolId;

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
}

function lineFromOffset(source: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < source.length; i++) {
    if (source.charCodeAt(i) === 10) {
      line += 1;
    }
  }
  return line;
}

// C# extractor
/**
 * Walk up AST to find the nearest enclosing method/constructor node for C#.
 * Returns the stable symbolId if found, otherwise null.
 */
const CSHARP_ENCLOSING_TYPES = new Set([
  "method_declaration",
  "constructor_declaration",
  "operator_declaration",
  "accessor_declaration"
]);

function findEnclosingCSharpSymbolId(node: Parser.SyntaxNode, input: ExtractInput): string | null {
  let current: Parser.SyntaxNode | null = node.parent;
  while (current) {
    if (CSHARP_ENCLOSING_TYPES.has(current.type)) {
      const nameNode = current.childForFieldName("name");
      if (nameNode) {
        const kind = current.type === "constructor_declaration" ? "constructor" : "method";
        return stableId(`${input.repoId}:${input.filePath}:${kind}:${nameNode.text}:${current.startPosition.row}`);
      }
    }
    current = current.parent;
  }
  return null;
}

function normalizeCSharpTypeName(raw: string): string {
  const withoutNullable = raw.replace(/\?/g, "").trim();
  const withoutArrays = withoutNullable.replace(/\[\]/g, "");
  const withoutGenericArgs = withoutArrays.replace(/<.*>/g, "");
  const simplified = withoutGenericArgs.split(".").pop() ?? withoutGenericArgs;
  return simplified.trim();
}

function emitTypeRefEdge(
  input: ExtractInput,
  edges: EdgeRecord[],
  fromId: string,
  rawTypeName: string
): void {
  const normalized = normalizeCSharpTypeName(rawTypeName);
  if (!normalized || normalized.length < 2) {
    return;
  }

  edges.push({
    repoId: input.repoId,
    fromId,
    toId: `type:${normalized}`,
    type: "TYPE_REF"
  });
}

function collectCSharpLocalTypeMap(scopeNode: Parser.SyntaxNode): Map<string, string> {
  const localTypes = new Map<string, string>();

  for (const node of scopeNode.descendantsOfType(["local_declaration_statement"])) {
    const varDecl = node.children.find((c) => c.type === "variable_declaration");
    if (!varDecl) continue;

    const typeNode = varDecl.childForFieldName("type");
    if (!typeNode?.text || typeNode.text === "var") continue;

    for (const declarator of varDecl.descendantsOfType(["variable_declarator"])) {
      const nameNode = declarator.childForFieldName("name");
      if (nameNode?.text) {
        localTypes.set(nameNode.text, typeNode.text);
      }
    }
  }

  return localTypes;
}

function extractCSharpSymbols(
  input: ExtractInput,
  root: Parser.SyntaxNode,
  symbols: SymbolRecord[],
  edges: EdgeRecord[],
  moduleSymbolId: string
): void {
  // Extract using directives (imports)
  for (const node of root.descendantsOfType(["using_directive"])) {
    const nameNode = node.childForFieldName("name");
    if (nameNode) {
      edges.push({
        repoId: input.repoId,
        fromId: moduleSymbolId,
        toId: `import:${nameNode.text}`,
        type: "IMPORTS"
      });
    }
  }

  // Extract invocation expressions (method calls)
  for (const node of root.descendantsOfType(["invocation_expression"])) {
    const functionNode = node.childForFieldName("function");
    if (functionNode) {
      let calleeName = "";
      let receiverName = "";
      if (functionNode.type === "identifier") {
        calleeName = functionNode.text;
      } else if (functionNode.type === "member_access_expression") {
        const nameNode = functionNode.childForFieldName("name");
        const expressionNode = functionNode.childForFieldName("expression");
        if (nameNode) {
          calleeName = nameNode.text;
        }
        if (expressionNode && expressionNode.type === "identifier") {
          receiverName = expressionNode.text;
        }
      }

      if (calleeName) {
        const fromId = findEnclosingCSharpSymbolId(node, input) ?? moduleSymbolId;
        edges.push({
          repoId: input.repoId,
          fromId,
          toId: `callee:${calleeName}`,
          type: "CALLS"
        });

        // Preserve static/member receiver context for better post-resolution:
        // e.g. Animal.Classify() => callee:Animal.Classify
        if (receiverName && /^[A-Z]/.test(receiverName)) {
          edges.push({
            repoId: input.repoId,
            fromId,
            toId: `callee:${receiverName}.${calleeName}`,
            type: "CALLS"
          });
        }
      }
    }
  }

  // Extract field declarations for TYPE_REF edges.
  // Catches patterns like: private readonly DbSet<Conversation> _conversations;
  for (const node of root.descendantsOfType(["field_declaration"])) {
    const fromId = findEnclosingCSharpSymbolId(node, input) ?? moduleSymbolId;
    const varDecl = node.children.find((c) => c.type === "variable_declaration");
    if (varDecl) {
      const typeNode = varDecl.childForFieldName("type");
      if (typeNode?.text) {
        emitTypeRefEdge(input, edges, fromId, typeNode.text);
      }
    }
  }

  // Extract local variable declarations for TYPE_REF edges.
  // Catches patterns like: Conversation conv = ...; IList<Message> messages = ...;
  for (const node of root.descendantsOfType(["local_declaration_statement"])) {
    const fromId = findEnclosingCSharpSymbolId(node, input) ?? moduleSymbolId;
    const varDecl = node.children.find((c) => c.type === "variable_declaration");
    if (varDecl) {
      const typeNode = varDecl.childForFieldName("type");
      if (typeNode?.text && typeNode.text !== "var") {
        emitTypeRefEdge(input, edges, fromId, typeNode.text);
      }
    }
  }

  // Conservative member-access type propagation.
  // Emits TYPE_REF when receiver variable has an explicit local type annotation.
  for (const scopeNode of root.descendantsOfType(["method_declaration", "constructor_declaration", "accessor_declaration"])) {
    const fromId = findEnclosingCSharpSymbolId(scopeNode, input) ?? moduleSymbolId;
    const localTypes = collectCSharpLocalTypeMap(scopeNode);
    if (localTypes.size === 0) {
      continue;
    }

    for (const accessNode of scopeNode.descendantsOfType(["member_access_expression"])) {
      const receiverNode = accessNode.childForFieldName("expression");
      if (!receiverNode || receiverNode.type !== "identifier") {
        continue;
      }

      const receiverType = localTypes.get(receiverNode.text);
      if (receiverType) {
        emitTypeRefEdge(input, edges, fromId, receiverType);
      }
    }
  }

  // Extract typeof(...) references commonly used in DI registration.
  for (const node of root.descendantsOfType(["typeof_expression"])) {
    const fromId = findEnclosingCSharpSymbolId(node, input) ?? moduleSymbolId;
    const typeNode = node.childForFieldName("type");
    if (typeNode?.text) {
      emitTypeRefEdge(input, edges, fromId, typeNode.text);
      continue;
    }

    const match = node.text.match(/typeof\s*\(([^)]+)\)/);
    if (match?.[1]) {
      emitTypeRefEdge(input, edges, fromId, match[1]);
    }
  }

  // Extract object creation expressions (constructor calls)
  for (const node of root.descendantsOfType(["object_creation_expression"])) {
    const typeNode = node.childForFieldName("type");
    if (typeNode) {
      const typeName = typeNode.text;
      if (typeName) {
        const fromId = findEnclosingCSharpSymbolId(node, input) ?? moduleSymbolId;
        emitTypeRefEdge(input, edges, fromId, typeName);
        edges.push({
          repoId: input.repoId,
          fromId,
          toId: `callee:${typeName}`,
          type: "CALLS"
        });
      }
    }
  }

  // Extract class, interface, method, property, struct, namespace declarations
  for (const node of root.descendantsOfType([
    "class_declaration",
    "interface_declaration",
    "method_declaration",
    "property_declaration",
    "constructor_declaration",
    "struct_declaration",
    "enum_declaration",
    "namespace_declaration",
    "record_declaration"
  ])) {
    const nameNode = node.childForFieldName("name");
    if (nameNode) {
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

      symbols.push({
        repoId: input.repoId,
        symbolId,
        filePath: input.filePath,
        name: nameNode.text,
        kind,
        line: node.startPosition.row + 1,
        signature: extractSignature(node)
      });

      const declarationTypeNode = node.childForFieldName("type");
      if (declarationTypeNode?.text) {
        emitTypeRefEdge(input, edges, symbolId, declarationTypeNode.text);
      }

      for (const parameterNode of node.descendantsOfType(["parameter"])) {
        const parameterTypeNode = parameterNode.childForFieldName("type");
        if (parameterTypeNode?.text) {
          emitTypeRefEdge(input, edges, symbolId, parameterTypeNode.text);
        }
      }

      // Emit IMPLEMENTS edges for class/struct/record base_list entries
      if (node.type === "class_declaration" || node.type === "struct_declaration" || node.type === "record_declaration") {
        // tree-sitter C# grammar: base_list is a child node, not a named field
        const baseList = node.children.find((c) => c.type === "base_list");
        if (baseList) {
          for (const baseNode of baseList.children) {
            const baseName = baseNode.text.trim();
            // Skip punctuation and whitespace nodes
            if (!baseName || baseName === "," || baseName === ":" || baseName.length < 2) continue;
            // Strip generic type args: IRepository<User> → IRepository
            const cleanName = baseName.replace(/<.*>$/, "").trim();
            if (cleanName) {
              emitTypeRefEdge(input, edges, symbolId, cleanName);
              edges.push({
                repoId: input.repoId,
                fromId: symbolId,
                toId: `iface:${cleanName}`,
                type: "IMPLEMENTS"
              });
            }
          }
        }
      }
    }
  }
}

function extractCSharpRoutes(input: ExtractInput, root: Parser.SyntaxNode, symbols: SymbolRecord[]): RouteRecord[] {
  const routes: RouteRecord[] = [];
  const classNodes = root.descendantsOfType(["class_declaration"]);

  for (const classNode of classNodes) {
    const className = classNode.childForFieldName("name")?.text ?? "";
    if (!className) {
      continue;
    }

    const classSymbolId = findSymbolIdByNode(symbols, "class", className, classNode.startPosition.row + 1);
    if (!classSymbolId) {
      continue;
    }

    const classAttributes = collectAttachedAttributeTexts(classNode);
    const classRoutePrefix = resolveRoutePrefix(classAttributes, className);

    for (const methodNode of classNode.descendantsOfType(["method_declaration"])) {
      const methodName = methodNode.childForFieldName("name")?.text ?? "";
      if (!methodName) {
        continue;
      }

      const handlerSymbolId = findSymbolIdByNode(symbols, "method", methodName, methodNode.startPosition.row + 1);
      if (!handlerSymbolId) {
        continue;
      }

      const methodAttributes = collectAttachedAttributeTexts(methodNode);
      const httpAttrs = resolveHttpAttributes(methodAttributes);
      if (httpAttrs.length === 0) {
        continue;
      }

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

  // Minimal API pattern: groupBuilder.MapGet("/path", HandlerMethod) or app.MapGet(...)
  // Handles IEndpointGroup.Map() body and Program.cs-style registration.
  extractMinimalApiRoutes(input, root, symbols, routes);

  return dedupeRoutes(routes);
}

/**
 * Extract ASP.NET Minimal API routes from patterns like:
 *   groupBuilder.MapGet("/conversations", ListConversations)
 *   app.MapPost("/endpoint", Handler)
 *   endpoints.MapPut("{id}", UpdateMethod)
 */
function extractMinimalApiRoutes(
  input: ExtractInput,
  root: Parser.SyntaxNode,
  symbols: SymbolRecord[],
  routes: RouteRecord[]
): void {
  const HTTP_METHOD_MAP: Record<string, RouteRecord["httpMethod"]> = {
    mapget: "GET",
    mappost: "POST",
    mapput: "PUT",
    mapdelete: "DELETE",
    mappatch: "PATCH"
  };

  // Walk all invocation_expression nodes and find receiver.MapXxx(route, handler) calls
  for (const invokeNode of root.descendantsOfType(["invocation_expression"])) {
    const funcNode = invokeNode.childForFieldName("function");
    if (!funcNode || funcNode.type !== "member_access_expression") {
      continue;
    }

    const receiverNode = funcNode.childForFieldName("expression");
    if (!isLikelyMinimalApiReceiver(receiverNode)) {
      continue;
    }

    const methodNameNode = funcNode.childForFieldName("name");
    const methodName = methodNameNode?.text?.toLowerCase() ?? "";
    const httpMethod = HTTP_METHOD_MAP[methodName];
    if (!httpMethod) {
      continue;
    }

    const argsNode = invokeNode.childForFieldName("arguments");
    if (!argsNode) {
      continue;
    }

    // Collect argument nodes (skip commas/punctuation)
    const argNodes = argsNode.children.filter(
      (c) => c.type === "argument" || c.type === "string_literal" || c.type === "verbatim_string_literal"
    );

    // First arg should be the route template string
    const firstArg = argNodes[0];
    if (!firstArg) {
      continue;
    }

    // argument node wraps the value
    const templateLiteral = firstArg.type === "argument"
      ? firstArg.children.find((c) => c.type === "string_literal" || c.type === "verbatim_string_literal")?.text ?? ""
      : firstArg.text;
    const routeTemplate = templateLiteral
      .replace(/^@?"/, "")
      .replace(/"$/, "")
      .trim();

    if (!routeTemplate || routeTemplate.length === 0) {
      continue;
    }

    // Second arg: handler reference (identifier or member_access_expression)
    const secondArg = argNodes[1];
    const handlerName = secondArg
      ? (secondArg.type === "argument"
          ? (secondArg.children.find((c) => c.type === "identifier")?.text ?? "")
          : (secondArg.type === "identifier" ? secondArg.text : ""))
      : "";

    const line = invokeNode.startPosition.row + 1;

    // Find enclosing class to use as controller
    let enclosingClassSymbolId: string | null = null;
    let cur: Parser.SyntaxNode | null = invokeNode.parent;
    while (cur) {
      if (cur.type === "class_declaration") {
        const name = cur.childForFieldName("name")?.text ?? "";
        enclosingClassSymbolId = findSymbolIdByNode(symbols, "class", name, cur.startPosition.row + 1);
        break;
      }
      cur = cur.parent;
    }

    // Resolve handler symbolId
    const handlerSymbolId = handlerName
      ? (findSymbolIdByName(symbols, handlerName) ?? enclosingClassSymbolId ?? `module:${input.filePath}`)
      : (enclosingClassSymbolId ?? `module:${input.filePath}`);

    const controllerSymbolId = enclosingClassSymbolId ?? `module:${input.filePath}`;

    // Normalize route template
    const normalized = routeTemplate.startsWith("/") ? routeTemplate : `/${routeTemplate}`;

    routes.push({
      repoId: input.repoId,
      filePath: input.filePath,
      controllerSymbolId,
      handlerSymbolId,
      httpMethod,
      routeTemplate: normalized,
      line
    });
  }
}

function isLikelyMinimalApiReceiver(node: Parser.SyntaxNode | null): boolean {
  if (!node) {
    return false;
  }

  if (node.type === "identifier") {
    return /^(app|endpoints|endpoint|groupbuilder|routegroupbuilder|group|routes)$/i.test(node.text);
  }

  if (node.type === "invocation_expression") {
    const callee = node.childForFieldName("function");
    if (callee?.type === "member_access_expression") {
      const methodName = callee.childForFieldName("name")?.text?.toLowerCase() ?? "";
      if (methodName === "mapgroup") {
        return true;
      }
      const parentExpr = callee.childForFieldName("expression");
      return isLikelyMinimalApiReceiver(parentExpr);
    }
    return false;
  }

  if (node.type === "member_access_expression") {
    const parentExpr = node.childForFieldName("expression");
    return isLikelyMinimalApiReceiver(parentExpr);
  }

  return false;
}

function dedupeRoutes(routes: RouteRecord[]): RouteRecord[] {
  const seen = new Set<string>();
  const output: RouteRecord[] = [];

  for (const route of routes) {
    const key = `${route.repoId}:${route.filePath}:${route.handlerSymbolId}:${route.httpMethod}:${route.routeTemplate}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push(route);
  }

  return output;
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

function resolveHttpAttributes(attributeTexts: string[]): { method: RouteRecord["httpMethod"]; template: string | null }[] {
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
    if (!match) {
      continue;
    }
    const template = extractFirstStringLiteral(match[1] ?? "");
    if (template) {
      return normalizeRouteToken(template, className, "");
    }
  }

  return "";
}

function extractFirstStringLiteral(input: string): string | null {
  const m = input.match(/"([^"]+)"/);
  return m?.[1] ?? null;
}

function normalizeRouteToken(template: string, className: string, methodName: string): string {
  const controllerName = className.replace(/Controller$/i, "");
  return template
    .replace(/\[controller\]/gi, controllerName)
    .replace(/\[action\]/gi, methodName);
}

function combineRouteTemplate(classPrefix: string, methodTemplate: string | null, className: string, methodName: string): string {
  const normalizedClass = normalizeRouteToken(classPrefix || "", className, methodName).replace(/^\/+|\/+$/g, "");
  const normalizedMethod = normalizeRouteToken(methodTemplate ?? "", className, methodName).replace(/^\/+|\/+$/g, "");

  if (methodTemplate && methodTemplate.startsWith("/")) {
    return `/${normalizedMethod}`.replace(/\/+/g, "/");
  }

  if (!normalizedClass && !normalizedMethod) {
    return "/";
  }
  if (!normalizedClass) {
    return `/${normalizedMethod}`.replace(/\/+/g, "/");
  }
  if (!normalizedMethod) {
    return `/${normalizedClass}`.replace(/\/+/g, "/");
  }

  return `/${normalizedClass}/${normalizedMethod}`.replace(/\/+/g, "/");
}

// Markdown extractor — parses headings, code blocks, and mentions
function extractMarkdownFile(input: ExtractInput): ExtractOutput {
  const { docs, mentions } = parseMarkdownFile(input);
  // Markdown files don't have traditional symbols, just docs and mentions
  return { symbols: [], edges: [], docs, mentions };
}
