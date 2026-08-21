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
import { assertRequiredKeysAdvertised, assertSchemaParity } from "@mcp/testing";

import type { BitbucketClient } from "../services/bitbucketClient.js";
import type { BitbucketConfig } from "../config/index.js";
import { buildTools, toWireError } from "./index.js";

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
  listPipelines: async () => {
    throw new Error("network not available in tests");
  },
  getPipeline: async () => {
    throw new Error("network not available in tests");
  },
  listPipelineSteps: async () => {
    throw new Error("network not available in tests");
  },
  getPipelineStepLog: async () => {
    throw new Error("network not available in tests");
  },
  createPullRequestPath: (repoSlug: string) => `/repositories/snapshot-ws/${repoSlug}/pullrequests`
} as unknown as BitbucketClient;

/**
 * A client that records what it was called with and answers instead of throwing.
 * The pipeline tools translate their arguments (filter parameters, braced UUIDs,
 * log tails), and the translation — not the HTTP call — is what needs pinning.
 */
function recordingClient(overrides: Record<string, unknown> = {}) {
  const calls: { method: string; args: unknown[] }[] = [];
  const record =
    (method: string, result: unknown) =>
    async (...args: unknown[]) => {
      calls.push({ method, args });
      return result;
    };
  const client = {
    ...STUB_CLIENT,
    listPipelines: record("listPipelines", { values: [], page: 1, pagelen: 25, size: 0 }),
    getPipeline: record("getPipeline", { uuid: "{x}", build_number: 7 }),
    listPipelineSteps: record("listPipelineSteps", { values: [] }),
    getPipelineStepLog: record("getPipelineStepLog", {
      text: "line one\nline two\n",
      partial: false
    }),
    ...overrides
  } as unknown as BitbucketClient;
  return { client, calls };
}

function call(
  name: string,
  args: Record<string, unknown>,
  config: BitbucketConfig = CONFIG,
  client: BitbucketClient = STUB_CLIENT
): Promise<{ isError?: boolean; content: readonly { text: string }[] }> {
  const registry = createToolRegistry(buildTools(config, client));
  return dispatchToolCall(registry, name, args, {
    logger,
    // Identical to the wiring in index.ts — the envelope is what is under test.
    formatError: (error) => asErrorPayload(toWireError(error), "verbose")
  });
}

const bodyOf = async (
  name: string,
  args: Record<string, unknown>,
  config?: BitbucketConfig,
  client?: BitbucketClient
) => {
  const result = await call(name, args, config, client);
  return { isError: result.isError, payload: JSON.parse(result.content[0]?.text ?? "null") };
};

// --- tools/list side of the contract ---------------------------------------

