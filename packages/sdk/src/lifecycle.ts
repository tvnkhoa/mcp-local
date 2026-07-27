/**
 * Process lifecycle.
 *
 * Startup validation fails fast and loudly; shutdown runs registered hooks once
 * and in reverse registration order, so resources acquired last are released
 * first. Signal handlers are opt-in — a test harness must never have them.
 */

import type { Logger, PlatformError, Result } from "@mcp/core";

export interface ShutdownHook {
  readonly name: string;
  run(): void | Promise<void>;
}

export interface Lifecycle {
  onShutdown(hook: ShutdownHook): void;
  shutdown(reason: string): Promise<void>;
  /** Attach SIGINT/SIGTERM handlers. Returns a detach function. */
  installSignalHandlers(): () => void;
  readonly isShuttingDown: boolean;
}

export function createLifecycle(logger: Logger): Lifecycle {
  const hooks: ShutdownHook[] = [];
  let shuttingDown = false;
  let completed: Promise<void> | undefined;

  const runShutdown = async (reason: string): Promise<void> => {
    logger.info("shutdown_started", { reason, hooks: hooks.length });
    for (const hook of [...hooks].reverse()) {
      try {
        await hook.run();
        logger.debug("shutdown_hook_ok", { hook: hook.name });
      } catch (cause) {
        // A failing hook must not prevent the remaining ones from running.
        logger.error("shutdown_hook_failed", { hook: hook.name, detail: String(cause) });
      }
    }
    logger.info("shutdown_complete", { reason });
  };

  const lifecycle: Lifecycle = {
    get isShuttingDown() {
      return shuttingDown;
    },

    onShutdown(hook) {
      hooks.push(hook);
    },

    async shutdown(reason) {
      if (completed !== undefined) {
        return completed;
      }
      shuttingDown = true;
      completed = runShutdown(reason);
      return completed;
    },

    installSignalHandlers() {
      const handle = (signal: NodeJS.Signals): void => {
        void lifecycle.shutdown(`signal:${signal}`).then(
          () => process.exit(0),
          () => process.exit(1)
        );
      };
      const onSigint = (): void => handle("SIGINT");
      const onSigterm = (): void => handle("SIGTERM");
      process.on("SIGINT", onSigint);
      process.on("SIGTERM", onSigterm);
      return () => {
        process.off("SIGINT", onSigint);
        process.off("SIGTERM", onSigterm);
      };
    }
  };

  return lifecycle;
}

/**
 * Fail fast on invalid configuration.
 *
 * Server convention S6: either the config validates cleanly or the process
 * exits with an actionable, secret-free message. Never start half-configured.
 */
export function assertConfigValid<T>(result: Result<T, PlatformError>, logger: Logger): T {
  if (result.ok) {
    return result.value;
  }
  logger.error("config_invalid", { code: result.error.code, message: result.error.message });
  throw result.error;
}
