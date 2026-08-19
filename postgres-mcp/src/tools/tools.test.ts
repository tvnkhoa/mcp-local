/**
 * Contract regression suite for the @mcp/sdk migration (S-24).
 *
 * `contracts/postgres-mcp.json` pins what `tools/list` advertises. This pins
 * what `tools/call` returns — the half a contract snapshot cannot see, and the
 * half the migration actually rewrote by replacing the dispatcher.
 *
 * Every expectation here was captured from the PRE-migration server over a real
 * stdio handshake: 60 observations, of which 59 are byte-identical after the
 * migration. The one intentional change is pinned at the bottom.
 *
 * No test here reaches a database. The connection points at a port nothing
 * listens on, and every case asserted below is decided by validation, a
 * guardrail, or a feature gate — all of which run before a pool is used.
 */

import assert from "node:assert/strict";
import process from "node:process";
import { test } from "node:test";

import { createNullLogger, createEventLogger } from "@mcp/core";
import { asErrorPayload, createToolRegistry, dispatchToolCall } from "@mcp/sdk";
import { assertRequiredKeysAdvertised, assertSchemaParity } from "@mcp/testing";

import { ConnectionManager } from "../repositories/connectionManager.js";
import { toWireError } from "../middleware/errors.js";
import { type MigrationConfig } from "../services/migration/efRunner.js";
import { buildSchemaResources } from "../resources/schemaResources.js";
import { buildTools, type PostgresDeps, type QueryLimits } from "./index.js";
import { WritePreviewStore } from "../services/write/previewStore.js";
import { type WriteConfig } from "./handlers/writeHandlers.js";

const logger = createNullLogger("test");
/** Discards its output: these tests must not write to stderr. */
const eventLog = createEventLogger(() => {});

/** Nothing listens here, so a stray DB call fails fast instead of hanging. */
process.env.POSTGRES_CONNECTION = "postgres://t:t@127.0.0.1:59999/t";
delete process.env.POSTGRES_ALLOWED_ENVIRONMENTS;
delete process.env.POSTGRES_DEFAULT_ENVIRONMENT;

const LIMITS: QueryLimits = {
  defaultLimit: 500,
  maxLimit: 2000,
  defaultTimeoutMs: 30_000,
  maxTimeoutMs: 60_000,
  explainCostWarn: 1_000_000
};

const WRITE_OFF: WriteConfig = {
  enabled: false,
  approvalSecret: "test-secret",
  previewTtlMs: 900_000,
  sampleLimit: 20
};

const MIGRATION_OFF: MigrationConfig = {
  enabled: false,
  project: "",
  startupProject: "",
  timeoutMs: 120_000,
  approvalSecret: "test-secret",
  previewTtlMs: 3_600_000
};

function deps(overrides: Partial<PostgresDeps> = {}): PostgresDeps {
  return {
    connections: new ConnectionManager({
      poolMax: 1,
      idleTimeoutMs: 1000,
      statementTimeoutMs: 1000,
      applicationName: "test"
    }),
    writeStore: new WritePreviewStore(),
    writeConfig: WRITE_OFF,
    migrationConfig: MIGRATION_OFF,
    limits: LIMITS,
    logger: eventLog,
    ...overrides
  };
}

