export type IndexMode = "full" | "incremental";

export type IndexRunStatus = "running" | "ok" | "failed" | "cancelled";

export type IndexRunSummary = {
  runId: string;
  repoId: string;
  commitSha: string | null;
  branch: string | null;
  indexVersion: string;
  mode: IndexMode;
  status: Exclude<IndexRunStatus, "running">;
  startedAt: string;
  finishedAt: string;
  filesScanned: number;
  filesIndexed: number;
  filesSkipped: number;
  symbolsUpserted: number;
  edgesUpserted: number;
  docsUpserted: number;
  mentionsUpserted: number;
  parseFailures: number;
  parseTimeouts: number;
  elapsedMs: number;
  crossRepoAttempts?: number;
  crossRepoResolved?: number;
  unresolvedNoCandidate?: number;
  unresolvedAmbiguous?: number;
  unresolvedBoundaryBlocked?: number;
  unresolvedLowConfidence?: number;
  vectorSymbolsIndexed?: number;
  resolvePhaseMs?: number;
  buildContextMs?: number;
  callResolveMs?: number;
  importResolveMs?: number;
  typeResolveMs?: number;
  propertyResolveMs?: number;
  implementsResolveMs?: number;
  ftsRebuildMs?: number;
  unresolvedCallsTotal?: number;
  /** true khi import/type/property resolve bị cap bởi maxUnresolvedRows policy.
   * NOTE: call resolve (buildCallResolutionContext) KHÔNG bao giờ bị cap — luôn fetch tất cả rows. */
  unresolvedImportsCappedByPolicy?: boolean;
  resolveCallsCoverage?: number;
  performanceProfile?: "standard" | "large" | "very-large";
};

export type GraphHealth = {
  unresolvedCalls: number;
  unresolvedImports: number;
  unresolvedTypeRefs: number;
  unresolvedProperties: number;
  importsTotal?: number;
  importsClassified?: number;
  importClassificationRatio?: number;
  note: string;
};

export type ReliabilitySummary = {
  edgeCount: number;
  medianConfidence: number;
  lowConfidenceEdgeCount: number;
  unresolvedRatio: number;
  warning: string | null;
};

export type ModuleImpactGroup = {
  module: string;
  fileCount: number;
  topRiskLevel: string;
  topFiles: string[];
};

export type UnresolvedReason = "no_candidate" | "ambiguous_candidates" | "boundary_blocked" | "low_confidence";

export type ResolutionStats = {
  attempts: number;
  resolved: number;
  unresolvedByReason: Record<UnresolvedReason, number>;
};

export type IndexProgressSnapshot = {
  runId: string;
  repoId: string;
  mode: IndexMode;
  status: IndexRunStatus;
  startedAt: string;
  finishedAt?: string;
  totalFiles: number;
  filesScanned: number;
  filesIndexed: number;
  filesSkipped: number;
  symbolsUpserted: number;
  edgesUpserted: number;
  parseFailures: number;
  parseTimeouts: number;
  batchSize: number;
  completedBatches: number;
  totalBatches: number;
  elapsedMs: number;
  etaSeconds?: number;
  filesPerSecond?: number;
  symbolsPerSecond?: number;
  edgesPerSecond?: number;
  byLanguage?: Record<string, { scanned: number; indexed: number }>;
  errorMessage?: string;
};

export type FileRecord = {
  repoId: string;
  path: string;
  contentHash: string;
  language: string | null;
  updatedAt: string;
};

export type SymbolRecord = {
  repoId: string;
  symbolId: string;
  filePath: string;
  name: string;
  kind: "function" | "class" | "method" | "variable" | "module" | "interface" | "property" | "constructor" | "type" | "struct" | "impl" | "unknown";
  line: number;
  signature?: string;
  /** ID of the enclosing class/struct/interface symbol. Used for qualified property edge resolution. */
  parentSymbolId?: string;
};

export type EdgeRecord = {
  repoId: string;
  fromId: string;
  toId: string;
  type: "IMPORTS" | "CALLS" | "DEPENDS_ON" | "IMPLEMENTS" | "TYPE_REF" | "PROPERTY_REF" | "PROPERTY_WRITE";
  confidence?: number;
  reason?: string;
};

