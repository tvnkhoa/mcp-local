import { existsSync } from "node:fs";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// End-to-end smoke test for board-mcp. Requires a build (dist/index.js).
//   npm run build && node scripts/smoke-test.mjs
//
// READ-ONLY, always: BOARD_WRITE_ENABLED is forced to false for the child, whatever the caller's
// environment says — the live board in wec.aria is shared by several sessions. It runs health_check,
// then `next` and `assess` against BOARD_REPO_ROOT (default: the wec.aria checkout, when present).

const DEFAULT_ROOT = "D:/1.SourceCode/crm/wec.aria";

function textOf(result) {
  const content = Array.isArray(result.content) ? result.content : [];
  return content.find((x) => x.type === "text")?.text ?? "<no text content>";
}

async function main() {
  const root = process.env.BOARD_REPO_ROOT || DEFAULT_ROOT;
  const haveBoard = path.isAbsolute(root) && existsSync(path.join(root, "checks", "board", "board.mjs"));
  const env = { ...process.env, BOARD_REPO_ROOT: root, BOARD_WRITE_ENABLED: "false" };

  const transport = new StdioClientTransport({ command: "node", args: ["dist/index.js"], env, stderr: "pipe" });
  transport.onerror = (error) => console.error("[transport-error]", error);

  const client = new Client({ name: "board-mcp-smoke-test", version: "0.1.0" });
  await client.connect(transport);

  const tools = await client.listTools();
  console.log("TOOLS:", tools.tools.map((t) => t.name));

  const health = await client.callTool({ name: "health_check", arguments: { profile: "standard" } });
  console.log("\nHEALTH_CHECK:\n" + textOf(health));

  if (!haveBoard) {
    console.log(`\nNo checks/board/board.mjs under ${root} — skipping the board reads.`);
  } else {
    for (const [name, args] of [["next", {}], ["assess", { kind: "screen", yes: [] }]]) {
      const r = await client.callTool({ name, arguments: { ...args, profile: "standard" } });
      const text = textOf(r);
      console.log(`\n${name.toUpperCase()}:\n${text.slice(0, 1200)}`);
      if (r.isError) throw new Error(`${name} failed: ${text}`);
    }
    const refused = await client.callTool({ name: "claim", arguments: { unit: "screen--review-intent", session: "00000000-0000-0000-0000-000000000000" } });
    if (!refused.isError || !/BOARD_WRITE_ENABLED/.test(textOf(refused))) throw new Error(`claim was not refused with writes off: ${textOf(refused)}`);
    console.log("\nCLAIM (writes off): refused, as it must be");
  }

  await client.close();
  console.log("\nOK");
}

main().catch((error) => {
  console.error("SMOKE TEST FAILED:", error);
  process.exit(1);
});
