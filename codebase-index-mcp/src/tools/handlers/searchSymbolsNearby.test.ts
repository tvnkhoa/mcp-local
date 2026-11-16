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
    needsVectorPadding: () => false,
    getSearchSuggestions: () => [],
    getRepository: () => null,
    getLatestRun: () => null
  };
  const asText = (payload: unknown): CallToolResult => ({ content: [{ type: "text", text: JSON.stringify(payload) }] });
  return { store, asText } as unknown as HandlerContext;
}

const call = async (rows: ReturnType<typeof sym>[], profile = "compact") =>
  JSON.parse(
    ((await handleSearchSymbols({ query: "r1_probe", strategy: "name", limit: 50, compact: false, profile, ranked: false, excludeTests: false }, ctxReturning(rows))).content[0] as { text: string }).text
  ) as { count: number; symbols?: { name: string }[]; topSymbols?: { name: string }[]; nearby?: { name: string }[]; coverage: { confidence: string } | string };

test("an exact match is not padded: near-neighbours go to `nearby`, at most five", async () => {
  const rows = [sym("r1_probe"), ...Array.from({ length: 49 }, (_, i) => sym(`other${String(i)}`, "fuzzy"))];
  const out = await call(rows);
  assert.equal(out.count, 1);
  assert.deepEqual(out.symbols?.map((s) => s.name), ["r1_probe"]);
  assert.equal(out.nearby?.length, 5);
  const nano = await call(rows, "nano");
  assert.deepEqual(nano.topSymbols?.map((s) => s.name), ["r1_probe"], "nano too");
});

test("no name match: `symbols` is empty, `nearby` holds the neighbours, coverage is low", async () => {
  const out = await call([sym("near1", "fuzzy"), sym("near2", "fuzzy")]);
  assert.equal(out.count, 0);
  assert.deepEqual(out.symbols, []);
  assert.equal(out.nearby?.length, 2);
  assert.equal(typeof out.coverage === "string" ? out.coverage : out.coverage.confidence, "low");
});

test("no fuzzy rows: no `nearby` field at all", async () => {
  const out = await call([sym("a"), sym("b")]);
  assert.equal(out.count, 2);
  assert.equal("nearby" in out, false);
});

// MCP-ISSUE-132: the neighbours come from the vector-search worker (ctx.vectorSearch), never from a KNN on the server thread.
function paddingCtx(vectorSearch: HandlerContext["vectorSearch"]): HandlerContext {
  const asked: { repoId: string; text: string; k: number }[] = [];
  const store = {
    searchSymbols: () => [sym("exact1")],
    needsVectorPadding: (matches: number, repoId: string | null) => matches < 3 && repoId !== null,
    appendVectorNeighbours: (rows: ReturnType<typeof sym>[], _repoId: string, n: { symbolId: string }[]) => [...rows, ...n.map((x) => sym(x.symbolId, "fuzzy"))],
    getSearchSuggestions: () => [],
    getRepository: () => null,
    getLatestRun: () => null
  };
  const asText = (payload: unknown): CallToolResult => ({ content: [{ type: "text", text: JSON.stringify(payload) }] });
  const wrapped = vectorSearch && (async (repoId: string, text: string, k: number) => {
    asked.push({ repoId, text, k });
    return vectorSearch(repoId, text, k);
  });
  return { store, asText, ...(wrapped && { vectorSearch: wrapped }), asked } as unknown as HandlerContext;
}
type PadOut = { count: number; nearby?: { name: string }[]; paddingSkipped?: string; coverage: { knownGaps: string[] } };
const padCall = async (ctx: HandlerContext, repoId: string | null = "r"): Promise<PadOut> => {
  const res = await handleSearchSymbols({ query: "exact", repoId: repoId ?? undefined, strategy: "name", limit: 10, compact: false, profile: "compact", ranked: false, excludeTests: false }, ctx);
  return JSON.parse((res.content[0] as { text: string }).text) as PadOut;
};
const askedOf = (ctx: HandlerContext): unknown[] => (ctx as unknown as { asked: unknown[] }).asked;

test("ISSUE-132: neighbours from the worker land in `nearby`; the worker is asked with the query and limit", async () => {
  const ctx = paddingCtx(async () => ({ rows: [{ symbolId: "n1", distance: 0.1 }, { symbolId: "n2", distance: 0.2 }] }));
  const out = await padCall(ctx);
  assert.equal(out.count, 1);
  assert.deepEqual(out.nearby?.map((s) => s.name), ["n1", "n2"]);
  assert.equal("paddingSkipped" in out, false);
  assert.deepEqual(askedOf(ctx), [{ repoId: "r", text: "exact", k: 10 }]);
});

test("ISSUE-132: a missing worker answer is reported (paddingSkipped + a coverage gap), never silent", async () => {
  for (const reason of ["budget", "queue", "error"] as const) {
    const out = await padCall(paddingCtx(async () => ({ skipped: reason })));
    assert.equal(out.count, 1, reason);
    assert.equal(out.paddingSkipped, reason);
    assert.equal(out.nearby, undefined, reason);
    assert.match(out.coverage.knownGaps[0] ?? "", /near-neighbours \(nearby\) were not searched/, reason);
  }
  const none = await padCall(paddingCtx(undefined));
  assert.equal(none.paddingSkipped, "unavailable");
});

test("ISSUE-132: no repoId, no padding and no worker call", async () => {
  const ctx = paddingCtx(async () => ({ rows: [{ symbolId: "n1", distance: 0.1 }] }));
  const out = await padCall(ctx, null);
  assert.equal(out.nearby, undefined);
  assert.equal("paddingSkipped" in out, false);
  assert.deepEqual(askedOf(ctx), []);
});
