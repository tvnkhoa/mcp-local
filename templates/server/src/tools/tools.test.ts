import assert from "node:assert/strict";
import test from "node:test";

import { createNullLogger } from "@mcp/core";
import { asErrorPayload, createToolRegistry, dispatchToolCall } from "@mcp/sdk";

import { buildTools, toWireError } from "./index.js";
import type { __PASCAL__Config } from "../config/index.js";

const config: __PASCAL__Config = { baseUrl: "https://example.invalid", timeoutMs: 1000 };

const logger = createNullLogger("test");

/**
 * Dispatch a call exactly as `index.ts` wires it, so the envelope under test is the one a client
 * actually receives — not one this test constructed.
 */
const bodyOf = async (name: string, args: Record<string, unknown>) => {
  const registry = createToolRegistry(buildTools(config));
  const result = await dispatchToolCall(registry, name, args, {
    logger,
    formatError: (error) => asErrorPayload(toWireError(error), "verbose")
  });
  return { isError: result.isError, payload: JSON.parse(result.content[0]?.text ?? "null") };
};

/**
 * Tools are pinned here rather than only in `contracts/__KEY__.json`.
 *
 * The snapshot covers `tools/list` — names, descriptions, schemas. It cannot see what a *call*
 * returns, so a refactor can keep the advertised contract byte-identical while changing every
 * response. These tests are that second net.
 */

test("every tool is snake_case and declares annotations", () => {
  for (const tool of buildTools(config)) {
    assert.match(tool.name, /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/, `${tool.name} is not snake_case`);
    assert.equal(typeof tool.annotations.readOnly, "boolean");
    assert.equal(typeof tool.annotations.idempotent, "boolean");
    assert.equal(typeof tool.annotations.destructive, "boolean");
    assert.notEqual(tool.description.trim(), "", `${tool.name} has an empty description`);
  }
});

test("health_check is present, as every server must have it", () => {
  const names = buildTools(config).map((t) => t.name);
  assert.ok(names.includes("health_check"), `health_check missing; got ${names.join(", ")}`);
});

test("echo returns the message it was given", async () => {
  const echo = buildTools(config).find((t) => t.name === "echo");
  assert.ok(echo, "echo tool missing");

  const result = await echo.handler({ message: "hello" }, { profile: "compact" } as never);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.value, { message: "hello", server: "__KEY__" });
  }
});

test("echo rejects an empty message rather than coercing it", () => {
  const echo = buildTools(config).find((t) => t.name === "echo");
  assert.ok(echo);
  // The zod schema is the runtime contract; `inputSchema` is only what clients are told.
  assert.equal(echo.input.safeParse({ message: "" }).success, false);
  assert.equal(echo.input.safeParse({ message: "ok", extra: 1 }).success, false);
});

// --- the error envelope, which `tools/list` cannot see ----------------------

test("a bad argument is a validation_error with readable issues, not a zod dump", async () => {
  const { isError, payload } = await bodyOf("echo", { message: "" });
  assert.equal(isError, true);
  assert.equal(payload.code, "validation_error");
  assert.equal(payload.message, "Invalid arguments.");
  // The issues belong in `detail`. A raw zod array in `message` is what this pins against.
  assert.match(payload.detail, /^message: /);
});

test("an unknown tool reports not_found, the code dispatch chose", async () => {
  // `toWireError` unwraps the PlatformError dispatch raises. Without it this would arrive as
  // `internal_error`, which tells a caller their own mistake is a defect in this server.
  const { isError, payload } = await bodyOf("no_such_tool", {});
  assert.equal(isError, true);
  assert.deepEqual(payload, { code: "not_found", message: "Unknown tool: no_such_tool." });
});
