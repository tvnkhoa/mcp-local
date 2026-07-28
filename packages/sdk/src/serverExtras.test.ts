/**
 * The two capabilities S-24 (postgres-mcp) required of the SDK:
 *
 *   1. `rawResult` tools — a handler that already built its wire envelope.
 *   2. `resources` — `resources/list` + `resources/read`, and the capability
 *      declaration that must accompany them.
 *
 * Both are covered here rather than in `sdk.test.ts`, which is at its size cap.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { createNullLogger, err, ok, policyViolation } from "@mcp/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ErrorCode, ListResourcesRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import type { McpServerHandle } from "./createServer.js";
import { createMcpServer } from "./createServer.js";
import { annotations, defineTool } from "./defineTool.js";
import { dispatchToolCall } from "./dispatch.js";
import { createToolRegistry } from "./registry.js";
import type { ResourceProvider } from "./resources.js";
import { asErrorPayload, asText } from "./responses.js";
import { schema } from "./schema.js";

const logger = createNullLogger("test");

function textOf(result: { content: readonly { text: string }[] }): string {
  return result.content[0]?.text ?? "";
}

// --- rawResult --------------------------------------------------------------

const rawTool = defineTool({
  name: "raw_echo",
  description: "Return an already-built wire result.",
  input: z.object({ value: z.string(), profile: z.string().optional() }).strict(),
  inputSchema: schema.object({ value: schema.string(), profile: schema.profile() }, {
    required: ["value"]
  }),
  annotations: annotations.read(),
  rawResult: true,
  // Serializes itself, at a profile of its own choosing — the case the flag exists for.
  handler: (input) => ok(asText({ echoed: input.value, own: true }, "verbose"))
});

const payloadTool = defineTool({
  name: "payload_echo",
  description: "Return a payload for dispatch to serialize.",
  input: z.object({ value: z.string(), profile: z.string().optional() }).strict(),
  inputSchema: schema.object({ value: schema.string(), profile: schema.profile() }, {
    required: ["value"]
  }),
  annotations: annotations.read(),
  handler: (input) => ok({ echoed: input.value, own: false })
});

test("rawResult defaults to false, so an unmarked tool is still serialized by dispatch", () => {
  assert.equal(payloadTool.rawResult, false);
  assert.equal(rawTool.rawResult, true);
});

test("a rawResult handler's envelope reaches the client untouched", async () => {
  const registry = createToolRegistry([rawTool]);
  const result = await dispatchToolCall(registry, "raw_echo", { value: "hi" }, { logger });
  // Pretty-printed because the HANDLER chose verbose, even though dispatch's
  // profile for this call is the compact default. Dispatch did not re-serialize.
  assert.equal(textOf(result), JSON.stringify({ echoed: "hi", own: true }, null, 2));
  assert.equal(result.isError, undefined);
});

test("the same payload through a normal tool is serialized by dispatch instead", async () => {
  const registry = createToolRegistry([payloadTool]);
  const result = await dispatchToolCall(registry, "payload_echo", { value: "hi" }, { logger });
  assert.equal(textOf(result), '{"echoed":"hi","own":false}');
});

test("a rawResult result is not double-wrapped", async () => {
  const registry = createToolRegistry([rawTool]);
  const result = await dispatchToolCall(registry, "raw_echo", { value: "hi" }, { logger });
  const parsed: unknown = JSON.parse(textOf(result));
  // The regression this guards: serializing an already-built ToolCallResult
  // would yield {"content":[{"type":"text","text":"..."}]} as the payload.
  assert.equal((parsed as { content?: unknown }).content, undefined);
  assert.equal(result.content.length, 1);
});

test("rawResult does not bypass validation, guards or the error path", async () => {
  const refusing = defineTool({
    name: "raw_refuse",
    description: "Always refuses.",
    input: z.object({ value: z.string() }).strict(),
    inputSchema: schema.object({ value: schema.string() }, { required: ["value"] }),
    annotations: annotations.read(),
    rawResult: true,
    handler: () => err(policyViolation("Writes are off."))
  });
  const registry = createToolRegistry([refusing]);

  // Validation still runs ahead of the handler.
  const invalid = await dispatchToolCall(registry, "raw_refuse", { value: 1 }, { logger });
  assert.equal(invalid.isError, true);

  // A failed Result still goes through formatError, not through the raw path.
  const refused = await dispatchToolCall(
    registry,
    "raw_refuse",
    { value: "x" },
    {
      logger,
      formatError: (error) =>
        asErrorPayload(
          { seen: (error as { code: string }).code, why: (error as { message: string }).message },
          "compact"
        )
    }
  );
  assert.equal(refused.isError, true);
  assert.equal(textOf(refused), '{"seen":"policy_violation","why":"Writes are off."}');
});

// --- resources --------------------------------------------------------------

const provider: ResourceProvider = {
  list: () => [
    {
      uri: "schema://dev",
      name: "Schema (dev)",
      description: "Schema snapshot for 'dev'.",
      mimeType: "application/json"
    }
  ],
  read: (uri) => {
    if (uri === "schema://dev") {
      return [{ uri, mimeType: "application/json", text: '{"tables":[]}' }];
    }
    if (uri === "schema://broken") {
      throw new Error("Environment 'broken' is not configured.");
    }
    return undefined;
  }
};

const noTools = { name: "t", version: "0", tools: [], protectStdout: false, handleSignals: false } as const;

/**
 * Connect a real MCP client to the handle over an in-memory transport pair.
 *
 * Exercising the actual protocol rather than poking at the server's registered
 * handlers: capability negotiation is half of what these tests are about, and it
 * only happens on a real `initialize`.
 */
