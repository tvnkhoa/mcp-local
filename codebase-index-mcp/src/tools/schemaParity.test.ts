import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";

import { buildTools } from "./index.js";
import type { CodebaseIndexDeps } from "./common.js";
import type { HandlerContext } from "./handlers/handlerContext.js";

/**
 * MCP-ISSUE-051 — the four one-line additions were the symptom; this is the deliverable.
 *
 * Every tool declares its input **twice**: a zod schema (what the handler validates against) and a
 * hand-written JSON Schema (what `tools/list` advertises, with `additionalProperties: false`). When
 * the two disagree, the same call is valid or invalid depending on how strictly the caller reads the
 * contract — and nothing caught it. `typecheck` sees two unrelated object literals. `contracts:check`
 * pins the advertised schema against a snapshot of *itself*, so a parameter missing from both stays
 * missing. `docs:check` reads the advertised side only. Six tools carried this drift before anyone
 * looked, and they were found by hand while editing something else.
 *
 * The parity is asserted in both directions, because each failure means something different:
 * an advertised key with no zod key is a parameter the server will reject as unknown; a zod key with
 * no advertised key is a parameter a conformant client cannot send.
 */

const deps: CodebaseIndexDeps = {
  limits: { maxResultLimit: 500, maxDepth: 5, maxFilesPerRun: 50_000 },
  // Never invoked: this test reads declarations and calls no handler.
  buildContext: () => ({}) as HandlerContext
};

/** Unwrap the modifiers a tool schema may be built with to reach the object at the centre. */
function objectShape(schema: unknown): Record<string, unknown> | null {
  let node: unknown = schema;
  for (let i = 0; i < 10 && node; i++) {
    if (node instanceof z.ZodObject) return node.shape as Record<string, unknown>;
    if (node instanceof z.ZodEffects) { node = node.innerType(); continue; }
    if (node instanceof z.ZodOptional || node instanceof z.ZodNullable || node instanceof z.ZodDefault) {
      node = (node as z.ZodOptional<z.ZodTypeAny>).unwrap();
      continue;
    }
    return null;
  }
  return null;
}

const tools = buildTools(deps);

test("every tool advertises exactly the parameters its zod schema accepts", () => {
  assert.ok(tools.length > 0, "buildTools returned nothing");

  const drift: string[] = [];
  let compared = 0;

  for (const tool of tools) {
    const shape = objectShape(tool.input);
    const advertised = (tool.inputSchema as { properties?: Record<string, unknown> })?.properties;
    if (!shape || !advertised) continue; // not an object-shaped contract; nothing to compare
    compared += 1;

    const zodKeys = new Set(Object.keys(shape));
    const jsonKeys = new Set(Object.keys(advertised));

    for (const key of zodKeys) {
      if (!jsonKeys.has(key)) drift.push(`${tool.name}: accepts "${key}" but never advertises it`);
    }
    for (const key of jsonKeys) {
      if (!zodKeys.has(key)) drift.push(`${tool.name}: advertises "${key}" but the handler rejects it`);
    }
  }

  assert.ok(compared >= 40, `expected to compare the whole tool surface, compared ${compared}`);
  assert.deepEqual(drift, [], `input-schema drift:\n  ${drift.join("\n  ")}`);
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
  // A required key absent from `properties` is unsatisfiable: the caller must send it and must not.
  for (const tool of tools) {
    const schema = tool.inputSchema as {
      properties?: Record<string, unknown>;
      required?: string[];
      additionalProperties?: boolean;
    };
    if (schema?.additionalProperties !== false) continue;
    for (const key of schema.required ?? []) {
      assert.ok(key in (schema.properties ?? {}), `${tool.name}: "${key}" is required but not advertised`);
    }
  }
});
