import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// End-to-end smoke test. Requires a build (dist/index.js) and real OpenObserve
// credentials in the environment (OBSERVE_USERNAME/OBSERVE_PASSWORD or
// OBSERVE_AUTH_BASIC). Run: npm run build && node scripts/smoke-test.mjs

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

  const client = new Client({ name: "observe-mcp-smoke-test", version: "0.1.0" });
  await client.connect(transport);

  const tools = await client.listTools();
  console.log("TOOLS:", tools.tools.map((t) => t.name));

  // 1. Configured environments — credential-free, so it fails before the network does.
  const envs = await client.callTool({ name: "list_environments", arguments: { profile: "standard" } });
  console.log("\nLIST_ENVIRONMENTS:\n" + textOf(envs));

  // 2. Connectivity + auth check.
  const streams = await client.callTool({ name: "list_streams", arguments: { type: "logs", profile: "standard" } });
  console.log("\nLIST_STREAMS:\n" + textOf(streams));

  // 3. Which services actually exist, and pick a real one for the log query below.
  // Hard-coding a service name is what made this test vacuous before: it filtered on
  // `CommunicationHub.Web`, which exists only in the TRACES lane, so search_logs
  // matched nothing and the test still "passed".
  const discovered = await client.callTool({
    name: "discover_services",
    arguments: { time: "1h", limit: 10, include: ["codeLinks"], profile: "standard" }
  });
  console.log("\nDISCOVER_SERVICES:\n" + textOf(discovered));

  let service;
  try {
    service = JSON.parse(textOf(discovered))?.services?.find((s) => s.logCount > 0)?.name;
  } catch {
    service = undefined;
  }

  // 4. Recent logs — inspect a raw hit to confirm field mapping.
  const logs = await client.callTool({
    name: "search_logs",
    arguments: { ...(service ? { service } : {}), time: "15m", limit: 5, profile: "standard" }
  });
  console.log(`\nSEARCH_LOGS (service=${service ?? "<any>"}):\n` + textOf(logs));

  // 5. If a trace id turns up, trace it end to end.
  try {
    const parsed = JSON.parse(textOf(logs));
    const traceId = parsed?.logs?.map((l) => l.traceId).find((t) => t);
    if (traceId) {
      const trace = await client.callTool({
        name: "trace_logs",
        arguments: { traceId, time: "1h", profile: "standard" }
      });
      console.log(`\nTRACE_LOGS (${traceId}):\n` + textOf(trace));
    } else {
      console.log("\nTRACE_LOGS: skipped (no trace id in recent logs)");
    }
  } catch (error) {
    console.log("\nTRACE_LOGS: skipped (could not parse search_logs output)", error);
  }

  // 6. Error/warning summary.
  const stats = await client.callTool({ name: "log_stats", arguments: { time: "1h", profile: "standard" } });
  console.log("\nLOG_STATS:\n" + textOf(stats));

  await client.close();
}

main().catch((error) => {
  console.error("SMOKE_TEST_FAILED:", error);
  process.exit(1);
});
