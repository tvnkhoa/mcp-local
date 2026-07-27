/**
 * stdout protection.
 *
 * stdout is the MCP transport. A single `console.log` anywhere in a server —
 * or in one of its dependencies — injects a non-JSON-RPC line into the stream
 * and breaks the session. Redirecting the console to stderr removes the
 * commonest way that happens.
 *
 * This does not patch `process.stdout.write` itself: the transport legitimately
 * needs it, and intercepting it would be both fragile and dangerous.
 */

type ConsoleMethod = "log" | "info" | "debug" | "warn" | "error" | "trace" | "dir";

const REDIRECTED: readonly ConsoleMethod[] = ["log", "info", "debug", "warn", "error", "trace", "dir"];

/**
 * Point console output at stderr. Returns a function restoring the originals.
 * Call once, at the very start of a server entry point.
 */
export function redirectConsoleToStderr(): () => void {
  const originals = new Map<ConsoleMethod, unknown>();

  const write = (args: readonly unknown[]): void => {
    const line = args
      .map((arg) => {
        if (typeof arg === "string") {
          return arg;
        }
        try {
          return JSON.stringify(arg);
        } catch {
          return String(arg);
        }
      })
      .join(" ");
    process.stderr.write(`${line}\n`);
  };

  for (const method of REDIRECTED) {
    originals.set(method, console[method]);
    // Reassigning console methods is the whole point of this module.
    (console as unknown as Record<ConsoleMethod, (...args: unknown[]) => void>)[method] = (
      ...args: unknown[]
    ): void => {
      write(args);
    };
  }

  return () => {
    for (const [method, original] of originals) {
      (console as unknown as Record<ConsoleMethod, unknown>)[method] = original;
    }
  };
}
