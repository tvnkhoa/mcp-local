/**
 * Shared extractor helpers.
 *
 * Split in S-41; this barrel keeps the import list of all seven importers unchanged. The parts
 * are grouped by what they need to know: nothing (primitives), routes, C# scope, edges, and JS
 * call noise.
 */

export {
  extractFirstStringLiteral,
  extractSignature,
  findEnclosingSymbolId,
  findSymbolIdByName,
  lineFromOffset,
  stableId,
  stripQuotes
} from "./extractorPrimitives.js";
export {
  combineRouteTemplate,
  dedupeRoutes,
  normalizeEndpointPath,
  normalizeRouteToken,
  toEndpointContractId
} from "./extractorRoutes.js";
export {
  collectCSharpEnclosingMemberTypeMap,
  collectCSharpScopeTypeMap,
  extractCSharpHttpDependencyContract,
  extractCSharpUsingNamespace,
  findEnclosingCSharpSymbolId,
  findEnclosingCSharpTypeName,
  isLikelyCSharpInterfaceName,
  mapUsingNamespaceToNugetContract,
  normalizeCSharpTypeName
} from "./extractorCSharpScope.js";
export {
  TRIVIAL_PROPERTY_TOKENS,
  applyCallEdgeCap,
  applyEdgeConfidenceFilter,
  dedupeEdges,
  dedupeSymbols,
  emitPropertyAccessEdge,
  emitTypeRefEdge,
  getEffectiveEdgeConfidence,
  isAncestorInvocation,
  resolveIntraFileEdges
} from "./extractorEdges.js";
export {
  BUILTIN_SKIP_NAMES,
  JS_DB_FLUENT_METHOD_NAMES,
  JS_EXTERNAL_LIKE_METHOD_NAMES,
  JS_EXTERNAL_LIKE_RECEIVER_NAMES,
  JS_NOISE_RECEIVER_TYPES,
  JS_STATIC_RECEIVER_NAMES,
  NODE_BUILTINS,
  shouldSkipJavaScriptMemberCall
} from "./extractorJsCalls.js";
