import type Parser from "tree-sitter";
import type { DocMentionRecord, DocRecord, EdgeRecord, RouteRecord, StringLiteralRecord, SymbolRecord } from "../types.js";

// ============================================================================
// Extract Input/Output Types
// ============================================================================

export type ExtractInput = {
  repoId: string;
  filePath: string;
  language: string;
  source: string;
  performanceProfile?: "standard" | "large" | "very-large";
  /** Package names from <PackageReference> in .csproj files — used to widen namespace→nuget contract mapping. */
  knownPackageNames?: Set<string>;
};

export type ExtractOutput = {
  symbols: SymbolRecord[];
  edges: EdgeRecord[];
  routes?: RouteRecord[];
  docs?: DocRecord[];
  mentions?: DocMentionRecord[];
  /** ISSUE-023: string-literal lane (C# + JS/TS). Worker pool serialize nguyên ExtractOutput nên field này đi qua không cần sửa worker. */
  literals?: StringLiteralRecord[];
};

// ============================================================================
// Helper Context Types
// ============================================================================

export type CSharpHelpers = {
  stableId: (input: string) => string;
  extractSignature: (node: Parser.SyntaxNode, maxLen?: number) => string;
  findEnclosingCSharpSymbolId: (node: Parser.SyntaxNode, input: ExtractInput) => string | null;
  extractCSharpUsingNamespace: (node: Parser.SyntaxNode) => string | null;
  mapUsingNamespaceToNugetContract: (namespaceImport: string) => string | null;
  extractCSharpHttpDependencyContract: (invocationNode: Parser.SyntaxNode) => {
    httpMethod: string;
    endpoint: string;
  } | null;
  toEndpointContractId: (httpMethod: RouteRecord["httpMethod"], routeTemplate: string) => string;
  emitTypeRefEdge: (
    input: ExtractInput,
    fromSymbolId: string,
    rawTypeName: string,
    edges: EdgeRecord[]
  ) => void;
  emitPropertyAccessEdge: (
    input: ExtractInput,
    fromSymbolId: string,
    propertyToken: string,
    isWrite: boolean,
    edges: EdgeRecord[]
  ) => void;
  collectCSharpScopeTypeMap: (scopeNode: Parser.SyntaxNode) => Map<string, string>;
  findEnclosingCSharpTypeName: (node: Parser.SyntaxNode) => string | undefined;
  isLikelyCSharpInterfaceName: (rawTypeName: string) => boolean;
  /** Package names collected from <PackageReference> in .csproj files in the same repo.
   *  Used to widen namespace→nuget contract mapping beyond the hardcoded set. */
  knownPackageNames?: Set<string>;
};

export type RouteHelpers = {
  dedupeRoutes: (routes: RouteRecord[]) => RouteRecord[];
  stableId: (input: string) => string;
  normalizeEndpointPath: (raw: string) => string;
  toEndpointContractId: (httpMethod: RouteRecord["httpMethod"], routeTemplate: string) => string;
  extractFirstStringLiteral: (input: string) => string | null;
  combineRouteTemplate: (classPrefix: string, methodTemplate: string | null, className: string, methodName: string) => string;
};

// ============================================================================
// Edge Policy Types
// ============================================================================

export type EdgePolicy = {
  maxCallEdgesPerFile: number;
  minEdgeConfidence: number;
};
