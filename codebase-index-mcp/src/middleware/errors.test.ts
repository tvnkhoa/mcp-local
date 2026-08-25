import assert from "node:assert/strict";
import test from "node:test";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { mapError } from "./errors.js";

/**
 * MCP-ISSUE-060 — the tool name appeared twice in every error a handler raised itself.
 *
 * `mapError` prefixes `${toolName}: ` on every branch, and the house idiom in ~37 handlers is to
 * build the message the same way. `McpError`'s own constructor then wedges the transport framing
 * between them, so a live response read:
 *
 *   "search_regex: MCP error -32602: search_regex: invalid regex pattern: ..."
 *
 * The envelope contract is that the message STARTS with the tool name; the second copy is noise that
 * makes an error harder to read at exactly the moment a reader is already off balance.
 */

test("a message that already names the tool is not prefixed a second time", () => {
  const mapped = mapError(
    new McpError(ErrorCode.InvalidParams, "search_regex: invalid regex pattern: Unterminated group"),
    "search_regex"
  );
  assert.equal(mapped.message.startsWith("search_regex:"), true);
  assert.equal(
    mapped.message.indexOf("search_regex:"),
    mapped.message.lastIndexOf("search_regex:"),
    `tool name appears twice: ${mapped.message}`
  );
});

test("a message that does not name the tool still gets the prefix — the envelope contract", () => {
  const mapped = mapError(new Error("something went wrong"), "get_call_chain");
  assert.equal(mapped.message, "get_call_chain: something went wrong");
  assert.equal(mapped.code, "INTERNAL_ERROR");
});

test("a zod failure keeps its VALIDATION_ERROR code and is prefixed once", () => {
  const schema = z.object({ limit: z.number() });
  const parsed = schema.safeParse({ limit: "ten" });
  assert.equal(parsed.success, false);

  const mapped = mapError(parsed.error, "search_symbols");
  assert.equal(mapped.code, "VALIDATION_ERROR");
  assert.equal(mapped.message.startsWith("search_symbols:"), true);
  assert.equal(mapped.message.indexOf("search_symbols:"), mapped.message.lastIndexOf("search_symbols:"));
});

test("a tool whose name is a prefix of another tool's is not confused for it", () => {
  // `get_file_summary` starts with `get_file`, but the guard tests for the colon, so a message from
  // one tool cannot suppress the prefix of another.
  const mapped = mapError(new Error("get_file_summary: boom"), "get_file");
  assert.equal(mapped.message, "get_file: get_file_summary: boom");
});

test("every error carries a fresh requestId", () => {
  const a = mapError(new Error("x"), "t");
  const b = mapError(new Error("x"), "t");
  assert.notEqual(a.requestId, b.requestId);
});
