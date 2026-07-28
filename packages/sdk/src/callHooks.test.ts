/**
 * The two capabilities codebase-index-mcp requires of the SDK (plan step S-31's
 * real prerequisite):
 *
 *   1. `renderResult` — the server owns the payload-to-text hop, because in that
 *      server the hop also emits telemetry. A pipeline that serializes on its own
 *      would drop the side effect while producing identical bytes, which neither
 *      a contract snapshot nor a response replay can detect.
 *   2. `wrapCall` — a scope around the whole call. Closes two apparently separate
 *      gaps with one hook: progress notifications (which need the request's
 *      progress token and notification channel) and a server-wide pre-dispatch
 *      policy (which per-tool guards cannot express).
 *
 * Own file rather than appended to `serverExtras.test.ts`, which is close enough
 * to the size cap that adding this would push it over.
 */

import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { test } from "node:test";

import { createNullLogger, ok } from "@mcp/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";

import type { CallContext } from "./callContext.js";
import type { McpServerHandle } from "./createServer.js";
import { createMcpServer } from "./createServer.js";
import { annotations, defineTool } from "./defineTool.js";
import { dispatchToolCall } from "./dispatch.js";
import { createToolRegistry } from "./registry.js";
import type { ToolCallResult } from "./responses.js";
import { asText } from "./responses.js";
import { schema } from "./schema.js";

const logger = createNullLogger("test");

function textOf(result: { content: readonly { text: string }[] }): string {
  return result.content[0]?.text ?? "";
}

const echo = defineTool({
  name: "echo",
  description: "Echo a value.",
  input: z.object({ value: z.string(), profile: z.string().optional() }).strict(),
  inputSchema: schema.object({ value: schema.string(), profile: schema.profile() }, { required: ["value"] }),
  annotations: annotations.read(),
  handler: (input) => ok({ echoed: input.value })
});

const rawEcho = defineTool({
  name: "raw_echo",
  description: "Echo, already enveloped.",
  input: z.object({ value: z.string() }).strict(),
  inputSchema: schema.object({ value: schema.string() }, { required: ["value"] }),
  annotations: annotations.read(),
  rawResult: true,
  handler: (input) => ok(asText({ echoed: input.value }, "verbose"))
});

const boom = defineTool({
  name: "boom",
  description: "Always throws.",
  input: z.object({}).strict(),
  inputSchema: schema.object({}),
  annotations: annotations.read(),
  handler: () => {
    throw new Error("handler exploded");
  }
});

// --- renderResult -------------------------------------------------------------

test("renderResult replaces the default serializer for successful payloads", async () => {
  const seen: { payload: unknown; profile: string }[] = [];
  const registry = createToolRegistry([echo]);
  const result = await dispatchToolCall(registry, "echo", { value: "hi" }, {
    logger,
    renderResult: (payload, profile) => {
      seen.push({ payload, profile });
      return { content: [{ type: "text", text: "rendered-by-server" }] };
    }
  });

  assert.equal(textOf(result), "rendered-by-server");
  assert.deepEqual(seen, [{ payload: { echoed: "hi" }, profile: "compact" }]);
});

test("renderResult receives the profile the CALLER asked for, not the default", async () => {
  const profiles: string[] = [];
  const registry = createToolRegistry([echo]);
  const render = (_payload: unknown, profile: string): ToolCallResult => {
    profiles.push(profile);
    return { content: [{ type: "text", text: profile }] };
  };
  for (const profile of ["nano", "compact", "standard", "verbose"]) {
    await dispatchToolCall(registry, "echo", { value: "x", profile }, { logger, renderResult: render });
  }
  assert.deepEqual(profiles, ["nano", "compact", "standard", "verbose"]);
});

test("serialize options are not consulted once renderResult owns the hop", async () => {
  const registry = createToolRegistry([echo]);
  const result = await dispatchToolCall(registry, "echo", { value: "hi" }, {
    logger,
    // stableKeys would reorder in the default path; renderResult bypasses it entirely.
    serialize: { stableKeys: true },
    renderResult: (payload) => ({ content: [{ type: "text", text: JSON.stringify(payload) }] })
  });
  assert.equal(textOf(result), '{"echoed":"hi"}');
});

test("a rawResult tool bypasses renderResult — it already made the decision", async () => {
  let called = false;
  const registry = createToolRegistry([rawEcho]);
  const result = await dispatchToolCall(registry, "raw_echo", { value: "hi" }, {
    logger,
    renderResult: () => {
      called = true;
      return { content: [{ type: "text", text: "should not happen" }] };
    }
  });
  assert.equal(called, false);
  assert.equal(textOf(result), JSON.stringify({ echoed: "hi" }, null, 2));
});

test("renderResult is not used for failures — formatError owns that half", async () => {
  let called = false;
  const registry = createToolRegistry([boom]);
  const result = await dispatchToolCall(registry, "boom", {}, {
    logger,
    renderResult: () => {
      called = true;
      return { content: [{ type: "text", text: "wrong" }] };
    }
  });
  assert.equal(called, false);
  assert.equal(result.isError, true);
});

test("a throwing renderResult degrades to a tool error, never a rejection", async () => {
  const registry = createToolRegistry([echo]);
  const result = await dispatchToolCall(registry, "echo", { value: "hi" }, {
    logger,
    renderResult: () => {
      throw new Error("renderer exploded");
    }
  });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /renderer exploded|internal_error/);
});

