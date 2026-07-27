import assert from "node:assert/strict";
import { test } from "node:test";

import { createNullLogger, ok, err, validationError, policyViolation } from "@mcp/core";
import { z } from "zod";

import { redirectConsoleToStderr } from "./console.js";
import { annotations, defineTool } from "./defineTool.js";
import { dispatchToolCall } from "./dispatch.js";
import { featureFlagGuard, immutableTargetGuard, runGuards } from "./guards.js";
import { createHealthCheckTool } from "./healthTool.js";
import { createLifecycle } from "./lifecycle.js";
import { createToolRegistry } from "./registry.js";
import type { LegacyBridge } from "./registry.js";
import { asError, asText, serializePayload } from "./responses.js";
import { EMPTY_OBJECT_SCHEMA, schema } from "./schema.js";
import type { ToolContext } from "./toolDefinition.js";
import { toToolDescriptor } from "./toolDefinition.js";

const logger = createNullLogger("test");

function makeCtx(): ToolContext {
  return { logger, profile: "compact", requestId: "req-test" };
}

const echoTool = defineTool({
  name: "echo_value",
  description: "Echo the supplied value back.",
  input: z.object({ value: z.string(), profile: z.string().optional() }).strict(),
  inputSchema: schema.object({ value: schema.string("Value to echo"), profile: schema.profile() }, {
    required: ["value"]
  }),
  annotations: annotations.read(),
  handler: (input) => ok({ echoed: input.value })
});

function textOf(result: { content: readonly { text: string }[] }): string {
  return result.content[0]?.text ?? "";
}

// --- defineTool -----------------------------------------------------------

test("defineTool: rejects a non snake_case name", () => {
  assert.throws(() =>
    defineTool({
      name: "EchoValue",
      description: "x",
      input: z.object({}),
      inputSchema: EMPTY_OBJECT_SCHEMA,
      annotations: annotations.read(),
      handler: () => ok({})
    })
  );
});

test("defineTool: rejects an empty description and contradictory annotations", () => {
  assert.throws(() =>
    defineTool({
      name: "a_tool",
      description: "   ",
      input: z.object({}),
      inputSchema: EMPTY_OBJECT_SCHEMA,
      annotations: annotations.read(),
      handler: () => ok({})
    })
  );

  assert.throws(() =>
    defineTool({
      name: "a_tool",
      description: "ok",
      input: z.object({}),
      inputSchema: EMPTY_OBJECT_SCHEMA,
      annotations: { readOnly: true, idempotent: true, destructive: true },
      handler: () => ok({})
    })
  );
});

test("defineTool: the result is frozen", () => {
  assert.equal(Object.isFrozen(echoTool), true);
  assert.equal(Object.isFrozen(echoTool.annotations), true);
});

test("toToolDescriptor: annotations map onto MCP hint names", () => {
  const descriptor = toToolDescriptor(echoTool);
  assert.deepEqual(descriptor.annotations, {
    readOnlyHint: true,
    idempotentHint: true,
    destructiveHint: false,
    openWorldHint: false
  });
  assert.equal(descriptor.name, "echo_value");
});

// --- registry -------------------------------------------------------------

test("registry: duplicate tool names are a startup failure", () => {
  assert.throws(() => createToolRegistry([echoTool, echoTool]));
});

test("registry: lists registered tools", () => {
  const registry = createToolRegistry([echoTool]);
  assert.deepEqual(registry.names(), ["echo_value"]);
  assert.equal(registry.has("echo_value"), true);
  assert.equal(registry.has("nope"), false);
  assert.deepEqual(registry.stats(), { registered: 1, legacy: 0 });
});

