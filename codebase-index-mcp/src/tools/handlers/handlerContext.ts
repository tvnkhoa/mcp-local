import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { GraphStore } from "../../repositories/graphStore.js";
import type { WatchManager } from "../../services/watch/watchManager.js";
import type { ResponseProfile } from "../../middleware/responseFormatter.js";
import type { IndexMode, IndexRunResult } from "../../types/index.js";

export interface HandlerConstants {
  MAX_FILES_PER_RUN: number;
  MAX_RESULT_LIMIT: number;
  MAX_DEPTH: number;
  WATCH_AUTO_START: boolean;
  WATCH_ACTIVE_ONLY: boolean;
  WATCH_ACTIVE_TTL_MS: number;
  DOCS_INDEXING_ENABLED: boolean;
  DOCS_TOOLS_ENABLED: boolean;
  LLM_ENABLED: boolean;
  REFACTOR_STRICT_APPROVAL: boolean;
  REFACTOR_APPROVAL_SECRET: string;
  REFACTOR_PREVIEW_TTL_MS: number;
  REFACTOR_LOW_CONFIDENCE_THRESHOLD: number;
  SERVER_VERSION: string;
  dbPath: string;
  allowedRoots: string[];
}

export interface HandlerContext {
  store: GraphStore;
  watchManager: WatchManager;
  activeWatchRef: { current: string | null };
  watchInactivityTimers: Map<string, NodeJS.Timeout>;
  runIndexAndResolve: (
    repoId: string,
    repoPath: string,
    mode: IndexMode,
    docsEnabled: boolean,
    maxFiles: number,
    batchSize: number
  ) => Promise<IndexRunResult>;
  asText: (payload: unknown, profile?: ResponseProfile) => CallToolResult;
  constants: HandlerConstants;
}