// --- wrapCall -----------------------------------------------------------------

async function connect(handle: McpServerHandle): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1.0.0" });
  await Promise.all([handle.server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

const base = { name: "wrap-test", version: "1.0.0", tools: [echo, boom], logger, protectStdout: false, handleSignals: false } as const;

test("wrapCall runs around dispatch and sees the tool name and raw arguments", async () => {
  const seen: CallContext[] = [];
  const client = await connect(
    createMcpServer({
      ...base,
      wrapCall: async (context, next) => {
        seen.push(context);
        return next();
      }
    })
  );

  await client.callTool({ name: "echo", arguments: { value: "hi" } });

  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.toolName, "echo");
  assert.deepEqual(seen[0]?.args, { value: "hi" });
  // Absent, not undefined-valued: nobody asked for progress.
  assert.equal(seen[0]?.progressToken, undefined);
});

test("wrapCall runs even for an unknown tool — it wraps the call, not the handler", async () => {
  const names: string[] = [];
  const client = await connect(
    createMcpServer({
      ...base,
      wrapCall: async (context, next) => {
        names.push(context.toolName);
        return next();
      }
    })
  );
  const result = await client.callTool({ name: "no_such_tool", arguments: {} });
  assert.deepEqual(names, ["no_such_tool"]);
  assert.equal(result.isError, true);
});

test("wrapCall can establish AsyncLocalStorage the handler reads — the actual use case", async () => {
  const als = new AsyncLocalStorage<{ tool: string }>();
  const ambient = defineTool({
    name: "ambient",
    description: "Read ambient request state.",
    input: z.object({}).strict(),
    inputSchema: schema.object({}),
    annotations: annotations.read(),
    handler: () => ok({ sawTool: als.getStore()?.tool ?? null })
  });

  const client = await connect(
    createMcpServer({
      ...base,
      tools: [ambient],
      wrapCall: (context, next) => als.run({ tool: context.toolName }, next)
    })
  );

  const result = await client.callTool({ name: "ambient", arguments: {} });
  assert.deepEqual(JSON.parse(textOf(result as { content: { text: string }[] })), { sawTool: "ambient" });
});

test("reportProgress reaches the client when the host asked for progress", async () => {
  const client = await connect(
    createMcpServer({
      ...base,
      wrapCall: async (context, next) => {
        context.reportProgress(1, 3, "starting");
        context.reportProgress(3, 3, "done");
        return next();
      }
    })
  );

  const updates: { progress: number; total?: number; message?: string }[] = [];
  await client.callTool({ name: "echo", arguments: { value: "hi" } }, undefined, {
    onprogress: (p) => updates.push(p)
  });

  assert.equal(updates.length, 2);
  assert.deepEqual(
    updates.map((u) => [u.progress, u.total, u.message]),
    [[1, 3, "starting"], [3, 3, "done"]]
  );
});

test("progressToken is present exactly when the host supplied one", async () => {
  const tokens: (string | number | undefined)[] = [];
  const client = await connect(
    createMcpServer({
      ...base,
      wrapCall: async (context, next) => {
        tokens.push(context.progressToken);
        return next();
      }
    })
  );

  await client.callTool({ name: "echo", arguments: { value: "a" } });
  await client.callTool({ name: "echo", arguments: { value: "b" } }, undefined, { onprogress: () => undefined });

  assert.equal(tokens[0], undefined);
  assert.notEqual(tokens[1], undefined);
});

test("reportProgress is a safe no-op when nobody is listening", async () => {
  const client = await connect(
    createMcpServer({
      ...base,
      wrapCall: async (context, next) => {
        // No progressToken on this call; must not throw and must not fail the tool.
        context.reportProgress(1, undefined, "into the void");
        return next();
      }
    })
  );
  const result = await client.callTool({ name: "echo", arguments: { value: "hi" } });
  assert.equal(result.isError, undefined);
});

test("a throwing wrapper becomes a fatal tool result, not a protocol error", async () => {
  const client = await connect(
    createMcpServer({
      ...base,
      wrapCall: async () => {
        throw new Error("wrapper exploded");
      }
    })
  );

  // The call must RESOLVE with isError, not reject: a server-side bug in the
  // wrapper is still a tool failure the client can read.
  const result = await client.callTool({ name: "echo", arguments: { value: "hi" } });
  assert.equal(result.isError, true);
  assert.match(textOf(result as { content: { text: string }[] }), /internal_error/);
});

test("a wrapper may substitute the result entirely", async () => {
  const client = await connect(
    createMcpServer({
      ...base,
      wrapCall: async (context) => {
        if (context.toolName === "boom") {
          return { content: [{ type: "text", text: "short-circuited" }] };
        }
        throw new Error("unreachable");
      }
    })
  );
  const result = await client.callTool({ name: "boom", arguments: {} });
  assert.equal(textOf(result as { content: { text: string }[] }), "short-circuited");
});

test("REGRESSION: without wrapCall, dispatch behaviour is unchanged", async () => {
  const client = await connect(createMcpServer({ ...base }));
  const result = await client.callTool({ name: "echo", arguments: { value: "hi" } });
  assert.equal(textOf(result as { content: { text: string }[] }), '{"echoed":"hi"}');
  assert.equal(result.isError, undefined);
});
