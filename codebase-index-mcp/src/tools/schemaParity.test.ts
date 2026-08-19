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
 * **`z` is passed in, and that is load-bearing.** Per ADR 0001 this server owns its own copy of
 * zod, so a `ZodObject` it builds is not an instance of the class a hoisted package imports —
 * `instanceof` is false across the copies. The helper never imports zod for exactly that reason;
 * handing it the wrong one makes it compare nothing, which its floor is there to catch.
 */

const deps: CodebaseIndexDeps = {
  limits: { maxResultLimit: 500, maxDepth: 5, maxFilesPerRun: 50_000 },
  // Never invoked: this test reads declarations and calls no handler.
  buildContext: () => ({}) as HandlerContext
};

const tools = buildTools(deps);

test("every tool advertises exactly the parameters its zod schema accepts", () => {
  assertSchemaParity(tools, { floor: 40 });
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
