import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { abortRule, createErrorMapper, type WireError } from "@mcp/sdk";

/**
 * Re-exported from @mcp/core, where the three servers' byte-identical copies now
 * live. Kept as a named export from this module so every existing import site is
 * unchanged.
 */
import { PolicyViolationError } from "@mcp/core";

export { PolicyViolationError };

/** HTTP-level failure talking to the OpenObserve backend. */
export class ObserveHttpError extends Error {
  readonly code = "observe_http_error";
  readonly status: number;
  readonly detail?: string;

  constructor(status: number, message: string, detail?: string) {
    super(message);
    this.status = status;
    this.detail = detail;
    this.name = "ObserveHttpError";
  }
}

export type MappedError = WireError;

/**
 * Normalize any thrown value into this server's `{ code, message, detail? }`
 * envelope.
 *
 * The branch order and every string are unchanged from the hand-written version;
 * what moved into `@mcp/sdk` is the order itself, which this server shared exactly
 * with bitbucket-mcp and almost exactly with postgres-mcp.
 *
 * **The classes are passed in, not imported by the SDK, and that is the whole
 * point.** Per ADR-0001 this server owns its own copies of `zod` and
 * `@modelcontextprotocol/sdk`, so a `ZodError` thrown here is not an instance of
 * any class a shared package could import. Injecting them keeps every `instanceof`
 * running against the classes this server actually throws — which is why the
 * extraction is safe now rather than only once those dependencies are
 * deduplicated (migration-plan step S-09).
 */
export const mapError: (error: unknown) => MappedError = createErrorMapper({
  validation: { type: z.ZodError, message: "Invalid arguments.", rootLabel: "(root)" },
  // Order preserved: a policy violation is matched before an upstream HTTP error.
  coded: [PolicyViolationError, ObserveHttpError],
  mcpError: McpError,
  rules: [abortRule("Request to OpenObserve timed out.")]
  // No `fallback`: the platform default *is* this server's previous behaviour —
  // `internal_error` carrying the thrown value's own message.
});

// `toWireError` — the `mapError` wrapper that unwraps a `PlatformError` first — lives in
// `tools/index.ts`, which is where `index.ts` and `tools.test.ts` both import it from.
//
// A second, byte-identical copy sat here until 2026-08-03, exported and imported by nothing. It
// was left behind when the standard-structure refactor split this module out; the live copy never
// moved. Removed rather than re-pointed, so there is one definition again.
