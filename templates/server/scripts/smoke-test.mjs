import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// End-to-end smoke test for __DIR__. Requires a build (dist/index.js).
//   npm run build && node scripts/smoke-test.mjs
//
// Every server answers to `npm run smoke`, which is what `verify:live` drives. Keep this
// read-only: it is run against real environments.

function textOf(result) {
  const content = Array.isArray(result.content) ? result.content : [];
  return content.find((x) => x.type === "text")?.text ?? "<no text content>";
}

async function main() {
  const transport = new StdioClientTransport({
    command: "node",
    args: ["dist/index.js"],
    env: process.env,
    stderr: "pipe"
  });
  transport.onerror = (error) => console.error("[transport-error]", error);

  const client = new Client({ name: "__DIR__-smoke-test", version: "0.1.0" });
  await client.connect(transport);

  const tools = await client.listTools();
  console.log("TOOLS:", tools.tools.map((t) => t.name));

  const health = await client.callTool({
    name: "health_check",
    arguments: { profile: "standard" }
  });
  console.log("\nHEALTH_CHECK:\n" + textOf(health));

  const echo = await client.callTool({
    name: "echo",
    arguments: { message: "smoke", profile: "standard" }
  });
  console.log("\nECHO:\n" + textOf(echo));

  await client.close();
  console.log("\nOK");
}

main().catch((error) => {
  console.error("SMOKE TEST FAILED:", error);
  process.exit(1);
});
