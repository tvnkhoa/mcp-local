/**
 * Server bootstrap — this server's contract, expressed as hooks into `@mcp/sdk` (S-31).
 *
 * The registry starts empty and a `LegacyBridge` sits behind it, so every tool is still
 * served by the pre-SDK `switch` (see `tools/legacyDispatch.ts`) and behaviour is provably
 * unchanged. S-32 registers real tool definitions a batch at a time; each one it registers
 * stops falling through, because the registry wins over the bridge by name.
 *
 * What this file exists to preserve — none of it visible in a `tools/list` snapshot:
 *
 *   - **`formatError`** — the `{ code, message, requestId }` envelope, pretty-printed at
 *     every profile, returned as an `isError` result rather than a JSON-RPC error. The
 *     platform default is a different shape.
 *   - **`renderResult`** — the success path's serializer, which also emits the telemetry
 *     line. Its side effect is invisible in the response bytes, so a pipeline that owns
 *     serialization would drop it silently.
 *   - **`wrapCall`** — the per-request `AsyncLocalStorage` scope. Code far below the
 *     handlers (the batch indexer's progress reporter, the telemetry emitter at
 *     serialization time) reaches the request through it rather than through parameters.
 *   - **`resources`** — the four `repo://` resources, and with them the `resources`
 *     capability, which must only be advertised because this server actually serves them.
 *
 * Wiring is injected rather than imported: `index.ts` owns the env, the store and the
 * watch manager, and this module must not reach back for them.
 */

import type { AsyncLocalStorage } from "node:async_hooks";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { CallWrapper, LegacyBridge, McpServerHandle, ResourceProvider, ToolCallResult } from "@mcp/sdk";
import { createMcpServer } from "@mcp/sdk";

import { mapError } from "./errorHandler.js";
import type { GraphStore } from "./graphStore.js";
import { handleListResources, handleReadResource } from "./handlers/resourceHandler.js";
import type { HandlerContext } from "./handlers/handlerContext.js";
import {
  type ResponseProfile,
  type ToolRequestContext,
  asArgsRecord,
  emitTelemetry
} from "./response/responseFormatter.js";
import type { DescriptorLimits } from "./tools/descriptors/limits.js";
import { legacyToolDescriptors } from "./tools/descriptors/index.js";
import type { LegacyDispatch } from "./tools/legacyDispatch.js";
import { maybeAutoActivateWatchFromArgs } from "./watch/watchLifecycle.js";

export interface TelemetryConfig {
  readonly enabled: boolean;
  readonly sampleRate: number;
}

export interface CodebaseIndexServerOptions {
  /**
   * The version advertised over `initialize` — deliberately NOT the package version
   * reported by `health_check`. The two have been different since before the migration
   * and unifying them is a client-visible change, so it stays a separate decision.
   */
  readonly version: string;
  readonly limits: DescriptorLimits;
  readonly store: GraphStore;
  readonly dispatchLegacyTool: LegacyDispatch;
  readonly buildHandlerContext: () => HandlerContext;
  readonly toolContextStorage: AsyncLocalStorage<ToolRequestContext>;
  /** The entry point's own serializer — it emits telemetry as a side effect. */
  readonly renderResult: (payload: unknown, profile: ResponseProfile) => CallToolResult;
  readonly telemetry: TelemetryConfig;
}

/**
 * Narrow a protocol result to the platform's text-only one.
 *
 * The protocol's `CallToolResult` also admits image, audio and embedded-resource blocks, so
 * it is strictly wider than `@mcp/sdk`'s `ToolCallResult`, and the compiler cannot know this
 * server only ever produces a single text block. Every result here comes from
 * `responseFormatter.asText` or is built literally two functions below, so the assertion
 * holds — but it IS an assertion, kept to this one function rather than spread across the
 * four hook boundaries that need it.
 *
 * It stops being needed when the handlers become tool definitions (S-32/S-33) and stop
 * declaring the wider protocol type they never use.
 */
function asWireResult(result: CallToolResult): ToolCallResult {
  return result as ToolCallResult;
}

