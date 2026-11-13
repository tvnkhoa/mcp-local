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
      "Insert, update or delete Postgres rows, step 1: dry-runs one INSERT/UPDATE/DELETE in a rolled-back transaction and returns a previewId + approvalToken for write_apply. Requires POSTGRES_WRITE_ENABLED; prod is always read-only. UPDATE/DELETE must have WHERE unless allowFullTable. Check rollbackSupported/rollbackNote: not every statement can be rolled back.",
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
      "Commit a Postgres write previewed by write_preview, using its previewId + approvalToken. Returns a rollbackId for write_rollback, or null when the preview reported the statement cannot be rolled back.",
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
    description:
      "Undo a Postgres write committed by write_apply, using its rollbackId. Restores each captured row independently; a row changed since the apply is reported, not overwritten. A partial rollback is retryable.",
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
