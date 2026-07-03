import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

/**
 * Policy / guardrail violation. Carries a stable machine-readable `code` so tool
 * responses can surface a consistent error taxonomy (ported from postgres-mcp).
 */
export class PolicyViolationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "PolicyViolationError";
  }
}

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

/** Normalize any thrown value into a stable { code, message, detail? } shape. */
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
