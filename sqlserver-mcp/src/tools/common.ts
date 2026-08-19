/**
 * Shared vocabulary for the sqlserver-mcp tool table.
 *
 * The zod and JSON Schema fragments live here rather than beside each tool because `tools/list` is
 * a committed contract: two tools that mean the same thing by `database` must advertise it
 * identically, and the only way to guarantee that is to declare it once.
 */

import type { EventLogger } from "@mcp/core";
import type { JsonSchemaNode, ToolAnnotations } from "@mcp/sdk";
import { schema } from "@mcp/sdk";
import { z } from "zod";

import type { SqlserverConfig } from "../config/index.js";
import type { ConnectionManager } from "../repositories/connectionManager.js";
import { responseProfileSchema } from "../middleware/responseFormatter.js";

export interface SqlserverDeps {
  readonly config: SqlserverConfig;
  readonly connections: ConnectionManager;
  readonly logger: EventLogger;
}

// --- annotations --------------------------------------------------------------
// A SQL Server instance is reached over the network, so every tool that touches it is openWorld
// even when it only reads. `annotations.read()` from the SDK is openWorld:false and is therefore
// wrong for all but the pure-configuration tools.

export const readsDatabase: ToolAnnotations = {
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

/**
 * `execute_routine`.
 *
 * `readOnly: false` and `destructive: true` are asserted for *every* routine, including one whose
 * name suggests it only reads. That is the finding this server was designed around: in the
 * deployment audited, procedures named `Get…` and `Report_…` sit beside `Customer_UpdateLastActivity`
 * in the same schema, and nothing in the catalog distinguishes them. A client deciding what to
 * auto-approve must be told the truth about the worst case, because the name does not carry it.
 */
export const executesRoutine: ToolAnnotations = {
  readOnly: false,
  idempotent: false,
  destructive: true,
  openWorld: true
};

// --- zod fragments ------------------------------------------------------------

export const environmentArg = z.string().min(1).max(64).optional();
export const databaseArg = z.string().min(1).max(128).optional();
export const schemaArg = z.string().min(1).max(128).optional();
export const profileArg = responseProfileSchema.optional();

/** A scalar bound to a query parameter. Anything richer would have to be serialized to SQL text. */
export const scalarParamArg = z
  .array(z.union([z.string(), z.number(), z.boolean(), z.null()]))
  .max(64)
  .optional();

// --- JSON Schema fragments ----------------------------------------------------

export const profileProp: JsonSchemaNode = schema.enumOf(
  ["nano", "compact", "standard", "verbose"],
  "Response verbosity. Defaults to compact."
);

export const environmentProp: JsonSchemaNode = schema.string(
  "Configured environment name. Defaults to the configured default environment."
);

export const databaseProp: JsonSchemaNode = schema.string(
  "Catalog to run against. Defaults to the catalog named by the connection string."
);

export const schemaProp: JsonSchemaNode = schema.string("Schema name. Defaults to dbo.");

export const scalarParamProp: JsonSchemaNode = schema.array(
  schema.anyOf([schema.string(), schema.number(), schema.boolean(), schema.null()]),
  "Positional parameter values, bound as @p1, @p2, … Never interpolated into the statement."
);

/** Clamp a caller-supplied bound to the configured ceiling. */
export function clamp(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return Math.min(fallback, max);
  }
  return Math.min(Math.floor(value), max);
}

/**
 * `[schema].[name]`, for logs and allowlist matching.
 *
 * Lower-cased because SQL Server object names are matched case-insensitively under every default
 * collation, and an allowlist that is case-sensitive when the server is not would refuse calls for
 * a reason the operator cannot see.
 */
export function qualify(schemaName: string, name: string): string {
  return `${schemaName}.${name}`.toLowerCase();
}
