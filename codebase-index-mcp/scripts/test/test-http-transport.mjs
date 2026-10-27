/**
 * R4: one served process, two clients, over streamable HTTP.
 *
 * Spawns `dist/index.js --transport http` against a scratch repo and an isolated DB, then pins:
 *   - the gate: no token → 401, a foreign Host or Origin → 403;
 *   - two clients answered concurrently by one process (search_symbols + query_docs);
 *   - a refactor preview belongs to the session that made it: B applying A's preview is refused
 *     with PREVIEW_OWNED_BY_ANOTHER_SESSION, and A's own apply goes through;
 *   - a client closing its session leaves the process serving the other.
 *
 * Usage: npm run build && node scripts/test/test-http-transport.mjs
 */

import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { makeTempDir } from "./_fixtures.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TOKEN = "r4-test-token-".padEnd(48, "x");

let passed = 0;
const failures = [];
function check(label, condition, detail = "") {
  if (condition) passed += 1;
  else failures.push(`${label}${detail ? `\n     ${detail}` : ""}`);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function rawStatus(port, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1", port, path: "/mcp", method: "POST",
        headers: { host: `127.0.0.1:${port}`, "content-type": "application/json", accept: "application/json, text/event-stream", ...headers }
      },
      (res) => { res.resume(); resolve(res.statusCode); }
    );
    req.on("error", reject);
    req.end(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }));
  });
}

