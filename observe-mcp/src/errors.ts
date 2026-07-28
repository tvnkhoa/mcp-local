import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

/**
 * Re-exported from @mcp/core, where the three servers' byte-identical copies now
 * live. Kept as a named export from this module so every existing import site is
 * unchanged.
 */
import { PolicyViolationError, isPlatformError } from "@mcp/core";

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

export type MappedError = {
  code: string;
  message: string;
  detail?: string;
};

/**
 * Normalize any thrown value into a stable { code, message, detail? } shape.
 *
 * NOT extracted to a shared package, despite being near-identical to
 * bitbucket-mcp's / observe-mcp's copy. The `z.ZodError` and `McpError` branches
 * are `instanceof` checks, and each server carries its OWN copy of `zod` and
 * `@modelcontextprotocol/sdk` (servers are intentionally not npm workspace
 * members, so those deps are not hoisted or deduplicated). A shared
 * implementation would compare against a DIFFERENT class object and both
 * branches would silently fall through — turning every validation error into
 * `internal_error` with a raw Zod JSON dump as its message. Verified empirically:
 * an error from a server's zod is not `instanceof` the hoisted zod's ZodError.
 *
 * Safe to share once the servers deduplicate those two dependencies
 * (migration-plan step S-09), and not before.
 */
export function mapError(error: unknown): MappedError {
  if (error instanceof z.ZodError) {
    return {
      code: "validation_error",
      message: "Invalid arguments.",
      detail: error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")
    };
  }
  if (error instanceof PolicyViolationError) {
    return { code: error.code, message: error.message };
  }
  if (error instanceof ObserveHttpError) {
    return { code: error.code, message: error.message, detail: error.detail };
  }
  if (error instanceof McpError) {
    return { code: "mcp_error", message: error.message };
  }
  if (error instanceof Error) {
    if (error.name === "AbortError") {
      return { code: "timeout", message: "Request to OpenObserve timed out." };
    }
    return { code: "internal_error", message: error.message };
  }
  return { code: "internal_error", message: String(error) };
}

/**
 * `mapError`, plus the refusals dispatch itself raises.
 *
 * A `PlatformError` reaching `mapError` would fall into its `instanceof Error`
 * branch and be reported as `internal_error` — actively misleading for something
 * like an unknown tool name. Unwrapping it first preserves the code dispatch
 * chose.
 */
export function toWireError(error: unknown): MappedError {
  if (isPlatformError(error)) {
    return { code: error.code, message: error.message };
  }
  return mapError(error);
}
