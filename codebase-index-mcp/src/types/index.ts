export type IndexMode = "full" | "incremental" | "dirty";

/**
 * `degraded` means the run completed but the graph it produced should not be trusted.
 *
 * Added after a full re-index of `mcp-local` reported `ok` while upserting 57 symbols and
 * **0 edges** against 217 parse failures — the previous run of the same tree had 2097 symbols
 * and 6233 edges. Nothing downstream could tell: `health_check` saw a run at HEAD with status
 * `ok`, so every graph tool answered from an empty index without a warning. A run that fails to
 * parse most of the repository is not a successful run, and the summary is the only place that
 * can say so.
 */
export type IndexRunStatus = "running" | "ok" | "degraded" | "failed" | "cancelled";

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
  /**
   * Edges the performance profile's bounds discarded — present only when non-zero.
   *
   * These exist because MCP-ISSUE-038 was undetectable from the run record: `very-large`'s confidence
   * floor deleted every unresolved TYPE_REF, and the summary reported a healthy run. A bound that does
   * not surface here cannot be audited, and its absence reads as "nothing was dropped".
   */
  edgesDroppedByConfidence?: number;
  edgesDroppedByCallCap?: number;
  edgesDroppedByTypeRefCap?: number;
  /**
   * Why `status` is `degraded` — one human-readable line per failing check, present only then.
   *
   * The status alone tells a caller not to trust the graph; these say what to fix. Same principle
   * as the `edgesDropped*` counters above: a bound that does not name itself cannot be acted on.
   */
  healthReasons?: string[];
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
  /** ISSUE-025: số call edge chưa resolve TRƯỚC resolve phase (population được attempt). */
  callEdgesAttempted?: number;
  /**
   * CALLS edges still on a `callee:` placeholder AFTER every resolver has run — measured, not derived.
   *
   * MCP-ISSUE-048: this used to be `max(0, attempted − resolved)`, but those two count different
   * things (distinct pairs vs updated rows plus inserted dispatch edges), so the subtraction went
   * negative and the clamp reported 0 next to `unresolvedCallsTotal: 14420`.
   */
  callEdgesUnresolved?: number;
  /**
   * CALLS rows in the graph still on a `callee:` placeholder — measured, and NOT a partition of
   * `callEdgesAttempted`: most are external/BCL targets that were never resolution candidates.
   */
  callEdgesUnresolvedInGraph?: number;
  /** Rows the resolve UPDATE touched (a pair can be several rows) and dispatch edges newly inserted. */
  callRowsUpdated?: number;
  dispatchEdgesInserted?: number;
  /**
   * Row counts read back from `symbols`/`edges` after the run — the authoritative graph size.
   *
   * `symbolsUpserted`/`edgesUpserted` are counted at extraction time, so they cannot equal these once
   * dedup and pruning have run. Both are legitimate; reporting only the first under a name that reads
   * like the second is what made MCP-ISSUE-048 look like a counting bug.
   */
  symbolsInGraph?: number;
  edgesInGraph?: number;
  /** Rows the post-resolve dedup removed, and what pruning removed — previously logged and discarded. */
  edgesDeduplicated?: number;
  filesPruned?: number;
  edgesPruned?: number;
  /** Scan + extraction + write only. `elapsedMs` spans the whole run, post-phase included. */
  extractPhaseMs?: number;
  /** @deprecated alias của callEdgesAttempted — tên cũ gây hiểu nhầm là "còn lại sau resolve". */
  unresolvedCallsTotal?: number;
  /** true khi import/type/property resolve bị cap bởi maxUnresolvedRows policy.
   * NOTE: call resolve (buildCallResolutionContext) KHÔNG bao giờ bị cap — luôn fetch tất cả rows. */
  unresolvedImportsCappedByPolicy?: boolean;
  resolveCallsCoverage?: number;
  performanceProfile?: "standard" | "large" | "very-large";
};

/**
 * What an index run actually returns: the persisted summary plus the counters the
 * post-resolve phase produces, and `skipReason` for a run that did no work.
 *
 * These fields are additive on purpose — `recordRun` writes the whole object, but
 * the extras are absent from a summary read back out of storage, so they cannot be
 * folded into `IndexRunSummary` without lying about what a stored row contains.
 */