async function connect(handle: McpServerHandle): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1.0.0" });
  await Promise.all([handle.server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

test("a server without a provider advertises no resources capability", () => {
  const handle = createMcpServer({ ...noTools });
  assert.throws(
    () => handle.server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: [] })),
    // The protocol SDK refuses a handler for an undeclared capability — which is
    // why `resources` had to become a first-class option rather than something a
    // server bolts on after createMcpServer returns.
    /does not support resources/i
  );
});

test("supplying a provider declares the capability and registers both handlers", async () => {
  const handle = createMcpServer({ ...noTools, resources: provider });
  const client = await connect(handle);
  try {
    // The client learns the capability from `initialize`, which is what makes a
    // resource-bearing server usable at all.
    assert.deepEqual(client.getServerCapabilities()?.resources, {});
  } finally {
    await client.close();
  }
});

test("resources/list returns the provider's descriptors", async () => {
  const handle = createMcpServer({ ...noTools, resources: provider });
  const client = await connect(handle);
  try {
    const listed = await client.listResources();
    assert.deepEqual(listed.resources, [
      {
        uri: "schema://dev",
        name: "Schema (dev)",
        description: "Schema snapshot for 'dev'.",
        mimeType: "application/json"
      }
    ]);
  } finally {
    await client.close();
  }
});

test("resources/read returns contents for a known uri", async () => {
  const handle = createMcpServer({ ...noTools, resources: provider });
  const client = await connect(handle);
  try {
    const read = await client.readResource({ uri: "schema://dev" });
    // `contents` is a text-or-blob union on the wire; this provider only emits text.
    const first = read.contents[0];
    assert.ok(first !== undefined && "text" in first);
    assert.equal(first.text, '{"tables":[]}');
  } finally {
    await client.close();
  }
});

test("an unroutable uri is InvalidParams, a failed read is not", async () => {
  const handle = createMcpServer({ ...noTools, resources: provider });
  const client = await connect(handle);
  try {
    // undefined means "I do not serve this URI" -> -32602.
    await assert.rejects(
      () => client.readResource({ uri: "bogus://x" }),
      (error: unknown) => {
        assert.equal((error as { code: number }).code, ErrorCode.InvalidParams);
        assert.match(String((error as Error).message), /Unsupported resource URI: bogus:\/\/x/);
        return true;
      }
    );

    // A thrown error is a genuine failure and must stay distinguishable: it
    // propagates, and the protocol layer reports it as an internal error.
    await assert.rejects(
      () => client.readResource({ uri: "schema://broken" }),
      (error: unknown) => {
        assert.equal((error as { code: number }).code, ErrorCode.InternalError);
        assert.match(String((error as Error).message), /not configured/);
        return true;
      }
    );
  } finally {
    await client.close();
  }
});

test("tools still work alongside resources", async () => {
  const handle = createMcpServer({ ...noTools, tools: [payloadTool], resources: provider });
  const client = await connect(handle);
  try {
    const called = await client.callTool({ name: "payload_echo", arguments: { value: "z" } });
    const content = called.content as { text: string }[];
    assert.equal(content[0]?.text, '{"echoed":"z","own":false}');
  } finally {
    await client.close();
  }
});
