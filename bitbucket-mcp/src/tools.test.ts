/**
 * Contract regression suite for the @mcp/sdk migration (S-23).
 *
 * `contracts/bitbucket-mcp.json` pins what `tools/list` advertises. This pins
 * what `tools/call` returns — the half a contract snapshot cannot see, and the
 * half the migration actually rewrote by replacing the dispatcher.
 *
 * Every expectation here was captured from the PRE-migration server over a real
 * stdio handshake: 18 cases, of which 17 are byte-identical after the migration.
 * The one intentional change is pinned at the bottom.
 *
 * The tools are built against a stub client, so nothing here touches the network.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { createNullLogger } from "@mcp/core";
import { asErrorPayload, createToolRegistry, dispatchToolCall } from "@mcp/sdk";

import type { BitbucketClient } from "./bitbucketClient.js";
import type { BitbucketConfig } from "./config/index.js";
import { buildTools, toWireError } from "./tools.js";

const logger = createNullLogger("test");

const CONFIG: BitbucketConfig = {
  baseUrl: "https://contract-snapshot.invalid",
  workspace: "snapshot-ws",
  defaultRepo: null,
  authHeader: "Bearer dummy",
  writeEnabled: false,
  timeoutMs: 1000,
  maxRetries: 0,
  defaultPagelen: 25,
  maxPagelen: 100
} as unknown as BitbucketConfig;

/** Every method rejects: no test here should reach the network. */
const STUB_CLIENT = {
  getRepository: async () => {
    throw new Error("network not available in tests");
  },
  listRepositories: async () => {
    throw new Error("network not available in tests");
  },
  listBranches: async () => {
    throw new Error("network not available in tests");
  },
  listPullRequests: async () => {
    throw new Error("network not available in tests");
  },
  getPullRequest: async () => {
    throw new Error("network not available in tests");
  },
  getPullRequestDiff: async () => {
    throw new Error("network not available in tests");
  },
  createPullRequest: async () => {
    throw new Error("network not available in tests");
  },
  createPullRequestPath: (repoSlug: string) => `/repositories/snapshot-ws/${repoSlug}/pullrequests`
} as unknown as BitbucketClient;

function call(
  name: string,
  args: Record<string, unknown>,
  config: BitbucketConfig = CONFIG
): Promise<{ isError?: boolean; content: readonly { text: string }[] }> {
  const registry = createToolRegistry(buildTools(config, STUB_CLIENT));
  return dispatchToolCall(registry, name, args, {
    logger,
    // Identical to the wiring in index.ts — the envelope is what is under test.
    formatError: (error) => asErrorPayload(toWireError(error), "verbose")
  });
}

const bodyOf = async (name: string, args: Record<string, unknown>, config?: BitbucketConfig) => {
  const result = await call(name, args, config);
  return { isError: result.isError, payload: JSON.parse(result.content[0]?.text ?? "null") };
};

// --- tools/list side of the contract ---------------------------------------

test("the tool table is the 8 advertised tools, in registration order", () => {
  const names = buildTools(CONFIG, STUB_CLIENT).map((tool) => tool.name);
  assert.deepEqual(names, [
    "health_check",
    "list_repositories",
    "get_repository",
    "list_branches",
    "list_pull_requests",
    "get_pull_request",
    "get_pull_request_diff",
    "create_pull_request"
  ]);
});

test("create_pull_request is the only tool not marked read-only", () => {
  const tools = buildTools(CONFIG, STUB_CLIENT);
  const writers = tools.filter((tool) => !tool.annotations.readOnly).map((tool) => tool.name);
  assert.deepEqual(writers, ["create_pull_request"]);
  // Creating a PR adds; it never removes.
  const create = tools.find((tool) => tool.name === "create_pull_request");
  assert.equal(create?.annotations.destructive, false);
  assert.equal(create?.annotations.idempotent, false);
});

// --- error envelope: { code, message, detail? }, always verbose -------------

test("validation errors keep this server's envelope, not the platform's", async () => {
  const { isError, payload } = await bodyOf("get_pull_request", { id: "not-a-number" });
  assert.equal(isError, true);
  assert.equal(payload.code, "validation_error");
  assert.equal(payload.message, "Invalid arguments.");
  assert.match(payload.detail, /^id: /);
  // The platform envelope would carry these; this server's must not.
  assert.equal(payload.audience, undefined);
  assert.equal(payload.retryable, undefined);
});

test("an unknown argument is rejected — schemas are strict", async () => {
  const { isError, payload } = await bodyOf("get_repository", { repoSlug: "r", nope: 1 });
  assert.equal(isError, true);
  assert.equal(payload.code, "validation_error");
});

test("a missing required argument names the field", async () => {
  const { payload } = await bodyOf("get_pull_request", {});
  assert.equal(payload.code, "validation_error");
  assert.match(payload.detail, /^id: Required/);
});

