/**
 * The wire-error mapper.
 *
 * The reason this engine can exist at all is injection, so the first test is the
 * one that matters most: a class from a *different module instance* — the
 * situation ADR-0001 says every server is permanently in — must still be
 * classified, because the class the mapper matches on is the one it was handed.
 *
 * The rest pins the three real configurations branch by branch, including the two
 * empty-string cases where a naive engine would quietly change a published
 * envelope.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { PolicyViolationError } from "@mcp/core";

import { abortRule, createErrorMapper, stringProperty } from "./errorMapper.js";

/** Stand-in for a server's own `z.ZodError`: same shape, unrelated class object. */
class ZodErrorLookalike extends Error {
  readonly issues: { path: (string | number)[]; message: string }[];
  constructor(issues: { path: (string | number)[]; message: string }[]) {
    super("zod");
    this.issues = issues;
    this.name = "ZodError";
  }
}

/** A second, *independent* class with the identical shape and name. */
class RivalZodError extends Error {
  readonly issues: { path: (string | number)[]; message: string }[] = [];
  constructor() {
    super("zod");
    this.name = "ZodError";
  }
}

class HttpError extends Error {
  readonly code = "upstream_http_error";
  constructor(message: string, readonly detail?: string) {
    super(message);
  }
}

class McpErrorLookalike extends Error {}

// --- the injection contract ----------------------------------------------------

test("classification follows the INJECTED class, not the name — the ADR-0001 hazard", () => {
  const mapError = createErrorMapper({
    validation: { type: ZodErrorLookalike, message: "Invalid arguments.", rootLabel: "(root)" }
  });

  // The class it was handed: classified.
  assert.equal(mapError(new ZodErrorLookalike([{ path: ["a"], message: "required" }])).code, "validation_error");

  // A same-named, same-shaped class from elsewhere: NOT classified. That is the
  // whole point — matching on `.name` would have called this a validation error,
  // and any object could then claim to be one.
  assert.equal(mapError(new RivalZodError()).code, "internal_error");
});

// --- the shared branch order ---------------------------------------------------

test("validation issues are rendered into detail, with the caller's root label", () => {
  const mapError = createErrorMapper({
    validation: { type: ZodErrorLookalike, message: "Invalid arguments.", rootLabel: "(root)" }
  });
  assert.deepEqual(
    mapError(
      new ZodErrorLookalike([
        { path: ["limit"], message: "must be a number" },
        { path: [], message: "unrecognized keys" }
      ])
    ),
    {
      code: "validation_error",
      message: "Invalid arguments.",
      detail: "limit: must be a number; (root): unrecognized keys"
    }
  );
});

test("a coded class keeps its own code, and its detail only when it has one", () => {
  const mapError = createErrorMapper({ coded: [PolicyViolationError, HttpError] });

  assert.deepEqual(mapError(new PolicyViolationError("policy_violation", "prod is read-only.")), {
    code: "policy_violation",
    message: "prod is read-only."
  });
  assert.deepEqual(mapError(new HttpError("404 Not Found", "no such repo")), {
    code: "upstream_http_error",
    message: "404 Not Found",
    detail: "no such repo"
  });
});

test("an EMPTY detail is still forwarded — dropping it would rewrite an envelope", () => {
  const mapError = createErrorMapper({ coded: [HttpError] });
  assert.deepEqual(mapError(new HttpError("502 Bad Gateway", "")), {
    code: "upstream_http_error",
    message: "502 Bad Gateway",
    detail: ""
  });
});

test("coded classes are tried in the order given", () => {
  class Specific extends PolicyViolationError {}
  const policyFirst = createErrorMapper({ coded: [PolicyViolationError, Specific] });
  // Both match; the first wins, which is why declaration order is the contract.
  assert.equal(policyFirst(new Specific("policy_violation", "blocked.")).code, "policy_violation");
});

test("the protocol error reports the configured code and nothing else", () => {
  const mapError = createErrorMapper({ mcpError: McpErrorLookalike });
  assert.deepEqual(mapError(new McpErrorLookalike("MCP error -32601: Unknown tool")), {
    code: "mcp_error",
    message: "MCP error -32601: Unknown tool"
  });
  assert.equal(createErrorMapper({ mcpError: McpErrorLookalike, mcpErrorCode: "protocol" })(
    new McpErrorLookalike("x")
  ).code, "protocol");
});

test("rules run after the class branches, in order, and a decline falls through", () => {
  const order: string[] = [];
  const mapError = createErrorMapper({
    mcpError: McpErrorLookalike,
    rules: [
      (error) => {
        order.push("first");
        return stringProperty(error, "code") === "57014"
          ? { code: "timeout", message: "Query timed out by statement_timeout." }
          : undefined;
      },
      (error) => {
        order.push("second");
        const message = stringProperty(error, "message");
        return message ? { code: "internal_error", message: "Database query failed.", detail: message } : undefined;
      }
    ],
    fallback: () => ({ code: "internal_error", message: "Unexpected error." })
  });

  assert.deepEqual(mapError({ code: "57014", message: "canceling statement" }), {
    code: "timeout",
    message: "Query timed out by statement_timeout."
  });
  assert.deepEqual(order, ["first"]);

  assert.deepEqual(mapError(new Error("connection refused")), {
    code: "internal_error",
    message: "Database query failed.",
    detail: "connection refused"
  });

  // Both rules decline: an object with an empty message, which is why the second
  // rule tests truthiness rather than presence.
  assert.deepEqual(mapError({ message: "" }), { code: "internal_error", message: "Unexpected error." });
  // A thrown string is not an object, so no rule sees a property at all.
  assert.deepEqual(mapError("boom"), { code: "internal_error", message: "Unexpected error." });
});

test("the default fallback carries the thrown value's own message", () => {
  const mapError = createErrorMapper({});
  assert.deepEqual(mapError(new Error("handler exploded")), {
    code: "internal_error",
    message: "handler exploded"
  });
  assert.deepEqual(mapError(42), { code: "internal_error", message: "42" });
});

test("abortRule catches a name, not a class — AbortError is not one", () => {
  const abort = Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
  const mapError = createErrorMapper({ rules: [abortRule("Request to Bitbucket timed out.")] });
  assert.deepEqual(mapError(abort), { code: "timeout", message: "Request to Bitbucket timed out." });
  assert.equal(mapError(new Error("other")).code, "internal_error");
});

test("stringProperty reads only strings, and only off objects", () => {
  assert.equal(stringProperty({ code: "57014" }, "code"), "57014");
  assert.equal(stringProperty({ code: 57014 }, "code"), undefined);
  assert.equal(stringProperty(null, "code"), undefined);
  assert.equal(stringProperty("57014", "code"), undefined);
});
