/**
 * Live end-to-end verification of the CH-150 enhancement batch against a real index.
 * Boots dist/index.js over stdio, indexes the codebase-index-mcp repo (self), and exercises
 * the new/changed tools: orient, get_feature_bundle, change_impact, find_impact_files
 * (indexMeta freshness), and mode="dirty".
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { makeTempDbPath } from "./test/_fixtures.mjs";
import process from "node:process";

function text(res) {
  const t = res?.content?.find((c) => c.type === "text")?.text ?? "{}";
  return JSON.parse(t);
}

async function main() {
  const repoPath = process.cwd();
  const repoId = "verify-self";
  const transport = new StdioClientTransport({
    command: "node",
    args: ["dist/index.js"],
    env: {
      ...process.env,
      CODEBASE_INDEX_ALLOWED_ROOTS: repoPath,
      CODEBASE_INDEX_DB_PATH: process.env.CODEBASE_INDEX_DB_PATH ?? makeTempDbPath("cbi-verify-")
    },
    stderr: "pipe"
  });
  const client = new Client({ name: "verify", version: "0.1.0" });
  await client.connect(transport);

  // List tools — confirm the 3 new tools registered.
  const tools = (await client.listTools()).tools.map((t) => t.name);
  for (const t of ["orient", "get_feature_bundle", "change_impact"]) {
    if (!tools.includes(t)) throw new Error(`tool not registered: ${t}`);
  }
  console.log("TOOLS_REGISTERED_OK", { newTools: ["orient", "get_feature_bundle", "change_impact"] });

  await client.callTool({ name: "index_repository", arguments: { repoId, repoPath, mode: "full", maxFiles: 500 } }, undefined, { timeout: 180_000 });

  // 1. orient — deterministic router.
  const orient = text(await client.callTool({ name: "orient", arguments: { repoId, intent: "what breaks if I change GraphStore", seed: "GraphStore" } }));
  if (!orient.recommendedTools?.some((r) => r.tool === "find_impact_files")) throw new Error("orient: expected find_impact_files recommendation");
  if (!orient.seedSymbols?.length) throw new Error("orient: expected resolved seedSymbols");
  console.log("ORIENT_OK", { classifiedAs: orient.classifiedAs, tools: orient.recommendedTools.map((r) => r.tool), seeds: orient.seedSymbols.length });

  // 2. change_impact — composite (working-tree diff of the dirty self repo).
  const ci = text(await client.callTool({ name: "change_impact", arguments: { repoId } }));
  if (typeof ci.changedFileCount !== "number") throw new Error("change_impact: missing changedFileCount");
  if (!ci.coverage) throw new Error("change_impact: missing coverage block");
  console.log("CHANGE_IMPACT_OK", { changedFileCount: ci.changedFileCount, testsToRun: ci.testsToRun?.length ?? 0, confidence: ci.coverage.confidence });

  // 3. get_feature_bundle — TS repo has no C# slice; expect graceful low-confidence, not a crash.
  const fb = text(await client.callTool({ name: "get_feature_bundle", arguments: { repoId, seedSymbol: "GraphStore", includeSource: false } }));
  if (!fb.entity) throw new Error("get_feature_bundle: missing entity");
  console.log("FEATURE_BUNDLE_OK", { entity: fb.entity?.name ?? fb.entity, confidence: fb.coverage?.confidence, unresolvedRoles: fb.unresolvedRoles?.length });

  // 4. find_impact_files freshness — self repo is dirty, expect indexMeta with dirty info.
  const impact = text(await client.callTool({ name: "find_impact_files", arguments: { repoId, filePath: "src/graphStore.ts", view: "files" } }));
  if (!impact.indexMeta) throw new Error("find_impact_files: missing indexMeta");
  console.log("FIND_IMPACT_FRESHNESS_OK", { hasIndexLag: Boolean(impact.indexMeta.indexLag), dirtyCount: impact.indexMeta.indexLag?.dirtyCount ?? 0 });

  // 5. mode="dirty" — fast re-index of working-tree changes only.
  const dirty = text(await client.callTool({ name: "index_repository", arguments: { repoId, repoPath, mode: "dirty" } }));
  console.log("DIRTY_MODE_OK", { mode: dirty.mode, filesIndexed: dirty.filesIndexed, skipReason: dirty.skipReason ?? null });

  // 6. find_implementations coverage block present.
  const impl = text(await client.callTool({ name: "find_implementations", arguments: { repoId, interfaceName: "INonExistentInterface" } }));
  if (!impl.coverage) throw new Error("find_implementations: missing coverage block");
  console.log("FIND_IMPL_COVERAGE_OK", { count: impl.count, confidence: impl.coverage.confidence });

  await client.close();
  console.log("verify-enhancements: ALL PASS");
}

main().catch((err) => {
  console.error("verify-enhancements: FAILED:", err.message);
  process.exit(1);
});
