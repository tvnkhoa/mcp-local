import { randomUUID, createHash } from "node:crypto";
import process from "node:process";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  McpError,
  ErrorCode,
  type CallToolResult
} from "@modelcontextprotocol/sdk/types.js";
import { type FieldDef } from "pg";
import { z } from "zod";

import { ConnectionManager } from "./db/connectionManager.js";
import { PolicyViolationError } from "./errors.js";
import { asText as asTextProfiled, asError as asErrorProfiled, responseProfileSchema } from "./response/responseFormatter.js";
import { validateReadOnlySql } from "./sqlGuardrails.js";
import { resolveApprovalSecret } from "./write/approval.js";
import { WritePreviewStore } from "./write/previewStore.js";
import {
  handleWritePreview,
  handleWriteApply,
  handleWriteRollback,
  type WriteConfig
} from "./write/writeHandlers.js";
import { type MigrationConfig } from "./migration/efRunner.js";
import {
  handleMigrationStatus,
  handleMigrationAdd,
  handleMigrationPreview,
  handleMigrationApply,
  handleMigrationDryRun,
  handleCompareEnvironments
} from "./migration/migrationHandlers.js";
import {
  handleGetTableRelationships,
  handleProfileTable,
  handleDataDiff
} from "./db/introspection.js";
import { captureSchema } from "./migration/schemaSnapshot.js";

const DEFAULT_LIMIT = numberFromEnv("MCP_DB_DEFAULT_LIMIT", 500);
const MAX_LIMIT = numberFromEnv("MCP_DB_MAX_LIMIT", 2000);
const DEFAULT_TIMEOUT_MS = numberFromEnv("MCP_DB_DEFAULT_TIMEOUT_MS", 30_000);
const MAX_TIMEOUT_MS = numberFromEnv("MCP_DB_MAX_TIMEOUT_MS", 60_000);

const connections = new ConnectionManager({
  poolMax: 10,
  idleTimeoutMs: 30_000,
  statementTimeoutMs: DEFAULT_TIMEOUT_MS,
  applicationName: "communicationhub-postgres-mcp"
});

const WRITE_ENABLED = parseBoolEnv("PG_WRITE_ENABLED");
const MIGRATION_ENABLED = parseBoolEnv("PG_MIGRATION_ENABLED");
// One shared HMAC secret for both write + migration approvals. Auto-generated per
// process when PG_WRITE_APPROVAL_SECRET is unset — the token is signed and verified
// entirely in-process against an in-memory preview store, so no client config is
// needed to enable writes (PG_WRITE_ENABLED=true is the on switch).
const APPROVAL_SECRET = resolveApprovalSecret(process.env.PG_WRITE_APPROVAL_SECRET ?? "");
const writeConfig: WriteConfig = {
  enabled: WRITE_ENABLED,
  approvalSecret: APPROVAL_SECRET,
  previewTtlMs: numberFromEnv("PG_WRITE_PREVIEW_TTL_MS", 900_000),
  sampleLimit: numberFromEnv("PG_WRITE_SAMPLE_LIMIT", 20)
};
const writeStore = new WritePreviewStore();

const migrationConfig: MigrationConfig = {
  enabled: MIGRATION_ENABLED,
  project: (process.env.CH_DOTNET_PROJECT ?? "").trim(),
  startupProject: (process.env.CH_DOTNET_STARTUP_PROJECT ?? "").trim(),
  timeoutMs: numberFromEnv("PG_DOTNET_TIMEOUT_MS", 120_000),
  approvalSecret: APPROVAL_SECRET,
  previewTtlMs: numberFromEnv("PG_WRITE_PREVIEW_TTL_MS", 900_000)
};

const environmentArg = z.string().min(1).max(64).optional();
const profileArg = responseProfileSchema.optional();

const healthSchema = z.object({
  environment: environmentArg,
  profile: profileArg
}).strict();
const listEnvironmentsSchema = z.object({
  profile: profileArg
}).strict();
const listTablesSchema = z.object({
  schema: z.string().min(1).max(128).optional(),
  environment: environmentArg,
  profile: profileArg
}).strict();
const describeTableSchema = z.object({
  schema: z.string().min(1).max(128).default("public"),
  table: z.string().min(1).max(128),
  environment: environmentArg,
  profile: profileArg
}).strict();
const runReadQuerySchema = z.object({
  sql: z.string().min(1),
  params: z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
  limit: z.number().int().min(1).max(MAX_LIMIT).optional(),
  timeoutMs: z.number().int().min(1).max(MAX_TIMEOUT_MS).optional(),
  requestId: z.string().min(1).max(128).optional(),
  environment: environmentArg,
  profile: profileArg,
  explain: z.boolean().optional()
}).strict();

