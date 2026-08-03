/**
 * The eight read tools: connectivity, environment/schema introspection, and the
 * guarded read-query path.
 *
 * `health_check`, `list_environments`, `list_tables` and `describe_table` return
 * plain payloads and let dispatch serialize them. The rest are `rawResult`
 * because their handlers already build an envelope — see
 * {@link ToolDefinition.rawResult}.
 */

import { randomUUID, createHash } from "node:crypto";

import type { ResponseProfile } from "@mcp/core";
import { ok } from "@mcp/core";
import type { AnyToolDefinition } from "@mcp/sdk";
import { defineTool, schema } from "@mcp/sdk";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { type FieldDef } from "pg";
import { z } from "zod";

import { handleGetTableRelationships, handleProfileTable, handleDataDiff } from "../repositories/introspection.js";
import { validateReadOnlySql } from "../middleware/sqlGuardrails.js";
import { asText as asTextProfiled, asError as asErrorProfiled } from "../middleware/responseFormatter.js";
import { safeRollback } from "./handlers/writeHandlers.js";
import {
  envProp,
  environmentArg,
  profileArg,
  profileProp,
  raw,
  readsConfig,
  readsDb,
  scalarParam,
  scalarParamProp,
  schemaProp,
  tableProp,
  type PostgresDeps
} from "./common.js";

