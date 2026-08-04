/**
 * `GraphStore` — the single entry point every caller uses to reach the graph.
 *
 * The SQL lives in the modules under `repositories/` and in the lane modules (`impactAnalyzer`,
 * `symbolSearch`, `docsStore`, `refactorStore`, `crossRepoStore`, `edgeResolver`,
 * `vectorStore`, `literalsStore`, `regexSearch`). What is left here is a façade: one method
 * per operation, forwarding to the module that owns it, so that 158 call sites across the
 * server never need to know which module moved where.
 *
 * S-30 brought this from 1,928 lines to ~810 by extracting four cohesive modules. It does not
 * go materially lower while it stays a façade — see the exemption below.
 *
 * @convention-exempt size/hard-cap: A delegation façade's length is its method count (~100
 * forwarding methods, 4 lines each with a blank), not its complexity. Splitting further does
 * not remove those lines, it only decides which file they sit in, and the alternatives are
 * worse: sub-facades (store.docs.x) change 158 call sites for no behavioural gain, and mixins
 * hide the class shape. Cohesion is enforced here by every method being a one-line forward —
 * if a body grows past that, it belongs in a store module, and that is the rule to police.
 */

import Database from "better-sqlite3";
import { createRequire } from "node:module";
import { indexWarn } from "../services/indexing/indexProgress.js";

import type {
  RefactorApplyHunkRecord,
  EdgeRecord,
  FileRecord,
  GraphHealth,
  IndexRunSummary,
  RefactorApplyChangeRecord,
  RefactorApplyRecord,
  RefactorPreviewHunkRecord,
  RefactorPreviewRecord,
  RefactorRollbackRecord,
  ReliabilitySummary,
  ResolvedEdge,
  ResolutionStats,
  RouteRecord,
  StringLiteralRecord,
  SymbolRecord
} from "../types/index.js";
import {
  resolveUnlinkedEdges as resolveUnlinkedEdgesImpl,
  resolveImportEdges as resolveImportEdgesImpl,
  resolveCallEdges as resolveCallEdgesImpl,
  resolveCallEdgesBatch as resolveCallEdgesBatchImpl,
  buildCallResolutionContext as buildCallResolutionContextImpl,
  resolveTypeRefEdges as resolveTypeRefEdgesImpl,
  resolvePropertyEdges as resolvePropertyEdgesImpl,
  resolveBaseClassDispatch as resolveBaseClassDispatchImpl,
  resolveExtendsEdges as resolveExtendsEdgesImpl,
  resolveImplementsEdges as resolveImplementsEdgesImpl,
  resolvePublishesConsumesEdges as resolvePublishesConsumesEdgesImpl
} from "../services/graph/edgeResolver.js";
import {
  linkTestsToSource as linkTestsToSourceImpl,
  getDeadCodeCandidates as getDeadCodeCandidatesImpl,
  detectCircularDependencies as detectCircularDependenciesImpl,
  findEntryPoints as findEntryPointsImpl,
  findImplementations as findImplementationsImpl,
  findSimilarInterfaceNames as findSimilarInterfaceNamesImpl
} from "../services/analysis/staticAnalyzer.js";
import {
  upsertDocsImpl,
  upsertDocMentionsImpl,
  rebuildDocsFtsImpl,
  resolveMentionsImpl,
  searchDocsImpl,
  findStaleDocsImpl,
  findDocCoverageImpl
} from "./docsStore.js";
import {
  saveRefactorPreviewImpl,
  getRefactorPreviewImpl,
  markRefactorPreviewStatusImpl,
  recordRefactorApplyImpl,
  getApplyByRollbackIdImpl,
  getRecentAppliedFileHashesImpl,
  recordRefactorRollbackImpl,
  recordPendingReindexFilesImpl,
  getPendingReindexFilesImpl,
  clearPendingReindexFilesImpl
} from "./refactorStore.js";
import {
  upsertCrossRepoDepImpl,
  getCrossRepoDepsImpl,
  getCrossRepoImpactImpl,
  findPackageConsumersImpl,
  findPackageProvidersImpl,
  packageContractExistsImpl,
  countPublisherSelfReferencesImpl,
  findSimilarPackageContractIdsImpl,
  getPackageBridgeStatsImpl
} from "./crossRepoStore.js";
import {
  buildFtsQuery,
  buildIntentFtsQuery,
  rebuildFtsImpl,
  searchSymbolsImpl,
  getSearchSuggestionsImpl,
  getSymbolDetailImpl,
  findCallersByNameImpl,
  findSymbolAtLineImpl,
  findReferencesImpl,
  getContextByNameImpl,
  getSymbolCandidatesImpl
} from "../services/search/symbolSearch.js";
import { expandInterfaceSiblingsImpl } from "../services/graph/interfaceSiblings.js";
import {
  replaceLiteralsForFileImpl,
  rebuildLiteralsFtsImpl,
  searchLiteralsImpl,
  type LiteralSearchResult
} from "./literalsStore.js";
import { searchRegexImpl, type RegexSearchOptions, type RegexSearchResult } from "../services/search/regexSearch.js";
import {
  resolveCanonicalFilePath,
  findModuleSymbolId,
  getImpactSurfaceImpl,
  getImpactFilesImpl,
  getFileSummaryImpl,
  getFileContextImpl,
  getBatchContextImpl,
  getChangeContextImpl,
  getRenameImpactImpl,
  traceExecutionFlowImpl,
  getFolderSummaryImpl,
  groupFilesByModuleImpl,
  getRouteMapImpl,
  getRepoSchemaSnapshotImpl,
  runReadOnlyGraphQueryImpl,
  listIndexedFilesImpl,
  listRepositoriesImpl
} from "../services/impact/impactAnalyzer.js";
import { initGraphSchema, runGraphMigrations } from "./schema.js";
import { recordRun as recordRunImpl, getLatestRun as getLatestRunImpl } from "./runStore.js";
import {
  type WriteContext,
  prepareWriteStatements,
  checkpoint as checkpointImpl,
  beginIndexSession as beginIndexSessionImpl,
  endIndexSession as endIndexSessionImpl,
  deduplicateResolvedEdges as deduplicateResolvedEdgesImpl,
  dropEdgeIndexesForBulkWrite as dropEdgeIndexesForBulkWriteImpl,
  rebuildEdgeIndexes as rebuildEdgeIndexesImpl,
  upsertFile as upsertFileImpl,
  ensureRepository as ensureRepositoryImpl,
  getFileHash as getFileHashImpl,
  replaceSymbolsForFile as replaceSymbolsForFileImpl,
  pruneStaleFiles as pruneStaleFilesImpl,
  pruneFiles as pruneFilesImpl,
  pruneOrphanedEdges as pruneOrphanedEdgesImpl,
  replaceEdgesForFile as replaceEdgesForFileImpl,
  replaceRoutesForFile as replaceRoutesForFileImpl
} from "./writeStore.js";
import {
  getDependencies as getDependenciesImpl,
  getCallEdges as getCallEdgesImpl,
  getFieldAccesses as getFieldAccessesImpl,
  getModuleFlow as getModuleFlowImpl,
  getSymbolsByIds as getSymbolsByIdsImpl,
  getRepository as getRepositoryImpl,
  getUnresolvedStats as getUnresolvedStatsImpl,
  type FieldAccessResult,
  type ModuleFlowResult,
  type UnresolvedStats
} from "./graphQueries.js";
import {
  initVectorStore,
  upsertSymbolVector,
  batchUpsertSymbolVectors,
  vectorSearchSymbols,
  rebuildVectorIndexForRepo,
  deleteVectorsByRepo,
  getVectorStats,
  isVectorEnabled,
} from "./vectorStore.js";

