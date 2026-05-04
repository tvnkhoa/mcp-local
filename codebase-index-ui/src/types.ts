export type EdgeRecord = {
  repoId: string;
  fromId: string;
  toId: string;
  type: "IMPORTS" | "CALLS" | "DEPENDS_ON";
};

export type SymbolRecord = {
  repoId: string;
  symbolId: string;
  filePath: string;
  name: string;
  kind: "function" | "class" | "method" | "variable" | "unknown";
  line: number;
};

export type ModuleFlowResponse = {
  repoId: string;
  filePath: string;
  edges: EdgeRecord[];
};

export type GraphViewResponse = {
  repoId: string;
  view: "module-flow" | "dependency" | "call-chain";
  root: Record<string, string | number>;
  nodes: SymbolRecord[];
  edges: EdgeRecord[];
};

export type ImpactResponse = {
  repoId: string;
  filePath: string;
  symbols: Array<{ symbolId: string; name: string }>;
};

export type NodeResolveResponse = {
  repoId: string;
  symbols: SymbolRecord[];
};

export type HealthResponse = {
  status: string;
  dbPath: string;
  allowedRootCount: number;
  latestRun: unknown;
};

export type IndexRunResponse = {
  runId: string;
  repoId: string;
  mode: "full" | "incremental";
  status: "ok" | "failed" | "cancelled";
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

export type IndexProgress = {
  runId: string;
  repoId: string;
  mode: "full" | "incremental";
  status: "running" | "ok" | "failed" | "cancelled";
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

export type IndexProgressResponse = {
  repoId: string;
  progress: IndexProgress | null;
};
