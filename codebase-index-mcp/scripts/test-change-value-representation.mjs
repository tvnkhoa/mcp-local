/**
 * ENH-029-A regression: change_value_representation promotes a property's string literals to enum
 * members across assignment, object-initializer, ==/!= comparison, and assertion-argument sites,
 * via the C# AST (no user-authored backreference — the MCP-ISSUE-029 failure mode). Cross-type
 * sites (a same-named property on a different owner type) must be skipped, not rewritten.
 *
 * The source file is padded past 32KB so the AST parse path uses the bufferSize fix. node-tree-sitter
 * throws "Invalid argument" on any source >32768 bytes parsed without an explicit bufferSize, so without
 * the fix every rewrite assertion below fails (the scan never gets past parsing the file).
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { bufferOverflowPad } from "./_fixtures.mjs";

let passed = 0, failed = 0;
function assert(cond, label, detail = "") {
  if (cond) { console.log(`  PASS  ${label}`); passed++; }
  else { console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`); failed++; }
}
const txt = (r) => Array.isArray(r?.content) ? (r.content.find((x) => x.type === "text")?.text ?? "") : "";
const js = (r) => { try { return JSON.parse(txt(r)); } catch { return null; } };

// >32KB pad that exercises the bufferSize fix without tripping the minified-file filter (see helper).
const PAD = bufferOverflowPad();

const tmpDir = mkdtempSync(join(tmpdir(), "cvr-test-"));
const repoId = `cvr-${Date.now()}`;
mkdirSync(join(tmpDir, "src"), { recursive: true });
const sourcePath = join(tmpDir, "src", "Conversation.cs");
writeFileSync(sourcePath, `public class Conversation
{
    public string HandledBy { get; set; }
}

public class Other
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
        var other = new Other();
        other.HandledBy = "ai";
        if (conv.HandledBy == "ai") { }
        Assert.Equal("human", conv.HandledBy);
    }
}
${PAD}`, "utf8");

const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/index.js"],
  env: { ...process.env, CODEBASE_INDEX_ALLOWED_ROOTS: tmpDir, CODEBASE_INDEX_LLM_ENABLED: "false" },
  stderr: "pipe"
});
const client = new Client({ name: "cvr-test", version: "0.1.0" });
await client.connect(transport);
transport.stderr?.resume();

try {
  await client.callTool({ name: "index_repository", arguments: { repoId, repoPath: tmpDir, mode: "full" } });

  const valueMap = { ai: "ConversationHandledBy.Ai", human: "ConversationHandledBy.Human" };

  // 1. Dry-run preview.
  const preview = js(await client.callTool({
    name: "change_value_representation",
    arguments: { repoId, property: "HandledBy", requiredOwnerType: "Conversation", valueMap, dryRun: true }
  }));
  assert(preview?.dryRun === true, "preview is dry-run", JSON.stringify(preview)?.slice(0, 300));
  // 4 Conversation sites: assignment, object-init, comparison, argument. The Other.HandledBy = "ai" is cross-type → skipped.
  // This also proves the >32KB file parsed without "Invalid argument" (bufferSize fix).
  assert(preview?.totalMatches === 4, "rewrites exactly the 4 Conversation sites in a >32KB file (bufferSize fix; skips cross-type Other)", `totalMatches=${preview?.totalMatches}`);
  assert(preview?.ambiguousOccurrences === 0, "all matched sites have a proven owner type", `ambiguous=${preview?.ambiguousOccurrences}`);

  // 2. Apply.
  const applied = js(await client.callTool({
    name: "change_value_representation",
    arguments: { repoId, property: "HandledBy", requiredOwnerType: "Conversation", valueMap, dryRun: false }
  }));
  assert(applied?.applyId && applied?.applyStatus, "apply returns applyId + status", JSON.stringify(applied)?.slice(0, 300));

  const after = readFileSync(sourcePath, "utf8");
  assert(after.includes('conv.HandledBy = ConversationHandledBy.Ai;'), "assignment literal rewritten", after.slice(0, 600));
  assert(after.includes('new Conversation { HandledBy = ConversationHandledBy.Human }'), "object-initializer literal rewritten", after.slice(0, 600));
  assert(after.includes('conv.HandledBy == ConversationHandledBy.Ai'), "comparison literal rewritten", after.slice(0, 600));
  assert(after.includes('Assert.Equal(ConversationHandledBy.Human, conv.HandledBy)'), "assertion-argument literal rewritten", after.slice(0, 600));
  assert(after.includes('other.HandledBy = "ai";'), "cross-type Other.HandledBy left untouched", after.slice(0, 600));

  // 3. Rollback restores the original source.
  const rollback = js(await client.callTool({
    name: "refactor_replace_rollback",
    arguments: { rollbackId: applied.rollbackId }
  }));
  const restored = readFileSync(sourcePath, "utf8");
  assert(restored.includes('conv.HandledBy = "ai";') && restored.includes('new Conversation { HandledBy = "human" }'),
    "rollback restores original literals", JSON.stringify(rollback)?.slice(0, 200));
} finally {
  await Promise.race([client.close().catch(() => {}), new Promise((r) => setTimeout(r, 3000))]);
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
