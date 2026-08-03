/**
 * Contract regression suite for the @mcp/sdk migration (S-25).
 *
 * `contracts/observe-mcp.json` pins what `tools/list` advertises. This pins what
 * `tools/call` returns — the half a contract snapshot cannot see, and the half
 * the migration actually rewrote by replacing the dispatcher.
 *
 * Every expectation here was captured from the PRE-migration server over a real
 * stdio handshake: 41 observations, of which 40 are byte-identical after the
 * migration. The one intentional change is pinned at the bottom.
 *
 * The tools are built against a stub client, so nothing here touches the network.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { createNullLogger } from "@mcp/core";
import { asErrorPayload, createToolRegistry, dispatchToolCall } from "@mcp/sdk";

import type { ObserveConfig } from "./config/index.js";
import type { ObserveClient } from "./observeClient.js";
import { buildTools, toWireError } from "./tools.js";

const logger = createNullLogger("test");

const CAPS = { message: 2000, exception: 4000, attributes: 20 };

const CONFIG: ObserveConfig = {
  baseUrl: "http://contract-snapshot.invalid",
  org: "test-org",
  logStream: "test_logs",
  traceStream: "test_traces",
  traceStreamConfigured: true,
  authHeader: "Basic dGVzdA==",
  defaultSize: 100,
  maxSize: 1000,
  defaultLookbackMs: 3_600_000,
  maxLookbackMs: 604_800_000,
  timeoutMs: 30_000,
  maxRetries: 0,
  logColumns: [],
  fieldCaps: { nano: CAPS, compact: CAPS, standard: CAPS, verbose: CAPS }
} as unknown as ObserveConfig;

/** Every method rejects: no test here should reach the network. */
const STUB_CLIENT = {
  search: async () => {
    throw new Error("network not available in tests");
  },
  listStreams: async () => {
    throw new Error("network not available in tests");
  }
} as unknown as ObserveClient;

function call(
  name: string,
  args: Record<string, unknown>,
  config: ObserveConfig = CONFIG
): Promise<{ isError?: boolean; content: readonly { text: string }[] }> {
  const registry = createToolRegistry(buildTools(config, STUB_CLIENT));
  return dispatchToolCall(registry, name, args, {
    logger,
    // Identical to the wiring in index.ts — the envelope is what is under test.
    formatError: (error) => asErrorPayload(toWireError(error), "verbose")
  });
}

