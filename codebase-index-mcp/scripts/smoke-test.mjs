import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

function readTextContent(result) {
  return Array.isArray(result?.content)
    ? (result.content.find((x) => x.type === "text")?.text ?? "<no text content>")
    : "<no text content>";
}

function readJsonTextContent(result) {
  const text = readTextContent(result);
  try {
    return { text, json: JSON.parse(text) };
  } catch {
    return { text, json: null };
  }
}

function bytesOf(text) {
  return Buffer.byteLength(text, "utf8");
}

async function main() {
  const repoPath = process.cwd();
  const repoId = "smoke-test-repo";

  const transport = new StdioClientTransport({
    command: "node",
    args: ["dist/index.js"],
    env: {
      ...process.env,
      CODEBASE_INDEX_ALLOWED_ROOTS: process.env.CODEBASE_INDEX_ALLOWED_ROOTS ?? repoPath
    },
    stderr: "pipe"
  });

  transport.onerror = (error) => {
    console.error("[transport-error]", error);
  };

  const client = new Client({
    name: "codebase-index-mcp-smoke-test",
    version: "0.1.0"
  });

  await client.connect(transport);

  const tools = await client.listTools();
  const toolNames = tools.tools.map((t) => t.name);
  console.log("TOOLS:", toolNames);

  const requiredTools = [
    "get_context_by_name",
    "get_change_context_by_name",
    "get_symbol_candidates",
    "watch_repo"
  ];
  for (const required of requiredTools) {
    if (!toolNames.includes(required)) {
      throw new Error(`Missing required tool in listTools: ${required}`);
    }
  }

  const health = await client.callTool({
    name: "health_check",
    arguments: {
      repoId
    }
  });

  const healthText = readTextContent(health);

  console.log("HEALTH_CHECK_RESULT:");
  console.log(healthText);

  const indexResult = await client.callTool({
    name: "index_repository",
    arguments: {
      repoId,
      repoPath,
      mode: "incremental",
      maxFiles: 200
    }
  }, undefined, { timeout: 180_000 });

  const indexPayload = readJsonTextContent(indexResult);
  console.log("INDEX_REPOSITORY_RESULT:");
  console.log(indexPayload.text);
  if (!indexPayload.json?.runId) {
    throw new Error("index_repository result missing runId");
  }

  const healthAfterIndex = await client.callTool({
    name: "health_check",
    arguments: {
      repoId
    }
  });
  const healthAfterIndexJson = readJsonTextContent(healthAfterIndex).json;
  if (!healthAfterIndexJson?.latestRun?.runId) {
    throw new Error("health_check did not return latestRun after indexing");
  }
  if (healthAfterIndexJson.latestRun.runId !== indexPayload.json.runId) {
    throw new Error(
      `Expected health_check.latestRun.runId to match index runId (${indexPayload.json.runId}), got ${healthAfterIndexJson.latestRun.runId}`
    );
  }

  const flowResult = await client.callTool({
    name: "get_module_flow",
    arguments: {
      repoId,
      filePath: "src/index.ts",
      limit: 20
    }
  });

  const flowPayload = readJsonTextContent(flowResult);
  console.log("MODULE_FLOW_RESULT:");
  console.log(flowPayload.text);
  if (!Array.isArray(flowPayload.json?.edges) || flowPayload.json.edges.length === 0) {
    throw new Error("get_module_flow returned no edges for src/index.ts");
  }
  if (typeof flowPayload.json?.unresolvedCalls?.count !== "number") {
    throw new Error("get_module_flow missing unresolvedCalls.count field");
  }

  const fileSummary = await client.callTool({
    name: "get_file_summary",
    arguments: {
      repoId,
      filePath: "src/index.ts"
    }
  });
  const fileSummaryJson = readJsonTextContent(fileSummary).json;
  if (fileSummaryJson?.file?.language !== "typescript") {
    throw new Error(`Expected get_file_summary language=typescript, got ${String(fileSummaryJson?.file?.language)}`);
  }
  if (!Array.isArray(fileSummaryJson?.exports) || fileSummaryJson.exports.length === 0) {
    throw new Error("Expected get_file_summary exports to be non-empty for src/index.ts");
  }

  const contextByNameStandard = await client.callTool({
    name: "get_context_by_name",
    arguments: {
      repoId,
      name: "runIndexAndResolve",
      limit: 20,
      profile: "standard"
    }
  });

  const contextByNameCompact = await client.callTool({
    name: "get_context_by_name",
    arguments: {
      repoId,
      name: "runIndexAndResolve",
      limit: 20,
      profile: "compact"
    }
  });

  const contextByNameVerbose = await client.callTool({
    name: "get_context_by_name",
    arguments: {
      repoId,
      name: "runIndexAndResolve",
      limit: 20,
      profile: "verbose"
    }
  });

  const contextStdText = readTextContent(contextByNameStandard);
  const contextCmpText = readTextContent(contextByNameCompact);
  const contextVrbText = readTextContent(contextByNameVerbose);
  const contextCmpJson = readJsonTextContent(contextByNameCompact).json;
  if (!contextCmpJson || !contextCmpJson.symbol) {
    throw new Error("get_context_by_name(compact) did not return a symbol");
  }

  const standardBytes = bytesOf(contextStdText);
  const compactBytes = bytesOf(contextCmpText);
  const verboseBytes = bytesOf(contextVrbText);
  if (compactBytes > standardBytes) {
    throw new Error(`Expected compact payload <= standard payload (compact=${compactBytes}, standard=${standardBytes})`);
  }
  if (verboseBytes < standardBytes) {
    throw new Error(`Expected verbose payload >= standard payload (verbose=${verboseBytes}, standard=${standardBytes})`);
  }

  console.log("CONTEXT_PROFILE_BYTES:", {
    standardBytes,
    compactBytes,
    verboseBytes
  });

  const changeByName = await client.callTool({
    name: "get_change_context_by_name",
    arguments: {
      repoId,
      name: "runIndexAndResolve",
      callerDepth: 2,
      calleeDepth: 1,
      limit: 20,
      profile: "compact"
    }
  });
  const changeByNameJson = readJsonTextContent(changeByName).json;
  if (!changeByNameJson || !changeByNameJson.symbol) {
    throw new Error("get_change_context_by_name(compact) returned no symbol");
  }

  const symbolCandidates = await client.callTool({
    name: "get_symbol_candidates",
    arguments: {
      repoId,
      name: "GraphStore",
      limit: 10,
      profile: "compact"
    }
  });
  const symbolCandidatesJson = readJsonTextContent(symbolCandidates).json;
  if (!symbolCandidatesJson || !Array.isArray(symbolCandidatesJson.candidates) || symbolCandidatesJson.candidates.length === 0) {
    throw new Error("get_symbol_candidates(compact) returned empty candidates");
  }

  if (!indexPayload.json || !flowPayload.json) {
    throw new Error("Smoke test received non-JSON text output from tool call.");
  }

  await client.close();
}

main().catch((error) => {
  console.error("SMOKE_TEST_FAILED:", error);
  process.exit(1);
});
