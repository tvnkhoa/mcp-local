/**
 * Error handling utilities
 */

import { randomUUID } from "node:crypto";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { PolicyViolationError } from "./refactorUtils.js";

export function mapError(error: unknown, toolName: string): { code: string; message: string; requestId: string } {
  const requestId = randomUUID();

  if (error instanceof z.ZodError) {
    return {
      code: "VALIDATION_ERROR",
      message: `${toolName}: ${error.issues.map((x) => `${x.path.join(".") || "input"}: ${x.message}`).join("; ")}`,
      requestId
    };
  }

  if (error instanceof PolicyViolationError) {
    return {
      code: error.code,
      message: `${toolName}: ${error.message}`,
      requestId
    };
  }

  if (error instanceof McpError) {
    return {
      code: "MCP_ERROR",
      message: `${toolName}: ${error.message}`,
      requestId
    };
  }

  return {
    code: "INTERNAL_ERROR",
    message: `${toolName}: ${error instanceof Error ? error.message : "Unknown error"}`,
    requestId
  };
}

export function assertNoLlmRuntimePolicy(llmEnabled: boolean): void {
  if (llmEnabled) {
    throw new Error("Startup blocked: CODEBASE_INDEX_LLM_ENABLED must be false. LLM runtime invocation is prohibited by policy.");
  }
}

export function assertRefactorApprovalPolicy(strictApproval: boolean, approvalSecret: string): void {
  if (strictApproval && approvalSecret.trim().length === 0) {
    throw new Error("Startup blocked: CODEBASE_INDEX_REFACTOR_APPROVAL_SECRET is required when CODEBASE_INDEX_REFACTOR_STRICT_APPROVAL=true.");
  }
}