export type IndexRunResult = IndexRunSummary & {
  crossRepoLinked?: number;
  callEdgesResolved?: number;
  importEdgesResolved?: number;
  mentionsResolved?: number;
  skipReason?: string;
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
  kind: "function" | "class" | "method" | "variable" | "module" | "interface" | "property" | "constructor" | "type" | "struct" | "record" | "record struct" | "impl" | "unknown";
  line: number;
  /** Last line of the symbol's source span (1-indexed). Optional: null on indexes built before end-line tracking. */
  endLine?: number;
  signature?: string;
  /** ID of the enclosing class/struct/interface symbol. Used for qualified property edge resolution. */
  parentSymbolId?: string;
  /**
   * How this row was matched, when it came from a search (MCP-ISSUE-058(b)).
   *
   * Absent means the index matched the query terms. `"fuzzy"` means it arrived through the vector
   * near-neighbour padding and may share no name token with the query at all — a distinction the
   * caller previously had no way to make, because both were reported at `confidence: "high"`.
   */
  matchType?: "fuzzy";
};

export type EdgeRecord = {
  repoId: string;
  fromId: string;
  toId: string;
  /**
   * `EXTENDS` is class inheritance and is deliberately NOT folded into `IMPLEMENTS` (MCP-ISSUE-037).
   * C# allows one base class and many interfaces, and several tools read `IMPLEMENTS` as "satisfies an
   * interface contract" — merging them would make those answers wrong without changing their shape.
   */
  type: "IMPORTS" | "CALLS" | "DEPENDS_ON" | "IMPLEMENTS" | "EXTENDS" | "TYPE_REF" | "PROPERTY_REF" | "PROPERTY_WRITE" | "PUBLISHES" | "CONSUMES";
  confidence?: number;
  reason?: string;
  /** ENH-029-B: RHS source text captured at PROPERTY_WRITE sites (assigned literal/expression). */
  assignedExpression?: string;
};

/**
 * Edge types followed when traversing the call graph: CALLS (static invocation) plus PUBLISHES
 * (a resolved message-bus producer→consumer hop, ISSUE-020). Every traversal/impact query that
 * crosses the call graph references this single source so the surface stays consistent — adding
 * a future flow edge here updates trace_execution_flow, get_call_chain, and get_change_context
 * at once instead of needing the literal duplicated across queries.
 */
export const CALL_TRAVERSAL_EDGE_TYPES = ["CALLS", "PUBLISHES"] as const;
/** SQL `in (...)` value list form of CALL_TRAVERSAL_EDGE_TYPES (constant literals, safe to inline). */
export const CALL_TRAVERSAL_EDGE_SQL_LIST = CALL_TRAVERSAL_EDGE_TYPES.map((t) => `'${t}'`).join(", ");

export type RouteRecord = {
  repoId: string;
  filePath: string;
  controllerSymbolId: string;
  handlerSymbolId: string;
  /**
   * MCP-ISSUE-055: the delegate name as written at the registration site. Survives when
   * `handlerSymbolId` could not be resolved — e.g. a partial-class handler declared in a sibling file.
   */
  handlerName: string | null;
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
  /** ISSUE-022: cách edge được merge vào kết quả — "interface" (DI-dispatch), "bus" (PUBLISHES), "member" (class → own method). */
  via?: "interface" | "bus" | "member";
};

/**
 * An `EdgeRecord` whose two endpoints have been resolved to a symbol name and file.
 *
 * MCP-ISSUE-049: `getCallEdges` and `getDependencies` selected ids only, so `get_call_chain` and
 * `get_dependency_graph` could report nothing but `fromId`/`toId` — an opaque 24-hex hash the caller
 * had to spend a second tool call resolving. This is `ResolvedEdge`'s name/path fields grafted onto
 * `EdgeRecord`, rather than `ResolvedEdge` itself, so the `repoId` those queries select and the narrow
 * `type` union both survive and every existing consumer keeps compiling.
 */
export type ResolvedEdgeRecord = EdgeRecord & {
  fromName: string | null;
  fromFilePath: string | null;
  toName: string | null;
  toFilePath: string | null;
};