// TRIVIAL_CALLEE_TOKENS, TRIVIAL_CALLEE_IN_CLAUSE → impactAnalyzer.ts
// parseRiskFlags → refactorStore.ts
// createEmptyResolutionStats → edgeResolver.ts

export class GraphStore {
  private readonly db: Database.Database;
  private readonly runInTransactionInternal: (fn: () => void) => void;
  private _vectorEnabled = false;

  /** Connection + the write path's cached prepared statements. @see store/writeStore.ts */
  private readonly writeCtx: WriteContext;

  // buildNamedCandidateMap, pickBestNamedCandidate → edgeResolver.ts

  // getEdgeDefaults, buildReliabilitySummary, normalizePath, resolveCanonicalFilePath → impactAnalyzer.ts

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("cache_size = -64000"); // 64MB cache
    this.db.pragma("temp_store = MEMORY");
    this.db.pragma("page_size = 4096"); // Standard 4KB page size
    this.db.pragma("busy_timeout = 30000"); // 30s timeout — handles checkpoint contention on large repos
    this.db.pragma("wal_autocheckpoint = 8000"); // Raise WAL checkpoint threshold (default 1000 pages)
    // Increase mmap size to reduce I/O contention during large batch writes
    this.db.pragma("mmap_size = 268435456"); // 256MB mmap
    this.runInTransactionInternal = this.db.transaction((fn: () => void) => fn());

    // Load sqlite-vec synchronously via createRequire
    try {
      const require = createRequire(import.meta.url);
      this._vectorEnabled = initVectorStore(this.db, require);
    } catch (e) {
      indexWarn(`[vector] sqlite-vec load error: ${e}`);
      this._vectorEnabled = false;
    }

