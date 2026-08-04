/**
 * What happens after the last batch commits: pruning, deferred edge resolution, the vector
 * rebuild, and assembling the run summary.
 *
 * Extracted from `indexPipeline.ts` in S-41. Like the scan phase, this touches no run counter —
 * it reads the store and reports — which is why it lifts out cleanly while the batch loop does not.
 *
 * `buildRunSummary` existed twice before this: the success path and the catch block each wrote
 * the same 19-field object literal, differing only in `status` and whether `vectorSymbolsIndexed`
 * was set. Two copies of a field list is how a new field gets added to one path and not the other.
 */

import path from "node:path";

import type { GraphStore } from "../../repositories/graphStore.js";
import { indexLog, indexWarn, type IndexProgress } from "./indexProgress.js";
import type { IndexMode, IndexRunSummary } from "../../types/index.js";

export interface FinalizeInput {
  readonly repoId: string;
  readonly repoPath: string;
  readonly mode: IndexMode;
  readonly onlyRelativePaths?: Set<string>;
  readonly abortSignal?: { aborted: boolean };
}

/**
 * Prune files that no longer exist, then resolve the edge types that could not be resolved until
 * every file had been seen.
 *
 * The guard is the important part. Pruning treats "not in this scan" as "deleted", so it is only
 * safe when the scan really did see the whole repo. Two cases where it did not:
 *
 *  - a capped scan (`files.length > maxFiles`) — the missing tail would look like deletions;
 *  - dirty mode, which restricts the scan to changed files by construction.
 *
 * IMPLEMENTS and PUBLISHES resolution is skipped in the same cases: with stale symbols still
 * present, resolving `iface:` placeholders against them would produce dangling edges.
 */
export function pruneAndResolve(
  store: GraphStore,
  input: FinalizeInput,
  progress: IndexProgress,
  files: string[],
  selectedFiles: string[],
  maxFiles: number
): { filesPruned: number; edgesPruned: number } {
  if (input.abortSignal?.aborted) {
    return { filesPruned: 0, edgesPruned: 0 };
  }

  const scanWasComplete = files.length <= maxFiles && !input.onlyRelativePaths;
  // MCP-ISSUE-048: these two were computed, logged, and thrown away — which is why the gap between
  // `edgesUpserted` (extraction-time) and the row count in `edges` could not be accounted for.
  let filesPruned = 0;
  let edgesPruned = 0;

  progress.phase("pruning");
  if (scanWasComplete) {
    const currentPaths = selectedFiles.map((f) => path.relative(input.repoPath, f));
    const pruned = store.pruneStaleFiles(input.repoId, currentPaths);
    filesPruned = pruned;
    if (pruned > 0) {
      indexLog(`[index-prune] removed ${String(pruned)} stale file(s) from index`);
    }
    const prunedEdges = store.pruneOrphanedEdges(input.repoId);
    edgesPruned = prunedEdges;
    if (prunedEdges > 0) {
      indexLog(`[index-prune] removed ${String(prunedEdges)} orphaned edge(s) from index`);
    }
  } else if (input.onlyRelativePaths) {
    indexLog(`[index-prune-skipped] dirty mode re-indexed ${String(files.length)} changed file(s) — pruning and IMPLEMENTS resolution skipped (subset scan)`);
  } else {
    indexLog(`[index-prune-skipped] repo has ${String(files.length)} files, exceeds cap of ${String(maxFiles)} — stale-file cleanup and IMPLEMENTS resolution skipped to avoid false deletions`);
  }

  // Resolve iface: placeholders → real symbolIds after all C# files have been indexed.
  if (input.mode === "full" && scanWasComplete) {
    const resolvedImpl = store.resolveImplementsEdges(input.repoId);
    // EXTENDS and the base-class dispatch fan-out are NOT invoked here, on purpose. This function runs
    // inside the pipeline, BEFORE `indexRunner`'s post-phase resolves call edges — and the fan-out reads
    // final CALLS edges, so running it here would work on unresolved tokens and produce nothing. It also
    // duplicated the work: both sites ran, and the useful one was the second. `implementsResolveMs`
    // reported 137576ms on wec.be, larger than the whole run, which is what exposed the double call.
    // They live in `indexRunner`'s post-phase only.
    if (resolvedImpl > 0) {
      indexLog(`[index-resolve] resolved ${String(resolvedImpl)} IMPLEMENTS edge(s)`);
    }
    // ISSUE-020: match message-bus PUBLISHES/CONSUMES contract tokens producer→consumer.
    const resolvedBus = store.resolvePublishesConsumesEdges(input.repoId);
    if (resolvedBus > 0) {
      indexLog(`[index-resolve] resolved ${String(resolvedBus)} PUBLISHES bus edge(s)`);
    }
  }

  return { filesPruned, edgesPruned };
}

/**
 * Rebuild the vector index, and never let it fail the run.
 *
 * Deliberately swallowing: semantic search is an enhancement over the graph, so a missing
 * sqlite-vec extension or a model load failure must degrade search, not lose an index run whose
 * symbols and edges are already committed.
 */
export function rebuildVectorIndex(store: GraphStore, repoId: string, progress: IndexProgress): number {
  if (!store.isVectorEnabled) {
    return 0;
  }

  const vecStart = Date.now();
  progress.phase("vector index");
  indexLog("[index-vector] rebuilding vector index...");
  try {
    const vectorSymbolsIndexed = store.rebuildVectorIndex(repoId);
    const vecMs = Date.now() - vecStart;
    indexLog(`[index-vector] indexed ${String(vectorSymbolsIndexed)} symbols in ${String(vecMs)}ms`);
    return vectorSymbolsIndexed;
  } catch (vecErr) {
    indexWarn(`[index-vector] rebuild failed (non-fatal): ${vecErr instanceof Error ? vecErr.message : String(vecErr)}`);
    return 0;
  }
}

