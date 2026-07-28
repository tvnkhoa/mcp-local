/**
 * Regression tests for the two server-owned extension points the SDK grew during migration:
 * the response formatter (S-22) and `formatError` (S-23).
 *
 * Split out of sdk.test.ts when that file crossed the 600-line hard cap. Kept together because
 * both pin the same property from opposite ends — a server adopting the SDK must be able to keep
 * its existing success *and* error envelopes byte-for-byte, or migration is a contract change.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { createNullLogger } from "@mcp/core";
import { z } from "zod";

import { annotations, defineTool } from "./defineTool.js";
import { dispatchToolCall } from "./dispatch.js";
import { createToolRegistry } from "./registry.js";
import { asErrorPayload, asText } from "./responses.js";
import { schema } from "./schema.js";

const logger = createNullLogger("test");

// --- Regression: server responseFormatter extraction --------------------------
// These lock the contract that postgres-mcp, observe-mcp and bitbucket-mcp now
// delegate to. Their previous local copies were behaviourally identical to each
// other (verified: 0 divergences across 720 observations), so one suite covers
// all three.

test("responses: asErrorPayload wraps a caller-shaped payload and flags isError", () => {
  const result = asErrorPayload({ code: "validation_error", message: "bad", detail: null }, "compact");
  assert.equal(result.isError, true);
  assert.equal(result.content.length, 1);
  assert.equal(result.content[0]?.type, "text");
  // compact drops nullish
  assert.equal(result.content[0]?.text, '{"code":"validation_error","message":"bad"}');
});

test("responses: only verbose is pretty-printed; only nano/compact strip nullish", () => {
  const payload = { a: 1, b: null };
  assert.equal(asText(payload, "nano").content[0]?.text, '{"a":1}');
  assert.equal(asText(payload, "compact").content[0]?.text, '{"a":1}');
  assert.equal(asText(payload, "standard").content[0]?.text, '{"a":1,"b":null}');
  assert.equal(asText(payload, "verbose").content[0]?.text, JSON.stringify({ a: 1, b: null }, null, 2));
});

test("responses: payloads that used to crash the servers now serialize", () => {
  const cyclic: Record<string, unknown> = { name: "root" };
  cyclic["self"] = cyclic;
  assert.equal(asText(cyclic, "compact").content[0]?.text, '{"name":"root","self":"[circular]"}');
  assert.equal(asText({ n: 10n }, "compact").content[0]?.text, '{"n":"10"}');
  // asErrorPayload must be at least as robust — it is the failure-reporting path.
  assert.equal(asErrorPayload(cyclic, "compact").isError, true);
  assert.equal(asErrorPayload({ n: 10n }, "compact").isError, true);
});

test("responses: structures the servers rely on are preserved exactly", () => {
  assert.equal(asText({ when: new Date("2026-01-01T00:00:00.000Z") }, "compact").content[0]?.text,
    '{"when":"2026-01-01T00:00:00.000Z"}');
  // Empty array/object carry "explicitly none" meaning and must not be dropped.
  assert.equal(asText({ rows: [], meta: {} }, "compact").content[0]?.text, '{"rows":[],"meta":{}}');
  // Array holes/undefined become null rather than reindexing the array.
  assert.equal(asText({ rows: [1, undefined, 3] }, "compact").content[0]?.text, '{"rows":[1,null,3]}');
  // Backslashes are left alone unless the caller opts into pathKeys. Built from
  // a char code so the assertion cannot drift on escaping alone.
  const backslash = String.fromCharCode(92);
  const windowsPath = `D:${backslash}src`;
  assert.equal(asText({ p: windowsPath }, "compact").content[0]?.text, JSON.stringify({ p: windowsPath }));
});

// --- Regression: formatError, the server-owned error envelope (S-23) ---------
// Without this hook, adopting the SDK silently rewrites every error response a
// server's clients already depend on — a change tools/list cannot reveal.

const failingTool = defineTool({
  name: "boom",
  description: "Throws a domain error.",
  input: z.object({ id: z.number().int().positive() }).strict(),
  inputSchema: schema.object({ id: schema.integer(undefined, { minimum: 1 }) }, { required: ["id"] }),
  annotations: annotations.read(),
  handler: () => {
    const error = new Error("domain failure");
    error.name = "DomainError";
    throw error;
  }
});

/** A stand-in for a server's own mapper: a shape PlatformError never produces. */
const serverEnvelope = (error: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify({ mine: true, kind: (error as Error)?.name ?? typeof error }) }],
  isError: true
});

test("dispatch: formatError owns the envelope for a handler throw", () => {
  const registry = createToolRegistry([failingTool]);
  return dispatchToolCall(registry, "boom", { id: 1 }, { logger, formatError: serverEnvelope }).then((result) => {
    assert.equal(result.isError, true);
    assert.deepEqual(JSON.parse(result.content[0]?.text ?? "{}"), { mine: true, kind: "DomainError" });
  });
});

test("dispatch: formatError receives the raw ZodError on a validation failure", async () => {
  const registry = createToolRegistry([failingTool]);
  let seen: unknown;
  const result = await dispatchToolCall(registry, "boom", { id: "nope" }, {
    logger,
    formatError: (error) => {
      seen = error;
      return serverEnvelope(error);
    }
  });
  assert.equal(result.isError, true);
  // The issues array is what a server's own zod renderer needs — not a summary.
  const issues = (seen as { issues?: unknown[] }).issues;
  assert.ok(Array.isArray(issues) && issues.length > 0, "expected the ZodError itself");
});

test("dispatch: formatError also covers unknown tools", async () => {
  const registry = createToolRegistry([failingTool]);
  const result = await dispatchToolCall(registry, "nope", {}, { logger, formatError: serverEnvelope });
  assert.equal(result.isError, true);
  assert.equal(JSON.parse(result.content[0]?.text ?? "{}").mine, true);
});

test("dispatch: a formatError that throws degrades instead of rejecting", async () => {
  const registry = createToolRegistry([failingTool]);
  const result = await dispatchToolCall(registry, "boom", { id: 1 }, {
    logger,
    formatError: () => {
      throw new Error("mapper is broken");
    }
  });
  // Still a well-formed tool error, not a protocol-level rejection.
  assert.equal(result.isError, true);
  assert.equal(typeof result.content[0]?.text, "string");
  assert.equal(JSON.parse(result.content[0]?.text ?? "{}").code, "internal_error");
});

test("dispatch: omitting formatError keeps the platform envelope unchanged", async () => {
  const registry = createToolRegistry([failingTool]);
  const result = await dispatchToolCall(registry, "boom", { id: 1 }, { logger });
  assert.equal(result.isError, true);
  const payload = JSON.parse(result.content[0]?.text ?? "{}");
  assert.equal(payload.code, "internal_error");
  assert.equal(typeof payload.audience, "string");
});
