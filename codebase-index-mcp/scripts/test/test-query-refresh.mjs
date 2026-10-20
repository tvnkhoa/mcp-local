/**
 * R1 (wec.aria adoption plan, release B): the index is never silently stale.
 *
 * Over real stdio, against a real git repo:
 *   1. a commit is visible to the NEXT read query, with no index_repository in between;
 *   2. an uncommitted edit is visible too (dirty-mode refresh);
 *   3. health_check shows the run was started by a query (`triggeredBy: "query"`);
 *   4. with a 0 ms budget the answer says it is not current (`freshness.state: "refreshing"`,
 *      coverage not "high"), the run is NOT aborted, and a later query answers from it.
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connect(tmpDir, budgetMs, name) {
  const transport = new StdioClientTransport({
    command: "node",
    args: ["dist/index.js"],
    env: {
      ...process.env,
      CODEBASE_INDEX_ALLOWED_ROOTS: tmpDir,
      CODEBASE_INDEX_DB_PATH: join(tmpDir, ".index", "index.db"),
      CODEBASE_INDEX_LLM_ENABLED: "false",
      CODEBASE_INDEX_QUERY_REFRESH_BUDGET_MS: String(budgetMs)
    },
    stderr: "pipe"
  });
  const client = new Client({ name, version: "0.1.0" });
  await client.connect(transport);
  attachServerStderr(transport, name);
  return client;
}

const tmpDir = makeTempDir("query-refresh-");
const repoId = `qr-${Date.now()}`;
mkdirSync(join(tmpDir, ".index"), { recursive: true });
writeFileSync(join(tmpDir, ".gitignore"), ".index/\n");
writeFileSync(join(tmpDir, "a.ts"), "export function alphaOne(): number {\n  return 1;\n}\n");
git(tmpDir, "init", "-q");
git(tmpDir, "add", ".");
git(tmpDir, "commit", "-q", "-m", "one");

const names = (r) => (r?.results ?? r?.symbols ?? r?.matches ?? []).map((s) => s.name);

let client = await connect(tmpDir, 30_000, "test-query-refresh");
try {
  await client.callTool({ name: "index_repository", arguments: { repoId, repoPath: tmpDir, mode: "full" } });

  // 1. A commit, then a plain read query.
  writeFileSync(join(tmpDir, "b.ts"), "export function betaTwo(): number {\n  return 2;\n}\n");
  git(tmpDir, "add", ".");
  git(tmpDir, "commit", "-q", "-m", "two");
  const afterCommit = js(await client.callTool({ name: "search_symbols", arguments: { repoId, query: "betaTwo", strategy: "name", profile: "standard" } }));
  assert(JSON.stringify(afterCommit).includes("betaTwo"), "a committed symbol is found by the next query, no index_repository", JSON.stringify(afterCommit)?.slice(0, 300));
  assert(afterCommit?.freshness?.state === "refreshed" && afterCommit?.freshness?.mode === "incremental", "the answer says it refreshed (incremental)", JSON.stringify(afterCommit?.freshness));

  // 2. An uncommitted edit.
  writeFileSync(join(tmpDir, "c.ts"), "export function gammaThree(): number {\n  return 3;\n}\n");
  const afterEdit = js(await client.callTool({ name: "search_symbols", arguments: { repoId, query: "gammaThree", strategy: "name", profile: "standard" } }));
  assert(JSON.stringify(afterEdit).includes("gammaThree"), "an uncommitted edit is found by the next query", JSON.stringify(afterEdit)?.slice(0, 300));
  assert(afterEdit?.freshness?.mode === "dirty", "via a dirty-mode refresh", JSON.stringify(afterEdit?.freshness));

  // 3. health_check names the trigger.
  const health = js(await client.callTool({ name: "health_check", arguments: { repoId } }));
  const latest = health?.latestRun ?? health?.codebaseState?.latestRun;
  assert(latest?.triggeredBy === "query", "health_check: latestRun.triggeredBy = query", (JSON.stringify(latest) ?? `no latestRun; keys: ${Object.keys(health ?? {}).join(",")} raw: ${txt({ content: [] }) || JSON.stringify(health)?.slice(0, 300)}`).slice(0, 400));

  // An unchanged tree is fresh: no freshness block, no run.
  const quiet = js(await client.callTool({ name: "search_symbols", arguments: { repoId, query: "alphaOne", strategy: "name", profile: "standard" } }));
  assert(quiet && quiet.freshness === undefined, "an unchanged tree answers with no freshness block", JSON.stringify(quiet?.freshness));
} finally {
  await Promise.race([client.close().catch(() => {}), new Promise((r) => setTimeout(r, 3000))]);
}

// 4. A 1 ms budget: the answer must not pretend, and the run must survive the answer.
client = await connect(tmpDir, 1, "test-query-refresh-budget"); // 1 ms: numberFromEnv reads 0 as unset
try {
  writeFileSync(join(tmpDir, "d.ts"), "export function deltaFour(): number {\n  return 4;\n}\n");
  git(tmpDir, "add", ".");
  git(tmpDir, "commit", "-q", "-m", "four");
  // Behind HEAD, before any read query: health_check must not send the caller to re-index by hand.
  const behind = js(await client.callTool({ name: "health_check", arguments: { repoId } }));
  const hint = (behind?.actionHints ?? []).find((h) => h.action === "index_repository");
  assert(hint && hint.recommended === false && hint.urgency === "low" && /automatically/.test(hint.note ?? ""), "health_check: a stale index is not a manual re-index while the gate is on", JSON.stringify(hint));
  const first = js(await client.callTool({ name: "search_regex", arguments: { repoId, pattern: "deltaFour", profile: "standard" } }));
  assert(first?.freshness?.state === "refreshing", "over budget: freshness.state = refreshing", JSON.stringify(first?.freshness));
  const conf = typeof first?.coverage === "string" ? first.coverage : first?.coverage?.confidence;
  assert(conf !== "high", "over budget: coverage is not high", JSON.stringify(first?.coverage));

  let seen = false;
  for (let i = 0; i < 40 && !seen; i++) {
    await sleep(250);
    const r = js(await client.callTool({ name: "search_symbols", arguments: { repoId, query: "deltaFour", strategy: "name", profile: "standard" } }));
    seen = JSON.stringify(r).includes("deltaFour");
  }
  assert(seen, "the run was not aborted: a later query answers from it");
} finally {
  await Promise.race([client.close().catch(() => {}), new Promise((r) => setTimeout(r, 3000))]);
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
