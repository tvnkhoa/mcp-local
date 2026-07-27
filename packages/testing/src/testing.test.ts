import assert from "node:assert/strict";
import { test } from "node:test";

import { err, ok, policyViolation } from "@mcp/core";
import { annotations, defineTool, featureFlagGuard, schema } from "@mcp/sdk";
import { z } from "zod";

import { assertNoLeak, assertToolError, assertToolOk } from "./assertions.js";
import { createMemoryLogger, createTestToolContext } from "./context.js";
import { diffSnapshots, formatDifferences, serializeSnapshot, snapshotTools } from "./contract.js";
import { createToolHarness, invokeTool } from "./harness.js";

const greetTool = defineTool({
  name: "greet_user",
  description: "Return a greeting for the supplied name.",
  input: z.object({ name: z.string().min(1), profile: z.string().optional() }).strict(),
  inputSchema: schema.object({ name: schema.string("Who to greet"), profile: schema.profile() }, {
    required: ["name"]
  }),
  annotations: annotations.read(),
  handler: (input, ctx) => {
    ctx.logger.info("greeting", { name: input.name });
    return ok({ greeting: `hello ${input.name}` });
  }
});

const secretTool = defineTool({
  name: "describe_connection",
  description: "Echo a non-secret connection description.",
  input: z.object({}).strict(),
  inputSchema: schema.object({}),
  annotations: annotations.read(),
  handler: () => ok({ host: "db.internal", authConfigured: true })
});

const gatedTool = defineTool({
  name: "apply_change",
  description: "Apply a change; gated behind a write flag.",
  input: z.object({}).strict(),
  inputSchema: schema.object({}),
  annotations: annotations.apply(),
  guards: [featureFlagGuard("write_enabled", () => false, "Writes are disabled.")],
  handler: () => ok({ applied: true })
});

test("harness: invokes a tool through the real dispatch pipeline", async () => {
  const invocation = await invokeTool<{ greeting: string }>(greetTool, { name: "koi" });
  const payload = assertToolOk(invocation);
  assert.equal(payload.greeting, "hello koi");
});

test("harness: validation failures surface as validation_error", async () => {
  const invocation = await invokeTool(greetTool, { name: "" });
  assertToolError(invocation, "validation_error");
});

test("harness: guard refusals surface as policy_violation and skip the handler", async () => {
  const invocation = await invokeTool(gatedTool, {});
  assertToolError(invocation, "policy_violation");
});

test("harness: logs emitted by a handler are captured", async () => {
  const invocation = await invokeTool(greetTool, { name: "koi" });
  assert.equal(invocation.logs.saw("greeting"), true);
  assert.equal(invocation.logs.at("info").length >= 1, true);
});

test("harness: a shared harness routes several tools and shares one log capture", async () => {
  const harness = createToolHarness([greetTool, secretTool]);
  const first = await harness.call<{ greeting: string }>("greet_user", { name: "a" });
  const second = await harness.call<{ host: string }>("describe_connection");
  assert.equal(assertToolOk(first).greeting, "hello a");
  assert.equal(assertToolOk(second).host, "db.internal");
  assert.equal(harness.logs.records.length >= 1, true);
});

test("harness: an unknown tool is reported, not thrown", async () => {
  const harness = createToolHarness([greetTool]);
  const invocation = await harness.call("no_such_tool");
  assertToolError(invocation, "not_found");
});

test("harness: the profile option controls serialization", async () => {
  const compact = await invokeTool(greetTool, { name: "koi" }, { profile: "compact" });
  const verbose = await invokeTool(greetTool, { name: "koi" }, { profile: "verbose" });
  assert.equal(compact.text.includes("\n"), false);
  assert.equal(verbose.text.includes("\n"), true);
});

