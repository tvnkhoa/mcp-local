import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { glob } from "glob";

import { shouldIndexFile, INDEX_IGNORE_GLOBS, type FilterDecision } from "./fileFilter.js";
import { GraphStore } from "./graphStore.js";
import { resolveHeadCommitSha, resolveCurrentBranch } from "./gitHelpers.js";
import { clamp, redactSensitive } from "./guardrails/indexGuardrails.js";
import { extractGraphData, isParseTimeoutError } from "./treeSitterExtractor.js";
import { ExtractionWorkerPool } from "./extractionWorkerPool.js";
import { extractDotnetProjectData } from "./dotnetProjectParser.js";
import { createIndexProgress, indexLog, indexWarn, type IndexProgress } from "./indexProgress.js";
import type { IndexMode, IndexProgressSnapshot, IndexRunSummary } from "./types.js";

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
  const runId = randomUUID();
  const startedAt = new Date().toISOString();
  const started = Date.now();
  const indexVersion = INDEX_VERSION;
  const commitSha = resolveHeadCommitSha(input.repoPath);
  const branch = resolveCurrentBranch(input.repoPath);

  store.ensureRepository(input.repoId, input.repoPath);

  const maxFiles = clamp(input.maxFiles, 1, 200_000);
  const includeDocs = input.includeDocs ?? true;
  const batchSize = clamp(input.batchSize ?? 200, 1, 2_000);
  const subtxSize = clamp(input.subtxSize ?? 20, 1, 500);
  const checkpointEveryNBatches = Math.max(1, input.checkpointEveryNBatches ?? 1);
  const largeFileThresholdBytes = Math.max(0, input.largeFileThresholdBytes ?? 512 * 1024);
  const maxFileSizeBytes = Math.max(10_000, input.maxFileSizeBytes ?? 500_000);
  const parseWorkers = clamp(input.parseWorkers ?? 2, 0, 32);
  const parseJobTimeoutMs = clamp(input.parseJobTimeoutMs ?? 20_000, 1_000, 120_000);
  const concurrencyLimit = 50; // Limit parallel file reads
  const workerPool = parseWorkers > 0 ? new ExtractionWorkerPool(parseWorkers, parseJobTimeoutMs) : null;

  // When the caller passes a progress controller it keeps ownership (stops it after
  // its own post-phase). Otherwise we own the one we create and stop it here.
  const ownsProgress = !input.progress;
  const progress = input.progress ?? createIndexProgress(input.repoId);
  progress.phase("scanning");
  indexLog(`[index-start] repoId=${input.repoId} mode=${input.mode} scanning files...`);

  const globbed = await glob("**/*", {
    cwd: input.repoPath,
    nodir: true,
    absolute: true,
    windowsPathsNoEscape: true,
    ignore: INDEX_IGNORE_GLOBS
  });

  // Dirty mode (ENH-A): restrict the scan to an explicit set of repo-relative POSIX
  // paths (the git working-tree delta). When set, pruning is suppressed below so the
  // restricted set is never mistaken for "all files on disk".
  const files = input.onlyRelativePaths
    ? globbed.filter((abs) =>
        input.onlyRelativePaths!.has(path.relative(input.repoPath, abs).replace(/\\/g, "/"))
      )
    : globbed;

  indexLog(`[index-scan-complete] found ${String(files.length)} files${input.onlyRelativePaths ? ` (restricted from ${String(globbed.length)} by dirty file set)` : ""}, will process up to ${String(maxFiles)}`);

  // Pre-scan: collect all PackageReference names from .csproj files so C# extractors
  // can widen namespace→nuget contract mapping beyond the hardcoded set. (ISSUE-006)
  const knownPackageNames = new Set<string>();
  const csprojFiles = files.filter((f) => f.endsWith(".csproj"));
  if (csprojFiles.length > 0) {
    const pkgRefRe = /<PackageReference\s+Include="([^"]+)"/gi;
    for (const csprojPath of csprojFiles) {
      try {
        const src = await readFile(csprojPath, "utf8");
        let m: RegExpExecArray | null;
        pkgRefRe.lastIndex = 0;
        while ((m = pkgRefRe.exec(src)) !== null) {
          if (m[1]) knownPackageNames.add(m[1].trim());
        }
      } catch {
        // Non-critical — skip unreadable csproj
      }
    }
    if (knownPackageNames.size > 0) {
      indexLog(`[index-nuget-bridge] collected ${String(knownPackageNames.size)} package names from ${String(csprojFiles.length)} .csproj files`);
    }
  }

  if (includeDocs) {
    // Count markdown files for user feedback
    const markdownFiles = files.filter((f) => f.endsWith(".md") || f.endsWith(".mdx"));
    if (markdownFiles.length > 0) {
      indexLog(`[index-scan] found ${String(markdownFiles.length)} markdown files for doc indexing`);
    }
  } else {
    indexLog("[index-scan] docs lane disabled for this run (markdown/docs indexing skipped)");
  }

  let filesScanned = 0;
  let filesIndexed = 0;
  let filesSkipped = 0;
  let symbolsUpserted = 0;
  let edgesUpserted = 0;
  let docsUpserted = 0;
  let mentionsUpserted = 0;
  let parseFailures = 0;
  let parseTimeouts = 0;
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
          symbols: import("./types.js").SymbolRecord[];
          edges: import("./types.js").EdgeRecord[];
          routes?: import("./types.js").RouteRecord[];
          docs?: import("./types.js").DocRecord[];
          mentions?: import("./types.js").DocMentionRecord[];
          literals?: import("./types.js").StringLiteralRecord[];
        };
      }> = [];
      const largeExtractionJobs: Array<Promise<{
        relativePath: string;
        language: string;
        contentHash: string;
        result: import("./extractionWorkerPool.js").WorkerExtractResult;
      }>> = [];

      const pushPendingWrite = (
        relativePath: string,
        language: string,
        contentHash: string,
        extracted: {
          symbols: import("./types.js").SymbolRecord[];
          edges: import("./types.js").EdgeRecord[];
          routes?: import("./types.js").RouteRecord[];
          docs?: import("./types.js").DocRecord[];
          mentions?: import("./types.js").DocMentionRecord[];
          literals?: import("./types.js").StringLiteralRecord[];
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

        filesIndexed += 1;
        symbolsUpserted += extracted.symbols.length;
        edgesUpserted += extracted.edges.length;
        if (includeDocs && extracted.docs) {
          docsUpserted += extracted.docs.length;
        }
        if (includeDocs && extracted.mentions) {
          mentionsUpserted += extracted.mentions.length;
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

        filesScanned += 1;

        if (result.status === "rejected") {
          parseFailures += 1;
          continue;
        }

        const { relativePath, bytes, decision } = result.value;

        try {
          const language = decision.language;
          if (!decision.include || !language) {
            filesSkipped += 1;
            continue;
          }

          if (!includeDocs && language === "markdown") {
            filesSkipped += 1;
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
              filesSkipped += 1;
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
            parseTimeouts += 1;
            indexLog(`[index-parse-timeout] ${relativePath}: ${err.message}`);
            continue;
          }

          parseFailures += 1;
          // A dropped file means missing symbols/edges in the graph — surface it
          // even in the default quiet mode, unlike routine narration.
          indexWarn(`[index-parse-failure] ${relativePath}: ${err instanceof Error ? err.message : String(err)}`);
        }

        // Emit progress every 10 files for smoother updates
        if (filesScanned % 10 === 0) {
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
            parseTimeouts += 1;
            if (largeResult.result.reason === "job-timeout") {
              indexLog(`[index-parse-timeout] ${largeResult.relativePath}: worker job timed out after ${String(parseJobTimeoutMs)}ms`);
            } else {
              indexLog(`[index-parse-timeout] ${largeResult.relativePath}: ${largeResult.result.error ?? "parse timed out"}`);
            }
            continue;
          }

          parseFailures += 1;
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
        `[index-write] batch=${String(batchNum)}/${String(totalBatches)} files=${String(pendingWrites.length)} subtx=${String(subtxCount)} extractMs=${String(extractMs)} writeMs=${String(writeMs)} checkpointMs=${String(checkpointMs)} symbols=${String(symbolsUpserted)} edges=${String(edgesUpserted)}`
      );
      emitProgress("running");
      syncProgressBar();

      // Check if cancelled after batch commit
      if (input.abortSignal?.aborted) {
        progress.note("[index-cancelled] Batch committed, stopping index run.");
        break;
      }
    }

    // Prune stale files (both full and incremental) only when the glob returned every file on disk.
    // A capped scan (files.length > maxFiles) cannot safely prune: the missing tail would look
    // like deletions. resolveImplementsEdges is also skipped in that case to avoid resolving
    // placeholder edges against stale symbols that prune would have removed.
    // Dirty mode (ENH-A) restricts `files` to a subset of disk, so it is NEVER a complete
    // scan — pruning would delete every file not in the dirty set. Force-suppress here.
    const scanWasComplete = files.length <= maxFiles && !input.onlyRelativePaths;
    if (!input.abortSignal?.aborted) {
      progress.phase("pruning");
      if (scanWasComplete) {
        const currentPaths = selectedFiles.map((f) => path.relative(input.repoPath, f));
        const pruned = store.pruneStaleFiles(input.repoId, currentPaths);
        if (pruned > 0) {
          indexLog(`[index-prune] removed ${String(pruned)} stale file(s) from index`);
        }
        const prunedEdges = store.pruneOrphanedEdges(input.repoId);
        if (prunedEdges > 0) {
          indexLog(`[index-prune] removed ${String(prunedEdges)} orphaned edge(s) from index`);
        }
      } else if (input.onlyRelativePaths) {
        indexLog(`[index-prune-skipped] dirty mode re-indexed ${String(files.length)} changed file(s) — pruning and IMPLEMENTS resolution skipped (subset scan)`);
      } else {
        indexLog(`[index-prune-skipped] repo has ${String(files.length)} files, exceeds cap of ${String(maxFiles)} — stale-file cleanup and IMPLEMENTS resolution skipped to avoid false deletions`);
      }
      // Resolve iface: placeholders → real symbolIds after all C# files have been indexed.
      // Skipped when scan was capped: prune didn't run so stale symbols may still be present,
      // and resolving against them would create dangling IMPLEMENTS edges.
      if (input.mode === "full" && scanWasComplete) {
        const resolvedImpl = store.resolveImplementsEdges(input.repoId);
        if (resolvedImpl > 0) {
          indexLog(`[index-resolve] resolved ${String(resolvedImpl)} IMPLEMENTS edge(s)`);
        }
        // ISSUE-020: match message-bus PUBLISHES/CONSUMES contract tokens producer→consumer.
        const resolvedBus = store.resolvePublishesConsumesEdges(input.repoId);
        if (resolvedBus > 0) {
          indexLog(`[index-resolve] resolved ${String(resolvedBus)} PUBLISHES bus edge(s)`);
        }
      }
    }

    // Post-index: rebuild vector index (async step, does not block pipeline result)
    let vectorSymbolsIndexed = 0;
    if (store.isVectorEnabled) {
      const vecStart = Date.now();
      progress.phase("vector index");
      indexLog("[index-vector] rebuilding vector index...");
      try {
        vectorSymbolsIndexed = store.rebuildVectorIndex(input.repoId);
        const vecMs = Date.now() - vecStart;
        indexLog(`[index-vector] indexed ${String(vectorSymbolsIndexed)} symbols in ${String(vecMs)}ms`);
      } catch (vecErr) {
        indexWarn(`[index-vector] rebuild failed (non-fatal): ${vecErr instanceof Error ? vecErr.message : String(vecErr)}`);
      }
    }

    const finishedAt = new Date().toISOString();
    const elapsedMs = Date.now() - started;
    const wasCancelled = input.abortSignal?.aborted ?? false;

    const summary: IndexRunSummary = {
      runId,
      repoId: input.repoId,
      commitSha,
      branch,
      indexVersion,
      mode: input.mode,
      status: wasCancelled ? "cancelled" : "ok",
      startedAt,
      finishedAt,
      filesScanned,
      filesIndexed,
      filesSkipped,
      symbolsUpserted,
      edgesUpserted,
      docsUpserted,
      mentionsUpserted,
      parseFailures,
      parseTimeouts,
      elapsedMs,
      vectorSymbolsIndexed,
    };

    // Note: recordRun is called by the caller (index.ts) after computing resolution metrics
    emitProgress(wasCancelled ? "cancelled" : "ok", finishedAt);
    syncProgressBar();
    const elapsedSec = (Date.now() - started) / 1000;
    const doneLine = `[index-done] status=${wasCancelled ? "cancelled" : "ok"} indexed=${String(filesIndexed)} skipped=${String(filesSkipped)} failures=${String(parseFailures)} timeouts=${String(parseTimeouts)} symbols=${String(symbolsUpserted)} elapsed=${elapsedSec.toFixed(1)}s`;
    indexLog(doneLine);
    if (ownsProgress) {
      // No caller post-phase — finish the reporter with a concise summary here.
      const mark = wasCancelled ? "⚠" : "✓";
      progress.stop(`${mark} index ${input.repoId} · ${wasCancelled ? "cancelled" : "done"} · ${String(filesIndexed)} files · ${String(symbolsUpserted)} symbols · ${elapsedSec.toFixed(1)}s`);
    } else {
      // Caller continues into its edge-resolution post-phase; keep reporting.
      progress.phase("resolving edges");
    }
    return summary;
  } catch (error) {
    const finishedAt = new Date().toISOString();
    const elapsedMs = Date.now() - started;
    const isCancelled = error instanceof Error && error.message === "INDEX_CANCELLED";

    const summary: IndexRunSummary = {
      runId,
      repoId: input.repoId,
      commitSha,
      branch,
      indexVersion,
      mode: input.mode,
      status: isCancelled ? "cancelled" : "failed",
      startedAt,
      finishedAt,
      filesScanned,
      filesIndexed,
      filesSkipped,
      symbolsUpserted,
      edgesUpserted,
      docsUpserted,
      mentionsUpserted,
      parseFailures,
      parseTimeouts,
      elapsedMs
    };

    store.recordRun(summary);
    emitProgress(isCancelled ? "cancelled" : "failed", finishedAt, error instanceof Error ? error.message : "Unknown index failure");
    // The run ended here (post-phase will not run), so always finish reporting.
    if (isCancelled) {
      progress.stop(`⚠ index ${input.repoId} · cancelled · ${String(filesIndexed)} files · ${String(symbolsUpserted)} symbols`);
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
    if (status === "running" && filesScanned > 0 && totalFiles > filesScanned) {
      const filesPerSecond = filesScanned / elapsedSeconds;
      const remainingFiles = totalFiles - filesScanned;
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
      filesScanned,
      filesIndexed,
      filesSkipped,
      symbolsUpserted,
      edgesUpserted,
      parseFailures,
      parseTimeouts,
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
      filesScanned,
      totalFiles,
      symbols: symbolsUpserted,
    });
  }
}

function hashOf(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}
