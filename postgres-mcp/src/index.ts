/**
 * postgres-mcp — migrated onto `@mcp/sdk` (migration-plan step S-24).
 *
 * Tools are declared as data in `tools/` and dispatched by the shared pipeline
 * (resolve → profile → validate → guards → handle → serialize) instead of a
 * hand-written `switch`. What stays local is this server's own contract: the
 * exact tool descriptions and JSON Schemas, the SQL guardrails, the write and
 * migration gates, and the `{ code, message, detail? }` error envelope, injected
 * via `formatError` rather than replaced by the platform's.
 *
 * This file is the entry point and nothing else — it has start-up side effects,
 * so anything that needs testing lives under `tools/`.
 *
 * Two safety nets cover the migration:
 *   - `contracts/postgres-mcp.json` pins `tools/list`
 *   - `src/tools/tools.test.ts` pins call responses, including error envelopes
 */

import { createEnvReader, createEventLogger, defaultEnvSource } from "@mcp/core";
import { asErrorPayload, createMcpServer, runServer } from "@mcp/sdk";

import { ConnectionManager } from "./repositories/connectionManager.js";
import { toWireError } from "./middleware/errors.js";
import { type MigrationConfig } from "./services/migration/efRunner.js";
import { buildSchemaResources } from "./resources/schemaResources.js";
import { buildTools, type QueryLimits } from "./tools/index.js";
import {
  approvalSecretFromEnv,
  dotnetProjectsFromEnv,
  numberFromEnv,
  parseBoolEnv
} from "./config/index.js";
import { resolveAliases } from "./config/aliases.js";
import { resolveApprovalSecret } from "./services/write/approval.js";
import { WritePreviewStore } from "./services/write/previewStore.js";
import { type WriteConfig } from "./tools/handlers/writeHandlers.js";

/**
 * Honour the pre-S-43 variable names before anything reads configuration.
 *
 * First statement with an effect, deliberately: every `numberFromEnv` / `parseBoolEnv` below reads a
 * `POSTGRES_*` name, and an install still carrying `PG_*` or `CH_*` would otherwise fall through to
 * defaults — silently, and for the write and migration gates that means reading `false` where the
 * operator set `true`. `resolveEnvironments()` calls this again for the same reason; it is
 * idempotent.
 */
resolveAliases();

/**
 * stderr event logger. Emits `{"level":..,"event":..,...detail}`. stdout is the
 * MCP transport, so nothing may be written there.
 */
const eventLog = createEventLogger();


const limits: QueryLimits = {
  defaultLimit: numberFromEnv("POSTGRES_DEFAULT_LIMIT", 500),
  maxLimit: numberFromEnv("POSTGRES_MAX_LIMIT", 2000),
  defaultTimeoutMs: numberFromEnv("POSTGRES_DEFAULT_TIMEOUT_MS", 30_000),
  maxTimeoutMs: numberFromEnv("POSTGRES_MAX_TIMEOUT_MS", 60_000),
  explainCostWarn: numberFromEnv("POSTGRES_EXPLAIN_COST_WARN", 1_000_000)
};

const connections = new ConnectionManager({
  poolMax: 10,
  idleTimeoutMs: 30_000,
  statementTimeoutMs: limits.defaultTimeoutMs,
  applicationName: "communicationhub-postgres-mcp"
});

// One shared HMAC secret for both write + migration approvals. Auto-generated per
// process when POSTGRES_WRITE_APPROVAL_SECRET is unset — the token is signed and verified
// entirely in-process against an in-memory preview store, so no client config is
// needed to enable writes (POSTGRES_WRITE_ENABLED=true is the on switch).
const APPROVAL_SECRET = resolveApprovalSecret(approvalSecretFromEnv());

const writeConfig: WriteConfig = {
  enabled: parseBoolEnv("POSTGRES_WRITE_ENABLED"),
  approvalSecret: APPROVAL_SECRET,
  previewTtlMs: numberFromEnv("POSTGRES_WRITE_PREVIEW_TTL_MS", 900_000),
  sampleLimit: numberFromEnv("POSTGRES_WRITE_SAMPLE_LIMIT", 20)
};
const writeStore = new WritePreviewStore();

const migrationConfig: MigrationConfig = {
  enabled: parseBoolEnv("POSTGRES_MIGRATION_ENABLED"),
  ...dotnetProjectsFromEnv(),
  timeoutMs: numberFromEnv("POSTGRES_DOTNET_TIMEOUT_MS", 120_000),
  approvalSecret: APPROVAL_SECRET,
  // Longer default (1h) than write previews: migration_apply against a prod-like env is
  // human-gated, so the preview→approve pause can outlast the 15-min write TTL. This bounds
  // how long the in-memory preview record survives; freshness is enforced by the drift guard
  // at apply time, not this window (see handleMigrationApply / PG-PRV-002).
  previewTtlMs: numberFromEnv("POSTGRES_MIGRATION_PREVIEW_TTL_MS", 3_600_000)
};

const handle = createMcpServer({
  name: "communicationhub-postgres-mcp",
  version: "0.2.0",
  tools: buildTools({ connections, writeStore, writeConfig, migrationConfig, limits, logger: eventLog }),
  resources: buildSchemaResources(connections),
  /**
   * This server's error contract, not the platform's. Every failure — zod
   * validation, a PolicyViolationError from a guardrail, a pg driver error — is
   * rendered in the `{ code, message, detail? }` envelope at the `verbose`
   * profile, exactly as the hand-written dispatcher did. Without this the
   * migration would silently rewrite every error response, which `tools/list`
   * cannot reveal.
   */
  formatError: (error) => asErrorPayload(toWireError(error), "verbose")
});

runServer(handle, {
  onStarted: () =>
    eventLog.info("server_started", {
      name: "communicationhub-postgres-mcp",
      version: "0.2.0",
      defaultEnvironment: connections.defaultEnvironment,
      environments: connections.list().map((e) => `${e.name}:${e.capabilities.join("|")}`)
    }),
  onCrash: (error) =>
    eventLog.error("server_crashed", { error: error instanceof Error ? error.message : String(error) })
});