export function buildReadTools(deps: PostgresDeps): AnyToolDefinition[] {
  const { connections, limits, logger } = deps;

  const healthCheck = defineTool({
    name: "health_check",
    description: "Check MCP server and PostgreSQL connectivity for an environment.",
    input: z.object({ environment: environmentArg, profile: profileArg }).strict(),
    inputSchema: schema.object({
      environment: schema.string("Target environment (default: configured default)."),
      profile: profileProp
    }),
    annotations: readsDb,
    handler: async (input) => {
      const env = connections.getEnvironment(input.environment);
      const pool = connections.getPool(input.environment);
      const now = new Date().toISOString();
      const db = await pool.query<{ now: string }>("select now()::text as now");
      return ok({
        status: "ok",
        environment: env.name,
        serverTimeUtc: now,
        databaseTime: db.rows[0]?.now ?? null
      });
    }
  });

  const listEnvironments = defineTool({
    name: "list_environments",
    description:
      "List configured database environments, their write capability, and masked connection info.",
    input: z.object({ profile: profileArg }).strict(),
    inputSchema: schema.object({ profile: profileProp }),
    annotations: readsConfig,
    handler: () =>
      ok({
        defaultEnvironment: connections.defaultEnvironment,
        environments: connections.list()
      })
  });

  const listTables = defineTool({
    name: "list_tables",
    description: "List tables in a schema (default: public).",
    input: z
      .object({
        schema: z.string().min(1).max(128).optional(),
        environment: environmentArg,
        profile: profileArg
      })
      .strict(),
    inputSchema: schema.object({ schema: schema.string(), environment: envProp, profile: profileProp }),
    annotations: readsDb,
    handler: async (input) => {
      // The default lived at the call site in the old dispatcher, not in the zod
      // schema; keeping it here preserves what `tools/list` advertises.
      const schemaName = input.schema ?? "public";
      const pool = connections.getPool(input.environment);
      const result = await pool.query<{ table_name: string }>(
        `
    select table_name
    from information_schema.tables
    where table_schema = $1
      and table_type = 'BASE TABLE'
    order by table_name asc
    `,
        [schemaName]
      );

      return ok({
        environment: connections.resolveEnvName(input.environment),
        schema: schemaName,
        tableCount: result.rowCount,
        tables: result.rows.map((r) => r.table_name)
      });
    }
  });

  const describeTable = defineTool({
    name: "describe_table",
    description: "Describe columns for a table.",
    input: z
      .object({
        schema: z.string().min(1).max(128).default("public"),
        table: z.string().min(1).max(128),
        environment: environmentArg,
        profile: profileArg
      })
      .strict(),
    inputSchema: schema.object(
      { schema: schemaProp, table: tableProp, environment: envProp, profile: profileProp },
      { required: ["table"] }
    ),
    annotations: readsDb,
    handler: async (input) => {
      const pool = connections.getPool(input.environment);
      const result = await pool.query<{
        column_name: string;
        data_type: string;
        is_nullable: string;
        character_maximum_length: number | null;
        column_default: string | null;
      }>(
        `
    select
      column_name,
      data_type,
      is_nullable,
      character_maximum_length,
      column_default
    from information_schema.columns
    where table_schema = $1
      and table_name = $2
    order by ordinal_position asc
    `,
        [input.schema, input.table]
      );

      return ok({
        environment: connections.resolveEnvName(input.environment),
        schema: input.schema,
        table: input.table,
        columnCount: result.rowCount,
        columns: result.rows
      });
    }
  });

  const runReadQuerySchema = z
    .object({
      sql: z.string().min(1),
      params: scalarParam,
      limit: z.number().int().min(1).max(limits.maxLimit).optional(),
      timeoutMs: z.number().int().min(1).max(limits.maxTimeoutMs).optional(),
      requestId: z.string().min(1).max(128).optional(),
      environment: environmentArg,
      profile: profileArg,
      explain: z.boolean().optional()
    })
    .strict();

  async function runReadQueryImpl(args: z.infer<typeof runReadQuerySchema>): Promise<CallToolResult> {
    const requestId = args.requestId ?? randomUUID();
    const startedAt = Date.now();
    const profile: ResponseProfile = args.profile ?? "compact";
    const envName = connections.resolveEnvName(args.environment);

    const validated = validateReadOnlySql(args.sql);
    if (!validated.ok) {
      return asErrorProfiled(
        {
          requestId,
          environment: envName,
          code: validated.error.code,
          message: validated.error.message
        },
        profile
      );
    }

    const effectiveLimit = Math.min(args.limit ?? limits.defaultLimit, limits.maxLimit);
    const effectiveTimeoutMs = Math.min(args.timeoutMs ?? limits.defaultTimeoutMs, limits.maxTimeoutMs);

    const pool = connections.getPool(args.environment);

    // Cost-guard / dry-run: EXPLAIN only, never executes the query.
    if (args.explain) {
      const explained = await pool.query<{ "QUERY PLAN": Array<{ Plan: { ["Total Cost"]: number } }> }>(
        `explain (format json) ${validated.sanitizedSql}`,
        args.params ?? []
      );
      const plan = explained.rows[0]?.["QUERY PLAN"]?.[0];
      const totalCost = plan?.Plan?.["Total Cost"] ?? null;
      return asTextProfiled(
        {
          requestId,
          environment: envName,
          explain: true,
          estimatedTotalCost: totalCost,
          costWarning:
            totalCost !== null && totalCost > limits.explainCostWarn
              ? `Estimated cost ${totalCost} exceeds warning threshold ${limits.explainCostWarn}.`
              : null,
          plan
        },
        profile
      );
    }

    const guardedSql = `select * from (${validated.sanitizedSql}) as mcp_read_query limit ${effectiveLimit}`;

    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query("set local transaction read only");
      await client.query(`set local statement_timeout = ${effectiveTimeoutMs}`);

      const result = await client.query(guardedSql, args.params ?? []);
      await client.query("rollback");

      const elapsedMs = Date.now() - startedAt;
      logger.info("query_succeeded", {
        requestId,
        environment: envName,
        queryHash: stableHash(validated.sanitizedSql),
        rowCount: result.rowCount,
        elapsedMs
      });

      return asTextProfiled(
        {
          requestId,
          environment: envName,
          rowCount: result.rowCount,
          truncated: result.rowCount === effectiveLimit,
          elapsedMs,
          columns: result.fields.map((f: FieldDef) => f.name),
          rows: result.rows
        },
        profile
      );
    } catch (error) {
      await safeRollback(client);
      logger.error("query_failed", {
        requestId,
        environment: envName,
        queryHash: stableHash(validated.sanitizedSql),
        error: normalizeUnknown(error)
      });
      throw error;
    } finally {
      client.release();
    }
  }

  const runReadQuery = defineTool({
    name: "run_read_query",
    description: "Run a read-only SQL query with guardrails.",
    input: runReadQuerySchema,
    inputSchema: schema.object(
      {
        sql: schema.string(),
        params: scalarParamProp,
        limit: schema.integer(undefined, { minimum: 1, maximum: limits.maxLimit }),
        timeoutMs: schema.integer(undefined, { minimum: 1, maximum: limits.maxTimeoutMs }),
        requestId: schema.string(),
        environment: envProp,
        profile: profileProp,
        explain: schema.boolean("Return the EXPLAIN plan + estimated cost instead of executing.")
      },
      { required: ["sql"] }
    ),
    annotations: readsDb,
    // Its guardrail rejection carries requestId + environment alongside the code,
    // which the platform error envelope has no room for.
    rawResult: true,
    handler: async (input) => ok(raw(await runReadQueryImpl(input)))
  });

  const getTableRelationships = defineTool({
    name: "get_table_relationships",
    description:
      "List foreign-key relationships (optionally for one table) — useful for JOINs and write/migration impact.",
    input: z
      .object({
        table: z.string().min(1).max(128).optional(),
        environment: environmentArg,
        profile: profileArg
      })
      .strict(),
    inputSchema: schema.object({ table: tableProp, environment: envProp, profile: profileProp }),
    annotations: readsDb,
    rawResult: true,
    handler: async (input) => ok(raw(await handleGetTableRelationships(input, connections)))
  });

  const profileTable = defineTool({
    name: "profile_table",
    description:
      "Quick table profile: estimated row count, per-column stats (distinct/null), and a small sample.",
    input: z
      .object({
        schema: z.string().min(1).max(128).optional(),
        table: z.string().min(1).max(128),
        sampleLimit: z.number().int().min(1).max(100).optional(),
        environment: environmentArg,
        profile: profileArg
      })
      .strict(),
    inputSchema: schema.object(
      {
        schema: schemaProp,
        table: tableProp,
        sampleLimit: schema.integer(undefined, { minimum: 1, maximum: 100 }),
        environment: envProp,
        profile: profileProp
      },
      { required: ["table"] }
    ),
    annotations: readsDb,
    rawResult: true,
    handler: async (input) => ok(raw(await handleProfileTable(input, connections)))
  });

  const dataDiff = defineTool({
    name: "data_diff",
    description:
      "Compare a table's data between two environments via row count + order-independent checksum (deploy/seed verification).",
    input: z
      .object({
        source: z.string().min(1).max(64),
        target: z.string().min(1).max(64),
        schema: z.string().min(1).max(128).optional(),
        table: z.string().min(1).max(128),
        columns: z.array(z.string().min(1).max(128)).optional(),
        profile: profileArg
      })
      .strict(),
    inputSchema: schema.object(
      {
        source: schema.string(),
        target: schema.string(),
        schema: schemaProp,
        table: tableProp,
        columns: schema.array(schema.string()),
        profile: profileProp
      },
      { required: ["source", "target", "table"] }
    ),
    annotations: readsDb,
    rawResult: true,
    handler: async (input) => ok(raw(await handleDataDiff(input, connections)))
  });

  return [
    healthCheck,
    listEnvironments,
    listTables,
    describeTable,
    runReadQuery,
    getTableRelationships,
    profileTable,
    dataDiff
  ];
}

function stableHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function normalizeUnknown(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
