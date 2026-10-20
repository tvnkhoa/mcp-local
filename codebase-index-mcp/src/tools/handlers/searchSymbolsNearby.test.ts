import assert from "node:assert/strict";
import test from "node:test";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { handleSearchSymbols } from "./searchHandler.js";
import type { HandlerContext } from "./handlerContext.js";

/**
 * Release B.1 (wec.aria acceptance): a name query for one exact, unique name came back as 50 rows, 49
 * of them vector near-neighbours, and agents read rows 2-50 as matches. Name matches are the answer;
 * near-neighbours are a separate, capped `nearby` list.
 */

const sym = (name: string, matchType?: "fuzzy") => ({ symbolId: `id-${name}`, name, kind: "function", filePath: `src/${name}.ts`, line: 1, signature: null, repoId: "r", ...(matchType && { matchType }) });

function ctxReturning(rows: ReturnType<typeof sym>[]): HandlerContext {
  const store = {
    searchSymbols: () => rows,
    getSearchSuggestions: () => [],
    getRepository: () => null,
    getLatestRun: () => null
  };
  const asText = (payload: unknown): CallToolResult => ({ content: [{ type: "text", text: JSON.stringify(payload) }] });
  return { store, asText } as unknown as HandlerContext;
}

const call = (rows: ReturnType<typeof sym>[], profile = "compact") =>
  JSON.parse(
    (handleSearchSymbols({ query: "r1_probe", strategy: "name", limit: 50, compact: false, profile, ranked: false, excludeTests: false }, ctxReturning(rows)).content[0] as { text: string }).text
  ) as { count: number; symbols?: { name: string }[]; topSymbols?: { name: string }[]; nearby?: { name: string }[]; coverage: { confidence: string } | string };

test("an exact match is not padded: near-neighbours go to `nearby`, at most five", () => {
  const rows = [sym("r1_probe"), ...Array.from({ length: 49 }, (_, i) => sym(`other${String(i)}`, "fuzzy"))];
  const out = call(rows);
  assert.equal(out.count, 1);
  assert.deepEqual(out.symbols?.map((s) => s.name), ["r1_probe"]);
  assert.equal(out.nearby?.length, 5);
  const nano = call(rows, "nano");
  assert.deepEqual(nano.topSymbols?.map((s) => s.name), ["r1_probe"], "nano too");
});

test("no name match: `symbols` is empty, `nearby` holds the neighbours, coverage is low", () => {
  const out = call([sym("near1", "fuzzy"), sym("near2", "fuzzy")]);
  assert.equal(out.count, 0);
  assert.deepEqual(out.symbols, []);
  assert.equal(out.nearby?.length, 2);
  assert.equal(typeof out.coverage === "string" ? out.coverage : out.coverage.confidence, "low");
});

test("no fuzzy rows: no `nearby` field at all", () => {
  const out = call([sym("a"), sym("b")]);
  assert.equal(out.count, 2);
  assert.equal("nearby" in out, false);
});
