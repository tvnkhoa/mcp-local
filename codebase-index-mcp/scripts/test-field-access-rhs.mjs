/**
 * ENH-029-B regression: find_field_accesses returns the assigned RHS (assignedExpression) at
 * PROPERTY_WRITE sites — both member-access writes (`conv.HandledBy = "ai"`) and object-initializer
 * writes (`new Conversation { HandledBy = "human" }`) — so the value-domain can be read in one call.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

let passed = 0, failed = 0;
function assert(cond, label, detail = "") {
  if (cond) { console.log(`  PASS  ${label}`); passed++; }
  else { console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`); failed++; }
}
const txt = (r) => Array.isArray(r?.content) ? (r.content.find((x) => x.type === "text")?.text ?? "") : "";
const js = (r) => { try { return JSON.parse(txt(r)); } catch { return null; } };

const tmpDir = mkdtempSync(join(tmpdir(), "rhs-test-"));
const repoId = `rhs-${Date.now()}`;
mkdirSync(join(tmpDir, "src"), { recursive: true });
writeFileSync(join(tmpDir, "src", "Conversation.cs"), `public class Conversation
{
    public string HandledBy { get; set; }
}

public class Handler
{
    public void Run()
    {
        var conv = new Conversation();
        conv.HandledBy = "ai";
        var c2 = new Conversation { HandledBy = "human" };
    }
}
`, "utf8");

const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/index.js"],
  env: { ...process.env, CODEBASE_INDEX_ALLOWED_ROOTS: tmpDir, CODEBASE_INDEX_LLM_ENABLED: "false" },
  stderr: "pipe"
});
const client = new Client({ name: "rhs-test", version: "0.1.0" });
await client.connect(transport);
transport.stderr?.resume();

try {
  await client.callTool({ name: "index_repository", arguments: { repoId, repoPath: tmpDir, mode: "full" } });

  const res = js(await client.callTool({
    name: "find_field_accesses",
    arguments: { repoId, name: "HandledBy", mode: "write", profile: "standard" }
  }));
  const writes = (res?.accesses ?? []).filter((a) => a.mode === "write");
  assert(writes.length >= 1, "find_field_accesses returns write sites", JSON.stringify(res)?.slice(0, 300));
  const exprs = writes.map((w) => w.assignedExpression).filter(Boolean);
  assert(exprs.some((e) => e.includes('"ai"')), 'member-access write captures RHS "ai"', JSON.stringify(writes).slice(0, 400));
  assert(exprs.some((e) => e.includes('"human"')), 'object-initializer write captures RHS "human"', JSON.stringify(writes).slice(0, 400));
} finally {
  await Promise.race([client.close().catch(() => {}), new Promise((r) => setTimeout(r, 3000))]);
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
