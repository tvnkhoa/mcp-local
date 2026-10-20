/**
 * Release D (R4) — query_docs{ mode:"term" } over real stdio and git: a registry doc named by
 * citations.json, a Zod contract, and a test file whose literal must not count as a schema key.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execFileSync } from "child_process";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { makeTempDir } from "./_fixtures.mjs";
import { attachServerStderr } from "./_serverStderr.mjs";

let passed = 0, failed = 0;
function assert(cond, label, detail = "") {
  if (cond) { console.log(`  PASS  ${label}`); passed++; }
  else { console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`); failed++; }
}
const txt = (r) => Array.isArray(r?.content) ? (r.content.find((x) => x.type === "text")?.text ?? "") : "";
const js = (r) => { try { return JSON.parse(txt(r)); } catch { return null; } };
const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, "-c", "user.email=t@t", "-c", "user.name=t", ...args], { stdio: "pipe" });

const repo = makeTempDir("docs-term-");
const repoId = `term-${Date.now()}`;
for (const d of [".index", ".codebase-index", "docs", "src", "test"]) mkdirSync(join(repo, d), { recursive: true });
writeFileSync(join(repo, ".gitignore"), ".index/\n");
writeFileSync(join(repo, ".codebase-index", "citations.json"), JSON.stringify({ version: 1, registryDoc: "docs/10-model.md", citations: [] }));
writeFileSync(join(repo, "docs", "10-model.md"), [
  "# 10 — Model", "", "### 3.2 Turn", "", "| Field | Type | Notes |", "|---|---|---|",
  "| `citations` | array | projected into `kb_version_ids` |", "",
  "### 3.13 Audit event", "", "| Field | Type | Notes |", "|---|---|---|",
  "| `kb_version_ids` | array | A list, never a scalar |", "", "The tool_names list is prose only.", ""
].join("\n"));
writeFileSync(join(repo, "src", "audit.ts"), [
  "import { z } from 'zod'",
  "const audit_event_common_fields = {",
  "  kb_version_ids: z.array(z.string()),",
  "  tool_names: z.array(z.string()),",
  "  staff_user_id: z.string().nullable(),",
  "}",
  "export const audit_event_schema = z.object({ ...audit_event_common_fields })",
  ""
].join("\n"));
writeFileSync(join(repo, "test", "audit.test.ts"), "import { z } from 'zod'\nconst fixture = {\n  orphan_key: z.string(),\n}\n");
git(repo, "init", "-q");
git(repo, "add", ".");
git(repo, "commit", "-q", "-m", "one");

const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/index.js"],
  env: { ...process.env, CODEBASE_INDEX_ALLOWED_ROOTS: repo, CODEBASE_INDEX_DB_PATH: join(repo, ".index", "index.db"), CODEBASE_INDEX_LLM_ENABLED: "false" },
  stderr: "pipe"
});
const client = new Client({ name: "test-docs-term", version: "0.1.0" });
await client.connect(transport);
attachServerStderr(transport, "test-docs-term");
const docs = async (args) => js(await client.callTool({ name: "query_docs", arguments: { repoId, mode: "term", profile: "standard", ...args } }));

try {
  await client.callTool({ name: "index_repository", arguments: { repoId, repoPath: repo, mode: "full" } });

  const t = await docs({ query: "kb_version_ids" });
  assert(t?.registryDoc === "docs/10-model.md" && t?.definedIn?.length === 1 && t.definedIn[0].line === 13 && t.definedIn[0].section === "3.13 Audit event", "the defining row and its section", JSON.stringify(t?.definedIn));
  assert(t?.mentionCount === 1 && t.mentions[0].line === 7, "the 3.2 row that only mentions it is a mention, not a definition", JSON.stringify(t?.mentions));
  const k = t?.schemaKeys?.[0];
  assert(t?.schemaKeys?.length === 1 && k.filePath === "src/audit.ts" && k.line === 3 && k.owner === "audit_event_common_fields" && k.registrySection === "3.13 Audit event", "the Zod key, its owner and the registry section it matches", JSON.stringify(t?.schemaKeys));

  const none = await docs({ query: "staff_user_id" });
  assert(none?.definedIn?.length === 0 && none?.schemaKeys?.length === 1 && /no table row/.test(none?.hint ?? ""), "a declared key with no row says it is a registry candidate", JSON.stringify(none));

  const rev = await docs({});
  const keys = (rev?.missing ?? []).map((m) => `${m.key}:${m.confidence}`);
  assert(JSON.stringify(keys) === JSON.stringify(["staff_user_id:high", "tool_names:medium"]) && rev?.definedInRegistry === 1, "reverse report: never-named first, test-file keys excluded", JSON.stringify(rev));
} finally {
  await Promise.race([client.close().catch(() => {}), new Promise((r) => setTimeout(r, 3000))]);
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
