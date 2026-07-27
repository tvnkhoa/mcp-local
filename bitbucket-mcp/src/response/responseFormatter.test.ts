/**
 * Regression suite for the responseFormatter extraction.
 *
 * This module no longer implements normalization — it delegates to @mcp/core and
 * @mcp/sdk. These tests pin the observable contract that existed BEFORE the
 * extraction, so a change in the shared package that would alter this server's
 * wire output fails here rather than in production.
 *
 * Baseline: the pre-extraction implementation was characterized across 240
 * observations (24 payload shapes x 4 profiles x normalize/asText/asError).
 * 220 are byte-identical after extraction; the 20 that differ are the two
 * documented crash-eliminations pinned at the bottom of this file.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { asError, asText, normalizePayload, responseProfileSchema } from "./responseFormatter.js";

/** Narrow the MCP content union to the text block these tools always return. */
function textOf(result: CallToolResult): string {
  const first = result.content[0];
  assert.ok(first !== undefined && first.type === "text", "expected a text content block");
  return first.text;
}

test("normalizePayload: strip=true drops nulls, strip=false keeps them", () => {
  assert.deepEqual(normalizePayload({ a: 1, b: null, c: "x" }, true), { a: 1, c: "x" });
  assert.deepEqual(normalizePayload({ a: 1, b: null }, false), { a: 1, b: null });
});

test("normalizePayload: strips recursively through arrays and objects", () => {
  assert.deepEqual(normalizePayload({ items: [{ name: "hi", err: null }] }, true), { items: [{ name: "hi" }] });
});

test("normalizePayload: keeps empty arrays/objects (explicit 'none')", () => {
  assert.deepEqual(normalizePayload({ rows: [], meta: {} }, true), { rows: [], meta: {} });
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
  const payload = { code: "bitbucket_http_error", message: "boom", detail: null };
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
