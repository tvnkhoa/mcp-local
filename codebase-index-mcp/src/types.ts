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
  parseFailures: number;
  elapsedMs: number;
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
};

export type EdgeRecord = {
  repoId: string;
  fromId: string;
  toId: string;
  type: "IMPORTS" | "CALLS" | "DEPENDS_ON";
};

export type CallChainDirection = "callers" | "callees";

export type QueryResult<T> = {
  requestId: string;
  data: T;
};
