/**
 * ENH-029-E regression: get_value_contract_impact traces a stored value ("resolved") across ALL
 * registered repos, groups exact-value hits per repo, and classifies producer (write) vs consumer
 * (read/compare) sites — the data-contract gate a symbol-oriented cross-repo query can't answer.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { makeTempDir } from "./_fixtures.mjs";

let passed = 0, failed = 0;
function assert(cond, label, detail = "") {
  if (cond) { console.log(`  PASS  ${label}`); passed++; }
  else { console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`); failed++; }
}
const txt = (r) => Array.isArray(r?.content) ? (r.content.find((x) => x.type === "text")?.text ?? "") : "";
const js = (r) => { try { return JSON.parse(txt(r)); } catch { return null; } };

const root = makeTempDir("vcontract-test-");
const dbPath = join(root, "vc.db");
const repoAPath = join(root, "service-a");
const repoBPath = join(root, "service-b");
mkdirSync(join(repoAPath, "src"), { recursive: true });
mkdirSync(join(repoBPath, "src"), { recursive: true });

writeFileSync(join(repoAPath, "src", "StatusWriter.cs"), `public class StatusWriter
{
    public void Resolve(Conversation c)
    {
        c.Status = "resolved";
    }
}
`, "utf8");

writeFileSync(join(repoBPath, "src", "StatusReader.cs"), `public class StatusReader
{
    public bool IsDone(Conversation c)
    {
        return c.Status == "resolved";
    }
}
`, "utf8");

const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/index.js"],
  env: { ...process.env, CODEBASE_INDEX_ALLOWED_ROOTS: root, CODEBASE_INDEX_DB_PATH: dbPath, CODEBASE_INDEX_LLM_ENABLED: "false" },
  stderr: "pipe"
});
const client = new Client({ name: "vc-test", version: "0.1.0" });
await client.connect(transport);
transport.stderr?.resume();

try {
  await client.callTool({ name: "index_repository", arguments: { repoId: "service-a", repoPath: repoAPath, mode: "full" } });
  await client.callTool({ name: "index_repository", arguments: { repoId: "service-b", repoPath: repoBPath, mode: "full" } });

  const res = js(await client.callTool({
    name: "get_value_contract_impact",
    arguments: { value: "resolved", column: "Status" }
  }));

  assert(res?.reposScanned === 2, "scans both registered repos", JSON.stringify(res)?.slice(0, 300));
  assert(res?.totalHits === 2, "finds exactly two exact-value hits", `totalHits=${res?.totalHits}`);

  const a = (res?.groups ?? []).find((g) => g.repoId === "service-a");
  const b = (res?.groups ?? []).find((g) => g.repoId === "service-b");
  assert(a?.producers === 1 && a?.consumers === 0, "service-a classified as producer (write-site)", JSON.stringify(a));
  assert(b?.consumers === 1 && b?.producers === 0, "service-b classified as consumer (comparison)", JSON.stringify(b));
  assert(a?.hits?.[0]?.lineText?.includes('c.Status = "resolved"'), "producer hit carries the source line", JSON.stringify(a?.hits?.[0]));
} finally {
  await Promise.race([client.close().catch(() => {}), new Promise((r) => setTimeout(r, 3000))]);
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
