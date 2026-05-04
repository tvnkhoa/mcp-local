/**
 * index-self.mjs
 * Indexes the mcp-local workspace into a local SQLite DB for evaluation.
 * Run from: codebase-index-mcp/
 *   node scripts/index-self.mjs
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// mcp-local workspace root = one level above codebase-index-mcp/
const repoPath = path.resolve(__dirname, "../../");
const repoId = "mcp-local";
const dbPath = path.resolve(__dirname, "../mcp-local-index.db");

function readTextContent(result) {
  return Array.isArray(result?.content)
    ? (result.content.find((x) => x.type === "text")?.text ?? "<no text content>")
    : "<no text content>";
}

function readJson(result) {
  const text = readTextContent(result);
  try {
    return { text, json: JSON.parse(text) };
  } catch {
    return { text, json: null };
  }
}

async function main() {
  console.log(`[index-self] repoPath : ${repoPath}`);
  console.log(`[index-self] repoId   : ${repoId}`);
  console.log(`[index-self] dbPath   : ${dbPath}`);
  console.log("");

  const transport = new StdioClientTransport({
    command: "node",
    args: ["dist/index.js"],
    env: {
      ...process.env,
      CODEBASE_INDEX_DB_PATH: dbPath,
      CODEBASE_INDEX_ALLOWED_ROOTS: repoPath
    },
    stderr: "inherit"
  });

  transport.onerror = (error) => {
    console.error("[transport-error]", error);
  };

  const client = new Client({
    name: "index-self-client",
    version: "0.1.0"
  });

  await client.connect(transport);

  // --- health check ---
  const health = readJson(await client.callTool({ name: "health_check", arguments: { repoId } }));
  console.log("[health_check]", health.text);

  // --- index ---
  console.log("\n[index_repository] starting full index — this may take a minute...\n");
  const indexResult = readJson(
    await client.callTool(
      {
        name: "index_repository",
        arguments: { repoId, repoPath, mode: "full", maxFiles: 2000, batchSize: 100 }
      },
      undefined,
      { timeout: 300_000 }
    )
  );

  console.log("\n[index_repository] result:");
  if (indexResult.json) {
    const r = indexResult.json;
    console.log(`  status         : ${r.status}`);
    console.log(`  filesScanned   : ${r.filesScanned}`);
    console.log(`  filesIndexed   : ${r.filesIndexed}`);
    console.log(`  filesSkipped   : ${r.filesSkipped}`);
    console.log(`  symbolsUpserted: ${r.symbolsUpserted}`);
    console.log(`  edgesUpserted  : ${r.edgesUpserted}`);
    console.log(`  parseFailures  : ${r.parseFailures}`);
    console.log(`  crossRepoLinked: ${r.crossRepoLinked ?? 0}`);
    console.log(`  elapsedMs      : ${r.elapsedMs}`);
  } else {
    console.log(indexResult.text);
  }

  // --- list_repositories verify ---
  const repos = readJson(await client.callTool({ name: "list_repositories", arguments: {} }));
  console.log("\n[list_repositories]:");
  if (Array.isArray(repos.json)) {
    for (const r of repos.json) {
      console.log(`  ${r.repoId} | files=${r.filesIndexed} symbols=${r.symbolCount} status=${r.lastRunStatus}`);
    }
  } else {
    console.log(repos.text);
  }

  // --- quick search sanity check ---
  const searchResults = readJson(
    await client.callTool({
      name: "search_symbols",
      arguments: { query: "GraphStore", repoId, limit: 5 }
    })
  );
  console.log("\n[search_symbols] query=GraphStore:");
  if (searchResults.json?.symbols) {
    for (const s of searchResults.json.symbols) {
      console.log(`  ${s.name} (${s.kind}) @ ${s.filePath}:${s.line}`);
    }
    if (searchResults.json.symbols.length === 0) {
      console.log("  WARNING: no results — FTS may not be populated yet");
    }
  } else {
    console.log(searchResults.text);
  }

  await client.close();
  console.log("\n[index-self] done. Run: node scripts/eval-graph.mjs");
}

main().catch((error) => {
  console.error("[index-self] FAILED:", error);
  process.exit(1);
});
