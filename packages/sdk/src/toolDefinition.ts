/**
 * The tool contract.
 *
 * A ToolDefinition is a plain, protocol-free description of one tool: what it
 * accepts, what it promises about side effects, what gates it, and what it
 * does. Nothing here imports the MCP protocol, which is what makes every tool
 * unit-testable without starting a server (see `@mcp/testing`).
 */

import type { LimitPolicy, Logger, PlatformError, ResponseProfile, Result } from "@mcp/core";
import type { ZodType } from "zod";

import type { JsonSchemaObject } from "./schema.js";

/**
 * Declared side-effect profile. Every field is mandatory: an unannotated tool
 * is a tool nobody can safely review.
 */
export interface ToolAnnotations {
  /** Performs no state change of any kind. */
  readonly readOnly: boolean;
  /** Calling twice with the same input has the same effect as calling once. */
  readonly idempotent: boolean;
  /** May remove or overwrite existing state. */
  readonly destructive: boolean;
  /** Interacts with systems outside this machine. Default false (local-first). */
  readonly openWorld?: boolean;
}

export interface ToolContext {
  readonly logger: Logger;
  readonly profile: ResponseProfile;
  readonly requestId: string;
  readonly signal?: AbortSignal;
}

export interface GuardContext {
  readonly toolName: string;
  readonly input: unknown;
  readonly ctx: ToolContext;
}

export interface Guard {
  readonly name: string;
  check(context: GuardContext): Result<void, PlatformError> | Promise<Result<void, PlatformError>>;
}

export type ToolHandler<I, O> = (
  input: I,
  ctx: ToolContext
) => Result<O, PlatformError> | Promise<Result<O, PlatformError>>;

export interface ToolDefinition<I = unknown, O = unknown> {
  /** snake_case, verb_noun, stable forever. */
  readonly name: string;
  readonly title: string | undefined;
  readonly description: string;
  /** Runtime validation. */
  readonly input: ZodType<I>;
  /** What `tools/list` advertises. */
  readonly inputSchema: JsonSchemaObject;
  readonly annotations: ToolAnnotations;
  readonly guards: readonly Guard[];
  readonly limits: LimitPolicy | undefined;
  /**
   * The handler returns a finished `ToolCallResult` and dispatch must not
   * serialize it.
   *
   * The pipeline's last step assumes the handler yields a *payload*. A server
   * arriving with handlers that already build their own envelope — a custom
   * error shape carrying `requestId` and `environment`, say, which a
   * `PlatformError` cannot express — would otherwise have to rewrite every one
   * of them to adopt the SDK, which is precisely the behaviour change a
   * migration must not make.
   *
   * So the escape hatch is explicit rather than inferred from the return shape:
   * a payload that happens to have a `content` array must not be silently
   * treated as a wire result. It also reads as migration debt — each `true` here
   * marks a handler that still owns its own serialization and can be converted
   * later, one at a time, without touching the tool table.
   */
  readonly rawResult: boolean;
  readonly handler: ToolHandler<I, O>;
}

/**
 * Erased tool type for heterogeneous collections (the registry holds tools of
 * many different input/output types). `any` is deliberate and confined to this
 * one alias — it is the only way to keep a registry array assignable in both
 * directions.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyToolDefinition = ToolDefinition<any, any>;

/** The `tools/list` wire shape. Structurally matches the MCP `Tool` type. */
export interface ToolDescriptor {
  readonly name: string;
  readonly title?: string;
  readonly description: string;
  readonly inputSchema: JsonSchemaObject;
  readonly annotations: {
    readonly readOnlyHint: boolean;
    readonly idempotentHint: boolean;
    readonly destructiveHint: boolean;
    readonly openWorldHint: boolean;
  };
}

/** Project a tool definition onto the MCP advertisement shape. */
export function toToolDescriptor(tool: AnyToolDefinition): ToolDescriptor {
  const base = {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    annotations: {
      readOnlyHint: tool.annotations.readOnly,
      idempotentHint: tool.annotations.idempotent,
      destructiveHint: tool.annotations.destructive,
      openWorldHint: tool.annotations.openWorld ?? false
    }
  };
  return tool.title === undefined ? base : { ...base, title: tool.title };
}
