/**
 * Release I6b (MCP-ISSUE-076 follow-up) — one per-file literal cap for every performance profile,
 * over real MCP stdio on a git fixture.
 *
 * The `auto` profile picks `large` for a cold-start full run (maxFiles >= 8000) and `standard` once the
 * repo has rows. The literal cap used to follow the profile (100 / 200), so an unchanged file stored
 * different literal rows depending on which run last extracted it. This harness forces each profile
 * explicitly (CODEBASE_INDEX_LARGE_REPO_PROFILE, read per run, so one server process per profile) and
 * compares the literal rows of files with more than 100 literals:
 *
 *   A  full run under `large`                                        → rows L_A
 *   B  under `standard`: commit an edit, incremental; commit the revert, incremental
 *      (the revert re-extracts the files under `standard` at the original content) → rows L_B
 *   C  full run under `very-large` into a fresh DB                     → rows L_C
 *   D  full run under `standard` into the first DB                     → rows L_D
 *
 * L_A = L_B = L_C = L_D, value for value and line for line.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { makeTempDir } from "./_fixtures.mjs";
import { attachServerStderr } from "./_serverStderr.mjs";

let passed = 0, failed = 0;
function assert(cond, label, detail = "") {
  if (cond) { console.log(`  PASS  ${label}`); passed++; }
  else { console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`); failed++; }
}
const txt = (r) => Array.isArray(r?.content) ? (r.content.find((x) => x.type === "text")?.text ?? "") : "";
const js = (r) => { try { return JSON.parse(txt(r)); } catch { return null; } };

const tmpDir = makeTempDir("literal-cap-profiles-");
const repoDir = join(tmpDir, "repo");
const repoId = `literal-cap-${Date.now()}`;

// 260 eval cases: an identifier-shaped id and a prose note each — 520 candidates, ranked then capped.
const jsonl = Array.from({ length: 260 }, (_, i) => JSON.stringify({ id: `cap-${String(i).padStart(3, "0")}`, notes: `a prose note for case number ${i}` })).join("\n") + "\n";
// 150 TS literals: above the old `large` cap (100), below the old `standard` cap (200).
const ts = Array.from({ length: 150 }, (_, i) => `export const s${i} = "typescript literal number ${i}";`).join("\n") + "\n";
// 250 C# literals: above both.
const cs = `namespace A;\npublic class Big\n{\n${Array.from({ length: 250 }, (_, i) => `    public string M${i}() => "csharp literal number ${i}";`).join("\n")}\n}\n`;
// 230 JSON string values.
const json = JSON.stringify({ messages: Array.from({ length: 230 }, (_, i) => `json-message-${i}`) }, null, 2) + "\n";

const files = {
  "evals/cases/big.jsonl": jsonl,
  "src/strings.ts": ts,
  "src/Big.cs": cs,
  "data/messages.json": json,
  "src/small.ts": `export const hello = "hello world literal";\n`
};
for (const [rel, text] of Object.entries(files)) {
  mkdirSync(dirname(join(repoDir, rel)), { recursive: true });
  writeFileSync(join(repoDir, rel), text, "utf8");
}
const git = (...args) => execFileSync("git", args, { cwd: repoDir, stdio: "pipe", windowsHide: true }).toString();
git("init", "-q");
git("config", "user.email", "fixture@example.invalid");
git("config", "user.name", "fixture");
git("config", "core.autocrlf", "false");
git("add", "-A");
git("commit", "-q", "-m", "fixture");

const BIG = ["data/messages.json", "evals/cases/big.jsonl", "src/Big.cs", "src/strings.ts"];

async function withServer(dbPath, profile, fn) {
  const transport = new StdioClientTransport({
    command: "node",
    args: ["dist/index.js"],
    env: { ...process.env, CODEBASE_INDEX_ALLOWED_ROOTS: repoDir, CODEBASE_INDEX_DB_PATH: dbPath, CODEBASE_INDEX_LLM_ENABLED: "false", CODEBASE_INDEX_LARGE_REPO_PROFILE: profile },
    stderr: "pipe"
  });
  const client = new Client({ name: "literal-cap-profiles", version: "0.1.0" });
  await client.connect(transport);
  attachServerStderr(transport, `test-literal-cap-profiles (${profile})`);
  try {
    return await fn(async (name, args) => js(await client.callTool({ name, arguments: { repoId, ...args } })));
  } finally {
    await Promise.race([client.close().catch(() => {}), new Promise((r) => setTimeout(r, 3000))]);
  }
}

function literalRows(dbPath) {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    return db.prepare(`select file_path, line, value from string_literals where repo_id = ? order by 1, 2, 3`).all(repoId);
  } finally { db.close(); }
}
const countsByFile = (rows) => Object.fromEntries(BIG.map((f) => [f, rows.filter((r) => r.file_path === f).length]));
function firstDiff(a, b) {
  const left = a.map((r) => JSON.stringify(r)), right = b.map((r) => JSON.stringify(r));
  const rs = new Set(right), ls = new Set(left);
  return `only-first=${left.filter((r) => !rs.has(r)).slice(0, 3).join(" ")} only-second=${right.filter((r) => !ls.has(r)).slice(0, 3).join(" ")} (${left.length} vs ${right.length})`;
}

const dbMain = join(tmpDir, "index.db");
const dbVeryLarge = join(tmpDir, "index-very-large.db");

try {
  // ── A: full under `large` ───────────────────────────────────────────────────────────────
  const a = await withServer(dbMain, "large", (call) => call("index_repository", { repoPath: repoDir, mode: "full" }));
  assert(a && !a.error && a.status === "ok", "A: full run under large", JSON.stringify(a)?.slice(0, 300));
  assert(a?.performanceProfile === "large", "A: the run recorded profile large", String(a?.performanceProfile));
  const lA = literalRows(dbMain);
  const countsA = countsByFile(lA);
  assert(countsA["evals/cases/big.jsonl"] === 200, "A: the JSONL file keeps 200 literals (was 100 under large)", JSON.stringify(countsA));
  assert(countsA["src/strings.ts"] === 150, "A: a TS file with 150 literals keeps all 150 (was 100 under large)", JSON.stringify(countsA));
  assert(countsA["src/Big.cs"] === 200, "A: the C# file keeps 200", JSON.stringify(countsA));
  assert(countsA["data/messages.json"] === 200, "A: the JSON file keeps 200", JSON.stringify(countsA));
  const jsonlA = lA.filter((r) => r.file_path === "evals/cases/big.jsonl");
  assert(jsonlA.filter((r) => r.value.startsWith("cap-")).length === 200, "A: the kept JSONL rows are the identifier-shaped ids, prose after them", JSON.stringify(jsonlA.slice(0, 3)));

  // ── B: under `standard`, re-extract the same content incrementally ──────────────────────
  const b = await withServer(dbMain, "standard", async (call) => {
    const edited = {
      "data/messages.json": files["data/messages.json"].replace("json-message-0\"", "json-message-edited\""),
      "evals/cases/big.jsonl": files["evals/cases/big.jsonl"] + "{\"id\":\"cap-extra\"}\n",
      "src/Big.cs": files["src/Big.cs"] + "// edit\n",
      "src/strings.ts": files["src/strings.ts"] + "// edit\n"
    };
    for (const f of BIG) writeFileSync(join(repoDir, f), edited[f], "utf8");
    git("commit", "-q", "-am", "edit");
    const edit = await call("index_repository", { repoPath: repoDir, mode: "incremental" });
    for (const f of BIG) writeFileSync(join(repoDir, f), files[f], "utf8");
    git("commit", "-q", "-am", "revert");
    const revert = await call("index_repository", { repoPath: repoDir, mode: "incremental" });
    return { edit, revert };
  });
  assert(b.edit && !b.edit.error && (b.edit.filesIndexed ?? 0) >= BIG.length, "B: incremental over the edit re-extracts the four files", JSON.stringify(b.edit)?.slice(0, 300));
  assert(b.revert && !b.revert.error && (b.revert.filesIndexed ?? 0) >= BIG.length && !b.revert.skipReason, "B: incremental over the revert re-extracts them again (no fast skip)", JSON.stringify(b.revert)?.slice(0, 300));
  assert(b.revert?.performanceProfile === "standard", "B: the incremental run recorded profile standard", String(b.revert?.performanceProfile));
  const lB = literalRows(dbMain);
  assert(JSON.stringify(lA) === JSON.stringify(lB), "full under large = incremental under standard (every literal row)", firstDiff(lA, lB));

  // ── C: full under `very-large`, fresh DB ────────────────────────────────────────────────
  const c = await withServer(dbVeryLarge, "very-large", (call) => call("index_repository", { repoPath: repoDir, mode: "full" }));
  assert(c?.performanceProfile === "very-large", "C: the run recorded profile very-large", String(c?.performanceProfile));
  const lC = literalRows(dbVeryLarge);
  assert(JSON.stringify(lA) === JSON.stringify(lC), "full under large = full under very-large (was a 50 cap)", firstDiff(lA, lC));

  // ── D: full under `standard` over the first DB ──────────────────────────────────────────
  const d = await withServer(dbMain, "standard", (call) => call("index_repository", { repoPath: repoDir, mode: "full" }));
  assert(d && !d.error && d.performanceProfile === "standard", "D: full run under standard", JSON.stringify(d)?.slice(0, 200));
  const lD = literalRows(dbMain);
  assert(JSON.stringify(lA) === JSON.stringify(lD), "full under large = full under standard", firstDiff(lA, lD));
} catch (err) {
  console.error("test-literal-cap-profiles: threw:", err?.stack ?? err);
  failed++;
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
