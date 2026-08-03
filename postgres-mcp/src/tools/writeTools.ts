/**
 * The three data-write tools: preview → apply → rollback.
 *
 * All three are `rawResult` — `write/writeHandlers.ts` already builds their
 * envelopes, including the `WRITE_DISABLED` refusal clients match on.
 */

import { ok } from "@mcp/core";
import type { AnyToolDefinition } from "@mcp/sdk";
import { defineTool, schema } from "@mcp/sdk";
import { z } from "zod";

import { handleWritePreview, handleWriteApply, handleWriteRollback } from "./handlers/writeHandlers.js";
import {
  appliesChange,
  envProp,
  environmentArg,
  previewsChange,
  profileArg,
  profileProp,
  raw,
  scalarParam,
  scalarParamProp,
  type PostgresDeps
} from "./common.js";

export function buildWriteTools(deps: PostgresDeps): AnyToolDefinition[] {
  const { connections, writeStore, writeConfig } = deps;

  // The POSTGRES_WRITE_ENABLED check stays inside the handlers rather than becoming a
  // featureFlagGuard: a guard runs before the handler, and the handlers refuse
  // with their own WRITE_DISABLED envelope which clients already match on.
  const writePreview = defineTool({
    name: "write_preview",
    description:
      "Preview an INSERT/UPDATE/DELETE (dry-run, rolled back) and get an approval token. Requires POSTGRES_WRITE_ENABLED. UPDATE/DELETE must have WHERE unless allowFullTable.",
    input: z
      .object({
        sql: z.string().min(1),
        params: scalarParam,
        allowFullTable: z.boolean().optional(),
        environment: environmentArg,
        profile: profileArg
      })
      .strict(),
    inputSchema: schema.object(
      {
        sql: schema.string(),
        params: scalarParamProp,
        allowFullTable: schema.boolean("Permit UPDATE/DELETE without WHERE (whole table)."),
        environment: envProp,
        profile: profileProp
      },
      { required: ["sql"] }
    ),
    annotations: previewsChange,
    rawResult: true,
    handler: async (input) => ok(raw(await handleWritePreview(input, connections, writeStore, writeConfig)))
  });

  const writeApply = defineTool({
    name: "write_apply",
    description:
      "Apply a previously previewed write using its previewId + approvalToken. Commits the change and returns a rollbackId.",
    input: z
      .object({
        previewId: z.string().min(1).max(128),
        approvalToken: z.string().min(1),
        environment: environmentArg,
        profile: profileArg
      })
      .strict(),
    inputSchema: schema.object(
      {
        previewId: schema.string(),
        approvalToken: schema.string(),
        environment: envProp,
        profile: profileProp
      },
      { required: ["previewId", "approvalToken"] }
    ),
    annotations: appliesChange,
    rawResult: true,
    handler: async (input) => ok(raw(await handleWriteApply(input, connections, writeStore, writeConfig)))
  });

  const writeRollback = defineTool({
    name: "write_rollback",
    description: "Roll back a previously applied write using its rollbackId (restores captured rows).",
    input: z
      .object({
        rollbackId: z.string().min(1).max(128),
        profile: profileArg
      })
      .strict(),
    inputSchema: schema.object(
      { rollbackId: schema.string(), profile: profileProp },
      { required: ["rollbackId"] }
    ),
    annotations: appliesChange,
    rawResult: true,
    handler: async (input) => ok(raw(await handleWriteRollback(input, connections, writeStore, writeConfig)))
  });

  return [writePreview, writeApply, writeRollback];
}
