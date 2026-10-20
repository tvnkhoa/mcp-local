/**
 * R3 exact — the budget a TypeScript LanguageService answer must fit in.
 *
 * Two caps, both configured in `src/config/` and passed in (this module reads no env):
 *
 * - **time** (`CODEBASE_INDEX_TS_LS_COLD_START_MS`, default 60 000): the whole answer — program
 *   build on a cold call, `findReferences`, the Zod parse pass and the gap scan — must finish inside
 *   it. Measured on wec.aria: 16.7 s cold, warm calls 4-65 ms.
 * - **memory** (`CODEBASE_INDEX_TS_LS_MAX_RSS_MB`, default 2 500): the process RSS. It is the whole
 *   server's RSS (SQLite's mmap included), not only the program's — the only figure the OS bounds.
 *   Measured on wec.aria: ~1.06 GB peak with the program built.
 *
 * A breach is never a partial answer. The LanguageService checks the cancellation token between
 * files inside `findReferences`, so a breach there throws {@link TsLsCapBreach} instead of returning
 * whatever had been found; the caller turns that into coverage `"gap"` with the reason and returns
 * NO access list. Program construction itself is synchronous and not cancellable inside TypeScript,
 * so a cold build that overruns is detected when it returns (the elapsed time is checked after every
 * phase) — the answer is still refused, and the built program is kept warm for the next call unless
 * the breach was memory, in which case the host is dropped.
 */

import ts from "typescript";

export type TsLsCaps = {
  /** Wall-clock budget for one answer, cold or warm. */
  budgetMs: number;
  /** Process RSS ceiling in MB. */
  maxRssMb: number;
};

export const DEFAULT_TS_LS_CAPS: TsLsCaps = { budgetMs: 60_000, maxRssMb: 2_500 };

export type CapBreachKind = "time" | "memory";

export class TsLsCapBreach extends Error {
  constructor(
    readonly kind: CapBreachKind,
    readonly detail: string
  ) {
    super(`R3 cap breached (${kind}): ${detail}`);
    this.name = "TsLsCapBreach";
  }
}

const MB = 1024 * 1024;

export function currentRssMb(): number {
  return Math.round(process.memoryUsage().rss / MB);
}

/**
 * One budget for one answer. `check(phase)` throws {@link TsLsCapBreach} once either cap is past;
 * `token` is the same check in the shape the LanguageService host asks for, so a breach inside
 * `findReferences` aborts it between files instead of returning a partial list.
 */
export class AnswerBudget {
  private readonly startedAt = performance.now();
  private lastRssCheckAt = 0;
  private breach: TsLsCapBreach | null = null;

  constructor(readonly caps: TsLsCaps) {}

  elapsedMs(): number {
    return Math.round(performance.now() - this.startedAt);
  }

  /** Throws when a cap is past. RSS is sampled at most every 100 ms — `memoryUsage()` is a syscall. */
  check(phase: string): void {
    if (this.breach) throw this.breach;
    const elapsed = this.elapsedMs();
    if (elapsed > this.caps.budgetMs) {
      this.breach = new TsLsCapBreach("time", `${phase}: ${String(elapsed)} ms elapsed, budget ${String(this.caps.budgetMs)} ms (CODEBASE_INDEX_TS_LS_COLD_START_MS)`);
      throw this.breach;
    }
    const now = performance.now();
    if (now - this.lastRssCheckAt >= 100) {
      this.lastRssCheckAt = now;
      const rss = currentRssMb();
      if (rss > this.caps.maxRssMb) {
        this.breach = new TsLsCapBreach("memory", `${phase}: process RSS ${String(rss)} MB, cap ${String(this.caps.maxRssMb)} MB (CODEBASE_INDEX_TS_LS_MAX_RSS_MB)`);
        throw this.breach;
      }
    }
  }

  /** The LanguageService's cancellation hook. Records the breach; the LS throws its own exception. */
  readonly token: ts.HostCancellationToken = {
    isCancellationRequested: (): boolean => {
      try {
        this.check("findReferences");
        return false;
      } catch {
        return true;
      }
    }
  };

  /** The breach that cancelled the LanguageService, if that is why it threw. */
  breachFrom(error: unknown): TsLsCapBreach | null {
    if (error instanceof TsLsCapBreach) return error;
    if (error instanceof ts.OperationCanceledException || (error as { name?: string } | null)?.name === "OperationCanceledException") {
      return this.breach ?? new TsLsCapBreach("time", "cancelled by the LanguageService");
    }
    return null;
  }
}
