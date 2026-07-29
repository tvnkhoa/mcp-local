/**
 * JavaScript/TypeScript call-noise suppression.
 *
 * Six deny-lists and one predicate, all serving one goal: keep `Array.map` and `db.get` out of
 * the call graph. Each entry is a judgement about what a reader would count as a real call
 * edge, which is why they are data rather than logic.
 */

import type Parser from "tree-sitter";

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
