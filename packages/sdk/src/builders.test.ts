/**
 * The `create*` / `register*` builder family.
 *
 * Three of these surfaces are new (`createPrompt`, `createResource`, and the
 * `prompts/*` wiring); the other two are aliases and assembly helpers over code
 * that already had coverage. What is worth pinning here:
 *
 *   - the **capability rule** — a server advertises `prompts` or `resources` only
 *     when it supplies one. Getting this wrong makes a client call a method the
 *     server cannot answer, and no unit test of the builders alone would show it.
 *   - the **not-served sentinel** on both new surfaces, including the
 *     `onUnmatched` escape hatch that keeps codebase-index-mcp's own message.
 *   - the two behaviours the existing providers depend on and would silently lose
 *     to a platform default: `emptyOnCursor`, and per-resource `serialize`.
 *
 * The protocol-level assertions go through a real client over an in-memory
 * transport, the same way `callHooks.test.ts` proves progress notifications.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { createNullLogger, ok } from "@mcp/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";

import type { McpServerHandle, McpServerOptions } from "./createServer.js";
import { createMcpServer, createServer } from "./createServer.js";
import { annotations, createTool, defineTool } from "./defineTool.js";
import { createPrompt, registerPrompt } from "./prompts.js";
import { registerTool } from "./registry.js";
import { createResource, registerResource } from "./resources.js";
import { schema } from "./schema.js";

const logger = createNullLogger("test");

const ping = defineTool({
  name: "ping",
  description: "Ping.",
  input: z.object({}).strict(),
  inputSchema: schema.object({}),
  annotations: annotations.read(),
  handler: () => ok({ pong: true })
});

function tool(name: string) {
  return defineTool({
    name,
    description: `Tool ${name}.`,
    input: z.object({}).strict(),
    inputSchema: schema.object({}),
    annotations: annotations.read(),
    handler: () => ok({ name })
  });
}

async function connect(handle: McpServerHandle): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1.0.0" });
  await Promise.all([handle.server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

function serverWith(options: Partial<McpServerOptions>): McpServerHandle {
  return createServer({
    name: "builder-test",
    version: "1.0.0",
    tools: [ping],
    logger,
    protectStdout: false,
    handleSignals: false,
    ...options
  });
}

// --- aliases ------------------------------------------------------------------

test("createTool and createServer are the same functions defineTool/createMcpServer are", () => {
  assert.equal(createTool, defineTool);
  assert.equal(createServer, createMcpServer);
});

// --- registerTool -------------------------------------------------------------

test("registerTool flattens groups and keeps declaration order", () => {
  const table = registerTool([tool("a"), [tool("b"), tool("c")], tool("d")]);
  assert.deepEqual(
    table.map((entry) => entry.name),
    ["a", "b", "c", "d"]
  );
});

test("registerTool rejects a duplicate name at assembly, naming itself", () => {
  assert.throws(() => registerTool([tool("a"), [tool("a")]]), /registerTool: duplicate tool name "a"/);
});

// --- createPrompt -------------------------------------------------------------

const reviewDiff = createPrompt({
  name: "review_diff",
  description: "Review a diff.",
  arguments: [
    { name: "diff", description: "The unified diff.", required: true },
    { name: "focus" }
  ],
  render: (args) => ({
    messages: [{ role: "user", content: { type: "text", text: `${args.focus ?? "all"}::${args.diff}` } }]
  })
});

test("createPrompt validates the declaration at construction", () => {
  const render = () => ({ messages: [] });
  assert.throws(() => createPrompt({ name: "Bad Name", description: "d", render }), /snake_case/);
  assert.throws(() => createPrompt({ name: "ok_name", description: "  ", render }), /non-empty description/);
  assert.throws(
    () => createPrompt({ name: "ok_name", description: "d", arguments: [{ name: "x" }, { name: "x" }], render }),
    /declares argument "x" twice/
  );
});

test("a declared-required argument is guaranteed present by the time render runs", async () => {
  assert.deepEqual(await reviewDiff.render({ diff: "@@" }), {
    messages: [{ role: "user", content: { type: "text", text: "all::@@" } }]
  });
  assert.throws(() => reviewDiff.render({}), /requires argument: diff/);
});

test("registerPrompt lists what it holds and returns undefined for a name it does not serve", async () => {
  const provider = registerPrompt([reviewDiff]);
  assert.deepEqual(await provider.list(), [
    {
      name: "review_diff",
      description: "Review a diff.",
      arguments: [{ name: "diff", description: "The unified diff.", required: true }, { name: "focus" }]
    }
  ]);
  assert.equal(await provider.get("nope", {}), undefined);
});

test("registerPrompt rejects a duplicate name", () => {
  assert.throws(() => registerPrompt([reviewDiff, reviewDiff]), /registerPrompt: duplicate prompt name/);
});

// --- prompts over the wire ----------------------------------------------------

test("a server with prompts advertises the capability and answers prompts/get", async () => {
  const client = await connect(serverWith({ prompts: [reviewDiff] }));

  assert.notEqual(client.getServerCapabilities()?.prompts, undefined);
  assert.deepEqual((await client.listPrompts()).prompts.map((p) => p.name), ["review_diff"]);

  const got = await client.getPrompt({ name: "review_diff", arguments: { diff: "@@ -1 +1 @@" } });
  assert.deepEqual(got.messages, [
    { role: "user", content: { type: "text", text: "all::@@ -1 +1 @@" } }
  ]);
});

test("a server with no prompts does not advertise the capability", async () => {
  const client = await connect(serverWith({}));
  assert.equal(client.getServerCapabilities()?.prompts, undefined);
  await assert.rejects(() => client.listPrompts(), /Method not found|-32601/);
});

test("an unknown prompt and a missing required argument are both invalid params", async () => {
  const client = await connect(serverWith({ prompts: [reviewDiff] }));
  await assert.rejects(() => client.getPrompt({ name: "nope" }), /Unknown prompt: nope/);
  await assert.rejects(() => client.getPrompt({ name: "review_diff" }), /requires argument: diff/);
});

test("a genuine failure inside render stays a failure, not an invalid-params answer", async () => {
  const exploding = createPrompt({
    name: "exploding",
    description: "Throws.",
    render: () => {
      throw new Error("render exploded");
    }
  });
  const client = await connect(serverWith({ prompts: [exploding] }));
  await assert.rejects(() => client.getPrompt({ name: "exploding" }), /render exploded/);
});

// --- createResource -----------------------------------------------------------

const staticResource = createResource({
  name: "status",
  uri: "status://now",
  title: "Server status",
  description: "One fixed resource.",
  read: () => ({ ok: true })
});

const family = createResource({
  name: "thing",
  serialize: (payload) => JSON.stringify(payload, null, 2),
  list: () => [{ uri: "thing://a", name: "thing a", mimeType: "application/json" }],
  match: (uri) => {
    const found = /^thing:\/\/(.+)$/.exec(uri);
    return found === null ? undefined : { id: found[1] };
  },
  read: ({ params }) => ({ id: params.id })
});

test("a static resource lists itself and reads only its own uri", async () => {
  assert.deepEqual(await staticResource.list(), [
    {
      uri: "status://now",
      name: "Server status",
      description: "One fixed resource.",
      mimeType: "application/json"
    }
  ]);
  assert.deepEqual(await staticResource.read("status://now"), [
    { uri: "status://now", mimeType: "application/json", text: '{"ok":true}' }
  ]);
  assert.equal(await staticResource.read("status://other"), undefined);
});

test("a family routes through its own matcher and serializes with its own renderer", async () => {
  assert.deepEqual(await family.read("thing://x"), [
    { uri: "thing://x", mimeType: "application/json", text: '{\n  "id": "x"\n}' }
  ]);
  assert.equal(await family.read("other://x"), undefined);
});

test("registerResource concatenates lists in order and reads the first match", async () => {
  const provider = registerResource([staticResource, [family]]);
  assert.deepEqual((await provider.list()).map((d) => d.uri), ["status://now", "thing://a"]);
  assert.equal((await provider.read("thing://z"))?.[0]?.uri, "thing://z");
  assert.equal(await provider.read("nothing://z"), undefined);
});

test("emptyOnCursor answers a cursored list with an empty page", async () => {
  const provider = registerResource([staticResource], { emptyOnCursor: true });
  assert.equal((await provider.list()).length, 1);
  assert.equal((await provider.list("c1")).length, 0);

  const forwarding = registerResource([staticResource]);
  assert.equal((await forwarding.list("c1")).length, 1);
});

test("onUnmatched owns the answer for a uri nothing routes", async () => {
  const provider = registerResource([family], {
    onUnmatched: () => {
      throw new Error("unsupported uri. Use thing://{id}");
    }
  });
  await assert.rejects(() => Promise.resolve(provider.read("bogus://x")), /unsupported uri/);
});

test("registerResource rejects a duplicate resource name", () => {
  assert.throws(() => registerResource([family, family]), /registerResource: duplicate resource name "thing"/);
});

// --- resources over the wire ---------------------------------------------------

test("a resource list passed to createServer is composed with registerResource", async () => {
  const client = await connect(serverWith({ resources: [staticResource, family] }));

  assert.notEqual(client.getServerCapabilities()?.resources, undefined);
  assert.deepEqual((await client.listResources()).resources.map((r) => r.uri), [
    "status://now",
    "thing://a"
  ]);
  const read = await client.readResource({ uri: "thing://q" });
  // `contents` is a text-or-blob union on the wire; this resource only emits text.
  const first = read.contents[0];
  assert.ok(first !== undefined && "text" in first);
  assert.equal(first.text, '{\n  "id": "q"\n}');
  await assert.rejects(() => client.readResource({ uri: "bogus://q" }), /Unsupported resource URI/);
});

test("a server with no resources does not advertise the capability", async () => {
  const client = await connect(serverWith({}));
  assert.equal(client.getServerCapabilities()?.resources, undefined);
});

test("an EMPTY declaration list is no declaration — neither capability is advertised", async () => {
  const client = await connect(serverWith({ resources: [], prompts: [] }));
  const capabilities = client.getServerCapabilities();
  assert.equal(capabilities?.resources, undefined);
  assert.equal(capabilities?.prompts, undefined);
});
