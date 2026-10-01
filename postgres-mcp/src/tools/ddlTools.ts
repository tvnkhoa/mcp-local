/**
 * The raw-SQL DDL migration tools. OFF unless `POSTGRES_DDL_ENABLED=true`; every handler
 * refuses with `DDL_DISABLED` otherwise, the same runtime-refusal shape as the write and
 * migration lanes (clients match on that envelope).
 *
 * Phase 1.3: `ddl_status` and `ddl_create`. Preview, dry run and apply follow in 1.4.
 */

import { ok } from "@mcp/core";
import type { AnyToolDefinition } from "@mcp/sdk";
import { defineTool, schema } from "@mcp/sdk";
import { z } from "zod";

import { MAX_DDL_SCRIPT_BYTES } from "../middleware/ddlGuardrails.js";
import { MIGRATION_NAME, MIGRATION_VERSION } from "../services/ddl/ddlFiles.js";
import { handleDdlCreate, handleDdlStatus } from "./handlers/ddlHandlers.js";
import { createsFiles, envProp, environmentArg, profileArg, profileProp, raw, readsDb, type PostgresDeps } from "./common.js";

export function buildDdlTools(deps: PostgresDeps): AnyToolDefinition[] {
  const { connections, ddlConfig } = deps;

  const ddlStatus = defineTool({
    name: "ddl_status",
    description:
      "Show raw-SQL DDL migrations for an environment: applied, pending, edited-since-applied (checksum mismatch), missing from disk, and out-of-order. Read-only; works on prod. Requires POSTGRES_DDL_ENABLED.",
    input: z.object({ environment: environmentArg, profile: profileArg }).strict(),
    inputSchema: schema.object({ environment: envProp, profile: profileProp }),
    annotations: readsDb,
    rawResult: true,
    handler: async (input) => ok(raw(await handleDdlStatus(input, connections, ddlConfig)))
  });

  const ddlCreate = defineTool({
    name: "ddl_create",
    description:
      "Write a new DDL migration file pair (V<timestamp>__<name>.up.sql / .down.sql) to POSTGRES_DDL_MIGRATIONS_DIR after validating it. Does NOT touch any database; never overwrites a file. Risks are reported for review, then enforced by ddl_preview.",
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
        up: schema.string("The migration's SQL. CREATE/ALTER/DROP/COMMENT ON only; no DML, DO, GRANT or transaction control."),
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

  return [ddlStatus, ddlCreate];
}
