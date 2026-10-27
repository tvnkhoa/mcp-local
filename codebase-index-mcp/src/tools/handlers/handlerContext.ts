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
  /** R1: read tools refresh a stale index themselves. */
  QUERY_REFRESH_ENABLED?: boolean;
  /**
   * R3 exact: TypeScript LanguageService lane for TS/JS fields in find_field_accesses. Absent (as in
   * handler unit tests that build a bare context) means the lane is off and the graph answers.
   */
  TS_LS?: {
    enabled: boolean;
    budgetMs: number;
    maxRssMb: number;
    /** Release I1: how long one call waits for the worker before answering `gap` (building). Defaults to budgetMs. */
    waitMs?: number;
    /**
     * What is left of the call's wait budget once the R1 freshness gate has taken its share. On a dirty
     * tree the gate can spend the whole budget first; without this the worker wait was added on top
     * (live release I: a cold field call answered at 11.5 s against a 5 s budget).
     */
    remainingWaitMs?: () => number;
  };
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
  /**
   * R4: the HTTP client session of the call being handled. A refactor preview records it and only
   * that session may apply the preview. Absent on stdio (one client per process) and in unit tests.
   */
  clientSessionId?: string;
  /**
   * MCP-ISSUE-108: the client process of the call (pid + start time, see the SDK's CallContext). When present it,
   * not the session id, owns a refactor preview, so a preview survives a server restart after which the client
   * re-initialized a new session. Absent when unresolvable: ownership falls back to {@link clientSessionId}.
   */
  clientIdentity?: string;
}
