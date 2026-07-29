/**
 * The index run: scan, extract in batches, write, finalize.
 *
 * S-41 moved three phases out to `indexing/` -- limit resolution (`runLimits.ts`), the scan
 * (`fileScan.ts`), and pruning/resolution/vector/summary (`runFinalize.ts`). What stays is the
 * batch loop, and that is deliberate: it is one unit of work whose parts share a mutable
 * accumulator and an abort signal checked at four points. Splitting it further would mean
 * inventing a context object to pass the same state around, which adds indirection without
 * making any failure easier to diagnose.
 *
 * The counters now live on a single `c` object rather than as nine separate `let` bindings, so
 * `buildRunSummary` can read them from one place instead of the field list being written out
 * twice (once on the success path, once in the catch).
 */

import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { shouldIndexFile, type FilterDecision } from "./fileFilter.js";
import { GraphStore } from "../store/graphStore.js";
import { resolveHeadCommitSha, resolveCurrentBranch } from "../gitHelpers.js";
import { redactSensitive } from "../guardrails/indexGuardrails.js";
import { extractGraphData, isParseTimeoutError } from "../extractors/treeSitterExtractor.js";
import { ExtractionWorkerPool } from "../extractors/extractionWorkerPool.js";
import { extractDotnetProjectData } from "../extractors/dotnetProjectParser.js";
import { createIndexProgress, indexLog, indexWarn, type IndexProgress } from "./indexProgress.js";
import { resolveIndexRunLimits } from "./runLimits.js";
import { scanRepoFiles } from "./fileScan.js";
import {
  buildRunSummary,
  pruneAndResolve,
  rebuildVectorIndex,
  type RunCounters,
  type RunIdentity
} from "./runFinalize.js";
import type { IndexMode, IndexProgressSnapshot, IndexRunSummary } from "../types.js";

export type PerformanceProfile = "standard" | "large" | "very-large";

export type RunIndexInput = {
  repoId: string;
  repoPath: string;
  mode: IndexMode;
  performanceProfile?: PerformanceProfile;
  includeDocs?: boolean;
  maxFiles: number;
  batchSize?: number;
  /** Number of files per sub-transaction inside a batch. Default 20. */
  subtxSize?: number;
  /** Run WAL checkpoint after every N completed batches. Default 1 (every batch). */
  checkpointEveryNBatches?: number;
  /** Route files >= this size (bytes) to worker-lane extraction. Default 512KB. */
  largeFileThresholdBytes?: number;
  /** Hard cap on file size (bytes) — files larger than this are skipped. Default 500KB. Env: CODEBASE_INDEX_MAX_FILE_SIZE_BYTES. */
  maxFileSizeBytes?: number;
  /** Number of extraction workers for large-file lane. Default 2. */
  parseWorkers?: number;
  /** Per-job timeout for worker-lane extraction in milliseconds. Default 20s. */
  parseJobTimeoutMs?: number;
  onProgress?: (progress: IndexProgressSnapshot) => void;
  /**
   * Progress reporter (log gating + MCP notifications/progress). When supplied
   * by the caller it is driven across scan → index → resolve so updates stay
   * continuous and the caller owns stop(). When omitted the pipeline creates
   * and stops its own.
   */
  progress?: IndexProgress;
  abortSignal?: AbortSignal;
  /**
   * Dirty mode (ENH-A): when set, only files whose repo-relative POSIX path is in this
   * set are indexed, and stale-file/orphaned-edge pruning is suppressed (the restricted
   * scan is a subset of disk, so pruning would delete every unlisted file). Used by
   * index_repository(mode="dirty") to re-index just the git working-tree delta.
   */
  onlyRelativePaths?: Set<string>;
};

// v2: ISSUE-023 string-literal lane — bump buộc evaluateIncrementalSkip không skip để repo cũ repopulate lane.
export const INDEX_VERSION = "v2-string-literals";

