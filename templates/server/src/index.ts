/**
 * __DIR__ — entry point, and nothing else.
 *
 * This file has start-up side effects by design (config load, transport connect), so it holds no
 * logic worth testing. Tools live in `tools/index.ts`, which can be built against a stub.
 *
 * stdout is the MCP transport. Writing to it corrupts the protocol, which is why logging goes to
 * stderr through `createEventLogger` and `guard:convention` rejects `console.log` outright.
 */

import { createEventLogger } from "@mcp/core";
import { asErrorPayload, createMcpServer, runServer } from "@mcp/sdk";

import { loadConfig, describeConfig, type __PASCAL__Config } from "./config/index.js";
import { mapError } from "./middleware/errors.js";
import { buildTools, toWireError } from "./tools/index.js";

const config: __PASCAL__Config = loadConfig();

const eventLog = createEventLogger();

const handle = createMcpServer({
  name: "__KEY__",
  version: "0.1.0",
  tools: buildTools(config),
  /**
   * This server's error contract, not the platform's. Every failure — zod validation, a policy
   * refusal, an upstream error — is rendered in `{ code, message, detail? }`. Remove this only if
   * you intend to adopt the platform default, because it changes every error response.
   */
  formatError: (error) => asErrorPayload(toWireError(error), "verbose")
});

/**
 * `runServer` owns the start-and-exit tail: start the transport, run `onStarted`, and on any
 * failure report it and exit non-zero. It is not set up to run the shutdown hooks here —
 * `stopOnCrash` is for servers that acquire a resource (a database handle, a file watcher)
 * *before* `start()`, and this one does not yet.
 */
runServer(handle, {
  onStarted: () => eventLog.info("server_started", { config: describeConfig(config) }),
  onCrash: (error) => eventLog.error("server_crashed", { error: mapError(error) })
});
