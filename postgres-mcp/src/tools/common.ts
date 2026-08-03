/**
 * Shared vocabulary for postgres-mcp's tool declarations.
 *
 * The tool table is split along the same boundary the handler modules already
 * use — read / write / migration — and everything those three files have in
 * common lives here: the dependency bundle they are built from, the annotation
 * presets, and the zod + JSON Schema fragments that must stay identical across
 * tools because `tools/list` is a committed contract.
 */

import type { EventLogger } from "@mcp/core";
import type { JsonSchemaNode, ToolAnnotations, ToolCallResult } from "@mcp/sdk";
import { schema } from "@mcp/sdk";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import type { ConnectionManager } from "../repositories/connectionManager.js";
import type { MigrationConfig } from "../services/migration/efRunner.js";
import { responseProfileSchema } from "../middleware/responseFormatter.js";
import type { WritePreviewStore } from "../services/write/previewStore.js";
import type { WriteConfig } from "./handlers/writeHandlers.js";

/** Bounds read from the environment once, at startup. */
export interface QueryLimits {
  readonly defaultLimit: number;
  readonly maxLimit: number;
  readonly defaultTimeoutMs: number;
  readonly maxTimeoutMs: number;
  readonly explainCostWarn: number;
}

export interface PostgresDeps {
  readonly connections: ConnectionManager;
  readonly writeStore: WritePreviewStore;
  readonly writeConfig: WriteConfig;
  readonly migrationConfig: MigrationConfig;
  readonly limits: QueryLimits;
  /**
   * The stderr event logger, passed in rather than taken from `ToolContext`:
   * `query_succeeded` / `query_failed` are existing operational log lines and
   * must keep their exact flat shape.
   */
  readonly logger: EventLogger;
}

/**
 * Bridge a handler's `CallToolResult` to the platform's `ToolCallResult`.
 *
 * `CallToolResult.content` is a union array (text | image | resource); the
 * platform type narrows it to text. Every value produced here is text, so this
 * is variance, not a shape change — the same cast `middleware/responseFormatter.ts`
 * already makes in the other direction.
 */
export function raw(result: CallToolResult): ToolCallResult {
  return result as unknown as ToolCallResult;
}

// --- annotation presets ------------------------------------------------------
// A Postgres server is reachable over the network, so every DB-touching tool is
// openWorld even when it only reads.

export const readsDb: ToolAnnotations = {
  readOnly: true,
  idempotent: true,
  destructive: false,
  openWorld: true
};
export const readsConfig: ToolAnnotations = {
  readOnly: true,
  idempotent: true,
  destructive: false,
  openWorld: false
};
/** Computes a plan and rolls back; the only state it leaves is an in-memory preview. */
export const previewsChange: ToolAnnotations = {
  readOnly: true,
  idempotent: false,
  destructive: false,
  openWorld: true
};
export const appliesChange: ToolAnnotations = {
  readOnly: false,
  idempotent: false,
  destructive: true,
  openWorld: true
};
/** Writes new migration files to disk; removes nothing, touches no database. */
export const createsFiles: ToolAnnotations = {
  readOnly: false,
  idempotent: false,
  destructive: false,
  openWorld: false
};

// --- shared zod fragments ----------------------------------------------------

export const environmentArg = z.string().min(1).max(64).optional();
export const profileArg = responseProfileSchema.optional();
export const scalarParam = z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])).optional();

// --- shared JSON Schema fragments --------------------------------------------
// Deliberately NOT `schema.profile()`: that helper adds a description this
// server has never advertised, and `tools/list` is a committed contract.

export const profileProp: JsonSchemaNode = schema.enumOf(["nano", "compact", "standard", "verbose"]);
export const envProp: JsonSchemaNode = schema.string();
export const schemaProp: JsonSchemaNode = schema.string(undefined, { default: "public" });
export const tableProp: JsonSchemaNode = schema.string();
export const scalarParamProp: JsonSchemaNode = schema.array(
  schema.anyOf([schema.string(), schema.number(), schema.boolean(), schema.null()])
);
