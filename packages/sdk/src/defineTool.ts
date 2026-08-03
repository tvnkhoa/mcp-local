/**
 * The reusable tool builder.
 *
 * `defineTool` is the single way a tool enters the platform. It validates the
 * declaration at construction time — a malformed tool is a programmer error and
 * fails at startup, not on first call — and freezes the result so nothing can
 * mutate a tool after registration.
 */

import type { LimitPolicy } from "@mcp/core";
import type { ZodType, infer as ZodInfer } from "zod";

import type { ToolCallResult } from "./responses.js";
import type { JsonSchemaObject } from "./schema.js";
import type { Guard, ToolAnnotations, ToolDefinition, ToolHandler } from "./toolDefinition.js";

/** snake_case, must start with a letter. Matches every existing platform tool. */
const TOOL_NAME_PATTERN = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/;

interface ToolSpecBase<S extends ZodType> {
  readonly name: string;
  readonly title?: string;
  readonly description: string;
  readonly input: S;
  readonly inputSchema: JsonSchemaObject;
  readonly annotations: ToolAnnotations;
  readonly guards?: readonly Guard[];
  readonly limits?: LimitPolicy;
}

export interface ToolSpec<S extends ZodType, O> extends ToolSpecBase<S> {
  /** Omitted or false: the handler returns a payload for dispatch to serialize. */
  readonly rawResult?: false;
  readonly handler: ToolHandler<ZodInfer<S>, O>;
}

/**
 * A tool whose handler builds the wire result itself. See
 * {@link ToolDefinition.rawResult} for why this exists and when to retire it.
 */
export interface RawToolSpec<S extends ZodType> extends ToolSpecBase<S> {
  readonly rawResult: true;
  readonly handler: ToolHandler<ZodInfer<S>, ToolCallResult>;
}

export function defineTool<S extends ZodType>(
  spec: RawToolSpec<S>
): ToolDefinition<ZodInfer<S>, ToolCallResult>;
export function defineTool<S extends ZodType, O>(spec: ToolSpec<S, O>): ToolDefinition<ZodInfer<S>, O>;
export function defineTool<S extends ZodType, O>(
  spec: ToolSpec<S, O> | RawToolSpec<S>
): ToolDefinition<ZodInfer<S>, O> {
  if (!TOOL_NAME_PATTERN.test(spec.name)) {
    throw new Error(
      `defineTool: tool name "${spec.name}" must be snake_case (e.g. "run_read_query")`
    );
  }
  if (spec.description.trim() === "") {
    throw new Error(`defineTool: tool "${spec.name}" must have a non-empty description`);
  }
  if (spec.inputSchema.type !== "object") {
    throw new Error(`defineTool: tool "${spec.name}" inputSchema must be an object schema`);
  }
  if (
    typeof spec.annotations.readOnly !== "boolean" ||
    typeof spec.annotations.idempotent !== "boolean" ||
    typeof spec.annotations.destructive !== "boolean"
  ) {
    throw new Error(
      `defineTool: tool "${spec.name}" must declare readOnly, idempotent and destructive annotations`
    );
  }
  if (spec.annotations.readOnly && spec.annotations.destructive) {
    throw new Error(`defineTool: tool "${spec.name}" cannot be both readOnly and destructive`);
  }

  const definition: ToolDefinition<ZodInfer<S>, O> = {
    name: spec.name,
    title: spec.title,
    description: spec.description,
    input: spec.input as ZodType<ZodInfer<S>>,
    inputSchema: spec.inputSchema,
    annotations: Object.freeze({ ...spec.annotations }),
    guards: Object.freeze([...(spec.guards ?? [])]),
    limits: spec.limits,
    rawResult: spec.rawResult === true,
    handler: spec.handler as ToolHandler<ZodInfer<S>, O>
  };

  return Object.freeze(definition);
}

/**
 * `defineTool` under the name the rest of the builder family uses.
 *
 * Same function, same overloads — kept as an alias rather than a rename because
 * every tool in all four servers is declared through `defineTool` and a rename
 * would touch every one of those files for no behavioural gain. New code can read
 * `createTool` / `createPrompt` / `createResource` as one vocabulary.
 */
export const createTool: typeof defineTool = defineTool;

/** Common annotation presets, so the usual cases stay one word. */
export const annotations = {
  read: (): ToolAnnotations => ({ readOnly: true, idempotent: true, destructive: false, openWorld: false }),
  readRemote: (): ToolAnnotations => ({ readOnly: true, idempotent: true, destructive: false, openWorld: true }),
  /** A preview step: computes a plan, changes nothing. */
  preview: (): ToolAnnotations => ({ readOnly: true, idempotent: true, destructive: false, openWorld: false }),
  /** An apply step: changes state and may overwrite. */
  apply: (): ToolAnnotations => ({ readOnly: false, idempotent: false, destructive: true, openWorld: false }),
  /** A create step: changes state without removing anything. */
  create: (): ToolAnnotations => ({ readOnly: false, idempotent: false, destructive: false, openWorld: true })
} as const;
