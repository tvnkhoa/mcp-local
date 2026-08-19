/**
 * sqlserver-mcp — entry point, and nothing else.
 *
 * This file has start-up side effects by design (config load, transport connect), so it holds no
 * logic worth testing. Tools live in `tools/index.ts`, which is built against a stub.
 *
 * stdout is the MCP transport. Writing to it corrupts the protocol, which is why logging goes to
 * stderr through `createEventLogger` and `guard:convention` rejects `console.log` outright.
 */

import { createEventLogger } from "@mcp/core";
import { asErrorPayload, createMcpServer, runServer } from "@mcp/sdk";

import { loadConfig, type SqlserverConfig } from "./config/index.js";
import { mapError } from "./middleware/errors.js";
import { ConnectionManager } from "./repositories/connectionManager.js";
import { buildDeps, buildTools, toWireError } from "./tools/index.js";

const config: SqlserverConfig = loadConfig();

const eventLog = createEventLogger();

const connections = new ConnectionManager(config);

const handle = createMcpServer({
  name: "sqlserver-mcp",
  version: "0.1.0",
  tools: buildTools(buildDeps(config, connections, eventLog)),
  /**
   * This server's error contract, not the platform's. Every failure — zod validation, a guard
   * refusal, a driver error — is rendered as `{ code, message, detail? }`, and
   * `src/tools/tools.test.ts` pins that.
   */
  formatError: (error) => asErrorPayload(toWireError(error), "verbose")
});

/**
 * Close the pools on the way out.
 *
 * A stdio server that exits without closing them leaves TDS connections on the instance until the
 * server times them out — and this one opens a pool per *catalog*, not per process, so the leak
 * scales with how many catalogs the session touched.
 */
handle.lifecycle.onShutdown({
  name: "connection-pools",
  run: async () => {
    await connections.closeAll();
  }
});

/**
 * `stopOnCrash` stays off: pools are opened lazily, on the first call that names a catalog, so a
 * start-up that fails has acquired nothing to release.
 */
runServer(handle, {
  onStarted: () =>
    eventLog.info("server_started", {
      environments: [...config.registry.environments.keys()],
      defaultEnvironment: config.registry.defaultEnvironment,
      execEnabled: config.exec.enabled
    }),
  onCrash: (error) => eventLog.error("server_crashed", { error: mapError(error) })
});
