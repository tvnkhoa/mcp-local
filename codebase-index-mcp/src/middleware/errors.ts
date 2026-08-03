/**
 * Error handling utilities.
 *
 * **This does not use `@mcp/sdk`'s `createErrorMapper`, and that is deliberate.** The other three
 * servers share it; this one publishes a different envelope — `{ code, message, requestId }` with
 * UPPER_SNAKE codes and every message prefixed with the tool name, against the shared
 * `{ code, message, detail? }`. `createErrorMapper` also builds a `(error) => WireError`, while
 * this signature is `(error, toolName)` and mints a fresh `requestId` per call, so adopting it
 * would mean either rebuilding a mapper per call or post-processing its output back into this
 * shape. `packages/sdk/src/errorMapper.ts` states the same conclusion from the other side: with
 * only one copy of this envelope there is no duplication to remove, and folding it in distorts both.
 *
 * Raised again during the 2026-08-03 repository review — "three servers share a mapper, this one
 * does not" reads as drift until you check what the envelopes actually are. Recorded here so the
 * next reader spends no time on it. Reopening needs the envelope itself to change first.
 */

import { randomUUID } from "node:crypto";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { isPlatformError } from "@mcp/core";
import { z } from "zod";
import { PolicyViolationError } from "../services/refactor/refactorUtils.js";

export function mapError(error: unknown, toolName: string): { code: string; message: string; requestId: string } {
  const requestId = randomUUID();

  /**
   * A `PlatformError` raised by `@mcp/sdk`'s dispatch, carrying the platform's own code.
   *
   * Required by S-33, not optional polish. Dispatch answers an unregistered tool name with
   * `notFound(...)` and hands it to this server's `formatError`; without this branch it falls
   * through to `INTERNAL_ERROR` below, which is the worst of the three outcomes — it drops the
   * old `MCP_ERROR` code, never produces the intended `not_found`, and relabels a caller's
   * mistake as a defect in this server.
   *
   * Checked first, matching postgres-mcp's `toWireError`. Order is not load-bearing —
   * `PlatformError` is none of the three classes below — but "platform errors carry their own
   * code" is the rule, and it reads as one.
   *
   * The code is passed through verbatim, so it is lower_snake (`not_found`) while this server's
   * own codes are UPPER_SNAKE. Deliberate: `not_found` is the platform's published vocabulary and
   * the same string the other three migrated servers emit. Inventing `NOT_FOUND` here would make
   * this the only server in the workspace with a fourth spelling. The `PolicyViolationError`
   * branch below already passes lowercase codes through for the same reason.
   */
  if (isPlatformError(error)) {
    return {
      code: error.code,
      message: `${toolName}: ${error.message}`,
      requestId
    };
  }

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
