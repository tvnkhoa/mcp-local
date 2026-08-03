/**
 * The entry-point tail.
 *
 * Every server ended with the same twelve lines: an async `main` that starts the
 * handle and logs, then `main().catch(...)` that logs the crash and exits
 * non-zero. Four copies, differing only in what they log and whether they run the
 * shutdown hooks first — and one of them can never be exercised by a test,
 * because it calls `process.exit`.
 *
 * Consolidating it here makes the difference between the four servers a set of
 * arguments rather than four hand-written tails, and confines the unavoidable
 * `process.exit` to one reviewed place.
 */

import process from "node:process";

import type { McpServerHandle } from "./createServer.js";

export interface RunServerOptions {
  /**
   * Ran after the transport is connected. This is where post-start work belongs —
   * the `server_started` log line, or starting background watchers.
   *
   * A rejection here is a crash: it reaches `onCrash` exactly as a failed
   * `start()` does, which is the behaviour all four entry points already had by
   * virtue of both being awaited inside the same `main`.
   */
  readonly onStarted?: () => void | Promise<void>;
  /**
   * Report the failure. Defaults to a `server_crashed` line on the handle's own
   * logger, which is what three of the four servers wrote by hand.
   *
   * Anything this throws is swallowed: the process is already exiting, and a
   * failure inside crash reporting must not replace the exit with an unhandled
   * rejection.
   */
  readonly onCrash?: (error: unknown) => void | Promise<void>;
  /**
   * Run the registered shutdown hooks before exiting.
   *
   * Off by default, matching three of the four servers: a start-up that failed
   * before any resource was acquired has nothing to release, and hooks that run
   * against half-built state can turn one error into two. Servers that acquire
   * state *before* `start()` — a database handle, a file watcher — set this.
   */
  readonly stopOnCrash?: boolean;
  /** Reason handed to `stop()` when `stopOnCrash` is set. */
  readonly crashReason?: string;
  readonly exitCode?: number;
}

/**
 * Start a server and own the process outcome.
 *
 * Returns immediately — the work happens on the promise chain, as it does in a
 * hand-written entry point. There is nothing to await: after this call the
 * process either serves requests or exits.
 */
export function runServer(handle: McpServerHandle, options: RunServerOptions = {}): void {
  const exitCode = options.exitCode ?? 1;

  const crash = async (error: unknown): Promise<never> => {
    try {
      if (options.onCrash === undefined) {
        handle.logger.error("server_crashed", {
          detail: error instanceof Error ? error.message : String(error)
        });
      } else {
        await options.onCrash(error);
      }
    } catch {
      // Deliberately silent: see `onCrash`.
    }

    if (options.stopOnCrash === true) {
      // `finally`, not `then`: a shutdown hook that itself fails must not leave
      // the process alive and idle.
      await handle.stop(options.crashReason ?? "startup_failed").catch(() => undefined);
    }

    process.exit(exitCode);
  };

  void (async () => {
    await handle.start();
    await options.onStarted?.();
  })().catch(crash);
}
