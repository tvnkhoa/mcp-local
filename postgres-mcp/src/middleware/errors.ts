/**
 * Re-exported from @mcp/core, where the three servers' byte-identical copies now
 * live. Kept as a named export from this module so every existing import site is
 * unchanged.
 */
import { PolicyViolationError, isPlatformError } from "@mcp/core";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { createErrorMapper, stringProperty, type ErrorRule, type WireError } from "@mcp/sdk";

export { PolicyViolationError };

export type MappedError = WireError;

/** Postgres `SQLSTATE 57014` — the statement was cancelled by `statement_timeout`. */
const statementTimeout: ErrorRule = (error) =>
  stringProperty(error, "code") === "57014"
    ? { code: "timeout", message: "Query timed out by statement_timeout." }
    : undefined;

/**
 * Any other failure that arrived with a message — in practice a `pg` driver error.
 *
 * The driver's message goes in `detail` and never in `message`, which is why this
 * server cannot use the platform's default catch-all: a connection failure's
 * message can carry the connection string.
 */
const databaseFailure: ErrorRule = (error) => {
  const message = stringProperty(error, "message");
  // Truthiness, not just presence: the hand-written branch was `if (message)`, so an
  // object carrying an EMPTY message falls through to the catch-all below instead of
  // reporting a database failure with nothing to show for it.
  return message ? { code: "internal_error", message: "Database query failed.", detail: message } : undefined;
};

/**
 * Normalize any thrown value into this server's stable `{ code, message, detail? }`
 * envelope. The branch order and every string are unchanged, because this shape is
 * what clients already parse.
 *
 * What moved into `@mcp/sdk` is the branch order this server shared with
 * observe-mcp and bitbucket-mcp. The two branches it does *not* share, and its
 * catch-all, stay here as rules.
 *
 * **The classes are passed in, not imported by the SDK, and that is the whole
 * point.** Per ADR-0001 this server owns its own copies of `zod` and
 * `@modelcontextprotocol/sdk`, so a `ZodError` thrown here is not an instance of
 * any class a shared package could import. Injecting them keeps every `instanceof`
 * running against the classes this server actually throws — which is why the
 * extraction is safe now rather than only once those dependencies are deduplicated
 * (migration-plan step S-09).
 */
const mapError: (error: unknown) => MappedError = createErrorMapper({
  validation: { type: z.ZodError, message: "Invalid tool input.", rootLabel: "root" },
  coded: [PolicyViolationError],
  mcpError: McpError,
  // Order preserved: SQLSTATE first, so a cancelled statement is reported as a
  // timeout rather than as a generic database failure.
  rules: [statementTimeout, databaseFailure],
  fallback: () => ({ code: "internal_error", message: "Unexpected error." })
});

/**
 * `mapError`, plus the refusals dispatch itself raises.
 *
 * A `PlatformError` reaching `mapError` would fall into the `databaseFailure` rule
 * and be reported as `internal_error: Database query failed` — actively misleading
 * for something like an unknown tool name. Unwrapping it first preserves the code
 * dispatch chose.
 *
 * Stays a hand-written wrapper rather than becoming another mapper branch:
 * `isPlatformError` is this server's own import, and "platform errors take
 * precedence over everything" is this server's decision, not the shared engine's.
 */
export function toWireError(error: unknown): MappedError {
  if (isPlatformError(error)) {
    return { code: error.code, message: error.message };
  }
  return mapError(error);
}
