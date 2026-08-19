import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// End-to-end smoke test for sqlserver-mcp. Requires a build (dist/index.js) and a REAL SQL Server:
//   SQLSERVER_CONNECTION="data source=…;initial catalog=…;User Id=…;Password=…" \
//     npm run build && npm run smoke
//
// Every server answers to `npm run smoke`, which is what `verify:live` drives. This one stays
// strictly read-only — it never calls execute_routine, whatever SQLSERVER_EXEC_ENABLED says.

function textOf(result) {
  const content = Array.isArray(result.content) ? result.content : [];
  return content.find((x) => x.type === "text")?.text ?? "<no text content>";
}

function jsonOf(result) {
  try {
    return JSON.parse(textOf(result));
  } catch {
    return null;
  }
}

async function main() {
  const transport = new StdioClientTransport({
    command: "node",
    args: ["dist/index.js"],
    env: process.env,
    stderr: "pipe"
  });
  transport.onerror = (error) => console.error("[transport-error]", error);

  const client = new Client({ name: "sqlserver-mcp-smoke-test", version: "0.1.0" });
  await client.connect(transport);

  const tools = await client.listTools();
  console.log("TOOLS:", tools.tools.map((t) => t.name).join(", "));

  const health = await client.callTool({ name: "health_check", arguments: { profile: "standard" } });
  console.log("\nHEALTH_CHECK:\n" + textOf(health));

  const healthPayload = jsonOf(health);
  if (healthPayload?.status !== "ok") {
    throw new Error("health_check did not report ok — is SQLSERVER_CONNECTION set and reachable?");
  }

  // The instance-level assumption behind the guardrail's four-part-name rule. Not fatal if it has
  // changed, but it must be visible.
  const linked = healthPayload?.probe?.linkedServerCount;
  console.log(`\nLINKED SERVERS: ${linked}`);
  if (typeof linked === "number" && linked > 0) {
    console.warn(
      "WARNING: linked servers are configured on this instance. The four-part-name refusal in " +
        "middleware/sqlGuardrails.ts assumes they are unused — re-check that assumption."
    );
  }

  const databases = await client.callTool({ name: "list_databases", arguments: { profile: "compact" } });
  const dbPayload = jsonOf(databases);
  const names = (dbPayload?.databases ?? []).filter((d) => d.accessible).map((d) => d.name);
  console.log(`\nDATABASES (${names.length} accessible): ${names.slice(0, 20).join(", ")}`);
  if (names.length === 0) {
    throw new Error("list_databases returned no accessible catalog — check the login's permissions.");
  }

  const target = names[0];

  const tables = await client.callTool({
    name: "list_tables",
    arguments: { database: target, profile: "nano" }
  });
  console.log(`\nLIST_TABLES (${target}): ${textOf(tables).slice(0, 400)}`);

  const routines = await client.callTool({
    name: "list_routines",
    arguments: { database: target, type: "procedure", profile: "nano" }
  });
  console.log(`\nLIST_ROUTINES (${target}, procedures): ${textOf(routines).slice(0, 400)}`);

  const crossDb = await client.callTool({
    name: "find_cross_database_references",
    arguments: { database: target, profile: "compact" }
  });
  const crossPayload = jsonOf(crossDb);
  console.log(
    `\nCROSS_DB (${target}): ${crossPayload?.referenceCount ?? "?"} reference(s) into ` +
      `${(crossPayload?.targets ?? []).map((t) => `${t.database}(${t.referenceCount})`).join(", ") || "no other catalog"}`
  );
  console.log(`  coverage: ${crossPayload?.coverage?.note ?? "?"}`);

  const query = await client.callTool({
    name: "run_read_query",
    arguments: { database: target, sql: "select top (3) name from sys.objects order by name", profile: "standard" }
  });
  console.log("\nRUN_READ_QUERY:\n" + textOf(query).slice(0, 600));

  // The guardrail must refuse this, over the wire, not merely in a unit test.
  const refused = await client.callTool({
    name: "run_read_query",
    arguments: { database: target, sql: "select 1; drop table nope" }
  });
  if (refused.isError !== true) {
    throw new Error("guardrail did not refuse a multi-statement query");
  }
  console.log("\nGUARDRAIL REFUSAL (expected):\n" + textOf(refused));

  await client.close();
  console.log("\nOK");
}

main().catch((error) => {
  console.error("SMOKE TEST FAILED:", error);
  process.exit(1);
});
