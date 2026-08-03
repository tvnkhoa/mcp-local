/**
 * bitbucket-mcp — the pilot server on `@mcp/sdk` (migration-plan step S-23).
 *
 * Tools are declared as data in `tools.ts` and dispatched by the shared pipeline
 * (resolve → profile → validate → guards → handle → serialize) instead of a
 * hand-written switch. What stays local is this server's own contract: the exact
 * tool descriptions and JSON Schemas, the Bitbucket payload shapes, and the
 * `mapError` envelope, injected via `formatError` rather than replaced by the
 * platform's.
 *
 * This file is the entry point and nothing else — it has start-up side effects,
 * so anything that needs testing lives in `tools.ts`.
 *
 * Two safety nets cover the migration:
 *   - `contracts/bitbucket-mcp.json` pins `tools/list`
 *   - `src/tools.test.ts` pins every call response, including error envelopes
 */

import process from "node:process";

import { createEventLogger } from "@mcp/core";
import { asErrorPayload, createMcpServer } from "@mcp/sdk";

import { BitbucketClient } from "./services/bitbucketClient.js";
import { loadConfig, describeConfig, type BitbucketConfig } from "./config/index.js";
import { mapError } from "./middleware/errors.js";
import { buildTools, toWireError } from "./tools/index.js";

const config: BitbucketConfig = loadConfig();
const client = new BitbucketClient(config);

/**
 * stderr event logger. Emits `{"level":..,"event":..,...detail}`. stdout is the
 * MCP transport, so nothing may be written there.
 */
const eventLog = createEventLogger();

const handle = createMcpServer({
  name: "bitbucket-mcp",
  version: "0.1.0",
  tools: buildTools(config, client),
  /**
   * This server's error contract, not the platform's. Every failure — zod
   * validation, a PolicyViolationError from the write gate, an upstream HTTP
   * error — is rendered in the `{ code, message, detail? }` envelope at the
   * `verbose` profile, exactly as the hand-written dispatcher did. Without this
   * the migration would silently rewrite every error response, which
   * `tools/list` cannot reveal.
   */
  formatError: (error) => asErrorPayload(toWireError(error), "verbose")
});

async function main(): Promise<void> {
  await handle.start();
  eventLog.info("server_started", { config: describeConfig(config) });
}

main().catch((error) => {
  eventLog.error("server_crashed", { error: mapError(error) });
  process.exit(1);
});