async function connect(port) {
  const client = new Client({ name: "r4-test", version: "0" });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${TOKEN}` } }
  });
  await client.connect(transport);
  return { client, transport };
}

async function waitForServer(port, child) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited early (${child.exitCode})`);
    try {
      if ((await rawStatus(port, {})) === 401) return;
    } catch { /* not listening yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("server did not start listening within 30 s");
}

const payload = (result) => JSON.parse(result.content[0].text);

// ── scratch repo ─────────────────────────────────────────────────────────────
const tmp = makeTempDir("cbi-http-");
const repo = path.join(tmp, "repo");
fs.mkdirSync(path.join(repo, "src"), { recursive: true });
fs.writeFileSync(path.join(repo, "src", "greet.ts"), "export function greetUser(name: string): string {\n  return `hi ${name}`;\n}\n");
fs.writeFileSync(path.join(repo, "README.md"), "# Greeter\n\n## Usage\n\nCall greetUser with a name.\n");
for (const args of [["init", "-q"], ["add", "-A"], ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"]]) {
  execFileSync("git", args, { cwd: repo });
}

const port = await freePort();
let stderr = "";
const child = spawn(process.execPath, [path.join(ROOT, "dist", "index.js"), "--transport", "http"], {
  env: {
    ...process.env,
    CODEBASE_INDEX_ALLOWED_ROOTS: tmp,
    CODEBASE_INDEX_DB_PATH: path.join(tmp, "index.db"),
    CODEBASE_INDEX_HTTP_PORT: String(port),
    CODEBASE_INDEX_HTTP_TOKEN: TOKEN,
    // MCP-ISSUE-104: HTTP refuses to start without one (scripts/serve-http.mjs supplies it in production).
    CODEBASE_INDEX_REFACTOR_APPROVAL_SECRET: "test-http-transport-secret-0123456789abcdef",
    CODEBASE_INDEX_WATCH_AUTO_START_ENABLED: "false"
  },
  stdio: ["ignore", "ignore", "pipe"]
});
child.stderr.on("data", (d) => { stderr += d; });

try {
  await waitForServer(port, child);

  // ── gate ───────────────────────────────────────────────────────────────────
  const bearer = { authorization: `Bearer ${TOKEN}` };
  check("no token → 401", (await rawStatus(port, {})) === 401);
  check("wrong token → 401", (await rawStatus(port, { authorization: "Bearer wrong" })) === 401);
  check("foreign Host → 403", (await rawStatus(port, { ...bearer, host: "evil.example" })) === 403);
  check("foreign Origin → 403", (await rawStatus(port, { ...bearer, origin: "http://evil.example" })) === 403);

  // ── two clients, one process ───────────────────────────────────────────────
  const a = await connect(port);
  const b = await connect(port);
  check("two distinct sessions", a.transport.sessionId !== b.transport.sessionId);

  const indexed = payload(await a.client.callTool({
    name: "index_repository", arguments: { repoId: "r4", repoPath: repo, mode: "full", docsMode: "on" }
  }));
  check("A indexed the scratch repo", (indexed.filesIndexed ?? indexed.run?.filesIndexed ?? 0) > 0, JSON.stringify(indexed).slice(0, 300));

  const [symbols, docs] = await Promise.all([
    a.client.callTool({ name: "search_symbols", arguments: { repoId: "r4", query: "greetUser", strategy: "name" } }),
    b.client.callTool({ name: "query_docs", arguments: { repoId: "r4", mode: "search", query: "greetUser" } })
  ]);
  check("A search_symbols answered", !symbols.isError && symbols.content[0].text.includes("greetUser"), symbols.content[0].text.slice(0, 300));
  check("B query_docs answered", !docs.isError && docs.content[0].text.includes("README.md"), docs.content[0].text.slice(0, 300));

  // ── previews are per session ───────────────────────────────────────────────
  const preview = payload(await a.client.callTool({
    name: "refactor_replace_preview", arguments: { repoId: "r4", find: "greetUser", replaceExpression: "welcomeUser", mode: "text" }
  }));
  check("A got a preview", typeof preview.previewId === "string" && typeof preview.approvalToken === "string", JSON.stringify(preview).slice(0, 300));

  const stolen = await b.client.callTool({
    name: "refactor_replace_apply", arguments: { previewId: preview.previewId, approvalToken: preview.approvalToken, includeLowConfidence: true }
  });
  check("B applying A's preview is refused", stolen.isError === true && stolen.content[0].text.includes("PREVIEW_OWNED_BY_ANOTHER_SESSION"), stolen.content[0].text.slice(0, 300));
  check("B's refusal wrote nothing", fs.readFileSync(path.join(repo, "src", "greet.ts"), "utf8").includes("greetUser"));

  const own = await a.client.callTool({
    name: "refactor_replace_apply", arguments: { previewId: preview.previewId, approvalToken: preview.approvalToken, includeLowConfidence: true }
  });
  check("A applies its own preview", !own.isError, own.content[0].text.slice(0, 300));
  check("A's apply wrote the file", fs.readFileSync(path.join(repo, "src", "greet.ts"), "utf8").includes("welcomeUser"));

  // ── rollbacks are per session too (FX-R1) ──────────────────────────────────
  const rollbackId = own.isError ? undefined : payload(own).rollbackId;
  check("A's apply returned a rollbackId", typeof rollbackId === "string", own.content[0].text.slice(0, 300));
  const undoneByB = await b.client.callTool({ name: "refactor_replace_rollback", arguments: { rollbackId } });
  check("B rolling back A's apply is refused", undoneByB.isError === true && undoneByB.content[0].text.includes("APPLY_OWNED_BY_ANOTHER_SESSION"), undoneByB.content[0].text.slice(0, 300));
  check("B's refused rollback restored nothing", fs.readFileSync(path.join(repo, "src", "greet.ts"), "utf8").includes("welcomeUser"));
  const undoneByA = await a.client.callTool({ name: "refactor_replace_rollback", arguments: { rollbackId } });
  check("A rolls back its own apply", !undoneByA.isError, undoneByA.content[0].text.slice(0, 300));
  check("A's rollback restored the file", fs.readFileSync(path.join(repo, "src", "greet.ts"), "utf8").includes("greetUser"));

  // ── one client leaving does not stop the other ─────────────────────────────
  await a.transport.terminateSession();
  await a.client.close();
  const after = await b.client.callTool({ name: "search_symbols", arguments: { repoId: "r4", query: "greetUser", strategy: "name" } });
  check("B still served after A left", !after.isError);
  check("process still running", child.exitCode === null);
  await b.client.close();
} catch (error) {
  failures.push(`harness crashed: ${error.stack ?? error}\n     server stderr tail: ${stderr.slice(-1500)}`);
} finally {
  child.kill();
}

if (failures.length > 0) {
  console.error(`test-http-transport: ${failures.length} failure(s), ${passed} passed`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`test-http-transport: all ${passed} checks passed`);
