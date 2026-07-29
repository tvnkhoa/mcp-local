/**
 * Resolving a run's tuning limits from its input.
 *
 * Extracted from `indexPipeline.ts` in S-41. Pure — input in, clamped numbers out — which makes
 * it the one part of a run whose behaviour can be pinned without a repository or a database.
 *
 * The clamps are not cosmetic. Every one of these values arrives from the environment via
 * `index.ts`, so an operator typo is the expected input, not the exception: `batchSize: 0` would
 * make the batch loop spin forever, and `parseJobTimeoutMs: 1` would fail every worker job. The
 * bounds are what turn a bad value into a slow run instead of a broken one.
 */

import { clamp } from "../guardrails/indexGuardrails.js";

export interface IndexRunLimits {
  readonly maxFiles: number;
  readonly includeDocs: boolean;
  readonly batchSize: number;
  readonly subtxSize: number;
  readonly checkpointEveryNBatches: number;
  readonly largeFileThresholdBytes: number;
  readonly maxFileSizeBytes: number;
  readonly parseWorkers: number;
  readonly parseJobTimeoutMs: number;
  /** Parallel file reads per chunk. Fixed, not configurable — see note below. */
  readonly concurrencyLimit: number;
}

export interface RunLimitsInput {
  readonly maxFiles: number;
  readonly includeDocs?: boolean;
  readonly batchSize?: number;
  readonly subtxSize?: number;
  readonly checkpointEveryNBatches?: number;
  readonly largeFileThresholdBytes?: number;
  readonly maxFileSizeBytes?: number;
  readonly parseWorkers?: number;
  readonly parseJobTimeoutMs?: number;
}

/**
 * Defaults and bounds, unchanged from what `runIndexPipeline` applied inline before S-41.
 *
 * Note `largeFileThresholdBytes` defaults to 512 KB *here* while `index.ts` passes 0 from the
 * env. That is not a contradiction: the env default of 0 routes everything to the worker pool,
 * because the old 512 KB default exceeded the 500 KB `fileFilter` cap and meant workers were
 * never used at all. This fallback only applies when a caller omits the field entirely.
 */
export function resolveIndexRunLimits(input: RunLimitsInput): IndexRunLimits {
  return {
    maxFiles: clamp(input.maxFiles, 1, 200_000),
    includeDocs: input.includeDocs ?? true,
    batchSize: clamp(input.batchSize ?? 200, 1, 2_000),
    subtxSize: clamp(input.subtxSize ?? 20, 1, 500),
    checkpointEveryNBatches: Math.max(1, input.checkpointEveryNBatches ?? 1),
    largeFileThresholdBytes: Math.max(0, input.largeFileThresholdBytes ?? 512 * 1024),
    maxFileSizeBytes: Math.max(10_000, input.maxFileSizeBytes ?? 500_000),
    parseWorkers: clamp(input.parseWorkers ?? 2, 0, 32),
    parseJobTimeoutMs: clamp(input.parseJobTimeoutMs ?? 20_000, 1_000, 120_000),
    // Not env-tunable: this bounds concurrent open file handles, and the failure mode of raising
    // it is EMFILE partway through a run rather than a slower run.
    concurrencyLimit: 50
  };
}
