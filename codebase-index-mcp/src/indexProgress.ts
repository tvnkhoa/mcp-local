import process from "node:process";
import { INDEX_LOG_MODE } from "./config/envConfig.js";

/**
 * Indexing progress reporting + log gating.
 *
 * There is no terminal animation: this server is used through an MCP host
 * (Claude Code) where stderr is piped, not a TTY, so a spinner/bar would never
 * render. Instead:
 *
 *   - Live progress ("running", percent, phase) is surfaced to the MCP host via
 *     `notifications/progress` — see the `notifier` wired in from the tool handler.
 *     The host shows it while `index_repository` is running.
 *   - Routine `[index-*]` narration is silenced by default (it was debug noise);
 *     the run ends with a single summary line.
 *
 * Log gating (CODEBASE_INDEX_INDEX_LOG):
 *   - unset   → quiet: only warnings + the final summary line reach stderr.
 *   - verbose → restore full line-by-line `[index-*]` logs (CI / debugging a hang).
 *   - quiet   → suppress even the final summary line.
 */

const LOG_MODE = INDEX_LOG_MODE;

/** Full line-by-line `[index-*]` logs (opt-in, e.g. CI / debugging a hang). */
export const VERBOSE_LOG = LOG_MODE === "verbose";
const SILENT = LOG_MODE === "quiet";

/** Minimum gap between progress notifications, to avoid flooding the host. */
const NOTIFY_THROTTLE_MS = 300;

/** Routine progress narration. Silent unless CODEBASE_INDEX_INDEX_LOG=verbose. */
export function indexLog(msg: string): void {
  if (!VERBOSE_LOG) return;
  process.stderr.write(msg.endsWith("\n") ? msg : `${msg}\n`);
}

/** Warnings / errors — always surfaced (unless explicitly silenced by =quiet). */
export function indexWarn(msg: string): void {
  if (SILENT) return;
  process.stderr.write(msg.endsWith("\n") ? msg : `${msg}\n`);
}

/**
 * Sends one MCP `notifications/progress` update. `total` is omitted when the
 * work is indeterminate (e.g. the edge-resolution phase, where "files" no longer
 * maps to progress). Fire-and-forget on the caller's side.
 */
export type ProgressNotifier = (progress: number, total: number | undefined, message: string) => void;

export type ProgressSnapshot = {
  phase?: string;
  filesScanned?: number;
  totalFiles?: number;
  symbols?: number;
};

export interface IndexProgress {
  /** Set the current phase label (e.g. "indexing", "resolving calls"). */
  phase(name: string): void;
  /** Merge new counters and (throttled) push a progress notification. */
  update(snap: ProgressSnapshot): void;
  /** Emit a one-off warning/notable line. */
  note(msg: string): void;
  /** Finish: print a single summary line and send a final progress update. Idempotent. */
  stop(finalLine?: string): void;
}

export function createIndexProgress(repoId: string, notifier?: ProgressNotifier): IndexProgress {
  const state: Required<ProgressSnapshot> = {
    phase: "starting",
    filesScanned: 0,
    totalFiles: 0,
    symbols: 0,
  };

  let stopped = false;
  let lastSentAt = 0;
  // MCP requires `progress` to increase on every notification, even when the
  // underlying metric is flat (e.g. stuck at 100% files during edge resolution).
  let lastProgressValue = 0;
  let postTick = 0;

  function emit(force: boolean): void {
    if (!notifier) return;

    const indexing = state.phase === "indexing" && state.totalFiles > 0;
    // Before any files are indexed (scanning/starting), there is no meaningful
    // value to report; skip so pre-index ticks never collide with the file
    // scale (which would let the post-index counter start above `total`).
    if (!indexing && state.totalFiles === 0) return;

    const now = Date.now();
    if (!force && now - lastSentAt < NOTIFY_THROTTLE_MS) return;
    lastSentAt = now;

    let progress: number;
    let total: number | undefined;
    let message: string;

    if (indexing) {
      progress = state.filesScanned;
      total = state.totalFiles;
      const pct = Math.min(100, Math.round((state.filesScanned / state.totalFiles) * 100));
      message = `${repoId}: indexing ${pct}% · ${String(state.filesScanned)}/${String(state.totalFiles)} files · ${String(state.symbols)} symbols`;
    } else {
      // Post-index indeterminate phase (resolve / finalize): counter continues
      // above the file total; no denominator so the host shows a busy indicator.
      progress = state.totalFiles + ++postTick;
      total = undefined;
      message = `${repoId}: ${state.phase}${state.symbols > 0 ? ` · ${String(state.symbols)} symbols` : ""}`;
    }

    // Keep `progress` monotonic without ever exceeding a known `total`.
    if (total === undefined) {
      if (progress <= lastProgressValue) progress = lastProgressValue + 1;
    } else {
      if (progress < lastProgressValue) progress = lastProgressValue;
      if (progress > total) progress = total;
    }
    lastProgressValue = progress;

    notifier(progress, total, message);
  }

  return {
    phase(name: string): void {
      state.phase = name;
      indexLog(`[index] ${repoId} · ${name}`);
      emit(true);
    },
    update(snap: ProgressSnapshot): void {
      Object.assign(state, snap);
      emit(false);
    },
    note(msg: string): void {
      indexWarn(msg);
    },
    stop(finalLine?: string): void {
      if (stopped) return;
      stopped = true;
      if (finalLine && !SILENT) {
        process.stderr.write(finalLine.endsWith("\n") ? finalLine : `${finalLine}\n`);
      }
      // Final 100%-style completion notification so the host clears its indicator.
      if (notifier) {
        lastProgressValue += 1;
        notifier(lastProgressValue, lastProgressValue, finalLine ?? `${repoId}: done`);
      }
    },
  };
}
