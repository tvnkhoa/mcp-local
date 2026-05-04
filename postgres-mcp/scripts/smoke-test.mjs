import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

async function main() {
  const transport = new StdioClientTransport({
    command: "node",
    args: ["dist/index.js"],
    env: process.env,
    stderr: "pipe"
  });

  transport.onerror = (error) => {
    console.error("[transport-error]", error);
  };

  const client = new Client({
    name: "postgres-mcp-smoke-test",
    version: "0.1.0"
  });

  await client.connect(transport);

  const tools = await client.listTools();
  console.log("TOOLS:", tools.tools.map((t) => t.name));

  const result = await client.callTool({
    name: "run_read_query",
    arguments: {
      sql: "select table_name from information_schema.tables where table_schema = 'public' order by table_name",
      limit: 10,
      timeoutMs: 10000,
      requestId: "smoke-test-001"
    }
  });

  const content = Array.isArray(result.content) ? result.content : [];
  const text = content.find((x) => x.type === "text")?.text ?? "<no text content>";
  console.log("RUN_READ_QUERY_RESULT:");
  console.log(text);

  await client.close();
}

main().catch((error) => {
  console.error("SMOKE_TEST_FAILED:", error);
  process.exit(1);
});
