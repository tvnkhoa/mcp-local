/**
 * MCP-ISSUE-114 (IX-4) — register_worktree: one call registers a git worktree of an indexed repo, queues its index
 * job and starts its watcher, and answers the runId at once.
 *
 * Fixture: a parent git repo (indexed) and `git worktree add` of it; a second, unrelated git repo.
 *   (a) one call answers in < 2 s with a runId, registered "new", watch started;
 *   (b) list_repositories shows the worktree; watch_repo status shows its watcher;
 *   (c) index_status reaches ok: one full run (a new repoId), the worktree's own symbol is indexed;
 *   (d) refusals: an unknown parentRepoId, a path that is not the parent's worktree, a repoId registered elsewhere.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const txt = (r) => (Array.isArray(r?.content) ? (r.content.find((x) => x.type === "text")?.text ?? "") : "");
const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, "-c", "user.email=t@t", "-c", "user.name=t", ...args], { stdio: "pipe" });

function writeRepo(dir, files) {
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text, "utf8");
  }
  git(dir, "init", "-q");
  git(dir, "config", "core.autocrlf", "false");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "fixture");
}

const root = makeTempDir("register-wt-");
const stamp = Date.now();
const parentDir = join(root, "parent");
const wtDir = join(root, "parent-wt-feature");
const otherDir = join(root, "other");
writeRepo(parentDir, {
  "tsconfig.json": '{ "compilerOptions": { "strict": true } }\n',
  "src/a.ts": "export function parentAlpha(): number {\n  return 1;\n}\n"
});
git(parentDir, "worktree", "add", "-q", "-b", "feature", wtDir);
writeFileSync(join(wtDir, "src/b.ts"), "export function worktreeOnlyBeta(): number {\n  return 2;\n}\n");
git(wtDir, "add", ".");
git(wtDir, "commit", "-q", "-m", "worktree change");
writeRepo(otherDir, { "src/o.ts": "export const other = 1;\n" });
const parentId = `rw-parent-${stamp}`;
const wtId = `rw-wt-${stamp}`;

const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/index.js"],
  env: {
    ...process.env,
    CODEBASE_INDEX_ALLOWED_ROOTS: root,
    CODEBASE_INDEX_DB_PATH: join(root, ".index", "index.db"),
    CODEBASE_INDEX_LLM_ENABLED: "false",
    CODEBASE_INDEX_MIN_FREE_RAM_MB: "0",
    CODEBASE_INDEX_WATCH_AUTO_START_ENABLED: "false"
  },
  stderr: "pipe"
});
mkdirSync(join(root, ".index"), { recursive: true });
const client = new Client({ name: "test-register-worktree", version: "0" });
await client.connect(transport);
attachServerStderr(transport, "test-register-worktree");
async function call(name, args) {
  const t0 = performance.now();
  const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 300_000 });
  const text = txt(r);
  let body = null;
  try { body = JSON.parse(text); } catch { /* error text */ }
  return { ms: Math.round(performance.now() - t0), body, text, isError: r.isError === true };
}

try {
  const base = await call("index_repository", { repoId: parentId, repoPath: parentDir, mode: "full", wait: true });
  assert(base.body?.state === "ok", "the parent repo is indexed", base.text.slice(0, 200));

  // (a)
  const reg = await call("register_worktree", { parentRepoId: parentId, repoPath: wtDir, repoId: wtId });
  console.log(`  info  register_worktree ${reg.ms} ms ${reg.text.slice(0, 1500)}`);
  assert(!reg.isError && typeof reg.body?.runId === "string" && ["queued", "running"].includes(reg.body?.state), "(a) one call answers a runId and state queued|running", reg.text.slice(0, 300));
  assert(reg.ms < 2000, "(a) ... at once (< 2 s)", `${reg.ms} ms`);
  assert(reg.body?.registered === "new" && reg.body?.parentRepoId === parentId, "(a) ... registered new, under the parent", reg.text.slice(0, 300));
  assert(reg.body?.watch?.started === true, "(a) ... and the watcher started", JSON.stringify(reg.body?.watch));

  // (b)
  // The run registers the repo, in the worker (follow-up 3): give it a moment to start.
  let list = await call("list_repositories", {});
  for (let i = 0; i < 50 && !list.text.includes(wtId); i++) {
    await sleep(200);
    list = await call("list_repositories", {});
  }
  assert(list.text.includes(wtId), "(b) list_repositories shows the worktree", list.text.slice(0, 300));
  const watch = await call("watch_repo", { action: "status", repoId: wtId });
  assert(watch.body?.activeWatchRepoId === wtId && JSON.stringify(watch.body?.watchers ?? []).includes(wtId), "(b) watch_repo status shows its watcher", watch.text.slice(0, 300));

  // (c)
  let done = null;
  for (let i = 0; i < 600 && !done; i++) {
    const s = await call("index_status", { runId: reg.body.runId });
    if (s.body?.state === "ok" || s.body?.state === "failed") done = s;
    else await sleep(200);
  }
  assert(done?.body?.state === "ok" && done.body.mode === "full" && /^full \(no index yet/.test(done.body.scope ?? ""), "(c) the job ends ok, one full run of the new repoId", done?.text.slice(0, 300));
  const sym = await call("search_symbols", { repoId: wtId, query: "worktreeOnlyBeta", strategy: "name", limit: 5 });
  assert(sym.text.includes("worktreeOnlyBeta"), "(c) the worktree's own symbol is indexed", sym.text.slice(0, 200));

  // (d)
  const noParent = await call("register_worktree", { parentRepoId: "no-such-parent", repoPath: wtDir, repoId: `${wtId}-x` });
  assert(noParent.isError && /unknown parentRepoId/.test(noParent.text), "(d) an unknown parentRepoId is refused", noParent.text.slice(0, 200));
  const notWt = await call("register_worktree", { parentRepoId: parentId, repoPath: otherDir, repoId: `rw-other-${stamp}` });
  assert(notWt.isError && /not a git worktree of/.test(notWt.text), "(d) a repo that is not the parent's worktree is refused", notWt.text.slice(0, 200));
  const taken = await call("register_worktree", { parentRepoId: parentId, repoPath: wtDir, repoId: parentId });
  assert(taken.isError && /must differ from parentRepoId/.test(taken.text), "(d) the parent's own repoId is refused", taken.text.slice(0, 200));
  const parentPath = await call("register_worktree", { parentRepoId: parentId, repoPath: parentDir, repoId: `rw-p2-${stamp}` });
  assert(parentPath.isError && /parent's own checkout/.test(parentPath.text), "(d) the parent's own checkout is refused", parentPath.text.slice(0, 200));
  const twice = await call("register_worktree", { parentRepoId: parentId, repoPath: wtDir.split("\\").join("/") + "/", repoId: `rw-dup-${stamp}` });
  assert(twice.isError && /already registered as/.test(twice.text), "(d) a path registered under another repoId is refused, in another spelling", twice.text.slice(0, 200));
  const again = await call("register_worktree", { parentRepoId: parentId, repoPath: wtDir, repoId: wtId });
  assert(!again.isError && again.body?.registered === "already" && again.body?.runId !== reg.body.runId, "(d) calling again for the same repoId and path queues another run", again.text.slice(0, 200));
  await call("watch_repo", { action: "stop", repoId: wtId });
} catch (error) {
  assert(false, "harness ran to the end", error instanceof Error ? error.stack ?? error.message : String(error));
} finally {
  await Promise.race([client.close().catch(() => {}), sleep(5000)]);
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
