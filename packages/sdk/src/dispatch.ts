/**
 * The dispatch pipeline.
 *
 * resolve -> profile -> validate -> guards -> handle -> serialize
 *
 * Every failure path returns a `CallToolResult` with `isError: true` carrying a
 * stable error code. Nothing throws out of here: an uncaught exception in a
 * handler becomes an `internal_error` with the detail logged, never returned.
 */

import type { Logger, PlatformError, ResponseProfile } from "@mcp/core";
import {
  DEFAULT_RESPONSE_PROFILE,
  notFound,
  parseResponseProfile,
  toPlatformError,
  validationError
} from "@mcp/core";

import { runGuards } from "./guards.js";
import type { ToolRegistry } from "./registry.js";
import type { SerializeOptions, ToolCallResult } from "./responses.js";
import { asError, asFatalError, asText } from "./responses.js";
import type { ToolContext } from "./toolDefinition.js";

export interface DispatchDeps {
  readonly logger: Logger;
  readonly defaultProfile?: ResponseProfile;
  readonly serialize?: SerializeOptions;
  /** Injectable so request ids are deterministic in tests. */
  readonly requestId?: () => string;
  readonly signal?: AbortSignal;
  /**
   * Render a failure using the server's own error contract.
   *
   * Dispatch decides *that* a call failed; the server decides how that failure
   * looks on the wire. Without this hook, adopting the SDK would force every
   * server onto `PlatformError`'s payload shape and closed code vocabulary —
   * silently rewriting every error response its clients already depend on, in a
   * way `tools/list` cannot reveal.
   *
   * Receives the most informative value available: the raw `ZodError` for a
   * validation failure, the original thrown value for a handler crash, and a
   * `PlatformError` for refusals dispatch itself raises. Defaults to
   * {@link asError}.
   *
   * Must not throw. If it does, the caller still gets {@link asFatalError}.
   */
  readonly formatError?: (error: unknown, profile: ResponseProfile) => ToolCallResult;
}

let requestCounter = 0;

function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter}`;
}

function formatZodIssues(error: unknown): Record<string, unknown> {
  const issues = (error as { issues?: { path?: unknown[]; message?: string }[] }).issues;
  if (!Array.isArray(issues)) {
    return {};
  }
  return {
    issues: issues.slice(0, 10).map((issue) => ({
      path: Array.isArray(issue.path) ? issue.path.join(".") : "",
      message: typeof issue.message === "string" ? issue.message : "invalid"
    }))
  };
}

export async function dispatchToolCall(
  registry: ToolRegistry,
  name: string,
  rawArgs: Record<string, unknown>,
  deps: DispatchDeps
): Promise<ToolCallResult> {
  const profile = parseResponseProfile(rawArgs["profile"], deps.defaultProfile ?? DEFAULT_RESPONSE_PROFILE);

  // The whole body is wrapped: the contract is that dispatch NEVER rejects.
  // Anything escaping here would surface as a protocol-level failure rather
  // than a tool error, which the client cannot interpret.
  try {
    return await dispatchInner(registry, name, rawArgs, deps, profile);
  } catch (cause) {
    const error = toPlatformError(cause, `Tool "${name}" failed unexpectedly.`);
    deps.logger.error("dispatch_failed", { tool: name, code: error.code, detail: String(cause) });
    try {
      return renderError(deps, cause, error, profile);
    } catch {
      return asFatalError();
    }
  }
}

/**
 * Render a failure, preferring the server's own envelope.
 *
 * `raw` is the most informative original value; `fallback` is the PlatformError
 * dispatch would otherwise return. A `formatError` that throws must not become a
 * protocol-level failure, so it degrades to the default rendering.
 */
function renderError(
  deps: DispatchDeps,
  raw: unknown,
  fallback: PlatformError,
  profile: ResponseProfile
): ToolCallResult {
  if (deps.formatError === undefined) {
    return asError(fallback, profile);
  }
  try {
    return deps.formatError(raw, profile);
  } catch (cause) {
    deps.logger.error("format_error_failed", { detail: String(cause) });
    return asError(fallback, profile);
  }
}

async function dispatchInner(
  registry: ToolRegistry,
  name: string,
  rawArgs: Record<string, unknown>,
  deps: DispatchDeps,
  profile: ResponseProfile
): Promise<ToolCallResult> {
  const serialize = deps.serialize ?? {};

  const tool = registry.get(name);

  if (tool === undefined) {
    const legacy = registry.legacy;
    if (legacy !== undefined && legacy.has(name)) {
      // Not yet migrated — hand off to the server's existing dispatcher.
      try {
        return await legacy.call(name, rawArgs);
      } catch (cause) {
        const error = toPlatformError(cause, `Legacy tool "${name}" failed.`);
        deps.logger.error("legacy_tool_failed", { tool: name, code: error.code });
        return renderError(deps, cause, error, profile);
      }
    }
    const unknown = notFound(`Unknown tool: ${name}.`, { tool: name });
    return renderError(deps, unknown, unknown, profile);
  }

  const requestId = (deps.requestId ?? nextRequestId)();
  const ctx: ToolContext = {
    logger: deps.logger.child({ tool: name, requestId }),
    profile,
    requestId,
    ...(deps.signal === undefined ? {} : { signal: deps.signal })
  };

  const parsed = tool.input.safeParse(rawArgs);
  if (!parsed.success) {
    // The raw ZodError is handed to formatError: a server that already renders
    // zod issues its own way needs the issues, not a summary of them.
    return renderError(
      deps,
      parsed.error,
      validationError(`Invalid arguments for ${name}.`, { tool: name, ...formatZodIssues(parsed.error) }),
      profile
    );
  }

  const guardOutcome = await runGuards(tool.guards, { toolName: name, input: parsed.data, ctx });
  if (!guardOutcome.ok) {
    ctx.logger.warn("tool_refused", { code: guardOutcome.error.code });
    return renderError(deps, guardOutcome.error, guardOutcome.error, profile);
  }

  try {
    const outcome = await tool.handler(parsed.data, ctx);
    if (!outcome.ok) {
      ctx.logger.warn("tool_error", { code: outcome.error.code });
      return renderError(deps, outcome.error, outcome.error, profile);
    }
    return asText(outcome.value, profile, serialize);
  } catch (cause) {
    const error = toPlatformError(cause, `Tool "${name}" failed unexpectedly.`);
    ctx.logger.error("tool_threw", { code: error.code, detail: String(cause) });
    return renderError(deps, cause, error, profile);
  }
}