const getTableRelationshipsSchema = z.object({
  table: z.string().min(1).max(128).optional(),
  environment: environmentArg,
  profile: profileArg
}).strict();
const profileTableSchema = z.object({
  schema: z.string().min(1).max(128).optional(),
  table: z.string().min(1).max(128),
  sampleLimit: z.number().int().min(1).max(100).optional(),
  environment: environmentArg,
  profile: profileArg
}).strict();
const dataDiffSchema = z.object({
  source: z.string().min(1).max(64),
  target: z.string().min(1).max(64),
  schema: z.string().min(1).max(128).optional(),
  table: z.string().min(1).max(128),
  keyColumns: z.array(z.string().min(1).max(128)).optional(),
  columns: z.array(z.string().min(1).max(128)).optional(),
  profile: profileArg
}).strict();

const writeParam = z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])).optional();
const writePreviewSchema = z.object({
  sql: z.string().min(1),
  params: writeParam,
  allowFullTable: z.boolean().optional(),
  environment: environmentArg,
  profile: profileArg
}).strict();
const writeApplySchema = z.object({
  previewId: z.string().min(1).max(128),
  approvalToken: z.string().min(1),
  environment: environmentArg,
  profile: profileArg
}).strict();
const writeRollbackSchema = z.object({
  rollbackId: z.string().min(1).max(128),
  profile: profileArg
}).strict();

const migrationStatusSchema = z.object({
  environment: environmentArg,
  profile: profileArg
}).strict();
const migrationAddSchema = z.object({
  name: z.string().min(1).max(128),
  environment: environmentArg,
  profile: profileArg
}).strict();
const migrationPreviewSchema = z.object({
  environment: environmentArg,
  profile: profileArg
}).strict();
const migrationApplySchema = z.object({
  previewId: z.string().min(1).max(128),
  approvalToken: z.string().min(1),
  environment: environmentArg,
  profile: profileArg
}).strict();
const migrationDryRunSchema = z.object({
  environment: environmentArg,
  profile: profileArg
}).strict();
const compareEnvironmentsSchema = z.object({
  source: z.string().min(1).max(64),
  target: z.string().min(1).max(64),
  includeRowCounts: z.boolean().optional(),
  profile: profileArg
}).strict();

const EXPLAIN_COST_WARN = numberFromEnv("PG_EXPLAIN_COST_WARN", 1_000_000);

