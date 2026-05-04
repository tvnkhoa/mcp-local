import { randomUUID, createHash } from "node:crypto";
import process from "node:process";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ErrorCode,
  type CallToolResult
} from "@modelcontextprotocol/sdk/types.js";
import { Pool, type PoolClient, type FieldDef, type PoolConfig } from "pg";
import { z } from "zod";

import { validateReadOnlySql } from "./sqlGuardrails.js";

const connectionString = process.env.CH_DB_CONNECTION;
if (!connectionString) {
  throw new Error("CH_DB_CONNECTION is required.");
}

const DEFAULT_LIMIT = numberFromEnv("MCP_DB_DEFAULT_LIMIT", 500);
const MAX_LIMIT = numberFromEnv("MCP_DB_MAX_LIMIT", 2000);
const DEFAULT_TIMEOUT_MS = numberFromEnv("MCP_DB_DEFAULT_TIMEOUT_MS", 30_000);
const MAX_TIMEOUT_MS = numberFromEnv("MCP_DB_MAX_TIMEOUT_MS", 60_000);

const pool = new Pool({
  ...parseConnection(connectionString),
  max: 10,
  idleTimeoutMillis: 30_000,
  statement_timeout: DEFAULT_TIMEOUT_MS,
  application_name: "communicationhub-postgres-mcp"
});

const healthSchema = z.object({}).strict();
const listTablesSchema = z.object({
  schema: z.string().min(1).max(128).optional()
}).strict();
const describeTableSchema = z.object({
  schema: z.string().min(1).max(128).default("public"),
  table: z.string().min(1).max(128)
}).strict();
const runReadQuerySchema = z.object({
  sql: z.string().min(1),
  params: z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
  limit: z.number().int().min(1).max(MAX_LIMIT).optional(),
  timeoutMs: z.number().int().min(1).max(MAX_TIMEOUT_MS).optional(),
  requestId: z.string().min(1).max(128).optional()
}).strict();

const server = new Server(
  {
    name: "communicationhub-postgres-mcp",
    version: "0.1.0"
  },
  {
    capabilities: {
      tools: {}
    }
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "health_check",
        description: "Check MCP server and PostgreSQL connectivity.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {}
        }
      },
      {
        name: "list_tables",
        description: "List tables in a schema (default: public).",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            schema: { type: "string" }
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
            table: { type: "string" }
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
            requestId: { type: "string" }
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
        healthSchema.parse(request.params.arguments ?? {});
        return await healthCheck();
      }
      case "list_tables": {
        const args = listTablesSchema.parse(request.params.arguments ?? {});
        return await listTables(args.schema ?? "public");
      }
      case "describe_table": {
        const args = describeTableSchema.parse(request.params.arguments ?? {});
        return await describeTable(args.schema, args.table);
      }
      case "run_read_query": {
        const args = runReadQuerySchema.parse(request.params.arguments ?? {});
        return await runReadQuery(args);
      }
      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${request.params.name}`);
    }
  } catch (error) {
    const mapped = mapError(error);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(mapped, null, 2)
        }
      ],
      isError: true
    } satisfies CallToolResult;
  }
});

async function healthCheck(): Promise<CallToolResult> {
  const now = new Date().toISOString();
  const db = await pool.query<{ now: string }>("select now()::text as now");

  return asText({
    status: "ok",
    serverTimeUtc: now,
    databaseTime: db.rows[0]?.now ?? null
  });
}

async function listTables(schema: string): Promise<CallToolResult> {
  const result = await pool.query<{
    table_name: string;
  }>(
    `
    select table_name
    from information_schema.tables
    where table_schema = $1
      and table_type = 'BASE TABLE'
    order by table_name asc
    `,
    [schema]
  );

  return asText({
    schema,
    tableCount: result.rowCount,
    tables: result.rows.map((r: { table_name: string }) => r.table_name)
  });
}

async function describeTable(schema: string, table: string): Promise<CallToolResult> {
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

  return asText({
    schema,
    table,
    columnCount: result.rowCount,
    columns: result.rows
  });
}

async function runReadQuery(args: z.infer<typeof runReadQuerySchema>): Promise<CallToolResult> {
  const requestId = args.requestId ?? randomUUID();
  const startedAt = Date.now();

  const validated = validateReadOnlySql(args.sql);
  if (!validated.ok) {
    return asError({
      requestId,
      code: validated.error.code,
      message: validated.error.message
    });
  }

  const effectiveLimit = Math.min(args.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
  const effectiveTimeoutMs = Math.min(args.timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);

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
      queryHash: stableHash(validated.sanitizedSql),
      rowCount: result.rowCount,
      elapsedMs
    });

    return asText({
      requestId,
      rowCount: result.rowCount,
      truncated: result.rowCount === effectiveLimit,
      elapsedMs,
      columns: result.fields.map((f: FieldDef) => f.name),
      rows: result.rows
    });
  } catch (error) {
    await safeRollback(client);
    logError("query_failed", {
      requestId,
      queryHash: stableHash(validated.sanitizedSql),
      error: normalizeUnknown(error)
    });
    throw error;
  } finally {
    client.release();
  }
}

function asText(payload: unknown): CallToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(payload, null, 2)
      }
    ]
  };
}

function asError(payload: unknown): CallToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(payload, null, 2)
      }
    ],
    isError: true
  };
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

function parseConnection(raw: string): PoolConfig {
  const trimmed = raw.trim();

  // URI mode: postgresql://user:pass@host:5432/db
  if (/^postgres(ql)?:\/\//i.test(trimmed)) {
    return { connectionString: trimmed };
  }

  // Npgsql-style mode: Server=...;Port=...;Database=...;Username=...;Password=...;
  const kv: Record<string, string> = {};
  for (const part of trimmed.split(";")) {
    const item = part.trim();
    if (!item) {
      continue;
    }

    const idx = item.indexOf("=");
    if (idx <= 0) {
      continue;
    }

    const key = item.slice(0, idx).trim().toLowerCase();
    const value = item.slice(idx + 1).trim();
    kv[key] = value;
  }

  const host = kv.server ?? kv.host;
  const database = kv.database;
  const user = kv.username ?? kv.user ?? kv["user id"] ?? kv.userid ?? kv.uid;
  const password = kv.password ?? kv.pwd;
  const portRaw = kv.port;
  const port = portRaw ? Number(portRaw) : undefined;

  if (!host || !database || !user) {
    throw new Error(
      "CH_DB_CONNECTION is missing required fields. Provide either postgres:// URI or Server/Port/Database/Username format."
    );
  }

  return {
    host,
    database,
    user,
    password,
    ...(Number.isFinite(port) ? { port } : {})
  };
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

async function safeRollback(client: PoolClient): Promise<void> {
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
    version: "0.1.0"
  });
}

main().catch((error) => {
  logError("server_crashed", { error: normalizeUnknown(error) });
  process.exit(1);
});
