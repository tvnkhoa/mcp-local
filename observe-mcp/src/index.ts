/**
 * observe-mcp — migrated onto `@mcp/sdk` (migration-plan step S-25).
 *
 * Tools are declared as data in `tools.ts` and dispatched by the shared pipeline
 * (resolve → profile → validate → guards → handle → serialize) instead of a
 * hand-written `switch`. What stays local is this server's own contract: the
 * exact tool descriptions and JSON Schemas, the read-only SQL guardrail, and the
 * `{ code, message, detail? }` error envelope, injected via `formatError` rather
 * than replaced by the platform's.
 *
 * This file is the entry point and nothing else — it has start-up side effects,
 * so anything that needs testing lives in `tools.ts`.
 *
 * Two safety nets cover the migration:
 *   - `contracts/observe-mcp.json` pins `tools/list`
 *   - `src/tools.test.ts` pins call responses, including error envelopes
 */

import { createEventLogger } from "@mcp/core";
import { asErrorPayload, createMcpServer, runServer } from "@mcp/sdk";

import { loadLimits, describeLimits, type ObserveLimits } from "./config/index.js";
import { mapError } from "./middleware/errors.js";
import { ClientManager } from "./services/clientManager.js";
import { buildTools, toWireError } from "./tools/index.js";

const limits: ObserveLimits = loadLimits();
/**
 * One manager, many environments. Building it here is what turns a missing or
 * malformed environment configuration into a startup failure rather than a
 * confusing per-call error — the registry throws if nothing is configured.
 */
const clients = new ClientManager(limits);

/**
 * stderr event logger. Emits `{"level":..,"event":..,...detail}`. stdout is the
 * MCP transport, so nothing may be written there.
 */
const eventLog = createEventLogger();

const handle = createMcpServer({
  name: "communicationhub-observe-mcp",
  version: "0.1.0",
  tools: buildTools(limits, clients),
  /**
   * This server's error contract, not the platform's. Every failure — zod
   * validation, a time-window refusal, an ObserveHttpError — is rendered in the
   * `{ code, message, detail? }` envelope at the `verbose` profile, exactly as
   * the hand-written dispatcher did. Without this the migration would silently
   * rewrite every error response, which `tools/list` cannot reveal.
   *
   * `run_observe_query`'s guardrail rejection deliberately does NOT come through
   * here — see its declaration in `tools.ts`.
   */
  formatError: (error) => asErrorPayload(toWireError(error), "verbose")
});

runServer(handle, {
  onStarted: () =>
    eventLog.info("server_started", {
      limits: describeLimits(limits),
      defaultEnvironment: clients.defaultEnvironment,
      // `list()` is the masked view — no credential can reach the log through it.
      environments: clients.list()
    }),
  onCrash: (error) => eventLog.error("server_crashed", { error: mapError(error) })
});
