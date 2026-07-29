/**
 * Barrel for edge resolution.
 *
 * One file per edge type, because that is how a resolution failure is diagnosed: a run reports
 * unresolved counts per kind, and the file names now match those kinds. Every import site keeps
 * this single path.
 */

export * from "./edgeResolverShared.js";
export * from "./edgeResolverImports.js";
export * from "./edgeResolverCalls.js";
export * from "./edgeResolverRefs.js";
export * from "./edgeResolverContracts.js";
