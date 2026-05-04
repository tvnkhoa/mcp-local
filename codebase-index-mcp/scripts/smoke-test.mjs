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
  console.log("TOOLS:", tools.tools.map((t) => t.name));

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

  if (!indexPayload.json || !flowPayload.json) {
    throw new Error("Smoke test received non-JSON text output from tool call.");
  }

  await client.close();
}

main().catch((error) => {
  console.error("SMOKE_TEST_FAILED:", error);
  process.exit(1);
});
