/**
 * Symbol search and resolution.
 *
 * Split in S-41; this barrel keeps `graphStore.ts` unchanged. The parts follow the path a query
 * takes: build the FTS query, run the search, resolve one symbol, then assemble context.
 */

export { buildFtsQuery, buildIntentFtsQuery, extractIntentTokens, rebuildFtsImpl } from "./symbolSearchFts.js";
export { getSearchSuggestionsImpl, searchSymbolsImpl } from "./symbolSearchQuery.js";
export {
  findCallersByNameImpl,
  findReferencesImpl,
  findSymbolAtLineImpl,
  getSymbolDetailImpl
} from "./symbolSearchResolve.js";
export { getContextByNameImpl } from "./symbolSearchContextPack.js";
export { getSymbolCandidatesImpl } from "./symbolSearchCandidates.js";
