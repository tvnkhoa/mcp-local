/**
 * Tests profile behavior for impact and list tools that newly support nano/compact/standard/verbose.
 * Tools covered: find_impact_files, get_dependency_graph, get_call_chain, get_file_summary, list_repositories
 *
 * Usage: node scripts/test-profile-responses.mjs
 * Requires: npm run build first, and an indexed repo (uses the smoke-test-repo from the current working dir)
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

function readTextContent(result) {
  return Array.isArray(result?.content)
    ? (result.content.find((x) => x.type === "text")?.text ?? "<no text content>")
    : "<no text content>";
}

function readJson(result) {
  const text = readTextContent(result);
  try { return { text, json: JSON.parse(text) }; } catch { return { text, json: null }; }
}

function bytesOf(text) { return Buffer.byteLength(text, "utf8"); }

let passed = 0;
let failed = 0;

function assert(condition, label, details = "") {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ FAIL: ${label}${details ? ` — ${details}` : ""}`);
    failed++;
  }
}

async function main() {
  const repoPath = process.cwd();
  const repoId = "profile-test-repo";

  const transport = new StdioClientTransport({
    command: "node",
    args: ["dist/index.js"],
    env: { ...process.env, CODEBASE_INDEX_ALLOWED_ROOTS: process.env.CODEBASE_INDEX_ALLOWED_ROOTS ?? repoPath },
    stderr: "pipe"
  });
  transport.onerror = (e) => console.error("[transport-error]", e);

  const client = new Client({ name: "profile-test", version: "0.1.0" });
  await client.connect(transport);

  // Index current directory (bounded sample)
  console.log("\n[setup] Indexing current repo...");
  const indexResult = await client.callTool({
    name: "index_repository",
    arguments: { repoId, repoPath, mode: "full", maxFiles: 100 }
  }, undefined, { timeout: 60_000 });
  const indexJson = readJson(indexResult).json;
  if (!indexJson?.runId) throw new Error("Indexing failed — no runId returned");
  console.log(`  indexed: ${indexJson.filesIndexed} files, ${indexJson.symbolsUpserted} symbols`);

  // ── list_repositories ─────────────────────────────────────────────────────
  console.log("\n[list_repositories] profile tests");
  const listNano = await client.callTool({ name: "list_repositories", arguments: { profile: "nano" } });
  const listStd = await client.callTool({ name: "list_repositories", arguments: {} });
  const nanoText = readTextContent(listNano);
  const stdText = readTextContent(listStd);
  const nanoJson = readJson(listNano).json;

  assert(bytesOf(nanoText) < bytesOf(stdText), "nano < standard bytes", `nano=${bytesOf(nanoText)}, std=${bytesOf(stdText)}`);
  assert(typeof nanoJson?.count === "number", "nano has count field");
  assert(Array.isArray(nanoJson?.repos), "nano has repos array");
  if (Array.isArray(nanoJson?.repos) && nanoJson.repos.length > 0) {
    const r = nanoJson.repos[0];
    assert("repoId" in r && "lastRunStatus" in r, "nano repo has repoId + lastRunStatus");
    assert(!("updatedAt" in r) && !("symbolCount" in r), "nano repo omits verbose fields");
  }

  // ── get_file_summary ──────────────────────────────────────────────────────
  console.log("\n[get_file_summary] profile tests");
  const summaryNano = await client.callTool({ name: "get_file_summary", arguments: { repoId, filePath: "src/index.ts", profile: "nano" } });
  const summaryCompact = await client.callTool({ name: "get_file_summary", arguments: { repoId, filePath: "src/index.ts", profile: "compact" } });
  const summaryNanoJson = readJson(summaryNano).json;
  const nanoBytes = bytesOf(readTextContent(summaryNano));
  const compactBytes = bytesOf(readTextContent(summaryCompact));

  assert(nanoBytes <= compactBytes, "nano <= compact bytes", `nano=${nanoBytes}, compact=${compactBytes}`);
  assert(typeof summaryNanoJson?.symbolCount === "number", "nano has symbolCount");
  assert(Array.isArray(summaryNanoJson?.topSymbols), "nano has topSymbols array");
  if (Array.isArray(summaryNanoJson?.topSymbols)) {
    assert(summaryNanoJson.topSymbols.length <= 5, "nano topSymbols limited to 5");
  }

  // ── get_dependency_graph ──────────────────────────────────────────────────
  console.log("\n[get_dependency_graph] profile tests");
  const depNano = await client.callTool({ name: "get_dependency_graph", arguments: { repoId, filePath: "src/index.ts", profile: "nano" } });
  const depCompact = await client.callTool({ name: "get_dependency_graph", arguments: { repoId, filePath: "src/index.ts", profile: "compact" } });
  const depNanoJson = readJson(depNano).json;
  const depNanoBytes = bytesOf(readTextContent(depNano));
  const depCompactBytes = bytesOf(readTextContent(depCompact));

  assert(depNanoBytes <= depCompactBytes, "nano <= compact bytes", `nano=${depNanoBytes}, compact=${depCompactBytes}`);
  assert(typeof depNanoJson?.edgeCount === "number", "nano has edgeCount");
  assert(Array.isArray(depNanoJson?.topEdges), "nano has topEdges");
  assert(typeof depNanoJson?.hasMore === "boolean", "nano has hasMore");
  if (Array.isArray(depNanoJson?.topEdges)) {
    assert(depNanoJson.topEdges.length <= 10, "nano topEdges limited to 10");
  }

  // ── find_impact_files ─────────────────────────────────────────────────────
  console.log("\n[find_impact_files] profile tests");
  const impactNano = await client.callTool({ name: "find_impact_files", arguments: { repoId, filePath: "src/graphStore.ts", profile: "nano" } });
  const impactCompact = await client.callTool({ name: "find_impact_files", arguments: { repoId, filePath: "src/graphStore.ts", profile: "compact" } });
  const impactNanoJson = readJson(impactNano).json;
  const impactNanoBytes = bytesOf(readTextContent(impactNano));
  const impactCompactBytes = bytesOf(readTextContent(impactCompact));

  assert(impactNanoBytes <= impactCompactBytes, "nano <= compact bytes", `nano=${impactNanoBytes}, compact=${impactCompactBytes}`);
  assert(typeof impactNanoJson?.totalFiles === "number", "nano has totalFiles");
  assert(Array.isArray(impactNanoJson?.topFiles), "nano has topFiles");
  assert(typeof impactNanoJson?.hasMore === "boolean", "nano has hasMore");
  if (Array.isArray(impactNanoJson?.topFiles)) {
    assert(impactNanoJson.topFiles.length <= 10, "nano topFiles limited to 10");
  }

  // ── get_call_chain ────────────────────────────────────────────────────────
  console.log("\n[get_call_chain] profile tests");
  // Find a callable symbol first
  const searchResult = await client.callTool({ name: "search_symbols", arguments: { repoId, query: "runIndexAndResolve", strategy: "name", profile: "nano", limit: 1 } });
  const searchJson = readJson(searchResult).json;
  const symbolId = searchJson?.symbols?.[0]?.symbolId ?? searchJson?.candidates?.[0]?.symbolId ?? null;

  if (symbolId) {
    const chainNano = await client.callTool({ name: "get_call_chain", arguments: { repoId, symbolId, direction: "callers", profile: "nano" } });
    const chainCompact = await client.callTool({ name: "get_call_chain", arguments: { repoId, symbolId, direction: "callers", profile: "compact" } });
    const chainNanoJson = readJson(chainNano).json;
    const chainNanoBytes = bytesOf(readTextContent(chainNano));
    const chainCompactBytes = bytesOf(readTextContent(chainCompact));

    assert(chainNanoBytes <= chainCompactBytes, "nano <= compact bytes", `nano=${chainNanoBytes}, compact=${chainCompactBytes}`);
    assert(typeof chainNanoJson?.chainLength === "number", "nano has chainLength");
    assert(Array.isArray(chainNanoJson?.path), "nano has path");
    assert(typeof chainNanoJson?.truncated === "boolean", "nano has truncated");
  } else {
    console.log("  [skip] get_call_chain — no callable symbol found for this repo");
  }

  // ── summary ───────────────────────────────────────────────────────────────
  console.log(`\n[results] ${passed} passed, ${failed} failed`);
  await client.close();
  if (failed > 0) process.exit(1);
}

main().catch((err) => { console.error("[fatal]", err); process.exit(1); });
