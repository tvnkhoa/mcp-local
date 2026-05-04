import { execSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { glob } from "glob";

import { shouldIndexFile, type FilterDecision } from "./fileFilter.js";
import { GraphStore } from "./graphStore.js";
import { clamp, redactSensitive } from "./indexGuardrails.js";
import { extractGraphData } from "./treeSitterExtractor.js";
import type { IndexMode, IndexProgressSnapshot, IndexRunSummary } from "./types.js";

export type RunIndexInput = {
  repoId: string;
  repoPath: string;
  mode: IndexMode;
  maxFiles: number;
  batchSize?: number;
  onProgress?: (progress: IndexProgressSnapshot) => void;
  abortSignal?: AbortSignal;
};

function resolveCommitSha(repoPath: string): string | null {
  try {
    return execSync("git rev-parse HEAD", { cwd: repoPath, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

export async function runIndexPipeline(store: GraphStore, input: RunIndexInput): Promise<IndexRunSummary> {
  const runId = randomUUID();
  const startedAt = new Date().toISOString();
  const started = Date.now();
  const indexVersion = "v1-tree-sitter-magika";
  const commitSha = resolveCommitSha(input.repoPath);

  store.ensureRepository(input.repoId, input.repoPath);

  const maxFiles = clamp(input.maxFiles, 1, 200_000);
  const batchSize = clamp(input.batchSize ?? 200, 1, 2_000);
  const concurrencyLimit = 50; // Limit parallel file reads
  
  process.stdout.write(`[index-start] repoId=${input.repoId} mode=${input.mode} scanning files...\n`);
  
  const files = await glob("**/*", {
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

  process.stdout.write(`[index-scan-complete] found ${String(files.length)} files, will process up to ${String(maxFiles)}\n`);

  let filesScanned = 0;
  let filesIndexed = 0;
  let filesSkipped = 0;
  let symbolsUpserted = 0;
  let edgesUpserted = 0;
  let parseFailures = 0;
  const languageStats = new Map<string, { scanned: number; indexed: number }>();

  const selectedFiles = files.slice(0, maxFiles);
  const totalFiles = selectedFiles.length;
  const totalBatches = Math.max(1, Math.ceil(totalFiles / batchSize));
  let completedBatches = 0;

  process.stdout.write(`[index-ready] processing ${String(totalFiles)} files in ${String(totalBatches)} batches (batchSize=${String(batchSize)})\n`);

  emitProgress("running");

  try {
    for (let offset = 0; offset < selectedFiles.length; offset += batchSize) {
      if (input.abortSignal?.aborted) {
        // Don't throw immediately - let current batch finish and commit
        process.stdout.write(`[index-cancelled] Finishing current batch before stopping...\n`);
        break;
      }

      const batchFiles = selectedFiles.slice(offset, offset + batchSize);
      const pendingWrites: Array<{
        file: {
          repoId: string;
          path: string;
          contentHash: string;
          language: string | null;
          updatedAt: string;
        };
        extracted: ReturnType<typeof extractGraphData>;
      }> = [];

      // Parallel file reading with concurrency limit
      const fileResults: Array<PromiseSettledResult<{
        filePath: string;
        relativePath: string;
        bytes: Buffer;
        decision: Awaited<ReturnType<typeof shouldIndexFile>>;
      }>> = [];

      for (let i = 0; i < batchFiles.length; i += concurrencyLimit) {
        if (input.abortSignal?.aborted) {
          // Stop reading more files, but process what we have
          process.stdout.write(`[index-cancelled] Stopping file reads, processing ${String(fileResults.length)} files already read...\n`);
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
                  return { filePath, relativePath, bytes: Buffer.from([]), decision: { include: false, reason: "unchanged_quick_check", language: null, classifierLabel: null } as FilterDecision };
                }
              } catch {
                // Continue with normal flow
              }
            }

            const bytes = await readFile(filePath);
            const decision = await shouldIndexFile(filePath, bytes);
            
            return { filePath, relativePath, bytes, decision };
          })
        );
        fileResults.push(...chunkResults);
      }

      for (const result of fileResults) {
        if (input.abortSignal?.aborted) {
          // Stop processing more results, but commit what we have
          process.stdout.write(`[index-cancelled] Stopping result processing, committing ${String(pendingWrites.length)} files...\n`);
          break;
        }

        filesScanned += 1;

        if (result.status === "rejected") {
          parseFailures += 1;
          continue;
        }

        const { relativePath, bytes, decision } = result.value;

        try {
          if (!decision.include || !decision.language) {
            filesSkipped += 1;
            continue;
          }

          // Track language stats
          const lang = decision.language;
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

          const extracted = extractGraphData({
            repoId: input.repoId,
            filePath: relativePath,
            language: decision.language,
            source: safeContent
          });

          pendingWrites.push({
            file: {
              repoId: input.repoId,
              path: relativePath,
              contentHash,
              language: decision.language,
              updatedAt: new Date().toISOString()
            },
            extracted
          });

          filesIndexed += 1;
          symbolsUpserted += extracted.symbols.length;
          edgesUpserted += extracted.edges.length;
          
          // Update language indexed count
          const langStats = languageStats.get(decision.language)!;
          langStats.indexed += 1;
        } catch {
          parseFailures += 1;
        }

        // Emit progress every 10 files for smoother updates
        if (filesScanned % 10 === 0) {
          emitProgress("running");
        }
      }

      store.runInTransaction(() => {
        for (const item of pendingWrites) {
          store.upsertFile(item.file);
          store.replaceSymbolsForFile(input.repoId, item.file.path, item.extracted.symbols);
          if (item.extracted.symbols.length > 0) {
            store.replaceEdgesForFile(input.repoId, item.extracted.symbols[0].symbolId, item.extracted.edges);
          }
        }
      });

      completedBatches += 1;
      emitProgress("running");
      writeTerminalProgress();
      
      // Log batch completion for debugging
      if (pendingWrites.length > 0) {
        process.stdout.write(
          `[batch-complete] batch=${String(completedBatches)} wrote=${String(pendingWrites.length)} files, total indexed=${String(filesIndexed)}\n`
        );
      }

      // Check if cancelled after batch commit
      if (input.abortSignal?.aborted) {
        process.stdout.write(`[index-cancelled] Batch committed, stopping index run.\n`);
        break;
      }
    }

    const finishedAt = new Date().toISOString();
    const elapsedMs = Date.now() - started;
    const wasCancelled = input.abortSignal?.aborted ?? false;

    const summary: IndexRunSummary = {
      runId,
      repoId: input.repoId,
      commitSha,
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
      parseFailures,
      elapsedMs
    };

    store.recordRun(summary);
    emitProgress(wasCancelled ? "cancelled" : "ok", finishedAt);
    return summary;
  } catch (error) {
    const finishedAt = new Date().toISOString();
    const elapsedMs = Date.now() - started;
    const isCancelled = error instanceof Error && error.message === "INDEX_CANCELLED";

    const summary: IndexRunSummary = {
      runId,
      repoId: input.repoId,
      commitSha,
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
      parseFailures,
      elapsedMs
    };

    store.recordRun(summary);
    emitProgress(isCancelled ? "cancelled" : "failed", finishedAt, error instanceof Error ? error.message : "Unknown index failure");
    throw error;
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
      batchSize,
      completedBatches,
      totalBatches,
      elapsedMs,
      etaSeconds,
      byLanguage: Object.keys(byLanguage).length > 0 ? byLanguage : undefined,
      errorMessage
    });
  }

  function writeTerminalProgress(): void {
    const percent = totalFiles === 0 ? 100 : Math.round((filesScanned / totalFiles) * 100);
    process.stdout.write(
      `[index-progress] repo=${input.repoId} run=${runId} percent=${String(percent)} scanned=${String(filesScanned)}/${String(totalFiles)} batch=${String(completedBatches)}/${String(totalBatches)} indexed=${String(filesIndexed)} skipped=${String(filesSkipped)} parseFailures=${String(parseFailures)}\n`
    );
  }
}

function hashOf(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}
