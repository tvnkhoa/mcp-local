export type IndexMode = "full" | "incremental";

export type IndexRunStatus = "running" | "ok" | "failed" | "cancelled";

export type IndexRunSummary = {
  runId: string;
  repoId: string;
  commitSha: string | null;
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
  elapsedMs: number;
  crossRepoAttempts?: number;
  crossRepoResolved?: number;
  unresolvedNoCandidate?: number;
  unresolvedAmbiguous?: number;
  unresolvedBoundaryBlocked?: number;
  unresolvedLowConfidence?: number;
};

export type GraphHealth = {
  unresolvedCalls: number;
  unresolvedImports: number;
  unresolvedTypeRefs: number;
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
  batchSize: number;
  completedBatches: number;
  totalBatches: number;
  elapsedMs: number;
  etaSeconds?: number;
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
};

export type EdgeRecord = {
  repoId: string;
  fromId: string;
  toId: string;
  type: "IMPORTS" | "CALLS" | "DEPENDS_ON" | "IMPLEMENTS" | "TYPE_REF";
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
