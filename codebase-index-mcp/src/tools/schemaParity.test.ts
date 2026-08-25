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

/**
 * MCP-ISSUE-060 — every tool that can write to the working tree must say so, unconditionally.
 *
 * `refactor_symbol_migration` and `change_value_representation` were annotated `previewsChange`
 * (`readOnlyHint:true`, `destructiveHint:false`) on the reasoning that it described their DEFAULT
 * posture, `dryRun:true`. But MCP annotations are static per tool, not per argument: a single call
 * with `dryRun:false` reaches `applyPreviewExclusively` and then `fs.writeFileSync`, the same path
 * `refactor_replace_apply` takes — and a host trusting `readOnlyHint` to skip a confirmation prompt
 * had no way to see it coming.
 *
 * Pinned by name rather than derived, because the derivation ("does any code path from this handler
 * reach a write?") is exactly what a reader cannot check at a glance, and is what went wrong.
 */
test("every tool with a write path is annotated destructive, whatever its default arguments", () => {
  for (const name of [
    "refactor_replace_apply",
    "refactor_replace_rollback",
    "refactor_symbol_migration",
    "change_value_representation"
  ]) {
    const tool = tools.find((t) => t.name === name);
    assert.ok(tool, `${name} not found`);
    assert.equal(tool.annotations?.destructive, true, `${name} can write files but is not annotated destructive`);
    assert.equal(tool.annotations?.readOnly, false, `${name} can write files but advertises readOnly`);
  }
});

test("the genuine preview tools stay read-only, so the signal keeps meaning something", () => {
  for (const name of ["refactor_replace_preview", "rename_assist"]) {
    const tool = tools.find((t) => t.name === name);
    assert.ok(tool, `${name} not found`);
    assert.equal(tool.annotations?.readOnly, true, `${name} writes nothing and should say so`);
    assert.equal(tool.annotations?.destructive, false);
  }
});
