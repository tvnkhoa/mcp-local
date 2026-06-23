import Parser from "tree-sitter";
import JavaScript from "tree-sitter-javascript";
import TypeScript from "tree-sitter-typescript";
import CSharp from "tree-sitter-c-sharp";

import type { DocMentionRecord, DocRecord, EdgeRecord, RouteRecord, SymbolRecord } from "./types.js";
import type { ExtractInput, ExtractOutput } from "./extractors/extractorTypes.js";

import { parseMarkdownFile } from "./markdownParser.js";
import { extractPythonSymbolsAndRoutesImpl } from "./extractors/pythonExtractor.js";
import { extractProtoSymbolsImpl } from "./extractors/protoExtractor.js";
import { extractJavaScriptRoutesImpl, extractJavaScriptSymbolsImpl } from "./extractors/jsExtractor.js";
import {
  emitEndpointContractSymbolsFromCSharpSignaturesImpl,
  emitEndpointContractSymbolsImpl,
  extractCSharpRoutesImpl,
  extractCSharpSymbolsImpl
} from "./extractors/csharpExtractor.js";

import {
  stableId,
  dedupeSymbols,
  dedupeEdges,
  dedupeRoutes,
  resolveIntraFileEdges,
  applyCallEdgeCap,
  applyEdgeConfidenceFilter
} from "./extractors/extractorUtils.js";
import { extractStringLiteralsImpl } from "./extractors/literalExtractor.js";

// Re-export types for backward compatibility
export type { ExtractInput, ExtractOutput };

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
// ISSUE-023: string-literal lane policy — min length lọc token ngắn ("GET", "utf8"),
// cap per file chặn locale/generated-string blowup; override qua env.
const OVERRIDE_MIN_STRING_LITERAL_LENGTH = optionalNumberFromEnv("CODEBASE_INDEX_MIN_STRING_LITERAL_LENGTH");
const OVERRIDE_MAX_STRING_LITERALS_PER_FILE = optionalNumberFromEnv("CODEBASE_INDEX_MAX_STRING_LITERALS_PER_FILE");

/** Per-file parse timeout in milliseconds. Files exceeding this are skipped (module symbol only). */
const PARSE_TIMEOUT_MS = optionalNumberFromEnv("CODEBASE_INDEX_PARSE_TIMEOUT_MS") ?? 5_000;

export function extractGraphData(input: ExtractInput): ExtractOutput {
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

  const edges: EdgeRecord[] = [];
  const routes: RouteRecord[] = [];

  if (input.language === "python") {
    extractPythonSymbolsAndRoutesImpl(input, symbols, edges, routes, moduleSymbolId);
    const resolvedEdges = resolveIntraFileEdges(edges, symbols);
    return {
      symbols: dedupeSymbols(symbols),
      edges: applyEdgeConfidenceFilter(applyCallEdgeCap(dedupeEdges(resolvedEdges), edgePolicy.maxCallEdgesPerFile), edgePolicy.minEdgeConfidence),
      routes: dedupeRoutes(routes)
    };
  }

  if (input.language === "proto") {
    extractProtoSymbolsImpl(input, symbols, edges, moduleSymbolId);
    const resolvedEdges = resolveIntraFileEdges(edges, symbols);
    return {
      symbols: dedupeSymbols(symbols),
      edges: applyEdgeConfidenceFilter(applyCallEdgeCap(dedupeEdges(resolvedEdges), edgePolicy.maxCallEdgesPerFile), edgePolicy.minEdgeConfidence)
    };
  }

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

  // Extract based on language
  let literals: ExtractOutput["literals"];
  if (input.language === "javascript" || input.language === "typescript") {
    extractJavaScriptSymbolsImpl(input, root, symbols, edges, moduleSymbolId);
    routes.push(...extractJavaScriptRoutesImpl(input, symbols, moduleSymbolId));
    literals = extractStringLiteralsImpl(input, root, resolveLiteralPolicy(input.performanceProfile ?? "standard"));
  } else if (input.language === "csharp") {
    extractCSharpSymbolsImpl(input, root, symbols, edges, moduleSymbolId, input.knownPackageNames);
    routes.push(...extractCSharpRoutesImpl(input, root, symbols));
    emitEndpointContractSymbolsImpl(input, symbols, routes);
    emitEndpointContractSymbolsFromCSharpSignaturesImpl(input, symbols);
    literals = extractStringLiteralsImpl(input, root, resolveLiteralPolicy(input.performanceProfile ?? "standard"));
  }

  const resolvedEdges = resolveIntraFileEdges(edges, symbols);

  return {
    symbols: dedupeSymbols(symbols),
    edges: applyEdgeConfidenceFilter(applyCallEdgeCap(dedupeEdges(resolvedEdges), edgePolicy.maxCallEdgesPerFile), edgePolicy.minEdgeConfidence),
    routes,
    literals
  };
}

/** ISSUE-023: literal-lane policy per performance profile (mirror defaultEdgePolicy). */
function resolveLiteralPolicy(profile: "standard" | "large" | "very-large"): { minLength: number; maxPerFile: number } {
  const maxPerFile = profile === "very-large" ? 50 : profile === "large" ? 100 : 200;
  return {
    minLength: OVERRIDE_MIN_STRING_LITERAL_LENGTH ?? 6,
    maxPerFile: OVERRIDE_MAX_STRING_LITERALS_PER_FILE ?? maxPerFile
  };
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

/**
 * Parse C# source on demand (outside the index pipeline) with the same four protections the
 * pipeline applies inline: the large-file guard (`> TREE_SITTER_MAX_BUFFER`), an adaptive
 * `bufferSize` (the fix for the 32 KB native-buffer "Invalid argument" crash, MCP-ISSUE-030),
 * a parse timeout, and a null-tree (timeout) check. Reuses the shared cached C# parser.
 *
 * Returns `null` when the file is unparseable for any of those reasons (too large, or the parse
 * timed out) so callers can skip that one file instead of aborting — or hanging — the whole tool
 * call. Every on-demand parse site MUST route through this helper rather than calling
 * `parser.parse(...)` directly, so a future lane can't silently regress on any of the four.
 */
export function parseCSharpOnDemand(content: string, filePath: string): Parser.Tree | null {
  const sourceBytes = Buffer.byteLength(content, "utf8");
  if (sourceBytes > TREE_SITTER_MAX_BUFFER) {
    return null;
  }
  const parser = getOrCreateParserForLanguage("csharp");
  if (!parser) {
    return null;
  }
  parser.setTimeoutMicros(PARSE_TIMEOUT_MS * 1000);
  let tree: Parser.Tree | null;
  try {
    tree = parser.parse(content, undefined, { bufferSize: getTreeSitterBufferSize(sourceBytes) });
  } finally {
    parser.setTimeoutMicros(0);
  }
  if (!tree) {
    // Parser timed out — reset so the shared cached parser is clean for the next file, then
    // signal "skip" rather than propagate (read/preview tools degrade per-file, never abort).
    parser.reset();
    return null;
  }
  return tree;
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

function extractMarkdownFile(input: ExtractInput): ExtractOutput {
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

  const parsed = parseMarkdownFile({ repoId: input.repoId, filePath: input.filePath, source: input.source });
  return {
    symbols,
    edges: [],
    docs: parsed.docs.map((doc) => ({
      ...doc,
      repoId: input.repoId,
      filePath: input.filePath
    })),
    mentions: parsed.mentions.map((mention) => ({
      ...mention,
      repoId: input.repoId,
      filePath: input.filePath
    }))
  };
}
