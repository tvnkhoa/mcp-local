import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { glob } from "glob";

import { shouldIndexFile, type FilterDecision } from "./fileFilter.js";
import { GraphStore } from "./graphStore.js";
import { resolveHeadCommitSha, resolveCurrentBranch } from "./gitHelpers.js";
import { clamp, redactSensitive } from "./indexGuardrails.js";
import { extractGraphData, isParseTimeoutError } from "./treeSitterExtractor.js";
import { ExtractionWorkerPool } from "./extractionWorkerPool.js";
import { extractDotnetProjectData } from "./dotnetProjectParser.js";
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
  abortSignal?: AbortSignal;
  /**
   * Dirty mode (ENH-A): when set, only files whose repo-relative POSIX path is in this
   * set are indexed, and stale-file/orphaned-edge pruning is suppressed (the restricted
   * scan is a subset of disk, so pruning would delete every unlisted file). Used by
   * index_repository(mode="dirty") to re-index just the git working-tree delta.
   */
  onlyRelativePaths?: Set<string>;
};

export async function runIndexPipeline(store: GraphStore, input: RunIndexInput): Promise<IndexRunSummary> {
  const runId = randomUUID();
  const startedAt = new Date().toISOString();
  const started = Date.now();
  const indexVersion = "v1-tree-sitter-property-edges";
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
  
  process.stderr.write(`[index-start] repoId=${input.repoId} mode=${input.mode} scanning files...\n`);
  
  const globbed = await glob("**/*", {
    cwd: input.repoPath,
    nodir: true,
    absolute: true,
    windowsPathsNoEscape: true,
    ignore: [
      "**/node_modules/**",
      "**/dist/**",
      "**/build/**",
      "**/.git/**",
      "**/coverage/**",
      "**/*.log",
      "**/*.lock",
      "**/package-lock.json",
      "**/yarn.lock",
      "**/pnpm-lock.yaml"
    ]
  });

  // Dirty mode (ENH-A): restrict the scan to an explicit set of repo-relative POSIX
  // paths (the git working-tree delta). When set, pruning is suppressed below so the
  // restricted set is never mistaken for "all files on disk".
  const files = input.onlyRelativePaths
    ? globbed.filter((abs) =>
        input.onlyRelativePaths!.has(path.relative(input.repoPath, abs).replace(/\\/g, "/"))
      )
    : globbed;

  process.stderr.write(`[index-scan-complete] found ${String(files.length)} files${input.onlyRelativePaths ? ` (restricted from ${String(globbed.length)} by dirty file set)` : ""}, will process up to ${String(maxFiles)}\n`);

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
      process.stderr.write(`[index-nuget-bridge] collected ${String(knownPackageNames.size)} package names from ${String(csprojFiles.length)} .csproj files\n`);
    }
  }

  if (includeDocs) {
    // Count markdown files for user feedback
    const markdownFiles = files.filter((f) => f.endsWith(".md") || f.endsWith(".mdx"));
    if (markdownFiles.length > 0) {
      process.stderr.write(`[index-scan] found ${String(markdownFiles.length)} markdown files for doc indexing\n`);
    }
  } else {
    process.stderr.write("[index-scan] docs lane disabled for this run (markdown/docs indexing skipped)\n");
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
  let lastProgressLogAt = 0;
  let lastProgressLogFiles = -1;

  process.stderr.write(`[index-ready] processing ${String(totalFiles)} files in ${String(totalBatches)} batches (batchSize=${String(batchSize)})\n`);

  emitProgress("running");

  try {
    for (let offset = 0; offset < selectedFiles.length; offset += batchSize) {
      if (input.abortSignal?.aborted) {
        // Don't throw immediately - let current batch finish and commit
        process.stderr.write(`\n[index-cancelled] Finishing current batch before stopping...\n`);
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
        process.stderr.write(`\n[index-cancelled] Stopping file reads, processing ${String(fileResults.length)} files already read...\n`);
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
          process.stderr.write(`\n[index-cancelled] Stopping result processing, committing ${String(pendingWrites.length)} files...\n`);
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
            process.stderr.write(`[index-parse-timeout] ${relativePath}: ${err.message}\n`);
            continue;
          }

          parseFailures += 1;
          process.stderr.write(`[index-parse-failure] ${relativePath}: ${err instanceof Error ? err.message : String(err)}\n`);
        }

        // Emit progress every 10 files for smoother updates
        if (filesScanned % 10 === 0) {
          emitProgress("running");
          writeTerminalProgress();
        }
      }

      if (largeExtractionJobs.length > 0) {
        const largeResults = await Promise.all(largeExtractionJobs);
        for (const largeResult of largeResults) {
          if (largeResult.result.status === "ok") {
            if (largeResult.result.parseMs > 1500) {
              process.stderr.write(`[index-slow-parse] ${largeResult.relativePath}: ${String(largeResult.result.parseMs)}ms\n`);
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
              process.stderr.write(`[index-parse-timeout] ${largeResult.relativePath}: worker job timed out after ${String(parseJobTimeoutMs)}ms\n`);
            } else {
              process.stderr.write(`[index-parse-timeout] ${largeResult.relativePath}: ${largeResult.result.error ?? "parse timed out"}\n`);
            }
            continue;
          }

          parseFailures += 1;
          process.stderr.write(`[index-parse-failure] ${largeResult.relativePath}: ${largeResult.result.error}\n`);
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

      process.stderr.write(
        `[index-write] batch=${String(batchNum)}/${String(totalBatches)} files=${String(pendingWrites.length)} subtx=${String(subtxCount)} extractMs=${String(extractMs)} writeMs=${String(writeMs)} checkpointMs=${String(checkpointMs)} symbols=${String(symbolsUpserted)} edges=${String(edgesUpserted)}
`
      );
      emitProgress("running");
      writeTerminalProgress();

      // Check if cancelled after batch commit
      if (input.abortSignal?.aborted) {
        process.stderr.write(`\n[index-cancelled] Batch committed, stopping index run.\n`);
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
      if (scanWasComplete) {
        const currentPaths = selectedFiles.map((f) => path.relative(input.repoPath, f));
        const pruned = store.pruneStaleFiles(input.repoId, currentPaths);
        if (pruned > 0) {
          process.stderr.write(`[index-prune] removed ${String(pruned)} stale file(s) from index\n`);
        }
        const prunedEdges = store.pruneOrphanedEdges(input.repoId);
        if (prunedEdges > 0) {
          process.stderr.write(`[index-prune] removed ${String(prunedEdges)} orphaned edge(s) from index\n`);
        }
      } else if (input.onlyRelativePaths) {
        process.stderr.write(`[index-prune-skipped] dirty mode re-indexed ${String(files.length)} changed file(s) — pruning and IMPLEMENTS resolution skipped (subset scan)\n`);
      } else {
        process.stderr.write(`[index-prune-skipped] repo has ${String(files.length)} files, exceeds cap of ${String(maxFiles)} — stale-file cleanup and IMPLEMENTS resolution skipped to avoid false deletions\n`);
      }
      // Resolve iface: placeholders → real symbolIds after all C# files have been indexed.
      // Skipped when scan was capped: prune didn't run so stale symbols may still be present,
      // and resolving against them would create dangling IMPLEMENTS edges.
      if (input.mode === "full" && scanWasComplete) {
        const resolvedImpl = store.resolveImplementsEdges(input.repoId);
        if (resolvedImpl > 0) {
          process.stderr.write(`[index-resolve] resolved ${String(resolvedImpl)} IMPLEMENTS edge(s)\n`);
        }
        // ISSUE-020: match message-bus PUBLISHES/CONSUMES contract tokens producer→consumer.
        const resolvedBus = store.resolvePublishesConsumesEdges(input.repoId);
        if (resolvedBus > 0) {
          process.stderr.write(`[index-resolve] resolved ${String(resolvedBus)} PUBLISHES bus edge(s)\n`);
        }
      }
    }

    // Post-index: rebuild vector index (async step, does not block pipeline result)
    let vectorSymbolsIndexed = 0;
    if (store.isVectorEnabled) {
      const vecStart = Date.now();
      process.stderr.write("[index-vector] rebuilding vector index...\n");
      try {
        vectorSymbolsIndexed = store.rebuildVectorIndex(input.repoId);
        const vecMs = Date.now() - vecStart;
        process.stderr.write(`[index-vector] indexed ${String(vectorSymbolsIndexed)} symbols in ${String(vecMs)}ms\n`);
      } catch (vecErr) {
        process.stderr.write(`[index-vector] rebuild failed (non-fatal): ${vecErr instanceof Error ? vecErr.message : String(vecErr)}\n`);
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
    writeTerminalProgress(true);
    const elapsedSec = (Date.now() - started) / 1000;
    process.stderr.write(`[index-done] status=${wasCancelled ? "cancelled" : "ok"} indexed=${String(filesIndexed)} skipped=${String(filesSkipped)} failures=${String(parseFailures)} timeouts=${String(parseTimeouts)} symbols=${String(symbolsUpserted)} elapsed=${elapsedSec.toFixed(1)}s\n`);
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
    writeTerminalProgress(true);
    if (!isCancelled) {
      process.stderr.write(`[index-error] ${error instanceof Error ? error.message : "Unknown index failure"}\n`);
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

  function writeTerminalProgress(final = false): void {
    const percent = totalFiles === 0 ? 100 : Math.round((filesScanned / totalFiles) * 100);
    const filled = Math.round(percent / 5);
    const bar = "█".repeat(filled) + "░".repeat(20 - filled);

    const elapsedMs = Date.now() - started;
    const elapsedSeconds = elapsedMs / 1000;
    let eta = "";
    if (!final && filesScanned > 0 && totalFiles > filesScanned) {
      const fps = filesScanned / elapsedSeconds;
      const remaining = Math.round((totalFiles - filesScanned) / fps);
      eta = ` | ETA ${remaining}s`;
    }

    const topLangs = [...languageStats.entries()]
      .sort((a, b) => b[1].indexed - a[1].indexed)
      .slice(0, 3)
      .map(([lang, s]) => `${lang}=${String(s.indexed)}`)
      .join(" ");
    const langSuffix = topLangs ? ` | ${topLangs}` : "";

    const line = `[${bar}] ${String(percent).padStart(3)}% | ${String(filesScanned)}/${String(totalFiles)} files | ${String(symbolsUpserted)} symbols${eta}${langSuffix}`;

    const now = Date.now();
    const enoughTimeElapsed = now - lastProgressLogAt >= 2000;
    const enoughFilesAdvanced = filesScanned - lastProgressLogFiles >= 200;
    const shouldLogLine = final || enoughTimeElapsed || enoughFilesAdvanced || filesScanned === 0 || filesScanned === totalFiles;

    if (!shouldLogLine) {
      return;
    }

    lastProgressLogAt = now;
    lastProgressLogFiles = filesScanned;

    const filesPerSecond = elapsedSeconds > 0 ? (filesScanned / elapsedSeconds).toFixed(1) : "0.0";
    const symbolsPerSecond = elapsedSeconds > 0 ? (symbolsUpserted / elapsedSeconds).toFixed(1) : "0.0";
    process.stderr.write(`[index-progress] ${line} | ${filesPerSecond} files/s | ${symbolsPerSecond} symbols/s\n`);
  }
}

function hashOf(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}