const server = new Server(
  {
    name: "communicationhub-postgres-mcp",
    version: "0.2.0"
  },
  {
    capabilities: {
      tools: {},
      resources: {}
    }
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "health_check",
        description: "Check MCP server and PostgreSQL connectivity for an environment.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            environment: { type: "string", description: "Target environment (default: configured default)." },
            profile: { type: "string", enum: ["nano", "compact", "standard", "verbose"] }
          }
        }
      },
      {
        name: "list_environments",
        description: "List configured database environments, their write capability, and masked connection info.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            profile: { type: "string", enum: ["nano", "compact", "standard", "verbose"] }
          }
        }
      },
      {
        name: "list_tables",
        description: "List tables in a schema (default: public).",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            schema: { type: "string" },
            environment: { type: "string" },
            profile: { type: "string", enum: ["nano", "compact", "standard", "verbose"] }
          }
        }
      },
      {
        name: "describe_table",
        description: "Describe columns for a table.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["table"],
          properties: {
            schema: { type: "string", default: "public" },
            table: { type: "string" },
            environment: { type: "string" },
            profile: { type: "string", enum: ["nano", "compact", "standard", "verbose"] }
          }
        }
      },
      {
        name: "run_read_query",
        description: "Run a read-only SQL query with guardrails.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["sql"],
          properties: {
            sql: { type: "string" },
            params: {
              type: "array",
              items: {
                anyOf: [
                  { type: "string" },
                  { type: "number" },
                  { type: "boolean" },
                  { type: "null" }
                ]
              }
            },
            limit: { type: "integer", minimum: 1, maximum: MAX_LIMIT },
            timeoutMs: { type: "integer", minimum: 1, maximum: MAX_TIMEOUT_MS },
            requestId: { type: "string" },
            environment: { type: "string" },
            profile: { type: "string", enum: ["nano", "compact", "standard", "verbose"] },
            explain: { type: "boolean", description: "Return the EXPLAIN plan + estimated cost instead of executing." }
          }
        }
      },
      {
        name: "get_table_relationships",
        description: "List foreign-key relationships (optionally for one table) — useful for JOINs and write/migration impact.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            table: { type: "string" },
            environment: { type: "string" },
            profile: { type: "string", enum: ["nano", "compact", "standard", "verbose"] }
          }
        }
      },
      {
        name: "profile_table",
        description: "Quick table profile: estimated row count, per-column stats (distinct/null), and a small sample.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["table"],
          properties: {
            schema: { type: "string", default: "public" },
            table: { type: "string" },
            sampleLimit: { type: "integer", minimum: 1, maximum: 100 },
            environment: { type: "string" },
            profile: { type: "string", enum: ["nano", "compact", "standard", "verbose"] }
          }
        }
      },
      {
        name: "data_diff",
        description: "Compare a table's data between two environments via row count + order-independent checksum (deploy/seed verification).",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["source", "target", "table"],
          properties: {
            source: { type: "string" },
            target: { type: "string" },
            schema: { type: "string", default: "public" },
            table: { type: "string" },
            keyColumns: { type: "array", items: { type: "string" } },
            columns: { type: "array", items: { type: "string" } },
            profile: { type: "string", enum: ["nano", "compact", "standard", "verbose"] }
          }
        }
      },
      {
        name: "write_preview",
        description: "Preview an INSERT/UPDATE/DELETE (dry-run, rolled back) and get an approval token. Requires PG_WRITE_ENABLED. UPDATE/DELETE must have WHERE unless allowFullTable.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["sql"],
          properties: {
            sql: { type: "string" },
            params: {
              type: "array",
              items: { anyOf: [{ type: "string" }, { type: "number" }, { type: "boolean" }, { type: "null" }] }
            },
            allowFullTable: { type: "boolean", description: "Permit UPDATE/DELETE without WHERE (whole table)." },
            environment: { type: "string" },
            profile: { type: "string", enum: ["nano", "compact", "standard", "verbose"] }
          }
        }
      },
      {
        name: "write_apply",
        description: "Apply a previously previewed write using its previewId + approvalToken. Commits the change and returns a rollbackId.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["previewId", "approvalToken"],
          properties: {
            previewId: { type: "string" },
            approvalToken: { type: "string" },
            environment: { type: "string" },
            profile: { type: "string", enum: ["nano", "compact", "standard", "verbose"] }
          }
        }
      },
      {
        name: "write_rollback",
        description: "Roll back a previously applied write using its rollbackId (restores captured rows).",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["rollbackId"],
          properties: {
            rollbackId: { type: "string" },
            profile: { type: "string", enum: ["nano", "compact", "standard", "verbose"] }
          }
        }
      },
      {
        name: "migration_status",
        description: "Show applied vs pending EF Core migrations for an environment. Requires PG_MIGRATION_ENABLED.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            environment: { type: "string" },
            profile: { type: "string", enum: ["nano", "compact", "standard", "verbose"] }
          }
        }
      },
      {
        name: "migration_add",
        description: "Generate a new EF Core migration (dotnet ef migrations add). Does NOT touch the database; returns generated file paths to edit.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["name"],
          properties: {
            name: { type: "string", description: "Migration name (letters/digits/underscore only)." },
            environment: { type: "string" },
            profile: { type: "string", enum: ["nano", "compact", "standard", "verbose"] }
          }
        }
      },
      {
        name: "migration_preview",
        description: "Snapshot current schema + produce the idempotent migration SQL that WILL run, and return an approval token.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            environment: { type: "string" },
            profile: { type: "string", enum: ["nano", "compact", "standard", "verbose"] }
          }
        }
      },
      {
        name: "migration_apply",
        description: "Apply pending migrations (dotnet ef database update) after a migration_preview. Drift-guarded + verifies post-schema.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["previewId", "approvalToken"],
          properties: {
            previewId: { type: "string" },
            approvalToken: { type: "string" },
            environment: { type: "string" },
            profile: { type: "string", enum: ["nano", "compact", "standard", "verbose"] }
          }
        }
      },
      {
        name: "migration_dry_run",
        description: "Run the idempotent migration script inside a rolled-back transaction to catch SQL errors before applying.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            environment: { type: "string" },
            profile: { type: "string", enum: ["nano", "compact", "standard", "verbose"] }
          }
        }
      },
      {
        name: "compare_environments",
        description: "Diff schema (and optionally row counts) between two environments — schema-drift / deploy check.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["source", "target"],
          properties: {
            source: { type: "string" },
            target: { type: "string" },
            includeRowCounts: { type: "boolean" },
            profile: { type: "string", enum: ["nano", "compact", "standard", "verbose"] }
          }
        }
      }
    ]
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    switch (request.params.name) {
      case "health_check": {
        const args = healthSchema.parse(request.params.arguments ?? {});
        return await healthCheck(args.environment, args.profile);
      }
      case "list_environments": {
        const args = listEnvironmentsSchema.parse(request.params.arguments ?? {});
        return listEnvironments(args.profile);
      }
      case "list_tables": {
        const args = listTablesSchema.parse(request.params.arguments ?? {});
        return await listTables(args.schema ?? "public", args.environment, args.profile);
      }
      case "describe_table": {
        const args = describeTableSchema.parse(request.params.arguments ?? {});
        return await describeTable(args.schema, args.table, args.environment, args.profile);
      }
      case "run_read_query": {
        const args = runReadQuerySchema.parse(request.params.arguments ?? {});
        return await runReadQuery(args);
      }
      case "write_preview": {
        const args = writePreviewSchema.parse(request.params.arguments ?? {});
        return await handleWritePreview(args, connections, writeStore, writeConfig);
      }
      case "write_apply": {
        const args = writeApplySchema.parse(request.params.arguments ?? {});
        return await handleWriteApply(args, connections, writeStore, writeConfig);
      }
      case "write_rollback": {
        const args = writeRollbackSchema.parse(request.params.arguments ?? {});
        return await handleWriteRollback(args, connections, writeStore, writeConfig);
      }
      case "migration_status": {
        const args = migrationStatusSchema.parse(request.params.arguments ?? {});
        return await handleMigrationStatus(args, connections, migrationConfig);
      }
      case "migration_add": {
        const args = migrationAddSchema.parse(request.params.arguments ?? {});
        return await handleMigrationAdd(args, connections, migrationConfig);
      }
      case "migration_preview": {
        const args = migrationPreviewSchema.parse(request.params.arguments ?? {});
        return await handleMigrationPreview(args, connections, migrationConfig);
      }
      case "migration_apply": {
        const args = migrationApplySchema.parse(request.params.arguments ?? {});
        return await handleMigrationApply(args, connections, migrationConfig);
      }
      case "migration_dry_run": {
        const args = migrationDryRunSchema.parse(request.params.arguments ?? {});
        return await handleMigrationDryRun(args, connections, migrationConfig);
      }
      case "compare_environments": {
        const args = compareEnvironmentsSchema.parse(request.params.arguments ?? {});
        return await handleCompareEnvironments(args, connections);
      }
      case "get_table_relationships": {
        const args = getTableRelationshipsSchema.parse(request.params.arguments ?? {});
        return await handleGetTableRelationships(args, connections);
      }
      case "profile_table": {
        const args = profileTableSchema.parse(request.params.arguments ?? {});
        return await handleProfileTable(args, connections);
      }
      case "data_diff": {
        const args = dataDiffSchema.parse(request.params.arguments ?? {});
        return await handleDataDiff(args, connections);
      }
      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${request.params.name}`);
    }
  } catch (error) {
    const mapped = mapError(error);
    return asErrorProfiled(mapped, "verbose");
  }
});

// Expose each environment's schema as a cached MCP resource (schema://<env>) so a
// client can read structure once instead of repeating describe_table calls.
server.setRequestHandler(ListResourcesRequestSchema, async () => {
  return {
    resources: connections.list().map((env) => ({
      uri: `schema://${env.name}`,
      name: `Schema (${env.name})`,
      description: `Database schema snapshot for environment '${env.name}'.`,
      mimeType: "application/json"
    }))
  };
});

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const uri = request.params.uri;
  const match = /^schema:\/\/(.+)$/.exec(uri);
  if (!match) {
    throw new McpError(ErrorCode.InvalidParams, `Unsupported resource URI: ${uri}`);
  }
  const envName = match[1];
  const pool = connections.getPool(envName);
  const snapshot = await captureSchema(pool);
  return {
    contents: [
      {
        uri,
        mimeType: "application/json",
        text: JSON.stringify(snapshot)
      }
    ]
  };
});