test("an out-of-range value is rejected by the zod bound, not silently clamped", async () => {
  assert.equal((await bodyOf("list_repositories", { pagelen: 5000 })).payload.code, "validation_error");
  assert.equal((await bodyOf("get_pull_request", { id: 0 })).payload.code, "validation_error");
});

test("an invalid profile is a validation error, not a silent fallback", async () => {
  const { payload } = await bodyOf("list_repositories", { profile: "chatty" });
  assert.equal(payload.code, "validation_error");
  assert.match(payload.detail, /^profile: /);
});

test("policy violations surface their own code", async () => {
  const { isError, payload } = await bodyOf("get_repository", {});
  assert.equal(isError, true);
  assert.deepEqual(payload, {
    code: "repo_required",
    message: "No repository specified. Pass `repoSlug` or set BITBUCKET_DEFAULT_REPO."
  });
});

// --- the write gate ---------------------------------------------------------

test("create_pull_request refuses when writes are disabled", async () => {
  const { isError, payload } = await bodyOf("create_pull_request", {
    repoSlug: "r",
    title: "t",
    sourceBranch: "b"
  });
  assert.equal(isError, true);
  assert.deepEqual(payload, {
    code: "WRITE_DISABLED",
    message:
      "Creating pull requests is disabled. Set BITBUCKET_WRITE_ENABLED=true to enable, or call with dryRun:true to preview the payload."
  });
});

test("dryRun works even when writes are disabled — the gate is after the preview", async () => {
  // This is why the write check is inline rather than a guard: a guard runs
  // before the handler and would block the preview too.
  const { isError, payload } = await bodyOf("create_pull_request", {
    repoSlug: "r",
    title: "t",
    sourceBranch: "b",
    dryRun: true
  });
  assert.equal(isError, undefined);
  assert.deepEqual(payload, {
    dryRun: true,
    workspace: "snapshot-ws",
    repoSlug: "r",
    request: {
      method: "POST",
      path: "/repositories/snapshot-ws/r/pullrequests",
      body: { title: "t", source: { branch: { name: "b" } } }
    }
  });
});

test("dryRun maps reviewers by shape: UUID vs account_id", async () => {
  // Regression guard: UUID_RE must be initialised before the handler runs.
  // It previously sat after the factory's `return`, so it was still in its
  // temporal dead zone and every reviewer call failed.
  const { payload } = await bodyOf("create_pull_request", {
    repoSlug: "r",
    title: "t",
    sourceBranch: "src",
    destinationBranch: "dst",
    description: "d",
    closeSourceBranch: true,
    reviewers: ["11111111-2222-3333-4444-555555555555", "557058:abc"],
    dryRun: true
  });
  assert.deepEqual(payload.request.body.reviewers, [
    { uuid: "{11111111-2222-3333-4444-555555555555}" },
    { account_id: "557058:abc" }
  ]);
  assert.equal(payload.request.body.destination.branch.name, "dst");
  assert.equal(payload.request.body.close_source_branch, true);
});

test("a write-enabled config reaches the client instead of refusing", async () => {
  const writable = { ...CONFIG, writeEnabled: true } as BitbucketConfig;
  const { isError, payload } = await bodyOf(
    "create_pull_request",
    { repoSlug: "r", title: "t", sourceBranch: "b" },
    writable
  );
  // The stub client throws, which proves the gate was passed rather than hit.
  assert.equal(isError, true);
  assert.notEqual(payload.code, "WRITE_DISABLED");
});

// --- upstream failures -------------------------------------------------------

test("an upstream failure is reported, and health_check reports it as a result", async () => {
  const listed = await bodyOf("list_repositories", { pagelen: 1 });
  assert.equal(listed.isError, true);

  // health_check must NOT fail: a failed probe is part of its answer.
  const health = await bodyOf("health_check", {});
  assert.equal(health.isError, undefined);
  assert.equal(health.payload.check.ok, false);
  assert.equal(typeof health.payload.check.error.code, "string");
  assert.equal(health.payload.config.workspace, "snapshot-ws");
});

// --- the one intentional behaviour change -----------------------------------

test("DELTA: an unknown tool now reports not_found instead of mcp_error", async () => {
  // Before the migration the hand-written switch threw McpError, producing
  //   { code: "mcp_error", message: "MCP error -32601: Unknown tool: x" }
  // Dispatch now raises a PlatformError, which toWireError unwraps to its own
  // code. `not_found` describes the condition; the old string leaked a JSON-RPC
  // error number into a tool payload. This is the only response that changed.
  const { isError, payload } = await bodyOf("no_such_tool", {});
  assert.equal(isError, true);
  assert.deepEqual(payload, { code: "not_found", message: "Unknown tool: no_such_tool." });
});
