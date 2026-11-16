import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { GraphStore } from "../../repositories/graphStore.js";
import { isVectorEnabled } from "../../repositories/vectorStore.js";
import { createIndexRunner } from "../indexing/indexRunner.js";
import { handleSearchSymbols } from "../../tools/handlers/searchHandler.js";
import type { HandlerContext } from "../../tools/handlers/handlerContext.js";

/**
 * Release J removed the RESOLVER's vector fallback (MCP-ISSUE-084), not vector search. `search_symbols`
 * still pads a thin FTS answer with vector neighbours, labelled `fuzzy` (MCP-ISSUE-058(b)): a misspelt
 * name finds the symbol it was meant to, through the vector index the run builds.
 *
 * MCP-ISSUE-132: the padding is the handler's, from the vector-search worker (`ctx.vectorSearch`); the store's
 * search no longer runs a KNN on the calling thread. Here `ctx.vectorSearch` is the store's own KNN, so the test
 * covers the ranking and the labelling; vectorSearchWorkerClient.test.ts spawns the real (bundled) worker.
 */

test("search_symbols still answers a near-miss spelling from the vector index, labelled fuzzy", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "cim-vec-search-"));
  const store = new GraphStore(path.join(dir, "index.db"));
  try {
    if (!isVectorEnabled()) return; // sqlite-vec not loadable here; vectorStore.test.ts covers the store itself
    const repo = path.join(dir, "repo");
    mkdirSync(repo);
    writeFileSync(
      path.join(repo, "handlers.ts"),
      "export function ManualOutboundHandler(): number {\n  return 1;\n}\n\nexport function renderInvoiceTotals(): string {\n  return \"\";\n}\n"
    );
    const run = createIndexRunner({
      store,
      limits: { subtxSize: 20, checkpointEveryNBatches: 1, largeFileThresholdBytes: 512 * 1024, maxFileSizeBytes: 500 * 1024, parseWorkers: 0, parseJobTimeoutMs: 20_000 },
      resolvePerformanceProfileOverride: () => "auto"
    });
    const summary = await run("vec-search", repo, "full", false, 100, 50);
    assert.ok((summary.vectorSymbolsIndexed ?? 0) >= 2, "the run builds the vector index");

    assert.deepEqual(store.searchSymbols("ManualOutbondHandlr", "vec-search", null, null, null, 5, "name"), [], "the store itself never pads (one path)");
    const ctx = {
      store,
      vectorSearch: async (repoId: string, text: string, k: number) => ({ rows: store.vectorSearchSymbols(repoId, text, k) }),
      asText: (payload: unknown) => ({ content: [{ type: "text", text: JSON.stringify(payload) }] })
    } as unknown as HandlerContext;
    const res = await handleSearchSymbols({ query: "ManualOutbondHandlr", repoId: "vec-search", strategy: "name", limit: 5, compact: false, profile: "compact", ranked: false, excludeTests: false }, ctx);
    const out = JSON.parse((res.content[0] as { text: string }).text) as { count: number; nearby?: { name: string; matchType?: string }[] };
    const hit = out.nearby?.find((h) => h.name === "ManualOutboundHandler");
    assert.ok(hit, "the misspelt name finds the symbol through the vector index");
    assert.equal(out.count, 0, "not passed off as a name match");
    assert.equal(hit.matchType, "fuzzy", "a vector neighbour is labelled");
    // `intent` splits the query into tokens, so its FTS already matches here.
    const intent = store.searchSymbols("manual outbound handler", "vec-search", null, null, null, 5, "intent");
    assert.ok(intent.some((h) => h.name === "ManualOutboundHandler"), "intent search still finds it");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