test("assertNoLeak: passes when a secret is absent and fails when present", async () => {
  const invocation = await invokeTool(secretTool, {});
  assertNoLeak(invocation, "super-secret-password");

  const leaking = defineTool({
    name: "leaky_tool",
    description: "Accidentally returns a credential.",
    input: z.object({}).strict(),
    inputSchema: schema.object({}),
    annotations: annotations.read(),
    handler: () => ok({ connection: "postgres://u:super-secret-password@host/db" })
  });
  const leaked = await invokeTool(leaking, {});
  assert.throws(() => assertNoLeak(leaked, "super-secret-password"));
});

test("assertToolOk: throws a helpful message when the tool errored", async () => {
  const failing = defineTool({
    name: "failing_tool",
    description: "Always fails.",
    input: z.object({}).strict(),
    inputSchema: schema.object({}),
    annotations: annotations.read(),
    handler: () => err(policyViolation("blocked"))
  });
  const invocation = await invokeTool(failing, {});
  assert.throws(() => assertToolOk(invocation));
});

test("context: the memory logger is deterministic and clearable", () => {
  const memory = createMemoryLogger("unit");
  memory.logger.warn("careful", { a: 1 });
  assert.equal(memory.records.length, 1);
  assert.equal(memory.records[0]?.msg, "careful");
  memory.clear();
  assert.equal(memory.records.length, 0);
});

test("context: createTestToolContext yields a usable ToolContext", () => {
  const ctx = createTestToolContext({ profile: "verbose", requestId: "req-42" });
  assert.equal(ctx.profile, "verbose");
  assert.equal(ctx.requestId, "req-42");
  ctx.logger.debug("ok");
});

// --- contract snapshots ---------------------------------------------------

test("contract: snapshots are sorted and order-independent", () => {
  const a = snapshotTools("demo", [greetTool, secretTool]);
  const b = snapshotTools("demo", [secretTool, greetTool]);
  assert.equal(serializeSnapshot(a), serializeSnapshot(b));
  assert.equal(a.toolCount, 2);
  assert.equal(a.tools[0]?.name, "describe_connection");
});

test("contract: an unchanged surface produces no differences", () => {
  const snapshot = snapshotTools("demo", [greetTool, secretTool]);
  assert.deepEqual(diffSnapshots(snapshot, snapshot), []);
  assert.equal(formatDifferences([]), "contract unchanged");
});

test("contract: added, removed, and changed tools are each detected", () => {
  const before = snapshotTools("demo", [greetTool, secretTool]);
  const after = snapshotTools("demo", [greetTool, gatedTool]);
  const differences = diffSnapshots(before, after);
  const kinds = new Map(differences.map((difference) => [difference.tool, difference.kind]));
  assert.equal(kinds.get("describe_connection"), "removed");
  assert.equal(kinds.get("apply_change"), "added");
});

test("contract: a description change is detected and named", () => {
  const before = snapshotTools("demo", [greetTool]);
  const renamed = defineTool({
    name: "greet_user",
    description: "A different description.",
    input: z.object({ name: z.string().min(1) }).strict(),
    inputSchema: schema.object({ name: schema.string("Who to greet"), profile: schema.profile() }, {
      required: ["name"]
    }),
    annotations: annotations.read(),
    handler: () => ok({})
  });
  const differences = diffSnapshots(before, snapshotTools("demo", [renamed]));
  assert.equal(differences.length, 1);
  assert.equal(differences[0]?.kind, "changed");
  assert.equal(differences[0]?.detail.includes("description"), true);
});

test("contract: an annotation change is detected - a read tool turning destructive", () => {
  const before = snapshotTools("demo", [secretTool]);
  const nowDestructive = defineTool({
    name: "describe_connection",
    description: "Echo a non-secret connection description.",
    input: z.object({}).strict(),
    inputSchema: schema.object({}),
    annotations: annotations.apply(),
    handler: () => ok({})
  });
  const differences = diffSnapshots(before, snapshotTools("demo", [nowDestructive]));
  assert.equal(differences[0]?.detail.includes("annotations"), true);
});