export async function runIndexPipeline(store: GraphStore, input: RunIndexInput): Promise<IndexRunSummary> {
  const identity: RunIdentity = {
    runId: randomUUID(),
    repoId: input.repoId,
    commitSha: resolveHeadCommitSha(input.repoPath),
    branch: resolveCurrentBranch(input.repoPath),
    indexVersion: INDEX_VERSION,
    mode: input.mode,
    startedAt: new Date().toISOString()
  };
  const { runId, startedAt } = identity;
  const started = Date.now();

  store.ensureRepository(input.repoId, input.repoPath);

  const {
    maxFiles, includeDocs, batchSize, subtxSize, checkpointEveryNBatches,
    largeFileThresholdBytes, maxFileSizeBytes, parseWorkers, parseJobTimeoutMs, concurrencyLimit
  } = resolveIndexRunLimits(input);
  const workerPool = parseWorkers > 0 ? new ExtractionWorkerPool(parseWorkers, parseJobTimeoutMs) : null;

  // When the caller passes a progress controller it keeps ownership (stops it after
  // its own post-phase). Otherwise we own the one we create and stop it here.
  const ownsProgress = !input.progress;
  const progress = input.progress ?? createIndexProgress(input.repoId);
  progress.phase("scanning");

  const { files, knownPackageNames } = await scanRepoFiles(input, maxFiles, includeDocs);

  const c: RunCounters = {
    filesScanned: 0, filesIndexed: 0, filesSkipped: 0, symbolsUpserted: 0, edgesUpserted: 0,
    docsUpserted: 0, mentionsUpserted: 0, parseFailures: 0, parseTimeouts: 0
  };
  const languageStats = new Map<string, { scanned: number; indexed: number }>();

  const selectedFiles = files.slice(0, maxFiles);
  const totalFiles = selectedFiles.length;
  const totalBatches = Math.max(1, Math.ceil(totalFiles / batchSize));
  let completedBatches = 0;

  indexLog(`[index-ready] processing ${String(totalFiles)} files in ${String(totalBatches)} batches (batchSize=${String(batchSize)})`);
  progress.phase("indexing");
  progress.update({ totalFiles, filesScanned: 0, symbols: 0 });

  emitProgress("running");

  try {
    for (let offset = 0; offset < selectedFiles.length; offset += batchSize) {
      if (input.abortSignal?.aborted) {
        // Don't throw immediately - let current batch finish and commit
        progress.note("[index-cancelled] Finishing current batch before stopping...");
        break;
      }

      const batchFiles = selectedFiles.slice(offset, offset + batchSize);
      const extractStart = Date.now();
      const pendingWrites: Array<{
        file: {
          repoId: string;
          path: string;
          contentHash: string;
          language: string | null;
          updatedAt: string;
        };
        extracted: {
          symbols: import("../types.js").SymbolRecord[];
          edges: import("../types.js").EdgeRecord[];
          routes?: import("../types.js").RouteRecord[];
          docs?: import("../types.js").DocRecord[];
          mentions?: import("../types.js").DocMentionRecord[];
          literals?: import("../types.js").StringLiteralRecord[];
        };
      }> = [];
      const largeExtractionJobs: Array<Promise<{
        relativePath: string;
        language: string;
        contentHash: string;
        result: import("../extractors/extractionWorkerPool.js").WorkerExtractResult;
      }>> = [];

      const pushPendingWrite = (
        relativePath: string,
        language: string,
        contentHash: string,
        extracted: {
          symbols: import("../types.js").SymbolRecord[];
          edges: import("../types.js").EdgeRecord[];
          routes?: import("../types.js").RouteRecord[];
          docs?: import("../types.js").DocRecord[];
          mentions?: import("../types.js").DocMentionRecord[];
          literals?: import("../types.js").StringLiteralRecord[];
        }
      ): void => {
        pendingWrites.push({
          file: {
            repoId: input.repoId,
            path: relativePath,
            contentHash,
            language,
            updatedAt: new Date().toISOString()
          },
          extracted
        });

        c.filesIndexed += 1;
        c.symbolsUpserted += extracted.symbols.length;
        c.edgesUpserted += extracted.edges.length;
        if (includeDocs && extracted.docs) {
          c.docsUpserted += extracted.docs.length;
        }
        if (includeDocs && extracted.mentions) {
          c.mentionsUpserted += extracted.mentions.length;
        }

        const langStats = languageStats.get(language);
        if (langStats) {
          langStats.indexed += 1;
        }
      };

      // Parallel file reading with concurrency limit
      const fileResults: Array<PromiseSettledResult<{
        filePath: string;
        relativePath: string;
        bytes: Buffer;
        decision: FilterDecision;
      }>> = [];

      for (let i = 0; i < batchFiles.length; i += concurrencyLimit) {
        if (input.abortSignal?.aborted) {
          // Stop reading more files, but process what we have
          progress.note(`[index-cancelled] Stopping file reads, processing ${String(fileResults.length)} files already read...`);
          break;
        }

        const chunk = batchFiles.slice(i, i + concurrencyLimit);
        const chunkResults = await Promise.allSettled(
          chunk.map(async (filePath) => {
            const relativePath = path.relative(input.repoPath, filePath);

            // Early exit for incremental mode: check hash before reading full file
            if (input.mode === "incremental") {
              try {
                const stats = await import("node:fs/promises").then(m => m.stat(filePath));
                const quickHash = `${stats.size}-${stats.mtimeMs}`;
                const previousHash = store.getFileHash(input.repoId, relativePath);
                if (previousHash && previousHash.startsWith(quickHash)) {
                  return { filePath, relativePath, bytes: Buffer.from([]), decision: { include: false, reason: "unchanged_quick_check", language: null } as FilterDecision };
                }
              } catch {
                // Continue with normal flow
              }
            }

            const bytes = await readFile(filePath);
            const decision = shouldIndexFile(filePath, bytes, maxFileSizeBytes);
            
            return { filePath, relativePath, bytes, decision };
          })
        );
        fileResults.push(...chunkResults);
      }

      for (const result of fileResults) {
        if (input.abortSignal?.aborted) {
          // Stop processing more results, but commit what we have
          progress.note(`[index-cancelled] Stopping result processing, committing ${String(pendingWrites.length)} files...`);
          break;
        }

        c.filesScanned += 1;

        if (result.status === "rejected") {
          c.parseFailures += 1;
          continue;
        }

        const { relativePath, bytes, decision } = result.value;

        try {
          const language = decision.language;
          if (!decision.include || !language) {
            c.filesSkipped += 1;
            continue;
          }

          if (!includeDocs && language === "markdown") {
            c.filesSkipped += 1;
            continue;
          }

          // Track language stats
          const lang = language;
          if (!languageStats.has(lang)) {
            languageStats.set(lang, { scanned: 0, indexed: 0 });
          }
          const stats = languageStats.get(lang)!;
          stats.scanned += 1;

          const raw = bytes.toString("utf8");
          const safeContent = redactSensitive(raw);
          const contentHash = hashOf(safeContent);

          if (input.mode === "incremental") {
            const previousHash = store.getFileHash(input.repoId, relativePath);
            if (previousHash === contentHash) {
              c.filesSkipped += 1;
              continue;
            }
          }

          const isDotnetProject = decision.language === "csproj" || decision.language === "sln";
          if (isDotnetProject) {
            const extracted = extractDotnetProjectData({
              repoId: input.repoId,
              filePath: relativePath,
              language: language as "csproj" | "sln",
              source: safeContent
            });
            pushPendingWrite(relativePath, language, contentHash, extracted);
            continue;
          }

          const shouldUseWorkerLane =
            workerPool !== null &&
            language !== "markdown" &&
            Buffer.byteLength(safeContent, "utf8") >= largeFileThresholdBytes;

          if (shouldUseWorkerLane) {
            largeExtractionJobs.push(
              workerPool.extract({
                repoId: input.repoId,
                filePath: relativePath,
                language,
                source: safeContent,
                performanceProfile: input.performanceProfile,
                knownPackageNames: knownPackageNames.size > 0 ? knownPackageNames : undefined
              }).then((result) => ({
                relativePath,
                language,
                contentHash,
                result
              }))
            );
            continue;
          }

          const extracted = extractGraphData({
            repoId: input.repoId,
            filePath: relativePath,
            language,
            source: safeContent,
            performanceProfile: input.performanceProfile,
            knownPackageNames: knownPackageNames.size > 0 ? knownPackageNames : undefined
          });
          pushPendingWrite(relativePath, language, contentHash, extracted);
        } catch (err) {
          if (isParseTimeoutError(err)) {
            c.parseTimeouts += 1;
            indexLog(`[index-parse-timeout] ${relativePath}: ${err.message}`);
            continue;
          }

          c.parseFailures += 1;
          // A dropped file means missing symbols/edges in the graph — surface it
          // even in the default quiet mode, unlike routine narration.
          indexWarn(`[index-parse-failure] ${relativePath}: ${err instanceof Error ? err.message : String(err)}`);
        }

        // Emit progress every 10 files for smoother updates
        if (c.filesScanned % 10 === 0) {
          emitProgress("running");
          syncProgressBar();
        }
      }

      if (largeExtractionJobs.length > 0) {
        const largeResults = await Promise.all(largeExtractionJobs);
        for (const largeResult of largeResults) {
          if (largeResult.result.status === "ok") {
            if (largeResult.result.parseMs > 1500) {
              indexLog(`[index-slow-parse] ${largeResult.relativePath}: ${String(largeResult.result.parseMs)}ms`);
            }
            pushPendingWrite(
              largeResult.relativePath,
              largeResult.language,
              largeResult.contentHash,
              largeResult.result.output
            );
            continue;
          }

          if (largeResult.result.status === "timeout") {
            c.parseTimeouts += 1;
            if (largeResult.result.reason === "job-timeout") {
              indexLog(`[index-parse-timeout] ${largeResult.relativePath}: worker job timed out after ${String(parseJobTimeoutMs)}ms`);
            } else {
              indexLog(`[index-parse-timeout] ${largeResult.relativePath}: ${largeResult.result.error ?? "parse timed out"}`);
            }
            continue;
          }

          c.parseFailures += 1;
          indexWarn(`[index-parse-failure] ${largeResult.relativePath}: ${largeResult.result.error}`);
        }
      }

      // Split write workload into smaller transactions to reduce lock duration and WAL growth.
      const batchNum = completedBatches + 1;
      const extractMs = Date.now() - extractStart;
      const writeStart = Date.now();
      let subtxCount = 0;
      for (let writeOffset = 0; writeOffset < pendingWrites.length; writeOffset += subtxSize) {
        const chunk = pendingWrites.slice(writeOffset, writeOffset + subtxSize);
        store.runInTransaction(() => {
          for (const item of chunk) {
            store.upsertFile(item.file);
            store.replaceSymbolsForFile(input.repoId, item.file.path, item.extracted.symbols);
            store.replaceEdgesForFile(input.repoId, item.file.path, item.extracted.edges);
            store.replaceRoutesForFile(input.repoId, item.file.path, item.extracted.routes ?? []);
            store.replaceLiteralsForFile(input.repoId, item.file.path, item.extracted.literals ?? []);
            // Upsert docs and mentions if present (e.g., from markdown files)
            if (item.extracted.docs && item.extracted.docs.length > 0) {
              if (includeDocs) {
                store.upsertDocs(item.extracted.docs);
              }
            }
            if (item.extracted.mentions && item.extracted.mentions.length > 0) {
              if (includeDocs) {
                store.upsertDocMentions(item.extracted.mentions);
              }
            }
          }
        });
        subtxCount += 1;
      }
      const writeMs = Date.now() - writeStart;

      // Checkpoint every N completed batches to reduce WAL pressure without over-flushing.
      completedBatches += 1;
      let checkpointMs = 0;
      if (completedBatches % checkpointEveryNBatches === 0) {
        const cpStart = Date.now();
        store.checkpoint();
        checkpointMs = Date.now() - cpStart;
      }

      indexLog(
        `[index-write] batch=${String(batchNum)}/${String(totalBatches)} files=${String(pendingWrites.length)} subtx=${String(subtxCount)} extractMs=${String(extractMs)} writeMs=${String(writeMs)} checkpointMs=${String(checkpointMs)} symbols=${String(c.symbolsUpserted)} edges=${String(c.edgesUpserted)}`
      );
      emitProgress("running");
      syncProgressBar();

      // Check if cancelled after batch commit
      if (input.abortSignal?.aborted) {
        progress.note("[index-cancelled] Batch committed, stopping index run.");
        break;
      }
    }

    pruneAndResolve(store, input, progress, files, selectedFiles, maxFiles);
    const vectorSymbolsIndexed = rebuildVectorIndex(store, input.repoId, progress);

    const finishedAt = new Date().toISOString();
    const elapsedMs = Date.now() - started;
    const wasCancelled = input.abortSignal?.aborted ?? false;

    const summary = buildRunSummary(
      identity, c, wasCancelled ? "cancelled" : "ok", finishedAt, elapsedMs, vectorSymbolsIndexed
    );

    // Note: recordRun is called by the caller (index.ts) after computing resolution metrics
    emitProgress(wasCancelled ? "cancelled" : "ok", finishedAt);
    syncProgressBar();
    const elapsedSec = (Date.now() - started) / 1000;
    const doneLine = `[index-done] status=${wasCancelled ? "cancelled" : "ok"} indexed=${String(c.filesIndexed)} skipped=${String(c.filesSkipped)} failures=${String(c.parseFailures)} timeouts=${String(c.parseTimeouts)} symbols=${String(c.symbolsUpserted)} elapsed=${elapsedSec.toFixed(1)}s`;
    indexLog(doneLine);
    if (ownsProgress) {
      // No caller post-phase — finish the reporter with a concise summary here.
      const mark = wasCancelled ? "⚠" : "✓";
      progress.stop(`${mark} index ${input.repoId} · ${wasCancelled ? "cancelled" : "done"} · ${String(c.filesIndexed)} files · ${String(c.symbolsUpserted)} symbols · ${elapsedSec.toFixed(1)}s`);
    } else {
      // Caller continues into its edge-resolution post-phase; keep reporting.
      progress.phase("resolving edges");
    }
    return summary;
  } catch (error) {
    const finishedAt = new Date().toISOString();
    const elapsedMs = Date.now() - started;
    const isCancelled = error instanceof Error && error.message === "INDEX_CANCELLED";

    const summary = buildRunSummary(
      identity, c, isCancelled ? "cancelled" : "failed", finishedAt, elapsedMs
    );

    store.recordRun(summary);
    emitProgress(isCancelled ? "cancelled" : "failed", finishedAt, error instanceof Error ? error.message : "Unknown index failure");
    // The run ended here (post-phase will not run), so always finish reporting.
    if (isCancelled) {
      progress.stop(`⚠ index ${input.repoId} · cancelled · ${String(c.filesIndexed)} files · ${String(c.symbolsUpserted)} symbols`);
    } else {
      const msg = error instanceof Error ? error.message : "Unknown index failure";
      progress.stop(`✗ index ${input.repoId} · failed · ${msg}`);
    }
    throw error;
  } finally {
    if (workerPool) {
      await workerPool.dispose();
    }
  }

  function emitProgress(
    status: "running" | "ok" | "failed" | "cancelled",
    finishedAtArg?: string,
    errorMessage?: string
  ): void {
    if (!input.onProgress) {
      return;
    }

    const elapsedMs = Date.now() - started;
    const elapsedSeconds = elapsedMs / 1000;
    
    // Calculate ETA
    let etaSeconds: number | undefined;
    if (status === "running" && c.filesScanned > 0 && totalFiles > c.filesScanned) {
      const filesPerSecond = c.filesScanned / elapsedSeconds;
      const remainingFiles = totalFiles - c.filesScanned;
      etaSeconds = Math.round(remainingFiles / filesPerSecond);
    }

    // Convert language stats to plain object
    const byLanguage: Record<string, { scanned: number; indexed: number }> = {};
    for (const [lang, stats] of languageStats.entries()) {
      byLanguage[lang] = { ...stats };
    }

    input.onProgress({
      runId,
      repoId: input.repoId,
      mode: input.mode,
      status,
      startedAt,
      finishedAt: finishedAtArg,
      totalFiles,
      filesScanned: c.filesScanned,
      filesIndexed: c.filesIndexed,
      filesSkipped: c.filesSkipped,
      symbolsUpserted: c.symbolsUpserted,
      edgesUpserted: c.edgesUpserted,
      parseFailures: c.parseFailures,
      parseTimeouts: c.parseTimeouts,
      batchSize,
      completedBatches,
      totalBatches,
      elapsedMs,
      etaSeconds,
      byLanguage: Object.keys(byLanguage).length > 0 ? byLanguage : undefined,
      errorMessage
    });
  }

  // Push the current counters into the progress reporter. Cheap and throttled
  // downstream, so it is safe to call every batch / every 10 files.
  function syncProgressBar(): void {
    progress.update({
      filesScanned: c.filesScanned,
      totalFiles,
      symbols: c.symbolsUpserted,
    });
  }
}

function hashOf(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}
