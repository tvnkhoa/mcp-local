import assert from "node:assert/strict";
import test from "node:test";

import { assertRequiredKeysAdvertised, assertSchemaParity } from "@mcp/testing";

import { buildTools } from "./index.js";
import type { CodebaseIndexDeps } from "./common.js";
import type { HandlerContext } from "./handlers/handlerContext.js";

/**
 * MCP-ISSUE-051 — the four one-line additions were the symptom; this is the deliverable.
 *
 * The comparison itself now lives in `@mcp/testing`, because four other servers needed the same
 * gate and had none. What stays here is this server's floor and the issue-specific check below.
 *
 * The helper takes no zod namespace. Passing one was the first design — ADR 0001 means this
 * server's `ZodObject` is not an instance of a hoisted package's class — but it does not work
 * here: `health_check` comes from `@mcp/sdk` carrying the hoisted zod while this server's own
 * tools carry its copy, so no single namespace matches the whole table. The helper discriminates
 * on `_def.typeName` instead. The floor below is what catches it if that ever stops working.
 */

const deps: CodebaseIndexDeps = {
  limits: { maxResultLimit: 500, maxDepth: 5, maxFilesPerRun: 50_000 },
  // Never invoked: this test reads declarations and calls no handler.
  buildContext: () => ({}) as HandlerContext
};

const tools = buildTools(deps);

test("every tool advertises exactly the parameters its zod schema accepts", () => {
  // The floor must equal the tool count, or the gate is slack by the difference. It sat at 40
  // against a 43-tool surface — carried forward unexamined from the inline version this replaced,
  // so three tools could have stopped being comparable with the test still green.
  assertSchemaParity(tools, { floor: 43 });
});

test("the four tools from MCP-ISSUE-051 advertise profile", () => {
  // Named explicitly, so deleting the general check above cannot quietly un-fix the filed issue.
  for (const name of ["get_symbol_detail", "find_symbol_at_line", "get_folder_summary", "find_entry_points"]) {
    const tool = tools.find((t) => t.name === name);
    assert.ok(tool, `${name} not found`);
    const props = (tool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
    assert.ok("profile" in props, `${name} still omits profile from tools/list`);
  }
});

test("a tool declaring additionalProperties:false advertises every required key", () => {
  assertRequiredKeysAdvertised(tools);
});
