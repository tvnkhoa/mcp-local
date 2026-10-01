/**
 * The raw-SQL DDL migration tools. OFF unless `POSTGRES_DDL_ENABLED=true`; every handler
 * refuses with `DDL_DISABLED` otherwise, the same runtime-refusal shape as the write and
 * migration lanes (clients match on that envelope).
 *
 * The flow: `ddl_status` → `ddl_create` → `ddl_preview` → `ddl_dry_run` → `ddl_apply`. Rollback is
 * `ddl_preview { direction: "down", target }` through the same preview, token and drift guard,
 * not a separate tool: a revert is DDL too, and a second path would either duplicate those
 * checks or skip them.
 */

import { ok } from "@mcp/core";
import type { AnyToolDefinition } from "@mcp/sdk";
import { defineTool, schema } from "@mcp/sdk";
import { z } from "zod";

import { MAX_DDL_SCRIPT_BYTES } from "../middleware/ddlGuardrails.js";
import { MIGRATION_NAME, MIGRATION_VERSION } from "../services/ddl/ddlFiles.js";
import { handleDdlApply, handleDdlCreate, handleDdlDryRun, handleDdlPreview, handleDdlStatus } from "./handlers/ddlHandlers.js";
import { appliesChange, createsFiles, envProp, environmentArg, previewsChange, profileArg, profileProp, raw, readsDb, type PostgresDeps } from "./common.js";

