/**
 * __DIR__'s error contract.
 *
 * `tools/list` is not the whole public API — the shape of a *failure* is part of it too, and no
 * type check notices when it changes. Every failure leaves this server as
 * `{ code, message, detail? }`, and `src/tools.test.ts` pins that.
 */

import { isPlatformError } from "@mcp/core";

export interface WireError {
  readonly code: string;
  readonly message: string
  readonly detail?: string;
}

/** Raised when a request is refused by policy rather than being invalid. */
export class PolicyViolationError extends Error {
  readonly code = "policy_violation";

  constructor(message: string) {
    super(message);
    this.name = "PolicyViolationError";
  }
}

/**
 * Map anything throwable into this server's envelope.
 *
 * `PlatformError` is unwrapped rather than collapsed to `internal_error`: the shared dispatch layer
 * raises it for failures that happen *before* a handler runs — an unknown tool name being the
 * common one — and those carry a perfectly good code already.
 */
export function mapError(error: unknown): WireError {
  if (isPlatformError(error)) {
    return { code: error.code, message: error.message };
  }
  if (error instanceof PolicyViolationError) {
    return { code: error.code, message: error.message };
  }
  if (error instanceof Error) {
    return { code: "internal_error", message: error.message };
  }
  return { code: "internal_error", message: String(error) };
}
