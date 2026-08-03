/**
 * __DIR__'s error contract.
 *
 * `tools/list` is not the whole public API — the shape of a *failure* is part of it too, and no
 * type check notices when it changes. Every failure leaves this server as
 * `{ code, message, detail? }`, and `src/tools/tools.test.ts` pins that.
 */

import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { PolicyViolationError } from "@mcp/core";
import { abortRule, createErrorMapper, type WireError } from "@mcp/sdk";

/**
 * Re-exported so every import site in this server reads `from "../middleware/errors.js"`, whichever
 * package the class actually lives in.
 *
 * Note the constructor is `(code, message)` — the code is per-refusal, not per-class:
 * `throw new PolicyViolationError("write_disabled", "Writes are disabled.")`.
 */
export { PolicyViolationError };

export type MappedError = WireError;

/**
 * Map anything throwable into this server's envelope.
 *
 * The branch order — validation → classes carrying their own code → protocol error → extra rules →
 * fallback — is shared, because three hand-written copies of it is how two of them end up subtly
 * different. What stays here is every string a client can see.
 *
 * **The classes are passed in, not imported by the SDK, and that is the whole point.** Per ADR-0001
 * this server owns its own copies of `zod` and `@modelcontextprotocol/sdk`, so a `ZodError` thrown
 * here is not an instance of any class a shared package could import. Injecting them keeps every
 * `instanceof` running against the classes this server actually throws.
 *
 * Add your own error classes to `coded` as the server grows — anything with a `code` property is
 * reported under it, and a `detail` string is forwarded.
 */
export const mapError: (error: unknown) => MappedError = createErrorMapper({
  validation: { type: z.ZodError, message: "Invalid arguments.", rootLabel: "(root)" },
  coded: [PolicyViolationError],
  mcpError: McpError,
  rules: [abortRule("Request timed out.")]
  // No `fallback`: the platform default is `internal_error` carrying the thrown value's own
  // message. Supply one if this server's upstream errors can carry a secret — a connection string,
  // a token — that must not reach a client.
});
