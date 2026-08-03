import assert from "node:assert/strict";
import test from "node:test";

import { buildTools } from "./tools.js";
import type { __PASCAL__Config } from "./config/index.js";

const config: __PASCAL__Config = { baseUrl: "https://example.invalid", timeoutMs: 1000 };

/**
 * Tools are pinned here rather than only in `contracts/__KEY__.json`.
 *
 * The snapshot covers `tools/list` — names, descriptions, schemas. It cannot see what a *call*
 * returns, so a refactor can keep the advertised contract byte-identical while changing every
 * response. These tests are that second net.
 */

test("every tool is snake_case and declares annotations", () => {
  for (const tool of buildTools(config)) {
    assert.match(tool.name, /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/, `${tool.name} is not snake_case`);
    assert.equal(typeof tool.annotations.readOnly, "boolean");
    assert.equal(typeof tool.annotations.idempotent, "boolean");
    assert.equal(typeof tool.annotations.destructive, "boolean");
    assert.notEqual(tool.description.trim(), "", `${tool.name} has an empty description`);
  }
});

test("health_check is present, as every server must have it", () => {
  const names = buildTools(config).map((t) => t.name);
  assert.ok(names.includes("health_check"), `health_check missing; got ${names.join(", ")}`);
});

test("echo returns the message it was given", async () => {
  const echo = buildTools(config).find((t) => t.name === "echo");
  assert.ok(echo, "echo tool missing");

  const result = await echo.handler({ message: "hello" }, { profile: "compact" } as never);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.value, { message: "hello", server: "__KEY__" });
  }
});

test("echo rejects an empty message rather than coercing it", () => {
  const echo = buildTools(config).find((t) => t.name === "echo");
  assert.ok(echo);
  // The zod schema is the runtime contract; `inputSchema` is only what clients are told.
  assert.equal(echo.input.safeParse({ message: "" }).success, false);
  assert.equal(echo.input.safeParse({ message: "ok", extra: 1 }).success, false);
});
