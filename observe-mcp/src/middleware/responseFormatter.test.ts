import test from "node:test";
import assert from "node:assert/strict";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { asError, asText, normalizePayload, responseProfileSchema } from "./responseFormatter.js";

/** Narrow the MCP content union to the text block these tools always return. */
function textOf(result: CallToolResult): string {
  const first = result.content[0];
  assert.ok(first !== undefined && first.type === "text", "expected a text content block");
  return first.text;
}

test("normalizePayload strips null fields when strip=true", () => {
  const out = normalizePayload({ a: 1, b: null, c: "x" }, true);
  assert.deepEqual(out, { a: 1, c: "x" });
});

test("normalizePayload keeps null fields when strip=false", () => {
  const out = normalizePayload({ a: 1, b: null }, false);
  assert.deepEqual(out, { a: 1, b: null });
});

test("normalizePayload strips nulls recursively inside arrays and objects", () => {
  const out = normalizePayload({ logs: [{ message: "hi", exception: null }] }, true);
  assert.deepEqual(out, { logs: [{ message: "hi" }] });
});

test("normalizePayload keeps empty arrays/objects (explicit 'none')", () => {
  const out = normalizePayload({ buckets: [], meta: {} }, true);
  assert.deepEqual(out, { buckets: [], meta: {} });
});

test("normalizePayload: Date survives as an ISO string", () => {
  assert.deepEqual(normalizePayload({ when: new Date("2026-01-01T00:00:00.000Z") }, true), {
    when: "2026-01-01T00:00:00.000Z"
  });
});

test("asText: only verbose is pretty-printed", () => {
  const payload = { a: 1, b: null };
  assert.equal(textOf(asText(payload, "nano")), '{"a":1}');
  assert.equal(textOf(asText(payload, "compact")), '{"a":1}');
  // standard keeps nulls but stays minified — the profile between compact and verbose.
  assert.equal(textOf(asText(payload, "standard")), '{"a":1,"b":null}');
  assert.equal(textOf(asText(payload, "verbose")), JSON.stringify({ a: 1, b: null }, null, 2));
});

test("asText: defaults to the compact profile", () => {
  assert.equal(textOf(asText({ a: 1, b: null })), '{"a":1}');
});

test("asError: same serialization as asText but flagged isError", () => {
  const payload = { code: "observe_http_error", message: "boom", detail: null };
  const ok = asText(payload, "compact");
  const bad = asError(payload, "compact");
  assert.equal(bad.isError, true);
  assert.equal(ok.isError, undefined);
  assert.equal(textOf(bad), textOf(ok));
});

test("responseProfileSchema: accepts exactly the four profiles", () => {
  for (const profile of ["nano", "compact", "standard", "verbose"]) {
    assert.equal(responseProfileSchema.parse(profile), profile);
  }
  assert.equal(responseProfileSchema.safeParse("chatty").success, false);
});

// --- The two documented behaviour deltas -------------------------------------
// Before extraction these threw out of the serializer. Every other input in the
// 240-observation corpus produces byte-identical output.

test("DELTA: a cyclic payload renders instead of throwing RangeError", () => {
  const cyclic: Record<string, unknown> = { name: "root" };
  cyclic["self"] = cyclic;
  assert.equal(textOf(asText(cyclic, "compact")), '{"name":"root","self":"[circular]"}');
  assert.equal(asError(cyclic, "compact").isError, true);
});

test("DELTA: a BigInt renders instead of throwing TypeError", () => {
  assert.equal(textOf(asText({ n: 10n }, "compact")), '{"n":"10"}');
});

test("a repeated (non-cyclic) reference is not mistaken for a cycle", () => {
  // Guards the shared-reference bug class: two fields pointing at one object are
  // not a cycle and must both render in full.
  const node = { id: "n1", name: "foo" };
  assert.deepEqual(normalizePayload({ edges: [{ from: node }], nodes: [node] }, true), {
    edges: [{ from: { id: "n1", name: "foo" } }],
    nodes: [{ id: "n1", name: "foo" }]
  });
});
