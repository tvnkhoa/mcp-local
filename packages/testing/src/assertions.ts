/**
 * Assertions over tool invocations.
 *
 * Built on `node:assert` so they work under `node --test` with no test-runner
 * dependency — the platform has no test framework to standardise on beyond the
 * one Node ships.
 */

import assert from "node:assert/strict";

import type { ToolInvocation } from "./harness.js";

/** Assert the tool succeeded, and return its payload narrowed to T. */
export function assertToolOk<T>(invocation: ToolInvocation<T>, message?: string): T {
  assert.equal(
    invocation.isError,
    false,
    message ?? `expected tool success but got ${invocation.errorCode ?? "an error"}: ${invocation.text}`
  );
  return invocation.payload;
}

/** Assert the tool failed, optionally with a specific error code. */
export function assertToolError(invocation: ToolInvocation, expectedCode?: string, message?: string): void {
  assert.equal(invocation.isError, true, message ?? `expected an error but got: ${invocation.text}`);
  if (expectedCode !== undefined) {
    assert.equal(
      invocation.errorCode,
      expectedCode,
      message ?? `expected error code "${expectedCode}" but got "${invocation.errorCode ?? "none"}"`
    );
  }
}

/**
 * Assert a secret never appears in the serialized response.
 *
 * Every tool that touches credentials should have one of these.
 */
export function assertNoLeak(invocation: ToolInvocation, ...secrets: readonly string[]): void {
  for (const secret of secrets) {
    if (secret === "") {
      continue;
    }
    assert.equal(
      invocation.text.includes(secret),
      false,
      `response leaked a secret value (${secret.slice(0, 3)}…)`
    );
    const logged = JSON.stringify(invocation.logs.records);
    assert.equal(logged.includes(secret), false, `logs leaked a secret value (${secret.slice(0, 3)}…)`);
  }
}

/** Assert the response is minified (any profile except verbose). */
export function assertMinified(invocation: ToolInvocation): void {
  assert.equal(invocation.text.includes("\n"), false, "expected a minified response");
}

/** Assert every path-like string in the response uses forward slashes. */
export function assertPosixPaths(invocation: ToolInvocation): void {
  assert.equal(
    /"[A-Za-z]:\\\\|\\\\\\\\/.test(invocation.text),
    false,
    "response contains Windows-style path separators"
  );
}
