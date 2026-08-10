/**
 * Shared input fragments for observe-mcp's tool table.
 *
 * Every tool here declares BOTH a zod `input` and a hand-written `inputSchema`.
 * That duplication is deliberate — `contracts/observe-mcp.json` is a committed
 * contract and a generator would be free to drift it — but it also means the two
 * can disagree, and a parity test compares their key sets in both directions. So
 * the two halves of a shared argument must be defined together, here, rather than
 * copied per tool.
 */

import type { JsonSchemaNode } from "@mcp/sdk";
import { schema } from "@mcp/sdk";
import { z } from "zod";

import { responseProfileSchema } from "../middleware/responseFormatter.js";

// --- zod fragments -----------------------------------------------------------

export const profileArg = responseProfileSchema.optional();
export const offsetArg = z.number().int().min(0).optional();
export const timeArg = z.string().min(1).max(32).optional();
export const instantArg = z.string().min(1).max(64).optional();
export const traceIdArg = z.string().min(8).max(64);
export const streamTypeArg = z.enum(["logs", "traces", "metrics"]);
export const limitArg = z.number().int().positive().optional();
export const streamArg = z.string().min(1).max(256).optional();
export const serviceArg = z.string().min(1).max(256).optional();
export const environmentArg = z.string().min(1).max(64).optional();

// --- JSON Schema fragments ---------------------------------------------------
// Deliberately NOT `schema.profile()`: that helper adds a description this server
// has never advertised, and `tools/list` is a committed contract.

export const profileProp: JsonSchemaNode = schema.enumOf(["nano", "compact", "standard", "verbose"]);
export const typeProp: JsonSchemaNode = schema.enumOf(["logs", "traces", "metrics"]);
export const limitProp: JsonSchemaNode = schema.number();
export const offsetProp: JsonSchemaNode = schema.number(
  "Row offset for pagination (default 0); use the returned nextOffset to page"
);
export const envProp: JsonSchemaNode = schema.string(
  "Which configured environment to query (default: the server's default; see list_environments)"
);