/** ISSUE-023: string literal được index làm lane riêng (KHÔNG vào symbols — tránh phá ranking + dead_code_scan). */
export type StringLiteralRecord = {
  repoId: string;
  literalId: string;
  filePath: string;
  line: number;
  /** Nội dung literal; interpolation/template hole chuẩn hoá thành {…}. */
  value: string;
  enclosingSymbolId: string | null;
  language: string;
  kind: "string" | "interpolated" | "template";
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
  /**
   * How the mention was found, which is also how much it is worth.
   *
   * `backtick` / `heading` / `filepath` are **prose** signals: an author deliberately named a symbol
   * in the text of a document, so the document is about that symbol.
   *
   * `code_call` is a bare `identifier(` harvested from inside a fenced code block (MCP-ISSUE-049).
   * It used to be recorded as `backtick`, with a code comment conceding "Treat as backtick-level
   * confidence since it's code" — which made every identifier in every pasted code sample look like
   * documentation of that symbol. A sample containing `Parse(` is not a doc for
   * `ConversationLoopCorrelationCodec.Parse`. Kept, because it is genuinely useful for "where is this
   * illustrated", but excluded from staleness by default.
   */
  mentionType: "backtick" | "heading" | "filepath" | "code_call";
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

export type RefactorRiskFlag = "ambiguous_target" | "cross_type" | "generated_file" | "unsubstituted_backreference";

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

/**
 * Edge `reason` labels that mean "the target was chosen from the callee's NAME alone".
 *
 * MCP-ISSUE-052: a traversal standing on one of these is standing on a guess. The resolver writes
 * them (`services/graph/edgeResolverCalls.ts`) and the read side uses them to refuse a
 * `coverage.confidence: "high"` it has not earned — so the two must agree on the exact strings.
 */
export const NAME_ONLY_EDGE_REASONS: ReadonlySet<string> = new Set([
  "resolved callee by name",
  "resolved callee by name (ambiguous)",
  "resolved callee vector-fallback",
  "resolved property by name",
  // The receiver's type was never proven — only the member name matched. MCP-ISSUE-052.
  "resolved property by name (unproven owner)",
  // Same shape one lane over (MCP-ISSUE-060): a bare-name match that happened to land on an
  // interface method was relabelled as an interface dispatch, which made it LOOK receiver-proven.
  // On `wec.be`, 986 of 2070 such edges named a method that two or more interfaces declare.
  "resolved interface method (unproven receiver)"
]);

/** Provenance roll-up for the edges underneath a traversal result. */
export type EdgeProvenance = {
  /** Edges considered. */
  total: number;
  /** How many of them were resolved by name only — see NAME_ONLY_EDGE_REASONS. */
  nameOnly: number;
  /** Lowest edge confidence in the set; 1 when there were no edges. */
  minConfidence: number;
};

/**
 * `to_id` prefixes that mean "extraction emitted a token and resolution never found a symbol for it".
 *
 * MCP-ISSUE-053: these rows join no symbol, so they surface with a null `toName` and a synthetic id —
 * `{"toId":"callee:Contains"}`, or worse `{"confidence":0.1}` with nothing else once null fields are
 * dropped. They also consumed `limit` slots ahead of real edges, so raising `limit` was the only way
 * to see actual callees. They are already counted in `graphHealth` / `unresolved`, which is where they
 * belong.
 *
 * Deliberately NOT listed: `nuget:`, `endpoint:` and `contract:`. Those are unresolved *by design* —
 * they name something outside the repo that a consumer legitimately queries (find_package_consumers
 * reads `DEPENDS_ON` → `nuget:%`), so they are data rather than noise.
 */
export const UNRESOLVED_SYMBOL_TOKEN_PREFIXES = ["callee:", "property:", "type:", "iface:", "base:", "import:"] as const;

/**
 * SQL predicate form of {@link UNRESOLVED_SYMBOL_TOKEN_PREFIXES}, for filtering in the query rather
 * than after it — applying it post-hoc leaves the noise counted against `LIMIT`.
 *
 * `e` is the edges alias.
 */
export const RESOLVED_TARGET_SQL_PREDICATE = UNRESOLVED_SYMBOL_TOKEN_PREFIXES.map(
  (p) => `e.to_id not like '${p}%'`
).join(" and ");
