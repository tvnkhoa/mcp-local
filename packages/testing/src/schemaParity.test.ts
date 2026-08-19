import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";

import {
  assertRequiredKeysAdvertised,
  assertSchemaParity,
  findSchemaParityDrift,
  type ParityTool
} from "./schemaParity.js";

/**
 * The helper's own tests. The interesting one is the last: a wrong zod namespace must fail loudly
 * rather than report a clean surface it never looked at.
 */

function tool(name: string, input: unknown, properties: Record<string, unknown>): ParityTool {
  return { name, input, inputSchema: { type: "object", additionalProperties: false, properties } };
}

const matched = tool("matched", z.object({ a: z.string(), b: z.number().optional() }).strict(), {
  a: { type: "string" },
  b: { type: "number" }
});

test("a tool whose two declarations agree reports no drift", () => {
  const { drift, compared } = findSchemaParityDrift([matched], { floor: 1 });
  assert.deepEqual(drift, []);
  assert.equal(compared, 1);
});

test("both directions are reported, and they say different things", () => {
  const unadvertised = tool("unadvertised", z.object({ a: z.string(), secret: z.string() }), {
    a: { type: "string" }
  });
  const unaccepted = tool("unaccepted", z.object({ a: z.string() }), {
    a: { type: "string" },
    ghost: { type: "string" }
  });
  const { drift } = findSchemaParityDrift([unadvertised, unaccepted], { floor: 2 });
  assert.deepEqual(drift, [
    'unadvertised: accepts "secret" but never advertises it',
    'unaccepted: advertises "ghost" but the handler rejects it'
  ]);
});

test("the modifiers a schema may be wrapped in are unwrapped", () => {
  const base = { a: { type: "string" } };
  const wrapped: ParityTool[] = [
    tool("optional", z.object({ a: z.string() }).optional(), base),
    tool("nullable", z.object({ a: z.string() }).nullable(), base),
    tool("default", z.object({ a: z.string() }).default({ a: "x" }), base),
    tool("effects", z.object({ a: z.string() }).refine(() => true), base)
  ];
  const { drift, compared } = findSchemaParityDrift(wrapped, { floor: 4 });
  assert.deepEqual(drift, []);
  assert.equal(compared, 4, "every wrapper shape must be reachable");
});

test("a non-object input is skipped, not failed", () => {
  const union = tool("union", z.union([z.object({ a: z.string() }), z.string()]), {
    a: { type: "string" }
  });
  const { drift, compared } = findSchemaParityDrift([union], { floor: 0 });
  assert.deepEqual(drift, []);
  assert.equal(compared, 0, "skipped rather than compared — this is what `floor` guards");
});

test("the floor fails when the surface stops being compared", () => {
  assert.throws(
    () => assertSchemaParity([matched], { floor: 5 }),
    /expected to compare at least 5 tools, compared 1/
  );
});

test("a node from a different copy of zod is still compared", () => {
  // The scenario that killed the injected-namespace design: one tool table mixes copies, because
  // `health_check` is built by @mcp/sdk with the hoisted zod while a server's own tools use its
  // own. `instanceof` says false for one of them; the structural walk must not care.
  const foreignCopy = {
    _def: { typeName: "ZodObject" },
    shape: { a: z.string(), b: z.number() }
  };
  const { drift, compared } = findSchemaParityDrift(
    [tool("fromAnotherCopy", foreignCopy, { a: { type: "string" }, b: { type: "number" } })],
    { floor: 1 }
  );
  assert.equal(compared, 1, "a foreign-copy node must still be walked");
  assert.deepEqual(drift, []);
});

test("an unrecognisable node fails the floor with the cause named", () => {
  // If a zod upgrade renames `_def.typeName`, every tool drops out at once. That must read as a
  // broken walk, not as a clean surface.
  assert.throws(
    () => assertSchemaParity([tool("alien", { _def: { typeName: "ZodSomethingNew" } }, { a: {} })], { floor: 1 }),
    /`_def\.typeName` changed shape in a zod upgrade\. Fix `objectShape`; do not lower the floor/
  );
});

test("a required key that is not advertised is unsatisfiable and fails", () => {
  const broken: ParityTool = {
    name: "broken",
    input: z.object({ a: z.string() }),
    inputSchema: { additionalProperties: false, required: ["a", "missing"], properties: { a: {} } }
  };
  assert.throws(() => assertRequiredKeysAdvertised([broken]), /"missing" is required but not advertised/);
  assertRequiredKeysAdvertised([matched]);
});

test("an empty tool list is a mistake, not a pass", () => {
  assert.throws(() => assertSchemaParity([], { floor: 0 }), /no tools were passed/);
});
