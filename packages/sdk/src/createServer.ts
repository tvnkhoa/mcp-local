/**
 * Server bootstrap.
 *
 * The only module in the platform that imports @modelcontextprotocol/sdk.
 * Everything above it deals in ToolDefinitions; everything below is protocol.
 * Consequence: an SDK major-version migration is a change to this file, not to
 * every server.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema
} from "@modelcontextprotocol/sdk/types.js";

import type { Logger, ResponseProfile } from "@mcp/core";
import { DEFAULT_RESPONSE_PROFILE, createLogger, isPlatformError } from "@mcp/core";

import type { CallContext, CallWrapper } from "./callContext.js";
import type { Entry } from "./collect.js";
import { redirectConsoleToStderr } from "./console.js";
import type { DispatchDeps } from "./dispatch.js";
import { dispatchToolCall } from "./dispatch.js";
import type { Lifecycle } from "./lifecycle.js";
import { createLifecycle } from "./lifecycle.js";
import type { PromptDefinition, PromptProvider } from "./prompts.js";
import { registerPrompt } from "./prompts.js";
import type { LegacyBridge, ToolRegistry } from "./registry.js";
import { createToolRegistry } from "./registry.js";
import type { ResourceDefinition, ResourceProvider } from "./resources.js";
import { registerResource } from "./resources.js";
import type { SerializeOptions, ToolCallResult } from "./responses.js";
import { asFatalError } from "./responses.js";
import type { AnyToolDefinition } from "./toolDefinition.js";

export interface McpServerOptions {
  readonly name: string;
  readonly version: string;
  readonly tools: readonly AnyToolDefinition[];
  readonly logger?: Logger;
  /** Coexistence adapter for servers migrating tool-by-tool. */
  readonly legacy?: LegacyBridge;
  readonly defaultProfile?: ResponseProfile;
  readonly serialize?: SerializeOptions;
  /** Redirect console.* to stderr on start. Default true. */
  readonly protectStdout?: boolean;
  /** Attach SIGINT/SIGTERM handlers on start. Default true. */
  readonly handleSignals?: boolean;
  /**
   * Render failures using this server's own error envelope instead of the
   * platform default. See {@link DispatchDeps.formatError} — a server with an
   * established error contract passes its existing mapper here so adopting the
   * SDK does not rewrite every error response.
   */
  readonly formatError?: DispatchDeps["formatError"];
  /**
   * Serialize successful payloads with this server's own renderer rather than
   * the platform's. See {@link DispatchDeps.renderResult} — the counterpart to
   * `formatError`, for a server whose payload-to-text hop carries side effects.
   */
  readonly renderResult?: DispatchDeps["renderResult"];
  /**
   * Read-addressable state served over `resources/list` and `resources/read`.
   * Supplying one is what declares the `resources` capability — a server that
   * has none must not advertise it.
   *
   * A list of `createResource` definitions is composed with `registerResource`
   * defaults; pass the provider itself when you need its options.
   */
  readonly resources?: ResourceProvider | readonly Entry<ResourceDefinition>[];
  /**
   * Message templates served over `prompts/list` and `prompts/get`. Same rule as
   * `resources`: supplying one is what declares the `prompts` capability.
   */
  readonly prompts?: PromptProvider | readonly Entry<PromptDefinition>[];
  /**
   * Run around every `tools/call`. The only place with access to the request's
   * progress token and notification channel, and the only place a server-wide
   * pre- or post-dispatch policy can live. See {@link CallWrapper}.
   */
  readonly wrapCall?: CallWrapper;
}

export interface McpServerHandle {
  readonly server: Server;
  readonly registry: ToolRegistry;
  readonly lifecycle: Lifecycle;
  readonly logger: Logger;
  start(): Promise<void>;
  stop(reason?: string): Promise<void>;
}

