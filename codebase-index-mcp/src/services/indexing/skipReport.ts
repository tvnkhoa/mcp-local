/**
 * Per-run "what was not indexed, and why" — `IndexRunSummary.skippedByReason`.
 *
 * Kept as a plain map during the run and shaped once at the end, so the hot loop pays one string
 * concatenation per skipped file.
 */

import path from "node:path";

import type { SkipBucket } from "../../types/index.js";

export type SkipTally = Map<string, number>;

/** The extension, lower-cased, or the basename for files that have none (`Dockerfile`, `Makefile`). */
export function skipExtensionOf(filePath: string): string {
  const base = path.basename(filePath.replace(/\\/g, "/"));
  const ext = path.extname(base).toLowerCase();
  return ext || base;
}

export function tallySkip(tally: SkipTally, reason: string, filePath: string): void {
  const key = `${reason}\u0000${skipExtensionOf(filePath)}`;
  tally.set(key, (tally.get(key) ?? 0) + 1);
}

/**
 * Largest first; ties by key in code-unit order (not `localeCompare`, for the reason `fileScan.ts`
 * gives), so two runs over one tree serialize identically on any machine.
 */
export function toSkipBuckets(tally: SkipTally): SkipBucket[] {
  return [...tally.entries()]
    .sort(([ka, a], [kb, b]) => b - a || (ka < kb ? -1 : ka > kb ? 1 : 0))
    .map(([key, count]) => {
      const [reason = "", extension = ""] = key.split("\u0000");
      return { reason, extension, count };
    });
}
