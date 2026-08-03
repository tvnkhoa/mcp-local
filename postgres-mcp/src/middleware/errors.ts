/**
 * Re-exported from @mcp/core, where the three servers' byte-identical copies now
 * live. Kept as a named export from this module so every existing import site is
 * unchanged.
 */
import { PolicyViolationError, isPlatformError } from "@mcp/core";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

export { PolicyViolationError };

export type MappedError = {
  code: string;
  message: string;
  detail?: string;
};

/**
 * Normalize any thrown value into this server's stable `{ code, message, detail? }`
 * envelope. Moved here verbatim from `index.ts` when the tool table was extracted
 * (S-24); the branch order and every string are unchanged, because this shape is
 * what clients already parse.
 *
 * NOT extracted to a shared package, despite being near-identical to
 * bitbucket-mcp's and observe-mcp's copies. The `z.ZodError` and `McpError`
 * branches are `instanceof` checks, and each server carries its OWN copy of `zod`
 * and `@modelcontextprotocol/sdk` (servers are intentionally not npm workspace
 * members, so those deps are not hoisted or deduplicated). A shared implementation
 * would compare against a DIFFERENT class object and both branches would silently
 * fall through — turning every validation error into `internal_error` with a raw
 * Zod dump as its detail. Safe to share once those two dependencies are
 * deduplicated (migration-plan step S-09), and not before.
 */
export function mapError(error: unknown): MappedError {
  if (error instanceof z.ZodError) {
    return {
      code: "validation_error",
      message: "Invalid tool input.",
      detail: error.issues.map((x) => `${x.path.join(".") || "root"}: ${x.message}`).join("; ")
    };
  }

  if (error instanceof PolicyViolationError) {
    return {
      code: error.code,
      message: error.message
    };
  }

  if (error instanceof McpError) {
    return {
      code: "mcp_error",
      message: error.message
    };
  }

  if (typeof error === "object" && error !== null) {
    const maybe = error as Record<string, unknown>;
    const code = typeof maybe.code === "string" ? maybe.code : undefined;
    const message = typeof maybe.message === "string" ? maybe.message : undefined;
    if (code === "57014") {
      return {
        code: "timeout",
        message: "Query timed out by statement_timeout."
      };
    }
    if (message) {
      return {
        code: "internal_error",
        message: "Database query failed.",
        detail: message
      };
    }
  }

  return {
    code: "internal_error",
    message: "Unexpected error."
  };
}

/**
 * `mapError`, plus the refusals dispatch itself raises.
 *
 * A `PlatformError` reaching `mapError` would fall into its generic
 * "object with a message" branch and be reported as `internal_error: Database
 * query failed` — actively misleading for something like an unknown tool name.
 * Unwrapping it first preserves the code dispatch chose.
 */
export function toWireError(error: unknown): MappedError {
  if (isPlatformError(error)) {
    return { code: error.code, message: error.message };
  }
  return mapError(error);
}
