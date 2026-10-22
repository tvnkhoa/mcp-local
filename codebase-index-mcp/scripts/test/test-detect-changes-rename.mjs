/**
 * MCP-ISSUE-087 (wec.aria adoption plan, release K2): `detect_changes` on a rename.
 *
 * `git diff --name-only` printed only the NEW side of a rename, so the old path — the one whose
 * importers a move breaks — never appeared, and its dependents were in no impact. Over real stdio,
 * against a real git repo where `b.ts` is imported by `a.ts` and `c.ts`:
 *   1. a staged `git mv` (the freshness gate prunes the old path first): both paths, paired, and the
 *      old path's importers found through their import tokens;
 *   2. the same with the gate off (the old path still indexed): the graph's own answer;
 *   3. a plain `mv` (unstaged): a deleted path and an untracked one, NO pairing claimed, importers still
 *      listed under the old path;
 *   4. the IDE rename (importers updated in the same change): 0 dependents, said, not silent;
 *   5. range mode over a commit that renames.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execFileSync } from "child_process";
import { mkdirSync, renameSync, writeFileSync } from "fs";
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
const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, "-c", "user.email=t@t", "-c", "user.name=t", ...args], { stdio: "pipe", encoding: "utf8" });

async function connect(tmpDir, refresh, name) {
  const transport = new StdioClientTransport({
    command: "node",
    args: ["dist/index.js"],
    env: {
      ...process.env,
      CODEBASE_INDEX_ALLOWED_ROOTS: tmpDir,
      CODEBASE_INDEX_DB_PATH: join(tmpDir, ".index", "index.db"),
      CODEBASE_INDEX_LLM_ENABLED: "false",
      CODEBASE_INDEX_QUERY_REFRESH_ENABLED: refresh ? "true" : "false",
      CODEBASE_INDEX_QUERY_REFRESH_BUDGET_MS: "60000"
    },
    stderr: "pipe"
  });
  const client = new Client({ name, version: "0.1.0" });
  await client.connect(transport);
  attachServerStderr(transport, name);
  return client;
}

const tmpDir = makeTempDir("detect-rename-");
const repoId = `dr-${Date.now()}`;
mkdirSync(join(tmpDir, ".index"), { recursive: true });
writeFileSync(join(tmpDir, ".gitignore"), ".index/\n");
const B = "export function bravo(): number {\n  return 2;\n}\n";
const importer = (name, from) => `import { bravo } from "${from}";\nexport function ${name}(): number {\n  return bravo();\n}\n`;
writeFileSync(join(tmpDir, "b.ts"), B);
writeFileSync(join(tmpDir, "a.ts"), importer("alpha", "./b"));
writeFileSync(join(tmpDir, "c.ts"), importer("charlie", "./b"));
writeFileSync(join(tmpDir, "d.ts"), "export const delta = 4;\n");
git(tmpDir, "init", "-q");
git(tmpDir, "add", ".");
git(tmpDir, "commit", "-q", "-m", "one");
const base = git(tmpDir, "rev-parse", "HEAD").trim();

/** Back to the committed tree, and a full run, so each case starts from the same index. */
async function reset(client) {
  git(tmpDir, "reset", "-q", "--hard", base);
  git(tmpDir, "clean", "-qfd", "-e", ".index");
  await client.callTool({ name: "index_repository", arguments: { repoId, repoPath: tmpDir, mode: "full", docsMode: "off" } }, undefined, { timeout: 120_000 });
}
const ALL = { policy: "custom", minRiskScore: 0, riskLevels: ["high", "medium", "low"], maxResults: 50, profile: "standard" };
async function detect(client, extra = {}) {
  return js(await client.callTool({ name: "detect_changes", arguments: { repoId, ...ALL, ...extra } }, undefined, { timeout: 120_000 }));
}
const row = (r, p) => (r?.impacts ?? []).find((x) => x.filePath === p);
const dependents = (x) => (x?.topImpactedFiles ?? []).map((f) => f.filePath).sort();

