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
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import type { Logger, ResponseProfile } from "@mcp/core";
import { DEFAULT_RESPONSE_PROFILE, createLogger } from "@mcp/core";

import { redirectConsoleToStderr } from "./console.js";
import type { DispatchDeps } from "./dispatch.js";
import { dispatchToolCall } from "./dispatch.js";
import type { Lifecycle } from "./lifecycle.js";
import { createLifecycle } from "./lifecycle.js";
import type { LegacyBridge, ToolRegistry } from "./registry.js";
import { createToolRegistry } from "./registry.js";
import type { SerializeOptions } from "./responses.js";
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

  const server = new Server(
    { name: options.name, version: options.version },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: registry.list().map((descriptor) => ({ ...descriptor }))
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    const result = await dispatchToolCall(registry, request.params.name, args, {
      logger,
      defaultProfile: options.defaultProfile ?? DEFAULT_RESPONSE_PROFILE,
      ...(options.serialize === undefined ? {} : { serialize: options.serialize }),
      ...(options.formatError === undefined ? {} : { formatError: options.formatError })
    });
    return { ...result };
  });

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