test("the tool table is the 12 advertised tools, in registration order", () => {
  const names = buildTools(CONFIG, STUB_CLIENT).map((tool) => tool.name);
  assert.deepEqual(names, [
    "health_check",
    "list_repositories",
    "get_repository",
    "list_branches",
    "list_pull_requests",
    "get_pull_request",
    "get_pull_request_diff",
    "list_pipelines",
    "get_pipeline",
    "list_pipeline_steps",
    "get_pipeline_step_log",
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


// --- input-schema parity ------------------------------------------------------
//
// Every tool declares its input twice: a zod schema the handler validates with, and a hand-written
// JSON Schema `tools/list` advertises. Nothing else compares them — `contracts:check` pins the
// advertised side against a snapshot of *itself*, so a parameter missing from both stays missing,
// and `docs:check` reads the advertised side only. Until now only codebase-index-mcp had this gate.

test("every tool advertises exactly the parameters its zod schema accepts", () => {
  // The floor must equal the tool count, or the gate is slack by the difference.
  assertSchemaParity(buildTools(CONFIG, STUB_CLIENT), { floor: 12 });
});

test("a tool declaring additionalProperties:false advertises every required key", () => {
  assertRequiredKeysAdvertised(buildTools(CONFIG, STUB_CLIENT));
});

// --- the pipeline group, through dispatch -------------------------------------

test("every pipeline tool is read-only, so create_pull_request stays the only writer", async () => {
  const pipelineNames = [
    "list_pipelines",
    "get_pipeline",
    "list_pipeline_steps",
    "get_pipeline_step_log"
  ];
  const tools = buildTools(CONFIG, STUB_CLIENT).filter((tool) => pipelineNames.includes(tool.name));
  assert.equal(tools.length, 4);
  for (const tool of tools) {
    assert.equal(tool.annotations.readOnly, true, tool.name);
    assert.equal(tool.annotations.destructive, false, tool.name);
    assert.equal(tool.annotations.openWorld, true, tool.name);
  }
});

test("list_pipelines passes the filters through as parameters, with the newest-first sort", async () => {
  const { client, calls } = recordingClient();
  const { isError, payload } = await bodyOf(
    "list_pipelines",
    { repoSlug: "r", branch: "main", status: ["FAILED", "STOPPED"] },
    CONFIG,
    client
  );
  assert.equal(isError, undefined);
  // No `q`: the pipelines endpoint ignores BBQL entirely (verified live), so the
  // client takes structured filters and builds target.branch + repeated status.
  assert.deepEqual(calls[0]?.args[1], {
    branch: "main",
    status: ["FAILED", "STOPPED"],
    sort: "-created_on",
    page: undefined,
    pagelen: undefined
  });
  assert.deepEqual(payload.filters, { branch: "main", status: ["FAILED", "STOPPED"] });
});

test("list_pipelines does not advertise a q parameter", () => {
  // Advertising one would advertise a no-op: the endpoint ignores it.
  const tool = buildTools(CONFIG, STUB_CLIENT).find((t) => t.name === "list_pipelines");
  const props = Object.keys(
    (tool?.inputSchema as { properties: Record<string, unknown> }).properties
  );
  assert.equal(props.includes("q"), false);
  assert.equal(props.includes("result"), false);
  assert.ok(props.includes("status"));
  assert.ok(props.includes("branch"));
});

test("list_pipelines with no filters sends no filter parameters", async () => {
  const { client, calls } = recordingClient();
  const { payload } = await bodyOf("list_pipelines", { repoSlug: "r" }, CONFIG, client);
  const sent = calls[0]?.args[1] as { branch?: string; status?: string[] };
  assert.equal(sent.branch, undefined);
  assert.equal(sent.status, undefined);
  // The handler omits `filters` outright when nothing was filtered. Building it
  // with null members instead would normalize to `{}`, which reads as "a filter
  // was applied" — worse than absent.
  assert.equal("filters" in payload, false);
});

test("an unknown status value is rejected by the enum, not sent upstream", async () => {
  // Upstream answers 200 with an empty page for an unrecognised status, which
  // would read as "no runs". The enum is the only thing that catches it.
  const { payload } = await bodyOf("list_pipelines", {
    repoSlug: "r",
    status: ["SUCCESSFUL"]
  });
  assert.equal(payload.code, "validation_error");
  assert.match(payload.detail, /^status/);
});

test("an empty status array is rejected rather than sent as no filter", async () => {
  const { payload } = await bodyOf("list_pipelines", { repoSlug: "r", status: [] });
  assert.equal(payload.code, "validation_error");
});

test("get_pipeline reaches the same path whether the uuid is braced or not", async () => {
  const uuid = "11111111-2222-3333-4444-555555555555";
  const braced = recordingClient();
  const bare = recordingClient();
  await bodyOf("get_pipeline", { repoSlug: "r", pipelineUuid: `{${uuid}}` }, CONFIG, braced.client);
  await bodyOf("get_pipeline", { repoSlug: "r", pipelineUuid: uuid }, CONFIG, bare.client);
  assert.equal(braced.calls[0]?.args[1], `{${uuid}}`);
  assert.deepEqual(bare.calls[0]?.args, braced.calls[0]?.args);
});

test("get_pipeline refuses a reference that is neither a uuid nor a build number", async () => {
  const { isError, payload } = await bodyOf("get_pipeline", {
    repoSlug: "r",
    pipelineUuid: "latest"
  });
  assert.equal(isError, true);
  assert.equal(payload.code, "invalid_pipeline_ref");
});

test("get_pipeline accepts a build number as the reference", async () => {
  const { client, calls } = recordingClient();
  await bodyOf("get_pipeline", { repoSlug: "r", pipelineUuid: "42" }, CONFIG, client);
  assert.equal(calls[0]?.args[1], "42");
});

test("get_pipeline_step_log refuses a step reference that is not a uuid", async () => {
  const { payload } = await bodyOf("get_pipeline_step_log", {
    repoSlug: "r",
    pipelineUuid: "42",
    stepUuid: "1"
  });
  assert.equal(payload.code, "invalid_step_uuid");
});

test("get_pipeline_step_log rejects a maxBytes over the hard cap instead of clamping", async () => {
  const { payload } = await bodyOf("get_pipeline_step_log", {
    repoSlug: "r",
    pipelineUuid: "42",
    stepUuid: "11111111-2222-3333-4444-555555555555",
    maxBytes: 1_048_577
  });
  assert.equal(payload.code, "validation_error");
  assert.match(payload.detail, /^maxBytes: /);
});

test("get_pipeline_step_log bounds the log even when the server ignores Range", async () => {
  // The client asks for a suffix range; a server that answers 200 with the whole
  // log must not be able to blow past maxBytes.
  const whole = "aaaa\nbbbb\ncccc\ndddd\n";
  const { client } = recordingClient({
    getPipelineStepLog: async () => ({ text: whole, partial: false })
  });
  const { isError, payload } = await bodyOf(
    "get_pipeline_step_log",
    {
      repoSlug: "r",
      pipelineUuid: "42",
      stepUuid: "11111111-2222-3333-4444-555555555555",
      maxBytes: 10
    },
    CONFIG,
    client
  );
  assert.equal(isError, undefined);
  assert.equal(payload.truncated, true);
  assert.equal(payload.tail, true);
  assert.ok(payload.returnedBytes <= 10);
  assert.ok(whole.endsWith(payload.log));
  assert.equal(payload.stepUuid, "{11111111-2222-3333-4444-555555555555}");
});

test("a log the server already cut (HTTP 206) is reported as truncated", async () => {
  // The bug this pins: when Bitbucket honours the Range — the COMMON path — the
  // body is within maxBytes, so a length check alone concluded truncated:false on
  // a log whose first line had been sliced mid-sentence.
  const { client } = recordingClient({
    getPipelineStepLog: async () => ({ text: "half a li\nreal line\n", partial: true })
  });
  const { payload } = await bodyOf(
    "get_pipeline_step_log",
    {
      repoSlug: "r",
      pipelineUuid: "42",
      stepUuid: "11111111-2222-3333-4444-555555555555",
      maxBytes: 4096
    },
    CONFIG,
    client
  );
  assert.equal(payload.truncated, true);
  // The sliced fragment is dropped, so the tail starts on a line boundary.
  assert.equal(payload.log, "real line\n");
});

test("a whole log delivered with HTTP 200 is not reported as truncated", async () => {
  const { client } = recordingClient({
    getPipelineStepLog: async () => ({ text: "all of it\n", partial: false })
  });
  const { payload } = await bodyOf(
    "get_pipeline_step_log",
    {
      repoSlug: "r",
      pipelineUuid: "42",
      stepUuid: "11111111-2222-3333-4444-555555555555",
      maxBytes: 4096
    },
    CONFIG,
    client
  );
  assert.equal(payload.truncated, false);
  assert.equal(payload.log, "all of it\n");
});

test("get_pipeline_step_log passes maxBytes down so the Range header can be built", async () => {
  const { client, calls } = recordingClient();
  await bodyOf(
    "get_pipeline_step_log",
    { repoSlug: "r", pipelineUuid: "42", stepUuid: "11111111-2222-3333-4444-555555555555" },
    CONFIG,
    client
  );
  // repoSlug, pipelineRef, stepUuid, maxBytes
  assert.equal(calls[0]?.args[3], 262_144);
});

test("a pipeline tool with no repo and no default repo reports repo_required", async () => {
  const { payload } = await bodyOf("list_pipelines", {});
  assert.deepEqual(payload, {
    code: "repo_required",
    message: "No repository specified. Pass `repoSlug` or set BITBUCKET_DEFAULT_REPO."
  });
});
