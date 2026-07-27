/**
 * Tool harness — call a tool exactly the way the server would, without a server.
 *
 * The harness routes through the real `dispatchToolCall`, so validation, guard
 * evaluation, error mapping, and profile serialization are the production code
 * paths. A test that passes here cannot pass for a reason the server would not
 * reproduce.
 */

import type { ResponseProfile } from "@mcp/core";
import type { AnyToolDefinition, LegacyBridge, SerializeOptions } from "@mcp/sdk";
import { createToolRegistry, dispatchToolCall } from "@mcp/sdk";

import type { MemoryLogger } from "./context.js";
import { createMemoryLogger } from "./context.js";

export interface ToolInvocation<T = unknown> {
  /** True when the tool returned an error result. */
  readonly isError: boolean;
  /** Decoded JSON payload. For errors, the platform error payload. */
  readonly payload: T;
  /** Raw serialized text, for assertions about formatting or leakage. */
  readonly text: string;
  /** Error code when `isError`, otherwise undefined. */
  readonly errorCode: string | undefined;
  readonly logs: MemoryLogger;
}

export interface InvokeOptions {
  readonly profile?: ResponseProfile;
  readonly logger?: MemoryLogger;
  readonly serialize?: SerializeOptions;
  readonly requestId?: string;
  readonly signal?: AbortSignal;
}

function decode(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/** Invoke a single tool. */
export async function invokeTool<T = unknown>(
  tool: AnyToolDefinition,
  input: Record<string, unknown> = {},
  options: InvokeOptions = {}
): Promise<ToolInvocation<T>> {
  return createToolHarness([tool], options).call<T>(tool.name, input);
}

export interface ToolHarness {
  call<T = unknown>(name: string, input?: Record<string, unknown>): Promise<ToolInvocation<T>>;
  /** Descriptors exactly as `tools/list` would advertise them. */
  list(): ReturnType<ReturnType<typeof createToolRegistry>["list"]>;
  readonly logs: MemoryLogger;
}

export interface HarnessOptions extends InvokeOptions {
  readonly legacy?: LegacyBridge;
}

/** Build a harness over a set of tools, sharing one log capture. */
export function createToolHarness(
  tools: readonly AnyToolDefinition[],
  options: HarnessOptions = {}
): ToolHarness {
  const logs = options.logger ?? createMemoryLogger();
  const registry = createToolRegistry(tools, {
    ...(options.legacy === undefined ? {} : { legacy: options.legacy })
  });

  return {
    logs,
    list: () => registry.list(),

    async call<T>(name: string, input: Record<string, unknown> = {}): Promise<ToolInvocation<T>> {
      const args =
        options.profile === undefined || "profile" in input
          ? input
          : { ...input, profile: options.profile };

      const result = await dispatchToolCall(registry, name, args, {
        logger: logs.logger,
        ...(options.profile === undefined ? {} : { defaultProfile: options.profile }),
        ...(options.serialize === undefined ? {} : { serialize: options.serialize }),
        ...(options.requestId === undefined ? {} : { requestId: () => options.requestId as string }),
        ...(options.signal === undefined ? {} : { signal: options.signal })
      });

      const text = result.content[0]?.text ?? "";
      const payload = decode(text);
      const isError = result.isError === true;
      const errorCode =
        isError && typeof payload === "object" && payload !== null && "code" in payload
          ? String((payload as { code: unknown }).code)
          : undefined;

      return { isError, payload: payload as T, text, errorCode, logs };
    }
  };
}