function call(
  name: string,
  args: Record<string, unknown>,
  overrides: Partial<PostgresDeps> = {}
): Promise<{ isError?: boolean; content: readonly { text: string }[] }> {
  const registry = createToolRegistry(buildTools(deps(overrides)));
  return dispatchToolCall(registry, name, args, {
    logger,
    // Identical to the wiring in index.ts — the envelope is what is under test.
    formatError: (error) => asErrorPayload(toWireError(error), "verbose")
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function bodyOf(name: string, args: Record<string, unknown>, overrides?: Partial<PostgresDeps>): Promise<{ isError?: boolean; payload: any }> {
  const result = await call(name, args, overrides);
  return { isError: result.isError, payload: JSON.parse(result.content[0]?.text ?? "null") };
}

// --- tools/list side of the contract ---------------------------------------

test("the tool table is the 17 advertised tools, in registration order", () => {
  const names = buildTools(deps()).map((tool) => tool.name);
  assert.deepEqual(names, [
    "health_check",
    "list_environments",
    "list_tables",
    "describe_table",
    "run_read_query",
    "get_table_relationships",
    "profile_table",
    "data_diff",
    "write_preview",
    "write_apply",
    "write_rollback",
    "migration_status",
    "migration_add",
    "migration_preview",
    "migration_apply",
    "migration_dry_run",
    "compare_environments"
  ]);
});

test("only the four state-changing tools are not read-only", () => {
  const tools = buildTools(deps());
  assert.deepEqual(
    tools.filter((tool) => !tool.annotations.readOnly).map((tool) => tool.name),
    ["write_apply", "write_rollback", "migration_add", "migration_apply"]
  );
  // migration_add writes files and touches no database, so it removes nothing.
  assert.deepEqual(
    tools.filter((tool) => tool.annotations.destructive).map((tool) => tool.name),
    ["write_apply", "write_rollback", "migration_apply"]
  );
  // list_environments reads process config only; every other tool reaches a
  // database that may not be on this machine.
  assert.deepEqual(
    tools.filter((tool) => tool.annotations.openWorld !== true).map((tool) => tool.name),
    ["list_environments", "migration_add"]
  );
});

test("the env-derived bounds reach the advertised schema, not just validation", () => {
  const tools = buildTools(deps({ limits: { ...LIMITS, maxLimit: 50, maxTimeoutMs: 5000 } }));
  const readQuery = tools.find((tool) => tool.name === "run_read_query");
  assert.equal(readQuery?.inputSchema.properties["limit"]?.maximum, 50);
  assert.equal(readQuery?.inputSchema.properties["timeoutMs"]?.maximum, 5000);
});

test("every tool advertising a profile omits a description for it", () => {
  // schema.profile() would add one; this server has never advertised it, and
  // tools/list is a committed contract.
  for (const tool of buildTools(deps())) {
    const profile = tool.inputSchema.properties["profile"];
    assert.equal(profile?.description, undefined, `${tool.name} gained a profile description`);
  }
});

// --- error envelope: { code, message, detail? }, always verbose -------------

test("validation errors keep this server's envelope, not the platform's", async () => {
  const { isError, payload } = await bodyOf("describe_table", {});
  assert.equal(isError, true);
  assert.equal(payload.code, "validation_error");
  assert.equal(payload.message, "Invalid tool input.");
  assert.equal(payload.detail, "table: Required");
  // The platform envelope would carry these; this server's must not.
  assert.equal(payload.audience, undefined);
  assert.equal(payload.retryable, undefined);
});

test("an unknown argument is rejected, and reports the path as `root`", async () => {
  const { payload } = await bodyOf("list_environments", { nope: 1 });
  assert.equal(payload.code, "validation_error");
  assert.equal(payload.detail, "root: Unrecognized key(s) in object: 'nope'");
});

test("out-of-range values are rejected by the zod bound, not silently clamped", async () => {
  assert.equal(
    (await bodyOf("run_read_query", { sql: "select 1", limit: 999999 })).payload.detail,
    "limit: Number must be less than or equal to 2000"
  );
  assert.equal(
    (await bodyOf("run_read_query", { sql: "select 1", limit: 0 })).payload.detail,
    "limit: Number must be greater than or equal to 1"
  );
  assert.equal(
    (await bodyOf("run_read_query", { sql: "select 1", timeoutMs: 999999 })).payload.detail,
    "timeoutMs: Number must be less than or equal to 60000"
  );
  assert.equal(
    (await bodyOf("profile_table", { table: "t", sampleLimit: 500 })).payload.detail,
    "sampleLimit: Number must be less than or equal to 100"
  );
});

test("an invalid profile is a validation error, not a silent fallback", async () => {
  const { payload } = await bodyOf("list_environments", { profile: "chatty" });
  assert.equal(payload.code, "validation_error");
  assert.match(payload.detail, /^profile: /);
});

test("a non-scalar SQL parameter is rejected", async () => {
  const { payload } = await bodyOf("run_read_query", { sql: "select 1", params: [{ a: 1 }] });
  assert.equal(payload.detail, "params.0: Invalid input");
});

// --- read-only SQL guardrails -----------------------------------------------
// These run inside run_read_query, which is why it is a rawResult tool: its
// rejection envelope carries requestId and environment, which a PlatformError
// cannot express.

test("a guardrail rejection keeps requestId and environment alongside the code", async () => {
  const { isError, payload } = await bodyOf("run_read_query", { sql: "delete from t" });
  assert.equal(isError, true);
  assert.equal(payload.code, "validation_error");
  assert.equal(payload.message, "Only SELECT or WITH ... SELECT queries are allowed.");
  // The fields the raw path exists to preserve.
  assert.equal(typeof payload.requestId, "string");
  assert.equal(payload.environment, "default");
});

test("the guardrails reject writes, DDL, multi-statement and CTE writes", async () => {
  const cases: [string, string][] = [
    ["insert into t values (1)", "Only SELECT or WITH ... SELECT queries are allowed."],
    ["update t set a=1", "Only SELECT or WITH ... SELECT queries are allowed."],
    ["drop table t", "Only SELECT or WITH ... SELECT queries are allowed."],
    ["copy t to '/tmp/x'", "Only SELECT or WITH ... SELECT queries are allowed."],
    ["set role postgres", "Only SELECT or WITH ... SELECT queries are allowed."],
    ["select 1; select 2", "Only one SQL statement is allowed."],
    ["with x as (delete from t returning *) select * from x", "Forbidden SQL token detected: delete."]
  ];
  for (const [sql, message] of cases) {
    const { payload } = await bodyOf("run_read_query", { sql });
    assert.equal(payload.message, message, sql);
  }
});

// --- the write gate ----------------------------------------------------------

test("all three write tools refuse when POSTGRES_WRITE_ENABLED is off", async () => {
  const expected = {
    code: "WRITE_DISABLED",
    message:
      "Data modification is disabled. Set POSTGRES_WRITE_ENABLED=true and POSTGRES_WRITE_APPROVAL_SECRET to enable."
  };
  assert.deepEqual((await bodyOf("write_preview", { sql: "update t set a=1 where id=1" })).payload, expected);
  assert.deepEqual((await bodyOf("write_apply", { previewId: "p", approvalToken: "t" })).payload, expected);
  assert.deepEqual((await bodyOf("write_rollback", { rollbackId: "r" })).payload, expected);
});

test("with writes on, the shape guards still refuse before any database work", async () => {
  const on = { writeConfig: { ...WRITE_OFF, enabled: true } };
  assert.deepEqual((await bodyOf("write_preview", { sql: "update t set a=1" }, on)).payload, {
    code: "MISSING_WHERE",
    message:
      "UPDATE without a WHERE clause is blocked. Add a WHERE, or pass allowFullTable:true to intentionally affect the whole table."
  });
  assert.deepEqual((await bodyOf("write_preview", { sql: "select 1" }, on)).payload, {
    code: "NOT_A_WRITE",
    message: "Use run_read_query for SELECT / WITH ... SELECT statements."
  });
  assert.deepEqual((await bodyOf("write_preview", { sql: "drop table t" }, on)).payload, {
    code: "DDL_NOT_ALLOWED",
    message: "DDL is not allowed here. Schema changes must go through the migration tools."
  });
  assert.deepEqual((await bodyOf("write_apply", { previewId: "nope", approvalToken: "bad" }, on)).payload, {
    code: "PREVIEW_NOT_FOUND",
    message: "Preview 'nope' not found or expired."
  });
  assert.deepEqual((await bodyOf("write_rollback", { rollbackId: "nope" }, on)).payload, {
    code: "ROLLBACK_NOT_FOUND",
    message: "Rollback 'nope' not found (process restart clears history)."
  });
});

// --- the migration gate ------------------------------------------------------

test("all five migration tools refuse when POSTGRES_MIGRATION_ENABLED is off", async () => {
  const expected = {
    code: "MIGRATION_DISABLED",
    message:
      "Migration tools are disabled. Set POSTGRES_MIGRATION_ENABLED=true, POSTGRES_DOTNET_PROJECT and POSTGRES_DOTNET_STARTUP_PROJECT to enable."
  };
  for (const [name, args] of [
    ["migration_status", {}],
    ["migration_add", { name: "AddThing" }],
    ["migration_preview", {}],
    ["migration_apply", { previewId: "p", approvalToken: "t" }],
    ["migration_dry_run", {}]
  ] as [string, Record<string, unknown>][]) {
    assert.deepEqual((await bodyOf(name, args)).payload, expected, name);
  }
});

test("enabling migrations without a project still refuses, before spawning dotnet", async () => {
  const on = { migrationConfig: { ...MIGRATION_OFF, enabled: true } };
  assert.deepEqual((await bodyOf("migration_status", {}, on)).payload, {
    code: "MIGRATION_PROJECT_UNCONFIGURED",
    message: "POSTGRES_DOTNET_PROJECT and POSTGRES_DOTNET_STARTUP_PROJECT must be set for migration tools."
  });
});

// --- environment resolution --------------------------------------------------

test("an unknown environment is refused with its own code, not internal_error", async () => {
  const expected = {
    code: "UNKNOWN_ENVIRONMENT",
    message: "Environment 'nowhere' is not configured. Known environments: default."
  };
  assert.deepEqual((await bodyOf("health_check", { environment: "nowhere" })).payload, expected);
  assert.deepEqual((await bodyOf("list_tables", { environment: "nowhere" })).payload, expected);
  assert.deepEqual(
    (await bodyOf("data_diff", { source: "nowhere", target: "dev", table: "t" })).payload,
    expected
  );
});

test("list_environments succeeds without a database and is serialized by dispatch", async () => {
  const { isError, payload } = await bodyOf("list_environments", {});
  assert.equal(isError, undefined);
  assert.equal(payload.defaultEnvironment, "default");
  assert.deepEqual(payload.environments, [
    {
      name: "default",
      capabilities: ["read", "write"],
      source: "legacy",
      sourceDetail: "POSTGRES_CONNECTION",
      // The masking contract: host/database/user only. No password, and not the
      // raw DSN — this payload is the one a client is most likely to log.
      connection: { host: "127.0.0.1", database: "t", user: "t" },
      isDefault: true
    }
  ]);
  assert.equal(JSON.stringify(payload).includes("59999"), false);
});

// --- resources ---------------------------------------------------------------

test("the schema resource provider lists one resource per environment", async () => {
  const provider = buildSchemaResources(deps().connections);
  assert.deepEqual(await provider.list(), [
    {
      uri: "schema://default",
      name: "Schema (default)",
      description: "Database schema snapshot for environment 'default'.",
      mimeType: "application/json"
    }
  ]);
});

test("a non-schema uri is unroutable, an unknown environment is a real failure", async () => {
  const provider = buildSchemaResources(deps().connections);
  // undefined -> the SDK raises InvalidParams, matching the old McpError.
  assert.equal(await provider.read("bogus://x"), undefined);
  // Throwing -> stays an internal error, as it did before.
  await assert.rejects(() => Promise.resolve(provider.read("schema://nowhere")), /not configured/);
});

// --- the one intentional behaviour change -----------------------------------

test("DELTA: an unknown tool now reports not_found instead of mcp_error", async () => {
  // Before the migration the hand-written switch threw McpError, producing
  //   { code: "mcp_error", message: "MCP error -32601: Unknown tool: x" }
  // Dispatch now raises a PlatformError, which toWireError unwraps to its own
  // code. `not_found` describes the condition; the old string leaked a JSON-RPC
  // error number into a tool payload. This is the only response that changed
  // across all 60 captured observations.
  const { isError, payload } = await bodyOf("no_such_tool", {});
  assert.equal(isError, true);
  assert.deepEqual(payload, { code: "not_found", message: "Unknown tool: no_such_tool." });
});


// --- input-schema parity ------------------------------------------------------
//
// Every tool declares its input twice: a zod schema the handler validates with, and a hand-written
// JSON Schema `tools/list` advertises. Nothing else compares them — `contracts:check` pins the
// advertised side against a snapshot of *itself*, so a parameter missing from both stays missing,
// and `docs:check` reads the advertised side only. Until now only codebase-index-mcp had this gate.

test("every tool advertises exactly the parameters its zod schema accepts", () => {
  assertSchemaParity(buildTools(deps()), { floor: 17 });
});

test("a tool declaring additionalProperties:false advertises every required key", () => {
  assertRequiredKeysAdvertised(buildTools(deps()));
});