export function createCodebaseIndexServer(options: CodebaseIndexServerOptions): McpServerHandle {
  const { toolContextStorage, telemetry } = options;

  /**
   * This server's failure envelope, for every failure: zod, a PolicyViolationError from
   * the refactor engine, an McpError, or anything a handler throws.
   *
   * `mapError` needs the tool name and the telemetry event needs the request's start time
   * and arguments, none of which the hook receives — they come from the per-request scope
   * that `wrapCall` establishes below, which is always active by the time this runs.
   *
   * The profile argument is ignored on purpose: errors were pretty-printed at every
   * profile before the migration, including `nano`.
   */
  function renderToolError(error: unknown): CallToolResult {
    const requestContext = toolContextStorage.getStore();
    const toolName = requestContext?.toolName ?? "unknown_tool";
    const mapped = mapError(error, toolName);
    const text = JSON.stringify(mapped, null, 2);

    emitTelemetry(
      {
        ts: new Date().toISOString(),
        toolName,
        elapsedMs: requestContext === undefined ? 0 : Date.now() - requestContext.startedAt,
        responseBytes: Buffer.byteLength(text, "utf8"),
        resultCount: 0,
        profile: "none",
        requestedProfile:
          typeof requestContext?.args.profile === "string" ? requestContext.args.profile : null,
        compactRequested: requestContext?.args.compact === true,
        isError: true,
        errorCode: mapped.code
      },
      telemetry.enabled,
      telemetry.sampleRate
    );

    return { content: [{ type: "text", text }], isError: true };
  }

  /**
   * Everything not in the registry, including names that exist nowhere.
   *
   * `has` answering `true` unconditionally is the point: during coexistence the switch is
   * the terminal handler, and its `default:` branch IS this server's unknown-tool
   * rejection — an `isError` result carrying `MCP_ERROR` and the MethodNotFound code.
   * Routing unknown names to the platform's `not_found` instead would change that
   * response, which is why it is not left to the default. Registered tools are resolved
   * before the bridge is consulted, so this stays correct as tools migrate.
   *
   * S-33 deletes the switch, and with it this branch. Reproducing the same envelope for
   * unknown tools is a decision that step has to make explicitly.
   */
  const legacy: LegacyBridge = {
    listTools: () => legacyToolDescriptors(options.limits),
    has: () => true,
    // `.then` rather than `await`: a rejection must stay a rejection so the bridge reports
    // it and `formatError` renders the envelope.
    call: (name, args) => options.dispatchLegacyTool(name, args).then(asWireResult)
  };

  /**
   * The `repo://{repoId}/{context|schema|routes|risk}` resources.
   *
   * `read` never returns the not-served sentinel: `handleReadResource` throws its own
   * `McpError` for both an unroutable URI and an unknown repoId, and a provider's throw
   * propagates unchanged. That keeps the message the client already gets, rather than the
   * platform's generic substitute.
   */
  const resources: ResourceProvider = {
    list: (cursor) => handleListResources(options.store, cursor).resources,
    read: (uri) => handleReadResource(uri, options.store, options.limits.maxResultLimit).contents
  };

  /**
   * Establish the per-request scope, then run the pre-dispatch watch policy inside it.
   *
   * `progressNotifier` is set only when the host actually supplied a progress token.
   * `reportProgress` is safe to call either way, but handing it over unconditionally would
   * make the indexer believe someone is listening and compute a progress snapshot per
   * batch that goes nowhere.
   *
   * The auto-activate call is guarded here rather than left to throw: a wrapper that
   * rejects is reported as a bare fatal result, and before the migration a failure in
   * this step went through the same error envelope as any other.
   */
  const wrapCall: CallWrapper = (context, next) => {
    const args = asArgsRecord(context.args);
    const requestContext: ToolRequestContext = {
      toolName: context.toolName,
      startedAt: Date.now(),
      args,
      ...(context.progressToken === undefined ? {} : { progressNotifier: context.reportProgress })
    };

    return toolContextStorage.run(requestContext, async () => {
      try {
        await maybeAutoActivateWatchFromArgs(context.toolName, args, options.buildHandlerContext());
      } catch (error) {
        return asWireResult(renderToolError(error));
      }
      return next();
    });
  };

  return createMcpServer({
    name: "codebase-index-mcp",
    version: options.version,
    // Empty until S-32. Every name falls through to `legacy` above.
    tools: [],
    legacy,
    resources,
    formatError: (error) => asWireResult(renderToolError(error)),
    // Unreachable while the registry is empty — the legacy handlers build their own wire
    // result. Wired now because the first tool S-32 migrates would otherwise lose the
    // telemetry emit without any test or snapshot being able to show it.
    renderResult: (payload, profile) => asWireResult(options.renderResult(payload, profile as ResponseProfile)),
    wrapCall
  });
}
