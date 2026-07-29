/**
 * __DIR__ — entry point, and nothing else.
 *
 * This file has start-up side effects by design (config load, transport connect), so it holds no
 * logic worth testing. Tools live in `tools.ts`, which can be built against a stub.
 *
 * stdout is the MCP transport. Writing to it corrupts the protocol, which is why logging goes to
 * stderr through `createEventLogger` and `guard:convention` rejects `console.log` outright.
 */

import process from "node:process";

import { createEventLogger } from "@mcp/core";
import { asErrorPayload, createMcpServer } from "@mcp/sdk";

import { loadConfig, describeConfig, type __PASCAL__Config } from "./config/index.js";
import { mapError } from "./errors.js";
import { buildTools } from "./tools.js";

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
  formatError: (error) => asErrorPayload(mapError(error), "verbose")
});

async function main(): Promise<void> {
  await handle.start();
  eventLog.info("server_started", { config: describeConfig(config) });
}

main().catch((error) => {
  eventLog.error("server_crashed", { error: mapError(error) });
  process.exit(1);
});
