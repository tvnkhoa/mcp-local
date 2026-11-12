import assert from "node:assert/strict";
import test from "node:test";

import { buildTools, PREFIX_SCOPED_TOOLS } from "./index.js";

/**
 * IX-A (MCP-ISSUE-126) / IX-B: the server's `ensureFresh` now takes the read's scope; the tools hand it a prefix only for a
 * tool whose answer depends on nothing outside it (leader review (a)). A whole-graph tool given a prefix still gets the
 * whole-repo verdict: a new caller outside lib/ changes dead_code_scan's answer about lib/.
 */
function gateCalls(): { tools: ReturnType<typeof buildTools>; calls: unknown[][]; call: (name: string, input: unknown) => Promise<void> } {
  const calls: unknown[][] = [];
  const tools = buildTools({
    limits: { maxResultLimit: 500, maxDepth: 5, maxFilesPerRun: 50_000 },
    buildContext: () => {
      throw new Error("no context in this test");
    },
    ensureFresh: async (...args: unknown[]) => {
      calls.push(args);
    }
  } as unknown as Parameters<typeof buildTools>[0]);
  const call = async (name: string, input: unknown): Promise<void> => {
    const tool = tools.find((t) => t.name === name);
    assert.ok(tool, name);
    try {
      await (tool.handler as (i: unknown, c: unknown) => Promise<unknown>)(input, {});
    } catch {
      // the handler has no context here; only the gate's call is under test
    }
  };
  return { tools, calls, call };
}

test("IX-A: a prefix-scoped tool hands its filePathPrefix to the gate", async () => {
  const { calls, call } = gateCalls();
  await call("search_regex", { repoId: "r", pattern: "x", filePathPrefix: ["src/", "lib/"] });
  assert.deepEqual(calls, [["r", { filePathPrefixes: ["src/", "lib/"] }]]);
});

test("IX-A (leader review (a)): a whole-graph tool given a prefix gets the whole-repo verdict", async () => {
  const { tools, calls, call } = gateCalls();
  const wholeGraph = ["dead_code_scan", "detect_circular_dependencies", "find_entry_points", "route_map"].filter((n) => tools.some((t) => t.name === n));
  assert.ok(wholeGraph.length >= 3, "the whole-graph tools that take a prefix are registered");
  for (const name of wholeGraph) {
    assert.equal(PREFIX_SCOPED_TOOLS.has(name), false, name);
    await call(name, { repoId: "r", filePathPrefix: "lib/" });
  }
  assert.deepEqual(calls, wholeGraph.map(() => ["r"]), "no scope reached the gate");
});