test("registry: a legacy bridge supplies unmigrated tools and migrated ones win", () => {
  const legacy: LegacyBridge = {
    listTools: () => [
      {
        name: "old_tool",
        description: "legacy",
        inputSchema: EMPTY_OBJECT_SCHEMA,
        annotations: {
          readOnlyHint: true,
          idempotentHint: true,
          destructiveHint: false,
          openWorldHint: false
        }
      },
      {
        name: "echo_value",
        description: "legacy twin that must be shadowed",
        inputSchema: EMPTY_OBJECT_SCHEMA,
        annotations: {
          readOnlyHint: true,
          idempotentHint: true,
          destructiveHint: false,
          openWorldHint: false
        }
      }
    ],
    has: (name) => name === "old_tool" || name === "echo_value",
    call: async () => asText({ from: "legacy" }, "compact")
  };

  const registry = createToolRegistry([echoTool], { legacy });
  assert.deepEqual([...registry.names()].sort(), ["echo_value", "old_tool"]);
  assert.deepEqual(registry.stats(), { registered: 1, legacy: 1 });

  const listed = registry.list();
  const echo = listed.find((entry) => entry.name === "echo_value");
  assert.equal(echo?.description, "Echo the supplied value back.");
});

// --- dispatch -------------------------------------------------------------

test("dispatch: a valid call returns the serialized payload", async () => {
  const registry = createToolRegistry([echoTool]);
  const result = await dispatchToolCall(registry, "echo_value", { value: "hi" }, { logger });
  assert.equal(result.isError, undefined);
  assert.deepEqual(JSON.parse(textOf(result)), { echoed: "hi" });
});

test("dispatch: an unknown tool is a not_found error, not a throw", async () => {
  const registry = createToolRegistry([echoTool]);
  const result = await dispatchToolCall(registry, "missing_tool", {}, { logger });
  assert.equal(result.isError, true);
  assert.equal((JSON.parse(textOf(result)) as { code: string }).code, "not_found");
});

test("dispatch: invalid input is a validation_error carrying the field path", async () => {
  const registry = createToolRegistry([echoTool]);
  const result = await dispatchToolCall(registry, "echo_value", { value: 42 }, { logger });
  assert.equal(result.isError, true);
  const payload = JSON.parse(textOf(result)) as { code: string; details?: { issues?: unknown[] } };
  assert.equal(payload.code, "validation_error");
  assert.equal(Array.isArray(payload.details?.issues), true);
});

test("dispatch: a refusing guard blocks the handler", async () => {
  let handlerRan = false;
  const gated = defineTool({
    name: "gated_tool",
    description: "Gated behind a feature flag.",
    input: z.object({}).strict(),
    inputSchema: EMPTY_OBJECT_SCHEMA,
    annotations: annotations.apply(),
    guards: [featureFlagGuard("write_enabled", () => false, "Writes are disabled.")],
    handler: () => {
      handlerRan = true;
      return ok({});
    }
  });

  const registry = createToolRegistry([gated]);
  const result = await dispatchToolCall(registry, "gated_tool", {}, { logger });
  assert.equal(result.isError, true);
  assert.equal((JSON.parse(textOf(result)) as { code: string }).code, "policy_violation");
  assert.equal(handlerRan, false);
});

test("dispatch: a thrown handler becomes internal_error and never leaks the message", async () => {
  const throwing = defineTool({
    name: "throwing_tool",
    description: "Throws.",
    input: z.object({}).strict(),
    inputSchema: EMPTY_OBJECT_SCHEMA,
    annotations: annotations.read(),
    handler: () => {
      throw new Error("connection=super-secret");
    }
  });

  const registry = createToolRegistry([throwing]);
  const result = await dispatchToolCall(registry, "throwing_tool", {}, { logger });
  assert.equal(result.isError, true);
  const text = textOf(result);
  assert.equal((JSON.parse(text) as { code: string }).code, "internal_error");
  assert.equal(text.includes("super-secret"), false);
});

test("dispatch: a handler returning err is surfaced with its code", async () => {
  const failing = defineTool({
    name: "failing_tool",
    description: "Returns an error result.",
    input: z.object({}).strict(),
    inputSchema: EMPTY_OBJECT_SCHEMA,
    annotations: annotations.read(),
    handler: () => err(validationError("nope"))
  });
  const registry = createToolRegistry([failing]);
  const result = await dispatchToolCall(registry, "failing_tool", {}, { logger });
  assert.equal((JSON.parse(textOf(result)) as { code: string }).code, "validation_error");
});

test("dispatch: unmigrated names fall through to the legacy bridge", async () => {
  let called = "";
  const legacy: LegacyBridge = {
    listTools: () => [],
    has: (name) => name === "old_tool",
    call: async (name) => {
      called = name;
      return asText({ from: "legacy" }, "compact");
    }
  };
  const registry = createToolRegistry([echoTool], { legacy });
  const result = await dispatchToolCall(registry, "old_tool", {}, { logger });
  assert.equal(called, "old_tool");
  assert.deepEqual(JSON.parse(textOf(result)), { from: "legacy" });
});