function listEnvironments(profile?: z.infer<typeof profileArg>): CallToolResult {
  return asTextProfiled(
    {
      defaultEnvironment: connections.defaultEnvironment,
      environments: connections.list()
    },
    profile ?? "compact"
  );
}

async function healthCheck(environment?: string, profile?: z.infer<typeof profileArg>): Promise<CallToolResult> {
  const env = connections.getEnvironment(environment);
  const pool = connections.getPool(environment);
  const now = new Date().toISOString();
  const db = await pool.query<{ now: string }>("select now()::text as now");

  return asTextProfiled(
    {
      status: "ok",
      environment: env.name,
      serverTimeUtc: now,
      databaseTime: db.rows[0]?.now ?? null
    },
    profile ?? "compact"
  );
}

async function listTables(
  schema: string,
  environment?: string,
  profile?: z.infer<typeof profileArg>
): Promise<CallToolResult> {
  const pool = connections.getPool(environment);
  const result = await pool.query<{ table_name: string }>(
    `
    select table_name
    from information_schema.tables
    where table_schema = $1
      and table_type = 'BASE TABLE'
    order by table_name asc
    `,
    [schema]
  );

  return asTextProfiled(
    {
      environment: connections.resolveEnvName(environment),
      schema,
      tableCount: result.rowCount,
      tables: result.rows.map((r) => r.table_name)
    },
    profile ?? "compact"
  );
}