    initGraphSchema(this.db);
    runGraphMigrations(this.db, this._vectorEnabled);
    // Statements are prepared last: they reference tables and columns the two calls above
    // create, so preparing earlier fails on a fresh or older database.
    this.writeCtx = { db: this.db, stmts: prepareWriteStatements(this.db) };
  }

  get isVectorEnabled(): boolean {
    return this._vectorEnabled && isVectorEnabled();
  }

  close(): void {
    this.db.close();
  }

  runInTransaction(fn: () => void): void {
    this.runInTransactionInternal(fn);
  }

  /** @see store/writeStore.ts — WAL session, bulk maintenance, and per-file writes. */
  checkpoint(): void {
    checkpointImpl(this.db);
  }

  beginIndexSession(): void {
    beginIndexSessionImpl(this.db);
  }

  endIndexSession(): void {
    endIndexSessionImpl(this.db);
  }

  deduplicateResolvedEdges(repoId: string): number {
    return deduplicateResolvedEdgesImpl(this.db, repoId);
  }

  dropEdgeIndexesForBulkWrite(): void {
    dropEdgeIndexesForBulkWriteImpl(this.db);
  }

  rebuildEdgeIndexes(): void {
    rebuildEdgeIndexesImpl(this.db);
  }

  upsertFile(record: FileRecord): void {
    upsertFileImpl(this.writeCtx, record);
  }

  ensureRepository(repoId: string, repoPath: string): void {
    ensureRepositoryImpl(this.db, repoId, repoPath);
  }

  getFileHash(repoId: string, filePath: string): string | null {
    return getFileHashImpl(this.db, repoId, filePath);
  }

  replaceSymbolsForFile(repoId: string, filePath: string, symbols: SymbolRecord[]): void {
    replaceSymbolsForFileImpl(this.writeCtx, repoId, filePath, symbols);
  }

  pruneStaleFiles(repoId: string, currentRelativePaths: string[]): number {
    return pruneStaleFilesImpl(this.db, repoId, currentRelativePaths);
  }

  pruneFiles(repoId: string, relativePaths: string[]): number {
    return pruneFilesImpl(this.db, repoId, relativePaths);
  }

  pruneOrphanedEdges(repoId: string): number {
    return pruneOrphanedEdgesImpl(this.db, repoId);
  }

  replaceEdgesForFile(repoId: string, filePath: string, edges: EdgeRecord[]): void {
    replaceEdgesForFileImpl(this.writeCtx, repoId, filePath, edges);
  }

  replaceRoutesForFile(repoId: string, filePath: string, routes: RouteRecord[]): void {
    replaceRoutesForFileImpl(this.writeCtx, repoId, filePath, routes);
  }

  /** ISSUE-023: string-literal lane — delete-then-insert per file (mirror replaceRoutesForFile). */
  replaceLiteralsForFile(repoId: string, filePath: string, literals: StringLiteralRecord[]): void {
    replaceLiteralsForFileImpl(this.db, repoId, filePath, literals);
  }

  rebuildLiteralsFts(): void {
    rebuildLiteralsFtsImpl(this.db);
  }

  searchLiterals(repoId: string, query: string, limit: number, filePathFilter: string | null = null): LiteralSearchResult[] {
    return searchLiteralsImpl(this.db, repoId, query, limit, filePathFilter);
  }

  searchRegex(repoId: string, opts: RegexSearchOptions): RegexSearchResult {
    return searchRegexImpl(this, repoId, opts);
  }

  /** @see store/runStore.ts */
  recordRun(summary: IndexRunSummary & { crossRepoLinked?: number; callEdgesResolved?: number; importEdgesResolved?: number; mentionsResolved?: number }): void {
    recordRunImpl(this.db, summary);
  }

  getLatestRun(repoId: string): IndexRunSummary | null {
    return getLatestRunImpl(this.db, repoId);
  }

  /** @see store/graphQueries.ts */
  getDependencies(repoId: string, fromId: string, limit: number): EdgeRecord[] {
    return getDependenciesImpl(this.db, repoId, fromId, limit);
  }

  findModuleSymbolId(repoId: string, filePath: string): string | null {
    return findModuleSymbolId(this.db, repoId, filePath);
  }

  getCallEdges(repoId: string, symbolId: string, direction: "callers" | "callees", limit: number): EdgeRecord[] {
    return getCallEdgesImpl(this.db, repoId, symbolId, direction, limit);
  }

  /** ISSUE-022: interface siblings (interface method ↔ impl method, class → members) cho caller expansion. */
  expandInterfaceSiblings(repoId: string, symbolIds: string[]): { symbolId: string; via: "interface" | "member" }[] {
    return expandInterfaceSiblingsImpl(this.db, repoId, symbolIds);
  }

  /**
   * ISSUE-018 — list read/write callsites of a property symbol. Surfaces the existing
   * PROPERTY_REF (read) / PROPERTY_WRITE (write) edges, resolving each `from_id` back to its
   * enclosing symbol. The property-token match (resolved id, qualified `Type.Member`,
   * any-owner `%.Member`, bare `Member`) is shared with impact analysis via
   * buildEdgeToSymbolPairsCte, so the token grammar lives in exactly one place.
   */
  getFieldAccesses(repoId: string, symbolId: string, mode: "read" | "write" | "all", limit: number): FieldAccessResult {
    return getFieldAccessesImpl(this.db, repoId, symbolId, mode, limit);
  }

  getModuleFlow(repoId: string, filePath: string, limit: number): ModuleFlowResult {
    return getModuleFlowImpl(this.db, repoId, filePath, limit);
  }

  getSymbolsByIds(repoId: string, symbolIds: string[]): SymbolRecord[] {
    return getSymbolsByIdsImpl(this.db, repoId, symbolIds);
  }

  getRepository(repoId: string): { repoId: string; repoPath: string; updatedAt: string } | null {
    return getRepositoryImpl(this.db, repoId);
  }

  upsertCrossRepoDep(fromRepoId: string, fromSymbolId: string, toRepoId: string, toSymbolId: string, type: string): void {
    upsertCrossRepoDepImpl(this.db, fromRepoId, fromSymbolId, toRepoId, toSymbolId, type);
  }

  /**
   * Drop this repo's OUTBOUND cross-repo links so a full run can rebuild them (MCP-ISSUE-045).
   *
   * The table is written with `on conflict do nothing` and had no delete path anywhere, which made it
   * append-only for the lifetime of the database: a link created by a rule that was later corrected
   * survived indefinitely. Returns the number of rows removed.
   */
  clearOutboundCrossRepoDeps(fromRepoId: string): number {
    return this.db.prepare("delete from cross_repo_deps where from_repo_id = ?").run(fromRepoId).changes;
  }

  getCrossRepoDeps(fromRepoId: string, fromSymbolId: string, limit: number): {
    toRepoId: string;
    toSymbolId: string;
    type: string;
  }[] {
    return getCrossRepoDepsImpl(this.db, fromRepoId, fromSymbolId, limit);
  }

  getCrossRepoImpact(
    repoId: string,
    symbolId: string,
    direction: "outbound" | "inbound",
    limit: number
  ): {
    fromRepoId: string;
    fromSymbolId: string;
    toRepoId: string;
    toSymbolId: string;
    type: string;
    relatedName: string | null;
    relatedKind: string | null;
    relatedFilePath: string | null;
    relatedSignature: string | null;
    edgeReason: string | null;
  }[] {
    return getCrossRepoImpactImpl(this.db, repoId, symbolId, direction, limit);
  }

  findPackageConsumers(
    packageContractId: string,
    repoId: string | null,
    limit: number
  ): {
    consumerRepoId: string;
    consumerSymbolId: string;
    consumerName: string | null;
    consumerKind: string | null;
    consumerFilePath: string | null;
    packageContractId: string;
    dependencyReason: string | null;
    providerRepoId: string | null;
    providerSymbolId: string | null;
  }[] {
    return findPackageConsumersImpl(this.db, packageContractId, repoId, limit);
  }

  findSimilarPackageContractIds(packageContractId: string, repoId: string | null, limit: number): string[] {
    return findSimilarPackageContractIdsImpl(this.db, packageContractId, repoId, limit);
  }

  findPackageProviders(
    packageContractId: string,
    limit: number
  ): { providerRepoId: string; providerName: string; providerFilePath: string }[] {
    return findPackageProvidersImpl(this.db, packageContractId, limit);
  }

  packageContractExists(packageContractId: string): boolean {
    return packageContractExistsImpl(this.db, packageContractId);
  }

  countPublisherSelfReferences(packageContractId: string): number {
    return countPublisherSelfReferencesImpl(this.db, packageContractId);
  }

  getPackageBridgeStats(repoId: string): {
    packageAttempts: number;
    packageResolved: number;
    packageNoCandidate: number;
  } {
    return getPackageBridgeStatsImpl(this.db, repoId);
  }

  linkTestsToSource(
    repoId: string,
    filePath: string | null,
    limit: number,
    maxCandidates: number,
    minScore: number,
    sourceTokensCache?: Map<string, Set<string>>
  ): {
    testFile: string;
    sourceFile: string;
    score: number;
    reasons: string[];
  }[] {
    return linkTestsToSourceImpl(this.db, repoId, filePath, limit, maxCandidates, minScore, sourceTokensCache);
  }

  getDeadCodeCandidates(
    repoId: string,
    filePathPrefix: string | null,
    language: string | null,
    kind: string | null,
    includePrivate: boolean,
    limit: number
  ): {
    candidates: {
      symbolId: string;
      name: string;
      kind: string;
      filePath: string;
      line: number;
      signature: string | null;
      language: string | null;
      incomingCalls: number;
      incomingTypeRefs: number;
      incomingImports: number;
      deadReason: string;
    }[];
    suppressed: {
      total: number;
      reasons: Record<string, number>;
    };
    scanPolicy: {
      mode: "skip_low_confidence";
      note: string;
    };
  } {
    return getDeadCodeCandidatesImpl(this.db, repoId, filePathPrefix, language, kind, includePrivate, limit);
  }


  detectCircularDependencies(
    repoId: string,
    filePathPrefix: string | null,
    mode: "module" | "symbol",
    includeCalls: boolean,
    maxDepth: number,
    maxCycles: number
  ): {
    mode: "module" | "symbol";
    cycleCount: number;
    cycles: { path: string[]; edgeTypes: string[]; length: number }[];
  } {
    return detectCircularDependenciesImpl(this.db, repoId, filePathPrefix, mode, includeCalls, maxDepth, maxCycles);
  }

  listRepositories(): { repoId: string; repoPath: string; updatedAt: string; filesIndexed: number; symbolCount: number; lastRunStatus: string | null; lastRunAt: string | null }[] {
    return listRepositoriesImpl(this.db);
  }

  getRouteMap(repoId: string, filePathPrefix: string | null, httpMethod: string | null, limit: number): { filePath: string; controllerSymbolId: string; controllerName: string | null; handlerSymbolId: string; handlerName: string | null; httpMethod: string; routeTemplate: string; line: number }[] {
    return getRouteMapImpl(this.db, repoId, filePathPrefix, httpMethod, limit);
  }

  getRepoSchemaSnapshot(repoId: string): { repoId: string; fileCount: number; symbolCount: number; edgeCount: number; routeCount: number; languages: { language: string; fileCount: number }[] } {
    return getRepoSchemaSnapshotImpl(this.db, repoId);
  }

  runReadOnlyGraphQuery(sql: string, namedParams: Record<string, string | number | boolean | null>, limit: number, timeoutMs?: number): { columns: string[]; rows: Record<string, unknown>[]; rowCount: number; truncated: boolean; elapsedMs: number; timedOut: boolean } {
    return runReadOnlyGraphQueryImpl(this.db, sql, namedParams, limit, timeoutMs);
  }

  rebuildFts(): void {
    rebuildFtsImpl(this.db);
  }

  searchSymbols(query: string, repoId: string | null, language: string | null, kind: string | null, filePath: string | null, limit: number, strategy: "name" | "intent" = "name"): (SymbolRecord & { repoPath: string | null })[] {
    return searchSymbolsImpl(this.db, query, repoId, language, kind, filePath, limit, strategy);
  }

  getSearchSuggestions(query: string, repoId: string | null, limit: number): string[] {
    return getSearchSuggestionsImpl(this.db, query, repoId, limit);
  }

  getSymbolDetail(repoId: string, symbolId: string, limit: number): { symbol: SymbolRecord | null; edgesOut: ResolvedEdge[]; edgesIn: ResolvedEdge[] } {
    return getSymbolDetailImpl(this.db, repoId, symbolId, limit);
  }

  getFileContext(repoId: string, filePath: string, limit: number, compact = false): { symbols: SymbolRecord[] | { name: string; kind: string; line: number }[]; edges: ResolvedEdge[]; graphHealth: GraphHealth } {
    return getFileContextImpl(this.db, repoId, filePath, limit, compact);
  }

  getBatchContext(repoId: string, filePaths: string[], limit: number, compact = false): { symbols: SymbolRecord[] | { name: string; kind: string; filePath: string; line: number }[]; edges: ResolvedEdge[] } {
    return getBatchContextImpl(this.db, repoId, filePaths, limit, compact);
  }

  resolveUnlinkedEdges(repoId: string): ResolutionStats {
    return resolveUnlinkedEdgesImpl(this.db, repoId);
  }

  resolveImportEdges(repoId: string, maxUnresolvedRows = 0): number {
    return resolveImportEdgesImpl(this.db, repoId, maxUnresolvedRows);
  }

  resolveCallEdges(repoId: string, maxUnresolvedRows = 0): number {
    return resolveCallEdgesImpl(this.db, repoId, maxUnresolvedRows);
  }

  buildCallResolutionContext(repoId: string): ReturnType<typeof buildCallResolutionContextImpl> {
    return buildCallResolutionContextImpl(this.db, repoId);
  }

  resolveCallEdgesBatch(
    repoId: string,
    ctx: ReturnType<typeof buildCallResolutionContextImpl>,
    batchSize: number,
    stats?: { rowsUpdated: number; dispatchInserted: number }
  ): number {
    return resolveCallEdgesBatchImpl(this.db, repoId, ctx, batchSize, stats);
  }

  resolveTypeRefEdges(repoId: string, maxUnresolvedRows = 0, skipExpensiveFallbacks = false): number {
    return resolveTypeRefEdgesImpl(this.db, repoId, maxUnresolvedRows, skipExpensiveFallbacks);
  }

  resolvePropertyEdges(repoId: string, maxUnresolvedRows = 0): number {
    return resolvePropertyEdgesImpl(this.db, repoId, maxUnresolvedRows);
  }

  getImpactSurface(repoId: string, filePath: string, limit: number): { callers: { callerName: string; callerFile: string; callerLine: number; symbolAffected: string; edgeType: string; confidence: number; reason: string | null }[]; graphHealth: GraphHealth; reliabilitySummary: ReliabilitySummary; wiringNote?: string } {
    return getImpactSurfaceImpl(this.db, repoId, filePath, limit);
  }

  getImpactFiles(repoId: string, filePath: string, limit: number): { impactedFiles: { filePath: string; reason: string; confidence: number; symbolsAffected: string[] }[]; graphHealth: GraphHealth; reliabilitySummary: ReliabilitySummary; wiringNote?: string } {
    return getImpactFilesImpl(this.db, repoId, filePath, limit);
  }

  getFileSummary(repoId: string, filePath: string): { file: { filePath: string; language: string | null }; exports: SymbolRecord[]; imports: ResolvedEdge[]; importedBy: { fromFilePath: string; edgeType: string }[]; graphHealth: GraphHealth } {
    return getFileSummaryImpl(this.db, repoId, filePath);
  }

  getChangeContext(repoId: string, symbolId: string, callerDepth: number, calleeDepth: number, limit: number): { symbol: SymbolRecord | null; callers: (ResolvedEdge & { distance: number })[]; callees: ResolvedEdge[]; typeDeps: ResolvedEdge[]; graphHealth: GraphHealth; reliabilitySummary: ReliabilitySummary } {
    return getChangeContextImpl(this.db, repoId, symbolId, callerDepth, calleeDepth, limit);
  }

  findCallersByName(repoId: string, symbolName: string, limit: number): { symbolName: string; callers: { callerName: string; callerFile: string; callerLine: number; kind: string }[] } {
    return findCallersByNameImpl(this.db, repoId, symbolName, limit);
  }

  /**
   * Find the symbol that encloses a given line number (nearest symbol with line <= target).
   * Useful for mapping stack-trace file+line → symbolId without an extra search hop.
   */
  findSymbolAtLine(repoId: string, filePath: string, line: number): SymbolRecord | null {
    return findSymbolAtLineImpl(this.db, repoId, filePath, line, (rid, fp) => resolveCanonicalFilePath(this.db, rid, fp));
  }

  /**
   * Find all callers (CALLS edges) and importing files (IMPORTS edges) for a symbol by name.
   * Does not require symbolId — resolves by name match first.
   */
  findReferences(repoId: string, symbolName: string, limit: number): { symbolName: string; matchedSymbols: SymbolRecord[]; callers: { callerName: string; callerFile: string; callerLine: number; kind: string }[]; importedByFiles: string[]; totalFound: number } {
    return findReferencesImpl(this.db, repoId, symbolName, limit);
  }

  /**
   * Single-call context lookup by symbol name — avoids the 2-hop search_symbols → get_symbol_detail pattern.
   * Returns the best-matching symbol plus its callers, callees, and importing files.
   */
  getContextByName(repoId: string, name: string, limit: number): { symbol: SymbolRecord | null; callers: { callerName: string; callerFile: string; callerLine: number; kind: string; via?: "interface" | "member" }[]; callees: { calleeName: string; calleeFile: string | null; calleeLine: number | null; kind: string | null }[]; importedByFiles: string[]; allMatchedSymbols: SymbolRecord[] } {
    return getContextByNameImpl(this.db, repoId, name, limit);
  }

  getSymbolCandidates(repoId: string, name: string, limit: number, strategy: "name" | "intent" = "name", filters: { kind?: string | null; language?: string | null; filePath?: string | null; excludeTests?: boolean } = {}): { symbolId: string; name: string; kind: string; filePath: string; line: number; signature: string | null; qualifiedName?: string; matchType: "exact" | "prefix" | "contains"; score: number; confidence: number }[] {
    return getSymbolCandidatesImpl(this.db, repoId, name, limit, strategy, filters);
  }

  /** Start line of the next symbol in the same file after `afterLine` — used to estimate a symbol's end when `end_line` is absent (pre-end-line indexes). */
  getNextSymbolStartLine(repoId: string, filePath: string, afterLine: number): number | null {
    const row = this.db
      .prepare(`select min(line) as nextLine from symbols where repo_id = ? and file_path = ? and line > ?`)
      .get(repoId, filePath, afterLine) as { nextLine: number | null } | undefined;
    return row?.nextLine ?? null;
  }

  getFolderSummary(repoId: string, folderPath: string, maxFiles: number): { folderPath: string; totalFiles: number; directFiles: number; subfolders: string[]; files: { filePath: string; language: string | null; symbolCount: number; exportedCount: number; callerCount: number }[] } {
    return getFolderSummaryImpl(this.db, repoId, folderPath, maxFiles);
  }

  /**
   * Find entry points in priority order:
   * 1. Runtime bootstrap files: Program.cs, Startup.cs, main.ts/js, index.ts (top-level)
   * 2. Public symbols with 0 incoming CALLS edges (not called internally)
   * Excludes modules, properties, constructors from the uncalled-symbol scan to reduce noise.
   */
  findEntryPoints(
    repoId: string,
    filePathPrefix: string | null,
    kind: string | null,
    limit: number
  ): { symbolId: string; name: string; kind: string; filePath: string; line: number; signature: string | null; entryReason: string }[] {
    return findEntryPointsImpl(this.db, repoId, filePathPrefix, kind, limit);
  }

  /**
   * Find all classes/structs implementing a named interface (via IMPLEMENTS edges).
   * Requires Phase 4 C# extractor changes to populate iface: edges.
   */
  findImplementations(
    repoId: string,
    interfaceName: string,
    limit: number
  ): { symbolId: string; name: string; kind: string; filePath: string; line: number; signature: string | null }[] {
    return findImplementationsImpl(this.db, repoId, interfaceName, limit);
  }

  /**
   * Suggest indexed interface names similar to a given name (for find_implementations
   * "did you mean" hints when an exact lookup returns no implementations).
   */
  findSimilarInterfaceNames(repoId: string, interfaceName: string, limit: number): string[] {
    return findSimilarInterfaceNamesImpl(this.db, repoId, interfaceName, limit);
  }

  /**
   * Resolve IMPLEMENTS edges — convert iface:InterfaceName placeholders to real symbolIds.
   * Should be called after indexing C# files.
   */
  resolveExtendsEdges(repoId: string): number {
    return resolveExtendsEdgesImpl(this.db, repoId);
  }

  resolveBaseClassDispatch(repoId: string): number {
    return resolveBaseClassDispatchImpl(this.db, repoId);
  }

  resolveImplementsEdges(repoId: string): number {
    return resolveImplementsEdgesImpl(this.db, repoId);
  }

  /** ISSUE-020: match PUBLISHES/CONSUMES `contract:` tokens across the producer→consumer bus. */
  resolvePublishesConsumesEdges(repoId: string): number {
    return resolvePublishesConsumesEdgesImpl(this.db, repoId);
  }

  upsertDocs(docs: import("../types/index.js").DocRecord[]): void {
    upsertDocsImpl(this.db, docs);
  }

  upsertDocMentions(mentions: import("../types/index.js").DocMentionRecord[]): void {
    upsertDocMentionsImpl(this.db, mentions);
  }

  rebuildDocsFts(): void {
    rebuildDocsFtsImpl(this.db);
  }

  /**
   * Resolve unresolved doc mentions to symbol IDs.
   * Strategy:
   * - Backtick mentions: exact name match, then fuzzy match (threshold 0.8)
   * - Filepath mentions: extract module path, find symbols from that file
   * - Heading mentions: low priority, keyword matching with fuzzy logic
   */
  resolveMentions(repoId: string): number {
    return resolveMentionsImpl(this.db, repoId);
  }

  // stringSimilarity, levenshteinDistance → docsStore.ts


  // --- Phase 7A: module grouping helper ---
  groupFilesByModule(files: string[]): Record<string, string[]> {
    return groupFilesByModuleImpl(files);
  }

  // --- Phase 7B-2: rename impact ---
  getRenameImpact(repoId: string, symbolId: string, limit: number): {
    symbol: SymbolRecord | null;
    callers: ResolvedEdge[];
    importers: ResolvedEdge[];
    affectedFileCount: number;
  } {
    return getRenameImpactImpl(this.db, repoId, symbolId, limit);
  }

  // --- Phase 7C: execution flow BFS ---
  traceExecutionFlow(repoId: string, entrySymbolId: string, maxDepth: number, maxNodes: number): {
    entrySymbol: SymbolRecord | null;
    nodes: SymbolRecord[];
    edges: { fromId: string; toId: string; fromName: string; toName: string; confidence: number | null }[];
    depthReached: number;
    truncated: boolean;
  } {
    return traceExecutionFlowImpl(this.db, repoId, entrySymbolId, maxDepth, maxNodes);
  }

  // buildFtsQuery, extractIntentTokens, buildIntentFtsQuery → symbolSearch.ts

  searchDocs(
    repoId: string,
    query: string,
    limit: number
  ): {
    docId: string;
    filePath: string;
    headingPath: string;
    contentType: string;
    text: string | null;
    level: number | null;
    resolvedMentions: { symbolId: string; symbolName: string | null; mentionText: string }[];
  }[] {
    return searchDocsImpl(this.db, repoId, query, limit, buildFtsQuery, buildIntentFtsQuery);
  }

  findStaleDocs(
    repoId: string,
    symbolIds: string[]
  ): {
    docId: string;
    filePath: string;
    headingPath: string;
    text: string | null;
    mentionText: string;
    symbolName: string | null;
  }[] {
    return findStaleDocsImpl(this.db, repoId, symbolIds);
  }

  findDocCoverage(
    repoId: string,
    filePath: string
  ): {
    symbolId: string;
    name: string;
    kind: string;
    line: number;
    signature: string | null;
    hasDocs: boolean;
    mentionCount: number;
  }[] {
    return findDocCoverageImpl(this.db, repoId, filePath);
  }

  // countUnresolvedEdgesForFile → impactAnalyzer.ts

  listIndexedFiles(repoId: string): { path: string; language: string | null }[] {
    return listIndexedFilesImpl(this.db, repoId);
  }

  saveRefactorPreview(preview: RefactorPreviewRecord, hunks: RefactorPreviewHunkRecord[]): void {
    saveRefactorPreviewImpl(this.db, preview, hunks);
  }

  getRefactorPreview(previewId: string): { preview: RefactorPreviewRecord; hunks: RefactorPreviewHunkRecord[] } | null {
    return getRefactorPreviewImpl(this.db, previewId);
  }

  markRefactorPreviewStatus(previewId: string, status: RefactorPreviewRecord["status"]): void {
    markRefactorPreviewStatusImpl(this.db, previewId, status);
  }

  recordRefactorApply(
    apply: RefactorApplyRecord,
    changes: RefactorApplyChangeRecord[],
    hunks: RefactorApplyHunkRecord[]
  ): void {
    recordRefactorApplyImpl(this.db, apply, changes, hunks);
  }

  getApplyByRollbackId(rollbackId: string): {
    apply: RefactorApplyRecord;
    changes: RefactorApplyChangeRecord[];
    hunks: RefactorApplyHunkRecord[];
  } | null {
    return getApplyByRollbackIdImpl(this.db, rollbackId);
  }

  getRecentAppliedFileHashes(repoId: string, filePaths: string[]): Map<string, string> {
    return getRecentAppliedFileHashesImpl(this.db, repoId, filePaths);
  }

  recordRefactorRollback(rollback: RefactorRollbackRecord): void {
    recordRefactorRollbackImpl(this.db, rollback);
  }

  // ── Pending re-index set (MCP-ISSUE-042) ────────────────────────────────────

  recordPendingReindexFiles(repoId: string, filePaths: string[], reason: string): void {
    recordPendingReindexFilesImpl(this.db, repoId, filePaths, reason);
  }

  getPendingReindexFiles(repoId: string): { filePath: string; reason: string; recordedAt: string }[] {
    return getPendingReindexFilesImpl(this.db, repoId);
  }

  clearPendingReindexFiles(repoId: string): void {
    clearPendingReindexFilesImpl(this.db, repoId);
  }


  // ── Vector store methods ────────────────────────────────────────────────────

  upsertSymbolVector(repoId: string, symbolId: string, name: string, signature?: string): void {
    upsertSymbolVector(this.db, repoId, symbolId, name, signature);
  }

  batchUpsertSymbolVectors(repoId: string, symbols: { symbolId: string; name: string; signature?: string }[]): number {
    return batchUpsertSymbolVectors(this.db, repoId, symbols);
  }

  vectorSearchSymbols(repoId: string, queryText: string, k: number): { symbolId: string; distance: number }[] {
    return vectorSearchSymbols(this.db, repoId, queryText, k);
  }

  rebuildVectorIndex(repoId: string): number {
    return rebuildVectorIndexForRepo(this.db, repoId);
  }

  deleteVectorsByRepo(repoId: string): void {
    deleteVectorsByRepo(this.db, repoId);
  }

  getVectorStats(repoId: string): { symbolsIndexed: number; lastRebuildAt: string | null } {
    return getVectorStats(this.db, repoId);
  }

  getUnresolvedStats(repoId: string): UnresolvedStats {
    return getUnresolvedStatsImpl(this.db, repoId);
  }

  /**
   * CALLS edges still pointing at a `callee:` placeholder — the measured remainder after resolution.
   *
   * MCP-ISSUE-048: `callEdgesUnresolved` used to be derived by subtracting the resolved count from the
   * attempted count, but those are different populations (distinct pairs vs updated rows plus inserted
   * dispatch edges), so the subtraction clamped to 0 while the run reported 14420 unresolved calls in
   * the same object.
   */
  countUnresolvedCallEdges(repoId: string): number {
    const row = this.db
      .prepare(
        `select count(*) as cnt from edges
         where repo_id = ? and type = 'CALLS' and to_id like 'callee:%'`
      )
      .get(repoId) as { cnt: number };
    return row.cnt;
  }
}
