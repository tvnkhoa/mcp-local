/**
 * The EF Core migration tools, plus `compare_environments` — which lives here
 * rather than with the read tools because its handler ships in
 * `migration/migrationHandlers.ts` and shares the schema-snapshot machinery.
 *
 * All are `rawResult`: the handlers already build their envelopes, including the
 * `MIGRATION_DISABLED` and `MIGRATION_PROJECT_UNCONFIGURED` refusals.
 */

import { ok } from "@mcp/core";
import type { AnyToolDefinition } from "@mcp/sdk";
import { defineTool, schema } from "@mcp/sdk";
import { z } from "zod";

import {
  handleMigrationStatus,
  handleMigrationAdd,
  handleMigrationPreview,
  handleMigrationApply,
  handleMigrationDryRun,
  handleCompareEnvironments
} from "./handlers/migrationHandlers.js";
import {
  appliesChange,
  createsFiles,
  envProp,
  environmentArg,
  previewsChange,
  profileArg,
  profileProp,
  raw,
  readsDb,
  type PostgresDeps
} from "./common.js";

export function buildMigrationTools(deps: PostgresDeps): AnyToolDefinition[] {
  const { connections, migrationConfig } = deps;

  const migrationStatus = defineTool({
    name: "migration_status",
    description:
      "Show applied vs pending EF Core migrations for an environment. Requires POSTGRES_MIGRATION_ENABLED.",
    input: z.object({ environment: environmentArg, profile: profileArg }).strict(),
    inputSchema: schema.object({ environment: envProp, profile: profileProp }),
    annotations: readsDb,
    rawResult: true,
    handler: async (input) => ok(raw(await handleMigrationStatus(input, connections, migrationConfig)))
  });

  const migrationAdd = defineTool({
    name: "migration_add",
    description:
      "Generate a new EF Core migration (dotnet ef migrations add). Does NOT touch the database; returns generated file paths to edit.",
    input: z
      .object({
        name: z.string().min(1).max(128),
        environment: environmentArg,
        profile: profileArg
      })
      .strict(),
    inputSchema: schema.object(
      {
        name: schema.string("Migration name (letters/digits/underscore only)."),
        environment: envProp,
        profile: profileProp
      },
      { required: ["name"] }
    ),
    annotations: createsFiles,
    rawResult: true,
    handler: async (input) => ok(raw(await handleMigrationAdd(input, connections, migrationConfig)))
  });

  const migrationPreview = defineTool({
    name: "migration_preview",
    description:
      "Snapshot current schema + return the pending migration SQL delta and an approval token. Full idempotent script available at profile:verbose.",
    input: z.object({ environment: environmentArg, profile: profileArg }).strict(),
    inputSchema: schema.object({ environment: envProp, profile: profileProp }),
    annotations: previewsChange,
    rawResult: true,
    handler: async (input) => ok(raw(await handleMigrationPreview(input, connections, migrationConfig)))
  });

  const migrationApply = defineTool({
    name: "migration_apply",
    description:
      "Apply pending migrations (dotnet ef database update) after a migration_preview. Drift-guarded + verifies post-schema.",
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
    handler: async (input) => ok(raw(await handleMigrationApply(input, connections, migrationConfig)))
  });

  const migrationDryRun = defineTool({
    name: "migration_dry_run",
    description:
      "Run the idempotent migration script inside a rolled-back transaction to catch SQL errors before applying.",
    input: z.object({ environment: environmentArg, profile: profileArg }).strict(),
    inputSchema: schema.object({ environment: envProp, profile: profileProp }),
    annotations: previewsChange,
    rawResult: true,
    handler: async (input) => ok(raw(await handleMigrationDryRun(input, connections, migrationConfig)))
  });

  const compareEnvironments = defineTool({
    name: "compare_environments",
    description:
      "Diff schema (and optionally row counts) between two environments — schema-drift / deploy check.",
    input: z
      .object({
        source: z.string().min(1).max(64),
        target: z.string().min(1).max(64),
        includeRowCounts: z.boolean().optional(),
        profile: profileArg
      })
      .strict(),
    inputSchema: schema.object(
      {
        source: schema.string(),
        target: schema.string(),
        includeRowCounts: schema.boolean(),
        profile: profileProp
      },
      { required: ["source", "target"] }
    ),
    annotations: readsDb,
    rawResult: true,
    handler: async (input) => ok(raw(await handleCompareEnvironments(input, connections)))
  });

  return [
    migrationStatus,
    migrationAdd,
    migrationPreview,
    migrationApply,
    migrationDryRun,
    compareEnvironments
  ];
}