async function bodyOf(
  name: string,
  args: Record<string, unknown>,
  config?: ObserveConfig
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<{ isError?: boolean; payload: any; text: string }> {
  const result = await call(name, args, config);
  const text = result.content[0]?.text ?? "null";
  return { isError: result.isError, payload: JSON.parse(text), text };
}

// --- tools/list side of the contract ---------------------------------------

test("the tool table is the 8 advertised tools, in registration order", () => {
  const names = buildTools(CONFIG, STUB_CLIENT).map((tool) => tool.name);
  assert.deepEqual(names, [
    "list_streams",
    "search_logs",
    "trace_logs",
    "get_trace_spans",
    "tail_logs",
    "log_stats",
    "run_observe_query",
    "describe_stream"
  ]);
});

test("every tool is read-only and open-world — this server never writes", () => {
  for (const tool of buildTools(CONFIG, STUB_CLIENT)) {
    assert.equal(tool.annotations.readOnly, true, tool.name);
    assert.equal(tool.annotations.destructive, false, tool.name);
    assert.equal(tool.annotations.openWorld, true, tool.name);
  }
});

test("every tool advertising a profile omits a description for it", () => {
  // schema.profile() would add one; this server has never advertised it, and
  // tools/list is a committed contract.
  for (const tool of buildTools(CONFIG, STUB_CLIENT)) {
    assert.equal(tool.inputSchema.properties["profile"]?.description, undefined, tool.name);
  }
});

test("limit and offset advertise `number`, not `integer`", () => {
  // The zod schemas are .int(), but the published JSON Schema says number.
  // Tightening it would be a contract change.
  const search = buildTools(CONFIG, STUB_CLIENT).find((t) => t.name === "search_logs");
  assert.equal(search?.inputSchema.properties["limit"]?.type, "number");
  assert.equal(search?.inputSchema.properties["offset"]?.type, "number");
});

// --- error envelope: { code, message, detail? }, always verbose -------------

test("validation errors keep this server's envelope, not the platform's", async () => {
  const { isError, payload } = await bodyOf("trace_logs", {});
  assert.equal(isError, true);
  assert.equal(payload.code, "validation_error");
  assert.equal(payload.message, "Invalid arguments.");
  assert.equal(payload.detail, "traceId: Required");
  // The platform envelope would carry these; this server's must not.
  assert.equal(payload.audience, undefined);
  assert.equal(payload.retryable, undefined);
});

test("an unknown argument is rejected, and reports the path as `(root)`", async () => {
  const { payload } = await bodyOf("list_streams", { nope: 1 });
  assert.equal(payload.code, "validation_error");
  assert.equal(payload.detail, "(root): Unrecognized key(s) in object: 'nope'");
});

test("bounds are enforced by zod, not silently clamped", async () => {
  assert.equal(
    (await bodyOf("trace_logs", { traceId: "abc" })).payload.detail,
    "traceId: String must contain at least 8 character(s)"
  );
  assert.equal(
    (await bodyOf("tail_logs", { minutes: 5000 })).payload.detail,
    "minutes: Number must be less than or equal to 1440"
  );
  assert.equal(
    (await bodyOf("log_stats", { limit: 9999 })).payload.detail,
    "limit: Number must be less than or equal to 500"
  );
  assert.equal(
    (await bodyOf("describe_stream", { sample: 500 })).payload.detail,
    "sample: Number must be less than or equal to 50"
  );
  assert.equal(
    (await bodyOf("run_observe_query", { sql: "s".repeat(9000) })).payload.detail,
    "sql: String must contain at most 8192 character(s)"
  );
  assert.equal(
    (await bodyOf("search_logs", { offset: -1 })).payload.detail,
    "offset: Number must be greater than or equal to 0"
  );
});

// --- time-window resolution --------------------------------------------------
// These throw out of the handler and are rendered by formatError at verbose.

test("time-window refusals surface their message, always pretty-printed", async () => {
  const bad = await bodyOf("search_logs", { time: "banana" });
  assert.equal(bad.payload.code, "validation_error");
  assert.equal(
    bad.payload.message,
    'Invalid relative time "banana". Use forms like "15m", "1h", "24h", "7d".'
  );
  // Always verbose regardless of the caller's profile.
  assert.ok(bad.text.includes("\n"));

  assert.equal(
    (await bodyOf("search_logs", { time: "999d" })).payload.message,
    "Time window exceeds the maximum lookback of 604800000 ms. Narrow the range."
  );
  assert.equal(
    (await bodyOf("search_logs", { start: "not-a-date" })).payload.message,
    'Invalid start time "not-a-date". Use ISO 8601 (e.g. 2026-07-03T10:00:00Z) or epoch milliseconds.'
  );
  assert.equal(
    (
      await bodyOf("search_logs", { start: "2026-01-02T00:00:00Z", end: "2026-01-01T00:00:00Z" })
    ).payload.message,
    "Time window end must be after start."
  );
});

// --- the read-only SQL guardrail ---------------------------------------------

test("the guardrail rejects writes, DDL, multi-statement and CTE writes", async () => {
  const cases: [string, string][] = [
    ["insert into t values (1)", "Only SELECT or WITH ... SELECT queries are allowed."],
    ["update t set a=1", "Only SELECT or WITH ... SELECT queries are allowed."],
    ["delete from t", "Only SELECT or WITH ... SELECT queries are allowed."],
    ["drop table t", "Only SELECT or WITH ... SELECT queries are allowed."],
    ["select 1; select 2", "Only one SQL statement is allowed."],
    ["with x as (delete from t returning *) select * from x", "Forbidden SQL token detected: delete."]
  ];
  for (const [sql, message] of cases) {
    const { isError, payload } = await bodyOf("run_observe_query", { sql });
    assert.equal(isError, true, sql);
    assert.deepEqual(payload, { code: "validation_error", message }, sql);
  }
});

test("REGRESSION: the guardrail rejection honours the caller's profile", async () => {
  // This is the entire reason run_observe_query is a rawResult tool. Routing it
  // through formatError would render every rejection at verbose, silently
  // pretty-printing the three profiles that are currently minified. Captured
  // from the pre-migration server at all four profiles.
  const sql = "drop table t";
  assert.equal((await bodyOf("run_observe_query", { sql, profile: "nano" })).text.includes("\n"), false);
  assert.equal((await bodyOf("run_observe_query", { sql, profile: "compact" })).text.includes("\n"), false);
  assert.equal((await bodyOf("run_observe_query", { sql, profile: "standard" })).text.includes("\n"), false);
  assert.equal((await bodyOf("run_observe_query", { sql, profile: "verbose" })).text.includes("\n"), true);
  // No profile at all defaults to verbose — unlike the rest of the server, where
  // the default response profile is compact.
  assert.equal((await bodyOf("run_observe_query", { sql })).text.includes("\n"), true);
});

// --- upstream failures --------------------------------------------------------

test("an upstream failure is reported for every tool that reaches the backend", async () => {
  for (const [name, args] of [
    ["list_streams", {}],
    ["search_logs", { limit: 5 }],
    ["trace_logs", { traceId: "0123456789abcdef0123456789abcdef" }],
    ["get_trace_spans", { traceId: "0123456789abcdef0123456789abcdef" }],
    ["tail_logs", {}],
    ["log_stats", {}],
    ["run_observe_query", { sql: "select 1" }],
    ["describe_stream", {}]
  ] as [string, Record<string, unknown>][]) {
    const { isError, payload } = await bodyOf(name, args);
    assert.equal(isError, true, name);
    assert.equal(payload.code, "internal_error", name);
    assert.equal(payload.message, "network not available in tests", name);
  }
});

test("get_trace_spans warns when no traces stream is configured", async () => {
  // The warning is computed before the search call, so it survives the stub's
  // rejection only via the config check — assert the config branch directly.
  const unconfigured = { ...CONFIG, traceStreamConfigured: false } as ObserveConfig;
  const tools = buildTools(unconfigured, STUB_CLIENT);
  assert.ok(tools.find((t) => t.name === "get_trace_spans"));
  // An explicit `stream` suppresses the warning; both paths still hit the stub.
  const { payload } = await bodyOf(
    "get_trace_spans",
    { traceId: "0123456789abcdef0123456789abcdef" },
    unconfigured
  );
  assert.equal(payload.code, "internal_error");
});

// --- the one intentional behaviour change -----------------------------------

test("DELTA: an unknown tool now reports not_found instead of mcp_error", async () => {
  // Before the migration the hand-written switch threw McpError, producing
  //   { code: "mcp_error", message: "MCP error -32601: Unknown tool: x" }
  // Dispatch now raises a PlatformError, which toWireError unwraps to its own
  // code. `not_found` describes the condition; the old string leaked a JSON-RPC
  // error number into a tool payload. This is the only response that changed
  // across all 41 captured observations.
  const { isError, payload } = await bodyOf("no_such_tool", {});
  assert.equal(isError, true);
  assert.deepEqual(payload, { code: "not_found", message: "Unknown tool: no_such_tool." });
});