/** The mutable counters a run accumulates. Held as one object only so the summary can be built. */
export interface RunCounters {
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
   * Edges the performance profile's bounds discarded this run — zero on `standard`.
   *
   * Reported, not merely counted. MCP-ISSUE-038: the `very-large` profile's confidence floor silently
   * deleted every unresolved TYPE_REF, so `dead_code_scan` on a 67980-symbol repo answered from 1112
   * edges and said nothing was wrong. A bound that does not appear in the run record is a bound nobody
   * can audit.
   */
  edgesDroppedByConfidence: number;
  edgesDroppedByCallCap: number;
  edgesDroppedByTypeRefCap: number;
}

export interface RunIdentity {
  readonly runId: string;
  readonly repoId: string;
  readonly commitSha: string | null;
  readonly branch: string | null;
  readonly indexVersion: string;
  readonly mode: IndexMode;
  readonly startedAt: string;
}

/**
 * A run is degraded when this share of the files it actually attempted failed to parse.
 *
 * 10% is well clear of both observed regimes: a healthy full index of this workspace reports 0
 * failures, and the incident that motivated the check reported 217 of 400 (54%). Deliberately a
 * module constant rather than an env var — every env var in this workspace is declared in
 * `packages/manifest` and generated outward, and a tuning knob nobody sets is not worth a row in
 * four generated files.
 */
export const PARSE_FAILURE_DEGRADED_RATIO = 0.1;

/**
 * Below this many indexed files, "no edges" is unremarkable — a two-file repo may genuinely have
 * no imports or calls. Above it, a symbol-bearing graph with zero edges means extraction ran and
 * produced nothing usable.
 */
const ZERO_EDGE_MIN_FILES = 10;

/**
 * Decide whether a completed run produced a graph worth trusting.
 *
 * Reads counters only — no store access — so it is a pure function the unit tests can drive
 * directly, which is the property that makes this check itself testable.
 */
export function assessRunHealth(
  counters: RunCounters,
  mode: IndexMode
): { degraded: boolean; reasons: string[] } {
  const reasons: string[] = [];

  const attempted = counters.filesIndexed + counters.parseFailures;
  if (attempted > 0) {
    const ratio = counters.parseFailures / attempted;
    if (ratio >= PARSE_FAILURE_DEGRADED_RATIO) {
      reasons.push(
        `${String(counters.parseFailures)} of ${String(attempted)} files failed to parse ` +
          `(${(ratio * 100).toFixed(1)}%, threshold ${String(PARSE_FAILURE_DEGRADED_RATIO * 100)}%)` +
          (counters.parseTimeouts > 0 ? `, including ${String(counters.parseTimeouts)} timeout(s)` : "") +
          " — check that the running server's build matches dist/ and re-run after a restart."
      );
    }
  }

  // Scoped to full runs: an incremental or dirty run legitimately upserts no edges when the
  // changed files contain none, so the same observation carries no signal there.
  if (
    mode === "full" &&
    counters.edgesUpserted === 0 &&
    counters.symbolsUpserted > 0 &&
    counters.filesIndexed >= ZERO_EDGE_MIN_FILES
  ) {
    reasons.push(
      `indexed ${String(counters.filesIndexed)} files and ${String(counters.symbolsUpserted)} symbols ` +
        "but produced 0 edges — the graph has no call, import or type relationships and impact tools will return nothing."
    );
  }

  return { degraded: reasons.length > 0, reasons };
}

/**
 * The single place a run summary is shaped, for both the success and the failure path.
 *
 * `vectorSymbolsIndexed` is omitted rather than zeroed when absent, because the failure path
 * never set it and adding it as 0 would claim the vector index was rebuilt and found nothing.
 * `healthReasons` follows the same rule: absent means "nothing to report", not "checked and clean".
 */
export function buildRunSummary(
  identity: RunIdentity,
  counters: RunCounters,
  status: IndexRunSummary["status"],
  finishedAt: string,
  elapsedMs: number,
  vectorSymbolsIndexed?: number,
  healthReasons?: string[]
): IndexRunSummary {
  return {
    runId: identity.runId,
    repoId: identity.repoId,
    commitSha: identity.commitSha,
    branch: identity.branch,
    indexVersion: identity.indexVersion,
    mode: identity.mode,
    status,
    startedAt: identity.startedAt,
    finishedAt,
    filesScanned: counters.filesScanned,
    filesIndexed: counters.filesIndexed,
    filesSkipped: counters.filesSkipped,
    symbolsUpserted: counters.symbolsUpserted,
    edgesUpserted: counters.edgesUpserted,
    docsUpserted: counters.docsUpserted,
    mentionsUpserted: counters.mentionsUpserted,
    parseFailures: counters.parseFailures,
    parseTimeouts: counters.parseTimeouts,
    // Omitted when nothing was dropped, so the common case adds nothing to the wire and a present field
    // always means the profile actually cost this run something.
    ...(counters.edgesDroppedByConfidence > 0 ? { edgesDroppedByConfidence: counters.edgesDroppedByConfidence } : {}),
    ...(counters.edgesDroppedByCallCap > 0 ? { edgesDroppedByCallCap: counters.edgesDroppedByCallCap } : {}),
    ...(counters.edgesDroppedByTypeRefCap > 0 ? { edgesDroppedByTypeRefCap: counters.edgesDroppedByTypeRefCap } : {}),
    ...(healthReasons !== undefined && healthReasons.length > 0 ? { healthReasons } : {}),
    elapsedMs,
    ...(vectorSymbolsIndexed === undefined ? {} : { vectorSymbolsIndexed })
  };
}