test("dispatch: the profile argument selects the serialization", async () => {
  const registry = createToolRegistry([echoTool]);
  const compact = await dispatchToolCall(registry, "echo_value", { value: "x" }, { logger });
  const verbose = await dispatchToolCall(
    registry,
    "echo_value",
    { value: "x", profile: "verbose" },
    { logger }
  );
  assert.equal(textOf(compact).includes("\n"), false);
  assert.equal(textOf(verbose).includes("\n"), true);
});

test("dispatch: never rejects, even when error details are unserializable", async () => {
  // Regression: asError used raw JSON.stringify on caller-supplied `details`.
  // A BigInt threw out of dispatch, surfacing as a protocol failure rather
  // than a tool error.
  const bigintGuard = defineTool({
    name: "bigint_guard_tool",
    description: "Refused by a guard whose error details hold a BigInt.",
    input: z.object({}).strict(),
    inputSchema: EMPTY_OBJECT_SCHEMA,
    annotations: annotations.read(),
    guards: [{ name: "g", check: () => err(policyViolation("nope", { attempted: 5n })) }],
    handler: () => ok({})
  });

  const registry = createToolRegistry([bigintGuard]);
  const result = await dispatchToolCall(registry, "bigint_guard_tool", {}, { logger });
  assert.equal(result.isError, true);
  assert.equal((JSON.parse(textOf(result)) as { code: string }).code, "policy_violation");
});

test("dispatch: never rejects when error details contain a cycle", async () => {
  const cyclic: Record<string, unknown> = { name: "d" };
  cyclic["self"] = cyclic;
  const cyclicTool = defineTool({
    name: "cyclic_error_tool",
    description: "Returns an error whose details are cyclic.",
    input: z.object({}).strict(),
    inputSchema: EMPTY_OBJECT_SCHEMA,
    annotations: annotations.read(),
    handler: () => err(validationError("bad", cyclic))
  });
  const registry = createToolRegistry([cyclicTool]);
  const result = await dispatchToolCall(registry, "cyclic_error_tool", {}, { logger });
  assert.equal(result.isError, true);
});

test("dispatch: a throwing legacy bridge is reported, not propagated", async () => {
  const legacy: LegacyBridge = {
    listTools: () => [],
    has: (name) => name === "old_tool",
    call: async () => {
      throw new Error("legacy blew up");
    }
  };
  const registry = createToolRegistry([echoTool], { legacy });
  const result = await dispatchToolCall(registry, "old_tool", {}, { logger });
  assert.equal(result.isError, true);
});

// --- responses ------------------------------------------------------------

test("responses: only verbose pretty-prints; other profiles drop nullish", () => {
  assert.equal(serializePayload({ a: 1, b: null }, "compact"), '{"a":1}');
  assert.equal(serializePayload({ a: 1, b: null }, "verbose").includes("null"), true);
  const errorResult = asError(policyViolation("blocked"), "compact");
  assert.equal(errorResult.isError, true);
});

test("responses: path keys are normalized to forward slashes", () => {
  const text = serializePayload({ filePath: "src\\a\\b.ts" }, "compact", { pathKeys: ["filePath"] });
  assert.equal(text, '{"filePath":"src/a/b.ts"}');
});

// --- schema ---------------------------------------------------------------

test("schema: enumOf advertises the member type, including boolean", () => {
  assert.equal(schema.enumOf(["a", "b"]).type, "string");
  assert.equal(schema.enumOf([1, 2]).type, "number");
  assert.equal(schema.enumOf([true, false]).type, "boolean");
});

// --- guards ---------------------------------------------------------------

test("guards: run in order and stop at the first refusal", async () => {
  const seen: string[] = [];
  const first = featureFlagGuard("first", () => {
    seen.push("first");
    return true;
  }, "no");
  const second = featureFlagGuard("second", () => {
    seen.push("second");
    return false;
  }, "blocked");
  const third = featureFlagGuard("third", () => {
    seen.push("third");
    return true;
  }, "no");

  const outcome = await runGuards([first, second, third], {
    toolName: "t",
    input: {},
    ctx: makeCtx()
  });
  assert.equal(outcome.ok, false);
  assert.deepEqual(seen, ["first", "second"]);
});