let client = await connect(tmpDir, true, "test-detect-rename");
try {
  await reset(client);

  // 1. Staged git mv, importers untouched; the gate's refresh has pruned b.ts before the handler runs.
  git(tmpDir, "mv", "b.ts", "b2.ts");
  let r = await detect(client);
  assert(r?.changedFiles?.includes("b.ts") && r?.changedFiles?.includes("b2.ts"), "git mv: both paths are listed", JSON.stringify(r?.changedFiles));
  assert(row(r, "b.ts")?.change === "deleted" && row(r, "b.ts")?.renamedTo === "b2.ts", "the old path is deleted, renamedTo the new one", JSON.stringify(row(r, "b.ts")));
  assert(row(r, "b2.ts")?.change === "added" && row(r, "b2.ts")?.renamedFrom === "b.ts", "the new path is added, renamedFrom the old one", JSON.stringify(row(r, "b2.ts")));
  assert(JSON.stringify(dependents(row(r, "b.ts"))) === JSON.stringify(["a.ts", "c.ts"]), "the old path's importers are its impact", JSON.stringify(row(r, "b.ts")?.topImpactedFiles));
  assert(row(r, "b.ts")?.impactedFilesCount === 2 && /no longer in the index/.test(row(r, "b.ts")?.dependentsNote ?? ""), "counted, and the source of the answer is said", JSON.stringify(row(r, "b.ts")));
  assert(/imports '\.\/b'/.test(row(r, "b.ts")?.topImpactedFiles?.[0]?.reason ?? ""), "each dependent names the import that still points at the old path", row(r, "b.ts")?.topImpactedFiles?.[0]?.reason);

  // 3. A plain mv: git pairs nothing. The deleted path gets the same dependents analysis.
  await reset(client);
  renameSync(join(tmpDir, "b.ts"), join(tmpDir, "b3.ts"));
  r = await detect(client, { includeUntracked: true });
  assert(row(r, "b.ts")?.change === "deleted" && row(r, "b.ts")?.renamedTo === undefined, "plain mv: the old path is deleted, no pairing claimed", JSON.stringify(row(r, "b.ts")));
  assert(row(r, "b3.ts")?.change === "added" && row(r, "b3.ts")?.renamedFrom === undefined, "plain mv: the new path is added, no pairing claimed", JSON.stringify(row(r, "b3.ts")));
  assert(JSON.stringify(dependents(row(r, "b.ts"))) === JSON.stringify(["a.ts", "c.ts"]), "plain mv: the old path's importers are still listed", JSON.stringify(row(r, "b.ts")?.topImpactedFiles));

  // 4. The IDE rename: importers updated in the same change. Nothing points at the old path any more.
  await reset(client);
  git(tmpDir, "mv", "b.ts", "b4.ts");
  writeFileSync(join(tmpDir, "a.ts"), importer("alpha", "./b4"));
  writeFileSync(join(tmpDir, "c.ts"), importer("charlie", "./b4"));
  r = await detect(client);
  assert(row(r, "b.ts")?.impactedFilesCount === 0, "IDE rename: the old path has 0 dependents", JSON.stringify(row(r, "b.ts")));
  assert(row(r, "b.ts")?.dependentsNote === "no remaining importer references b.ts", "and says so", JSON.stringify(row(r, "b.ts")?.dependentsNote));

  // 5. Range mode over a commit that renames.
  await reset(client);
  git(tmpDir, "mv", "b.ts", "b5.ts");
  git(tmpDir, "commit", "-q", "-m", "rename");
  r = await detect(client, { baseRef: base, headRef: "HEAD", includeUntracked: false });
  assert(row(r, "b.ts")?.change === "deleted" && row(r, "b.ts")?.renamedTo === "b5.ts", "range: the old path is deleted, renamedTo", JSON.stringify(row(r, "b.ts")));
  assert(row(r, "b5.ts")?.change === "added" && row(r, "b5.ts")?.renamedFrom === "b.ts", "range: the new path is added, renamedFrom", JSON.stringify(row(r, "b5.ts")));
  assert(JSON.stringify(dependents(row(r, "b.ts"))) === JSON.stringify(["a.ts", "c.ts"]), "range: the old path's importers", JSON.stringify(row(r, "b.ts")?.topImpactedFiles));
  git(tmpDir, "reset", "-q", "--hard", base);
  await reset(client);
} finally {
  await Promise.race([client.close().catch(() => {}), new Promise((r) => setTimeout(r, 3000))]);
}

// 2. The gate off: nothing prunes b.ts, so its dependents come from the graph itself.
client = await connect(tmpDir, false, "test-detect-rename-nogate");
try {
  git(tmpDir, "mv", "b.ts", "b2.ts");
  const r = await detect(client);
  assert(row(r, "b.ts")?.change === "deleted" && row(r, "b.ts")?.renamedTo === "b2.ts", "gate off: the old path is deleted, renamedTo", JSON.stringify(row(r, "b.ts")));
  assert(dependents(row(r, "b.ts")).includes("a.ts") && dependents(row(r, "b.ts")).includes("c.ts"), "gate off: the old path's dependents, from the graph", JSON.stringify(row(r, "b.ts")?.topImpactedFiles));
  assert(row(r, "b.ts")?.dependentsNote === undefined, "gate off: scored from the index, no removed-path note", JSON.stringify(row(r, "b.ts")?.dependentsNote));
} finally {
  await Promise.race([client.close().catch(() => {}), new Promise((r) => setTimeout(r, 3000))]);
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
