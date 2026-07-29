/**
 * Static analysis over the indexed graph - the read-only questions that need no re-parse.
 *
 * Split in S-41; this barrel keeps `graphStore.ts`'s import list unchanged. Each part answers one
 * kind of question, which is also the unit in which a wrong answer gets diagnosed.
 */

export { isInfraPersistencePath, isIntegrationTestPath, linkTestsToSource } from "./staticAnalyzerNameAffinity.js";
export { findEntryPoints, findImplementations, findSimilarInterfaceNames } from "./staticAnalyzerDiscovery.js";
export { detectCircularDependencies } from "./staticAnalyzerCycles.js";
export { getDeadCodeCandidates } from "./staticAnalyzerDeadCode.js";
