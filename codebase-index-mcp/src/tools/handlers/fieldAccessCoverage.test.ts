import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { GraphStore } from "../../repositories/graphStore.js";
import { createIndexRunner } from "../../services/indexing/indexRunner.js";
import { handleFindFieldAccesses } from "./impactHandler.js";
import type { HandlerContext } from "./handlerContext.js";

/**
 * `find_field_accesses` must not answer a field it cannot see with a confident count.
 *
 * Measured on wec.aria (2026-10-20): `kb_version_ids`, a Zod `z.object` key read across two packages,
 * returned 0 reads, 0 writes and `coverage: "high"`. Two causes, both covered here: a name with no
 * `property` symbol was answered by whatever symbol shared it (`candidates[0]`), and the TS/JS lane —
 * which emits property edges only for `this.<member>` — was reported as complete.
 */

const REPO = "field-access-coverage";

const CONTRACT = `import { z } from "zod";

export const TurnSchema = z.object({
  kb_version_ids: z.array(z.string()),
});

export function kb_version_ids_of(turn: { kb_version_ids: string[] }): string[] {
  return turn.kb_version_ids;
}
`;

const SERVICE = `export class Counter {
  count = 0;

  bump(): number {
    this.count = this.count + 1;
    return this.count;
  }
}
`;

function ctxFor(store: GraphStore): HandlerContext {
  const asText = (payload: unknown): CallToolResult => ({ content: [{ type: "text", text: JSON.stringify(payload) }] });
  return { store, asText } as unknown as HandlerContext;
}

function payloadOf(result: CallToolResult): Record<string, unknown> {
  const first = result.content[0];
  assert.ok(first && first.type === "text");
  return JSON.parse(first.text) as Record<string, unknown>;
}

test("find_field_accesses is honest about TS fields the graph cannot count", async () => {
  const repoPath = mkdtempSync(path.join(tmpdir(), "cim-field-cov-"));
  const dbDir = mkdtempSync(path.join(tmpdir(), "cim-field-cov-db-"));
  const store = new GraphStore(path.join(dbDir, "graph.db"));
  try {
    writeFileSync(path.join(repoPath, "contract.ts"), CONTRACT);
    writeFileSync(path.join(repoPath, "counter.ts"), SERVICE);
    await createIndexRunner({
      store,
      limits: { subtxSize: 20, checkpointEveryNBatches: 1, largeFileThresholdBytes: 512 * 1024, maxFileSizeBytes: 500 * 1024, parseWorkers: 0, parseJobTimeoutMs: 20_000 },
      resolvePerformanceProfileOverride: () => "auto"
    })(REPO, repoPath, "full", false, 1000, 50);
    const ctx = ctxFor(store);

    // A Zod key is not a property symbol; a same-named function exists. It must NOT be substituted.
    const zod = payloadOf(await handleFindFieldAccesses({ repoId: REPO, name: "kb_version_ids", mode: "all", limit: 50, excludeTests: false, profile: "compact" }, ctx));
    assert.equal(zod.property, null, "no property symbol: nothing may be substituted for it");
    const zodCoverage = zod.coverage as { confidence: string; knownGaps: string[] };
    assert.equal(zodCoverage.confidence, "low");
    assert.ok(zodCoverage.knownGaps.some((g) => g.includes("no symbol of kind 'property'")), JSON.stringify(zodCoverage));
    const others = (zod.otherMatches ?? []) as { name: string; kind: string }[];
    assert.ok(others.some((o) => o.name === "kb_version_ids_of"), `same-named symbols are listed, not used: ${JSON.stringify(others)}`);

    // A TS class property the graph DOES see (`this.count`) is still only a lower bound.
    const counter = payloadOf(await handleFindFieldAccesses({ repoId: REPO, name: "count", mode: "all", limit: 50, excludeTests: false, profile: "compact" }, ctx));
    assert.equal((counter.property as { name: string }).name, "count");
    const counterCoverage = counter.coverage as { confidence: string; knownGaps: string[] };
    assert.notEqual(counterCoverage.confidence, "high", JSON.stringify(counter));
    assert.ok(counterCoverage.knownGaps.some((g) => g.includes("TS/JS property edges cover only")));
  } finally {
    store.close();
    rmSync(repoPath, { recursive: true, force: true });
    rmSync(dbDir, { recursive: true, force: true });
  }
});
