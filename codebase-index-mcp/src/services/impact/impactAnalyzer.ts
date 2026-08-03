/**
 * Barrel for impact analysis.
 *
 * Grouped by the question being answered rather than by the tool that asks it, because several
 * tools share an implementation — `get_symbol_context_pack` is built from the surface and the
 * change context. Every import site keeps this single path.
 */

export * from "./impactShared.js";
export * from "./impactSurface.js";
export * from "./impactFileContext.js";
export * from "./impactRenameTrace.js";
export * from "./impactRepoSummaries.js";
