/**
 * Edge post-processing and emission: dedupe, intra-file resolution, caps, confidence, and the
 * two emitters (TYPE_REF and property access).
 *
 * The cap and the confidence filter are the only thing standing between one pathological file
 * and millions of edges, so they run over every extractor's output rather than just C#'s.
 */

import type Parser from "tree-sitter";
import type { EdgeRecord, SymbolRecord } from "../types.js";
import type { ExtractInput } from "./extractorTypes.js";
import { normalizeCSharpTypeName } from "./extractorCSharpScope.js";

export function dedupeEdges(edges: EdgeRecord[]): EdgeRecord[] {
  const seen = new Set<string>();
  const output: EdgeRecord[] = [];

  for (const edge of edges) {
    // Distinct write-sites with distinct RHS values (ENH-029-B) must survive dedup so the
    // value-domain (e.g. "ai" vs "human") is preserved. assignedExpression is undefined for
    // every non-write edge, so this is a no-op for all existing edge types.
    const key = `${edge.repoId}:${edge.fromId}:${edge.toId}:${edge.type}:${edge.assignedExpression ?? ""}`;
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
    if ((symbol.kind === "function" || symbol.kind === "method" || symbol.kind === "constructor" || symbol.kind === "class" || symbol.kind === "record" || symbol.kind === "record struct") && !callTargetByName.has(symbol.name)) {
      callTargetByName.set(symbol.name, symbol);
    }
    if ((symbol.kind === "class" || symbol.kind === "interface" || symbol.kind === "struct" || symbol.kind === "type" || symbol.kind === "record" || symbol.kind === "record struct") && !typeTargetByName.has(symbol.name)) {
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

// ============================================================================
// C# Property Edge Utilities
// ============================================================================

/**
 * P1.4: Property/member names that are BCL/framework statics, LINQ methods, or
 * enum-like constants that will never resolve to a user-defined property symbol.
 * Skipping these reduces noise in unresolvedRatio without losing real impact data.
 */
export const TRIVIAL_PROPERTY_TOKENS = new Set<string>([
  // System.String statics
  "Empty", "IsNullOrEmpty", "IsNullOrWhiteSpace", "Format", "Concat", "Join",
  // System.DateTime / DateTimeOffset
  "UtcNow", "Now", "Today", "MinValue", "MaxValue", "Zero",
  // System.Guid
  "NewGuid", "Parse", "TryParse",
  // System.Array / Enumerable
  "Length", "Rank",
  // LINQ extension methods (emitted as member_access but are method calls)
  "Select", "Where", "OrderBy", "OrderByDescending", "ThenBy", "ThenByDescending",
  "GroupBy", "GroupJoin", "Join", "SelectMany", "Distinct", "DistinctBy",
  "ToList", "ToArray", "ToHashSet", "ToDictionary", "ToLookup",
  "ToListAsync", "ToArrayAsync", "ToDictionaryAsync", "ToHashSetAsync",
  "FirstOrDefault", "LastOrDefault", "SingleOrDefault", "First", "Last", "Single",
  "FirstOrDefaultAsync", "LastOrDefaultAsync", "SingleOrDefaultAsync",
  "FirstAsync", "LastAsync", "SingleAsync",
  "Any", "All", "Count", "LongCount", "CountAsync", "AnyAsync", "AllAsync",
  "Sum", "Min", "Max", "Average", "SumAsync", "MinAsync", "MaxAsync", "AverageAsync",
  "Contains", "ContainsAsync", "Except", "Intersect", "Union",
  "Skip", "Take", "SkipWhile", "TakeWhile", "SkipLast", "TakeLast",
  "Aggregate", "Zip", "Append", "Prepend", "Reverse", "DefaultIfEmpty",
  "AsEnumerable", "AsQueryable", "Cast", "OfType", "Flatten",
  // EF Core async
  "FindAsync", "AddAsync", "AddRangeAsync", "SaveChangesAsync", "SaveChanges",
  "ExecuteDeleteAsync", "ExecuteUpdateAsync", "ExecuteNonQueryAsync",
  "FromSqlRaw", "FromSqlInterpolated", "Include", "ThenInclude",
  "AsNoTracking", "AsTracking", "AsSplitQuery", "AsSingleQuery",
  // ASP.NET StatusCodes static properties
  "Status200OK", "Status201Created", "Status204NoContent",
  "Status400BadRequest", "Status401Unauthorized", "Status403Forbidden",
  "Status404NotFound", "Status409Conflict", "Status422UnprocessableEntity",
  "Status500InternalServerError", "Status503ServiceUnavailable",
  // gRPC / Protobuf status codes
  "NOT_FOUND", "OK", "CANCELLED", "UNKNOWN", "INVALID_ARGUMENT",
  "ALREADY_EXISTS", "PERMISSION_DENIED", "UNAUTHENTICATED", "UNAVAILABLE",
  // StringComparison / CultureInfo
  "Ordinal", "OrdinalIgnoreCase", "InvariantCulture", "InvariantCultureIgnoreCase",
  "CurrentCulture", "CurrentCultureIgnoreCase",
  // Nullable / Optional
  "HasValue", "GetValueOrDefault",
  // Task / async
  "Result", "IsCompleted", "IsFaulted", "IsCanceled", "CompletedTask",
  "FromResult", "FromException", "FromCanceled", "WhenAll", "WhenAny", "Delay", "Run",
  // IEnumerable / ICollection
  "IsReadOnly", "IsFixedSize", "IsSynchronized", "SyncRoot",
  // Reflection
  "Assembly", "FullName", "Namespace", "DeclaringType", "BaseType",
  "GetType", "GetMethod", "GetProperty", "GetField", "GetMethods",
  // Exception
  "Message", "StackTrace", "InnerException", "HResult", "Source", "Data",
  // ConfigurationProvider / IConfiguration
  "ConfigurationProvider",
  // Validation
  "IsValid", "Errors", "ErrorMessage",
  // ConfigurationProvider / IConfiguration
  "ConfigurationProvider",
  // Generic CRUD / lifecycle method names too common to be meaningful as property refs
  "Create", "CreateAsync", "Cancel", "CancelAsync",
  "Submit", "SubmitAsync", "Execute", "ExecuteAsync",
  "Start", "Stop", "Reset", "ResetAsync",
  "Get", "GetAsync", "Set", "SetAsync",
  "Add", "AddAsync", "Remove", "RemoveAsync",
  "Update", "UpdateAsync", "Delete", "DeleteAsync",
  "Save", "SaveAsync", "Load", "LoadAsync",
  "Send", "SendAsync", "Receive", "ReceiveAsync",
  "Process", "ProcessAsync", "Handle", "HandleAsync",
  "Build", "BuildAsync", "Publish", "PublishAsync",
  "Dispatch", "DispatchAsync", "Notify", "NotifyAsync",
  "Validate", "ValidateAsync", "Initialize", "InitializeAsync",
  "Open", "OpenAsync", "Close", "CloseAsync",
  "Read", "ReadAsync", "Write", "WriteAsync",
  "Flush", "FlushAsync", "Dispose", "DisposeAsync",
]);

/**
 * P1.2: Check if a node has an ancestor invocation_expression that uses it as
 * the function (callee) position — meaning this member access is a method call,
 * not a property read. Used to avoid emitting false PROPERTY_REF edges for
 * LINQ/repository method chains.
 */
export function isAncestorInvocation(node: Parser.SyntaxNode): boolean {
  let current: Parser.SyntaxNode | null = node.parent;
  while (current) {
    if (current.type === "invocation_expression") {
      const fn = current.childForFieldName("function");
      // If this node or any ancestor is the function of an invocation → it's a call
      if (fn === node || fn?.descendantsOfType(node.type).some(d => d === node)) {
        return true;
      }
      // Walk up — stop at statement boundaries
      return false;
    }
    // Stop at statement-level nodes to avoid false positives
    if (
      current.type === "expression_statement" ||
      current.type === "local_declaration_statement" ||
      current.type === "return_statement" ||
      current.type === "assignment_expression"
    ) {
      break;
    }
    current = current.parent;
  }
  return false;
}

export function emitPropertyAccessEdge(
  input: ExtractInput,
  fromSymbolId: string,
  propertyToken: string,
  isWrite: boolean,
  edges: EdgeRecord[],
  // ENH-029-B: RHS source text for write sites (assigned literal/expression). Attached only to
  // PROPERTY_WRITE edges; ignored for reads.
  assignedExpression?: string
): void {
  if (!propertyToken || propertyToken.length < 2) {
    return;
  }

  // P1.4: Skip trivial/framework property tokens that will never resolve to user symbols.
  const memberName = propertyToken.split(".").pop() ?? propertyToken;
  if (TRIVIAL_PROPERTY_TOKENS.has(memberName)) {
    return;
  }

  edges.push({
    repoId: input.repoId,
    fromId: fromSymbolId,
    toId: `property:${propertyToken}`,
    type: isWrite ? "PROPERTY_WRITE" : "PROPERTY_REF",
    ...(isWrite && assignedExpression ? { assignedExpression } : {})
  });
}

// ============================================================================
// AST Utilities
// ============================================================================