test("guards: a throwing guard fails closed", async () => {
  const boom = { name: "boom", check: () => {
    throw new Error("guard exploded");
  } };
  const outcome = await runGuards([boom], { toolName: "t", input: {}, ctx: makeCtx() });
  assert.equal(outcome.ok, false);
});

test("guards: immutableTargetGuard blocks protected targets case-insensitively", async () => {
  const guard = immutableTargetGuard(
    "prod_readonly",
    (input) => (input as { env?: string }).env,
    ["prod"],
    "prod is read-only"
  );
  const blocked = await runGuards([guard], { toolName: "t", input: { env: "PROD" }, ctx: makeCtx() });
  const allowed = await runGuards([guard], { toolName: "t", input: { env: "dev" }, ctx: makeCtx() });
  assert.equal(blocked.ok, false);
  assert.equal(allowed.ok, true);
});

// --- health tool ----------------------------------------------------------

test("healthTool: reports ok without a probe", async () => {
  const tool = createHealthCheckTool({ serverName: "demo", version: "1.2.3" });
  const registry = createToolRegistry([tool]);
  const result = await dispatchToolCall(registry, "health_check", {}, { logger });
  const payload = JSON.parse(textOf(result)) as { status: string; server: string; version: string };
  assert.equal(payload.status, "ok");
  assert.equal(payload.server, "demo");
  assert.equal(payload.version, "1.2.3");
});

test("healthTool: a failing probe degrades instead of erroring", async () => {
  const tool = createHealthCheckTool({
    serverName: "demo",
    version: "1.0.0",
    probe: async () => err(validationError("upstream down"))
  });
  const registry = createToolRegistry([tool]);
  const result = await dispatchToolCall(registry, "health_check", {}, { logger });
  assert.equal(result.isError, undefined);
  assert.equal((JSON.parse(textOf(result)) as { status: string }).status, "degraded");
});

test("healthTool: a throwing probe still answers", async () => {
  const tool = createHealthCheckTool({
    serverName: "demo",
    version: "1.0.0",
    probe: async () => {
      throw new Error("socket closed");
    }
  });
  const registry = createToolRegistry([tool]);
  const result = await dispatchToolCall(registry, "health_check", {}, { logger });
  assert.equal((JSON.parse(textOf(result)) as { status: string }).status, "degraded");
});

// --- lifecycle ------------------------------------------------------------

test("lifecycle: hooks run once, in reverse order", async () => {
  const order: string[] = [];
  const lifecycle = createLifecycle(logger);
  lifecycle.onShutdown({ name: "a", run: () => void order.push("a") });
  lifecycle.onShutdown({ name: "b", run: () => void order.push("b") });

  await lifecycle.shutdown("test");
  await lifecycle.shutdown("test-again");

  assert.deepEqual(order, ["b", "a"]);
  assert.equal(lifecycle.isShuttingDown, true);
});

test("lifecycle: a failing hook does not stop the others", async () => {
  const order: string[] = [];
  const lifecycle = createLifecycle(logger);
  lifecycle.onShutdown({ name: "ok", run: () => void order.push("ok") });
  lifecycle.onShutdown({
    name: "bad",
    run: () => {
      throw new Error("hook failed");
    }
  });
  await lifecycle.shutdown("test");
  assert.deepEqual(order, ["ok"]);
});

// --- stdout protection ----------------------------------------------------

test("console: redirect sends console.log to stderr, not stdout", () => {
  const stdoutWrites: string[] = [];
  const stderrWrites: string[] = [];
  const originalOut = process.stdout.write.bind(process.stdout);
  const originalErr = process.stderr.write.bind(process.stderr);

  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    stdoutWrites.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    stderrWrites.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;

  const restore = redirectConsoleToStderr();
  try {
    console.log("this would corrupt the transport");
  } finally {
    restore();
    process.stdout.write = originalOut;
    process.stderr.write = originalErr;
  }

  assert.equal(stdoutWrites.length, 0);
  assert.equal(stderrWrites.some((line) => line.includes("corrupt the transport")), true);
});