export type RouteRecord = {
  repoId: string;
  filePath: string;
  controllerSymbolId: string;
  handlerSymbolId: string;
  httpMethod: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
  routeTemplate: string;
  line: number;
};

export type ResolvedEdge = {
  fromId: string;
  fromName: string | null;
  fromFilePath: string | null;
  toId: string;
  toName: string | null;
  toFilePath: string | null;
  type: string;
  confidence?: number;
  reason?: string | null;
};

export type DocRecord = {
  repoId: string;
  docId: string;
  filePath: string;
  headingPath: string; // e.g., "README.md#API" or "README.md" for file-level
  contentType: "heading" | "code_block" | "paragraph";
  text: string;
  level?: number; // heading level (1-6) if contentType="heading"
};

export type DocMentionRecord = {
  repoId: string;
  docId: string;
  symbolId: string | null; // null if unresolved
  mentionType: "backtick" | "heading" | "filepath";
  confidence: number; // 1.0, 0.7, 0.5
  mentionText: string; // the actual text matched, e.g., "GraphStore"
};

export type CallChainDirection = "callers" | "callees";

export type QueryResult<T> = {
  requestId: string;
  data: T;
};

export type WatchConfig = {
  debounceMs: number;
  maxQueuedEvents: number;
  maxFilesPerRun: number;
  batchSize: number;
};

export type RepoWatchStatus = {
  repoId: string;
  repoPath: string;
  running: boolean;
  startedAt: string;
  lastRunAt: string | null;
  lastError: string | null;
  eventsReceived: number;
  eventsDeduped: number;
  batchesProcessed: number;
  filesPruned: number;
  runFailures: number;
  queuedChanged: number;
  queuedDeleted: number;
};

export type RefactorRiskFlag = "ambiguous_target" | "cross_type" | "generated_file";

export type RefactorPreviewRecord = {
  previewId: string;
  repoId: string;
  findPattern: string;
  replaceExpression: string;
  mode: "text" | "syntax-aware" | "symbol-aware";
  ambiguityThresholdPercent: number;
  createdAt: string;
  expiresAt: string;
  digest: string;
  status: "ready" | "applied" | "apply_partial" | "apply_failed" | "rolled_back" | "expired";
  totalMatches: number;
  affectedFileCount: number;
  riskAmbiguousCount: number;
  riskCrossTypeCount: number;
  riskGeneratedCount: number;
};

export type RefactorPreviewHunkRecord = {
  previewId: string;
  hunkId: string;
  filePath: string;
  line: number;
  startOffset: number;
  endOffset: number;
  beforeText: string;
  afterText: string;
  replacementText: string;
  ownerType: string | null;
  symbolKind: string | null;
  confidence: number;
  riskFlags: RefactorRiskFlag[];
  fileHashBefore: string;
};

export type RefactorApplyRecord = {
  applyId: string;
  rollbackId: string;
  previewId: string;
  repoId: string;
  status: "applied" | "partial" | "failed";
  createdAt: string;
  completedAt: string;
  totalFiles: number;
  totalReplacements: number;
  conflictCount: number;
};

export type RefactorApplyChangeRecord = {
  applyId: string;
  filePath: string;
  replacementCount: number;
  status: "applied" | "skipped" | "conflict";
  reason: string | null;
  fileHashBefore: string;
  fileHashAfter: string | null;
  // null when file exceeded APPLY_CONTENT_STORE_MAX_BYTES at time of apply — hunk-level rollback
  // is used in that case; content-based fallback rollback is unavailable.
  beforeContent: string | null;
  afterContent: string | null;
};

export type RefactorApplyHunkRecord = {
  applyId: string;
  filePath: string;
  hunkId: string;
  startOffsetApplied: number;
  endOffsetApplied: number;
  beforeText: string;
  afterText: string;
};

export type RefactorRollbackRecord = {
  rollbackId: string;
  applyId: string;
  status: "restored" | "partial" | "failed";
  createdAt: string;
  completedAt: string;
  restoredFiles: number;
  conflictCount: number;
};