export function createMcpServer(options: McpServerOptions): McpServerHandle {
  const logger = options.logger ?? createLogger({ name: options.name });
  const registry = createToolRegistry(options.tools, {
    ...(options.legacy === undefined ? {} : { legacy: options.legacy })
  });
  const lifecycle = createLifecycle(logger);

  /**
   * A *list* of definitions is composed here; a provider is taken as given.
   *
   * An empty list counts as none at all, so it does not advertise the capability:
   * a server passing `[]` has declared no resources, and a capability with
   * nothing behind it invites a client to call a method the server cannot
   * usefully answer. A provider is never second-guessed this way — it may be
   * serving state that is only empty right now.
   */
  const resources = Array.isArray(options.resources)
    ? options.resources.length === 0
      ? undefined
      : registerResource(options.resources)
    : (options.resources as ResourceProvider | undefined);
  const prompts = Array.isArray(options.prompts)
    ? options.prompts.length === 0
      ? undefined
      : registerPrompt(options.prompts)
    : (options.prompts as PromptProvider | undefined);

  const server = new Server(
    { name: options.name, version: options.version },
    {
      capabilities: {
        tools: {},
        ...(resources === undefined ? {} : { resources: {} }),
        ...(prompts === undefined ? {} : { prompts: {} })
      }
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: registry.list().map((descriptor) => ({ ...descriptor }))
  }));

  const dispatchDeps: DispatchDeps = {
    logger,
    defaultProfile: options.defaultProfile ?? DEFAULT_RESPONSE_PROFILE,
    ...(options.serialize === undefined ? {} : { serialize: options.serialize }),
    ...(options.formatError === undefined ? {} : { formatError: options.formatError }),
    ...(options.renderResult === undefined ? {} : { renderResult: options.renderResult })
  };

  const wrapCall = options.wrapCall;

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const toolName = request.params.name;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    const next = (): Promise<ToolCallResult> => dispatchToolCall(registry, toolName, args, dispatchDeps);

    if (wrapCall === undefined) {
      return { ...(await next()) };
    }

    // Only read off the request when a wrapper exists to receive it: `_meta` is
    // untyped by the protocol schema and this is the one narrowing of it.
    const progressToken = (request.params._meta as { progressToken?: string | number } | undefined)
      ?.progressToken;

    const context: CallContext = {
      toolName,
      args,
      ...(progressToken === undefined ? {} : { progressToken }),
      reportProgress: (progress, total, message) => {
        if (progressToken === undefined) {
          return;
        }
        void extra
          .sendNotification({
            method: "notifications/progress",
            params: { progressToken, progress, ...(total === undefined ? {} : { total }), message }
          })
          // Best-effort by contract: a dropped progress frame must never fail
          // the tool call that produced it.
          .catch(() => undefined);
      }
    };

    try {
      return { ...(await wrapCall(context, next)) };
    } catch (cause) {
      // dispatchToolCall never rejects, so this can only be the wrapper itself.
      // Letting it escape would turn a server-side bug into a protocol error the
      // client cannot interpret, which is the one thing this layer guarantees
      // against.
      logger.error("wrap_call_failed", { tool: toolName, detail: String(cause) });
      return { ...asFatalError() };
    }
  });

  if (resources !== undefined) {
    server.setRequestHandler(ListResourcesRequestSchema, async (request) => ({
      // The cursor is forwarded, not interpreted: paging is the provider's business.
      resources: (await resources.list(request.params?.cursor)).map((descriptor) => ({ ...descriptor }))
    }));

    server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      const uri = request.params.uri;
      const contents = await resources.read(uri);
      if (contents === undefined) {
        // Distinct from a read that failed: the URI is not one this server
        // routes at all, which is an invalid parameter rather than an internal
        // fault. Anything the provider throws propagates instead.
        throw new McpError(ErrorCode.InvalidParams, `Unsupported resource URI: ${uri}`);
      }
      return { contents: contents.map((content) => ({ ...content })) };
    });
  }

  if (prompts !== undefined) {
    server.setRequestHandler(ListPromptsRequestSchema, async (request) => ({
      // Cursor forwarded, not interpreted — the provider owns paging, as with resources.
      prompts: (await prompts.list(request.params?.cursor)).map((descriptor) => ({
        ...descriptor,
        ...(descriptor.arguments === undefined
          ? {}
          : { arguments: descriptor.arguments.map((argument) => ({ ...argument })) })
      }))
    }));

    server.setRequestHandler(GetPromptRequestSchema, async (request) => {
      const name = request.params.name;
      let result;
      try {
        result = await prompts.get(name, request.params.arguments ?? {});
      } catch (cause) {
        /**
         * A user-audience `PlatformError` is a bad request, not a server fault —
         * a missing required argument being the one `createPrompt` itself raises.
         * Mapping it to invalid-params keeps the client's own retry logic viable;
         * anything else is a genuine failure and propagates as it is.
         */
        if (isPlatformError(cause) && cause.audience === "user") {
          throw new McpError(ErrorCode.InvalidParams, cause.message);
        }
        throw cause;
      }
      if (result === undefined) {
        // Same distinction resources draw: a name this server does not serve is
        // an invalid parameter, not an internal fault.
        throw new McpError(ErrorCode.InvalidParams, `Unknown prompt: ${name}`);
      }
      return {
        ...(result.description === undefined ? {} : { description: result.description }),
        messages: result.messages.map((message) => ({ ...message, content: { ...message.content } }))
      };
    });
  }

  let restoreConsole: (() => void) | undefined;
  let detachSignals: (() => void) | undefined;

  return {
    server,
    registry,
    lifecycle,
    logger,

    async start() {
      if (options.protectStdout !== false) {
        restoreConsole = redirectConsoleToStderr();
      }
      if (options.handleSignals !== false) {
        detachSignals = lifecycle.installSignalHandlers();
      }

      const stats = registry.stats();
      logger.info("server_starting", {
        name: options.name,
        version: options.version,
        toolsRegistered: stats.registered,
        toolsLegacy: stats.legacy
      });

      const transport = new StdioServerTransport();
      lifecycle.onShutdown({
        name: "transport",
        run: async () => {
          await server.close();
        }
      });

      await server.connect(transport);
      logger.info("server_ready", { name: options.name });
    },

    async stop(reason = "explicit") {
      await lifecycle.shutdown(reason);
      detachSignals?.();
      restoreConsole?.();
    }
  };
}

/**
 * `createMcpServer` under the name the rest of the builder family uses.
 *
 * An alias, not a rename: all four servers call `createMcpServer`, and renaming
 * their call sites would be churn with no behavioural gain. `createServer` /
 * `createTool` / `createPrompt` / `createResource` read as one vocabulary for new
 * code.
 */
export const createServer: typeof createMcpServer = createMcpServer;