export function buildDdlTools(deps: PostgresDeps): AnyToolDefinition[] {
  const { connections, ddlConfig, ddlStore } = deps;

  const ddlStatus = defineTool({
    name: "ddl_status",
    description:
      "Show raw-SQL DDL migrations for an environment: applied, pending, edited-since-applied (checksum mismatch), missing from disk, and out-of-order, read from the configured ledger (mcp_ops.ddl_history, or the repo's own table with POSTGRES_DDL_EXTERNAL_LEDGER). Read-only; works on prod. Requires POSTGRES_DDL_ENABLED.",
    input: z.object({ environment: environmentArg, profile: profileArg }).strict(),
    inputSchema: schema.object({ environment: envProp, profile: profileProp }),
    annotations: readsDb,
    rawResult: true,
    handler: async (input) => ok(raw(await handleDdlStatus(input, connections, ddlConfig)))
  });

  const ddlCreate = defineTool({
    name: "ddl_create",
    description:
      "Write a new DDL migration file pair (V<timestamp>__<name>.up.sql / .down.sql) to POSTGRES_DDL_MIGRATIONS_DIR after validating it. Does NOT touch any database; never overwrites a file. Risks are reported for review, then enforced by ddl_preview. Not available with POSTGRES_DDL_EXTERNAL_LEDGER, whose files are the repo's own.",
    input: z
      .object({
        name: z.string().regex(MIGRATION_NAME),
        up: z.string().min(1).max(MAX_DDL_SCRIPT_BYTES),
        down: z.string().min(1).max(MAX_DDL_SCRIPT_BYTES).optional(),
        noTransaction: z.boolean().optional(),
        version: z.string().regex(MIGRATION_VERSION).optional(),
        profile: profileArg
      })
      .strict(),
    inputSchema: schema.object(
      {
        name: schema.string("Migration name: lowercase letters, digits and underscore (^[a-z0-9_]{1,100}$)."),
        up: schema.string("The migration's SQL. CREATE/ALTER/DROP/COMMENT ON, GRANT/REVOKE on a named object, and ALTER … OWNER TO an allowlisted role; no DML, DO, role membership or transaction control."),
        down: schema.string("SQL that reverts `up`. Optional, but without it the migration cannot be rolled back."),
        noTransaction: schema.boolean("Write the -- mcp:no-transaction directive. Required for CREATE/DROP INDEX CONCURRENTLY; the migration must then be one statement."),
        version: schema.string("14-digit UTC timestamp (yyyymmddhhmmss). Omit to use the next one."),
        profile: profileProp
      },
      { required: ["name", "up"] }
    ),
    annotations: createsFiles,
    rawResult: true,
    handler: async (input) => ok(raw(await handleDdlCreate(input, ddlConfig)))
  });

  const ddlPreview = defineTool({
    name: "ddl_preview",
    description:
      "Plan DDL migrations against an environment and return an approval token. File mode applies pending files (direction \"up\", optional target) or reverts applied ones newest-first via their .down.sql (direction \"down\", target required; \"0\" = all). Inline mode takes sql instead. Reports per-migration risks and which ones ddl_apply must acknowledge. Executes nothing; refused on read-only environments (prod).",
    input: z
      .object({
        environment: environmentArg,
        direction: z.enum(["up", "down"]).optional(),
        target: z.string().regex(/^(\d{14}|\d{4,13}|0)$/).optional(),
        allowOutOfOrder: z.boolean().optional(),
        sql: z.string().min(1).max(MAX_DDL_SCRIPT_BYTES).optional(),
        label: z.string().regex(MIGRATION_NAME).optional(),
        noTransaction: z.boolean().optional(),
        profile: profileArg
      })
      .strict(),
    inputSchema: schema.object({
      environment: envProp,
      direction: schema.enumOf(["up", "down"], "File mode: \"up\" (default) applies pending migrations; \"down\" reverts applied ones."),
      target: schema.string("File mode: 14-digit version (the NNNN prefix with an external ledger). Up: apply through it. Down: revert everything newer than it (\"0\" = everything)."),
      allowOutOfOrder: schema.boolean("File mode: allow pending migrations older than the newest applied one."),
      sql: schema.string("Inline mode: the DDL to run, instead of files. Same rules as a migration file."),
      label: schema.string("Inline mode: a name for the ledger (^[a-z0-9_]{1,100}$)."),
      noTransaction: schema.boolean("Inline mode: run without a transaction (needed for CONCURRENTLY; one statement only)."),
      profile: profileProp
    }),
    annotations: previewsChange,
    rawResult: true,
    handler: async (input) => ok(raw(await handleDdlPreview(input, connections, ddlConfig, ddlStore)))
  });

  const ddlDryRun = defineTool({
    name: "ddl_dry_run",
    description:
      "Run a ddl_preview's plan inside one transaction and roll it back, to catch failures before ddl_apply. Takes real locks while it runs (bounded by lock_timeout). Non-transactional migrations (CONCURRENTLY) are skipped and reported as skipped.",
    input: z.object({ previewId: z.string().min(1).max(128), profile: profileArg }).strict(),
    inputSchema: schema.object({ previewId: schema.string(), profile: profileProp }, { required: ["previewId"] }),
    annotations: previewsChange,
    rawResult: true,
    handler: async (input) => ok(raw(await handleDdlDryRun(input, connections, ddlConfig, ddlStore)))
  });

  const ddlApply = defineTool({
    name: "ddl_apply",
    description:
      "Apply a ddl_preview's plan. Re-plans under a database advisory lock and refuses (DDL_DRIFT) if the schema, the ledger or the files changed since the preview. One transaction per migration, stopping at the first failure. High risks from the preview must be listed in acknowledgeRisks — only after a human has agreed to them.",
    input: z
      .object({
        previewId: z.string().min(1).max(128),
        approvalToken: z.string().min(1).max(4096),
        acknowledgeRisks: z.array(z.string().min(1).max(64)).max(50).optional(),
        profile: profileArg
      })
      .strict(),
    inputSchema: schema.object(
      {
        previewId: schema.string(),
        approvalToken: schema.string(),
        acknowledgeRisks: schema.array(schema.string(), "Risk codes from the preview's requiredAcknowledgements, confirmed by a human."),
        profile: profileProp
      },
      { required: ["previewId", "approvalToken"] }
    ),
    annotations: appliesChange,
    rawResult: true,
    handler: async (input) => ok(raw(await handleDdlApply(input, connections, ddlConfig, ddlStore)))
  });

  return [ddlStatus, ddlCreate, ddlPreview, ddlDryRun, ddlApply];
}