async function describeTable(
  schema: string,
  table: string,
  environment?: string,
  profile?: z.infer<typeof profileArg>
): Promise<CallToolResult> {
  const pool = connections.getPool(environment);
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
    [schema, table]
  );

  return asTextProfiled(
    {
      environment: connections.resolveEnvName(environment),
      schema,
      table,
      columnCount: result.rowCount,
      columns: result.rows
    },
    profile ?? "compact"
  );
}

async function runReadQuery(args: z.infer<typeof runReadQuerySchema>): Promise<CallToolResult> {
  const requestId = args.requestId ?? randomUUID();
  const startedAt = Date.now();
  const profile = args.profile ?? "compact";
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

  const effectiveLimit = Math.min(args.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
  const effectiveTimeoutMs = Math.min(args.timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);

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
        costWarning: totalCost !== null && totalCost > EXPLAIN_COST_WARN
          ? `Estimated cost ${totalCost} exceeds warning threshold ${EXPLAIN_COST_WARN}.`
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
    logInfo("query_succeeded", {
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
    logError("query_failed", {
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

function numberFromEnv(key: string, fallbackValue: number): number {
  const raw = process.env[key];
  if (!raw) {
    return fallbackValue;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallbackValue;
  }
  return parsed;
}

function parseBoolEnv(key: string): boolean {
  const raw = process.env[key];
  return raw === "true" || raw === "1";
}

function mapError(error: unknown): {
  code: string;
  message: string;
  detail?: string;
} {
  if (error instanceof z.ZodError) {
    return {
      code: "validation_error",
      message: "Invalid tool input.",
      detail: error.issues.map((x) => `${x.path.join(".") || "root"}: ${x.message}`).join("; ")
    };
  }

  if (error instanceof PolicyViolationError) {
    return {
      code: error.code,
      message: error.message
    };
  }

  if (error instanceof McpError) {
    return {
      code: "mcp_error",
      message: error.message
    };
  }

  if (typeof error === "object" && error !== null) {
    const maybe = error as Record<string, unknown>;
    const code = typeof maybe.code === "string" ? maybe.code : undefined;
    const message = typeof maybe.message === "string" ? maybe.message : undefined;
    if (code === "57014") {
      return {
        code: "timeout",
        message: "Query timed out by statement_timeout."
      };
    }
    if (message) {
      return {
        code: "internal_error",
        message: "Database query failed.",
        detail: message
      };
    }
  }

  return {
    code: "internal_error",
    message: "Unexpected error."
  };
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

function logInfo(event: string, payload: Record<string, unknown>): void {
  console.error(JSON.stringify({ level: "info", event, ...payload }));
}

function logError(event: string, payload: Record<string, unknown>): void {
  console.error(JSON.stringify({ level: "error", event, ...payload }));
}

async function safeRollback(client: { query: (sql: string) => Promise<unknown> }): Promise<void> {
  try {
    await client.query("rollback");
  } catch {
    // swallow rollback failure to avoid masking original error
  }
}

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logInfo("server_started", {
    name: "communicationhub-postgres-mcp",
    version: "0.2.0",
    defaultEnvironment: connections.defaultEnvironment,
    environments: connections.list().map((e) => `${e.name}:${e.capabilities.join("|")}`)
  });
}

main().catch((error) => {
  logError("server_crashed", { error: normalizeUnknown(error) });
  process.exit(1);
});
