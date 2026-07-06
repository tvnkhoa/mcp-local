import test from "node:test";
import assert from "node:assert/strict";

import { normalizePayload } from "./responseFormatter.js";

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
