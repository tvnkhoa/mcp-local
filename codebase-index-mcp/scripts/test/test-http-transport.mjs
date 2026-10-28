/**
 * R4: one served process, two clients, over streamable HTTP.
 *
 * Spawns `dist/index.js --transport http` against a scratch repo and an isolated DB, then pins:
 *   - the gate: no token → 401, a foreign Host or Origin → 403;
 *   - two clients answered concurrently by one process (search_symbols + query_docs);
 *   - a refactor preview belongs to the client process that made it (MCP-ISSUE-108): a peer process
 *     applying A's preview is refused with PREVIEW_OWNED_BY_ANOTHER_SESSION, and A's own apply goes through;
 *   - a client closing its session leaves the process serving the other;
 *   - across a restart: the old session id is re-adopted (MCP-ISSUE-103), a NEW session of the same
 *     client process still applies its pre-restart preview (MCP-ISSUE-108), a peer process and another
 *     bearer are refused.
 *
 * Usage: npm run build && node scripts/test/test-http-transport.mjs
 */

import { execFile, execFileSync, spawn } from "node:child_process";
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

// MCP-ISSUE-110: start-up is module resolution on disk (611 modules) — measured 7.5 s idle and 48.7 s with
// 6 CPU burners + 8 processes spawning PowerShell/git, so 30 s failed every run under that load.
const SERVER_START_MS = 120_000;

async function waitForServer(port, child) {
  const deadline = Date.now() + SERVER_START_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited early (${child.exitCode})`);
    try {
      if ((await rawStatus(port, {})) === 401) return;
    } catch { /* not listening yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`server did not start listening within ${String(SERVER_START_MS / 1000)} s`);
}

const payload = (result) => JSON.parse(result.content[0].text);

/** MCP-ISSUE-108: run tool calls from a peer client in another process (_httpPeerClient.mjs); returns their results. */
function peerCalls(port, calls, token = TOKEN) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [path.join(ROOT, "scripts", "test", "_httpPeerClient.mjs")], {
      env: { ...process.env, PEER_REQUEST: JSON.stringify({ port, token, calls }) }, timeout: 60_000
    }, (error, stdout, stderrText) => (error ? reject(new Error(`peer failed: ${error.message}\n${stderrText}`)) : resolve(JSON.parse(stdout))));
  });
}
const refusedAs = (result, code) => result.isError === true && result.content[0].text.includes(code);

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

  const [stolen] = await peerCalls(port, [{
    name: "refactor_replace_apply", arguments: { previewId: preview.previewId, approvalToken: preview.approvalToken, includeLowConfidence: true }
  }]);
  check("a peer process applying A's preview is refused", refusedAs(stolen, "PREVIEW_OWNED_BY_ANOTHER_SESSION"), stolen.content[0].text.slice(0, 300));
  check("the peer's refusal wrote nothing", fs.readFileSync(path.join(repo, "src", "greet.ts"), "utf8").includes("greetUser"));

  const own = await a.client.callTool({
    name: "refactor_replace_apply", arguments: { previewId: preview.previewId, approvalToken: preview.approvalToken, includeLowConfidence: true }
  });
  check("A applies its own preview", !own.isError, own.content[0].text.slice(0, 300));
  check("A's apply wrote the file", fs.readFileSync(path.join(repo, "src", "greet.ts"), "utf8").includes("welcomeUser"));

  // ── rollbacks are per session too (FX-R1) ──────────────────────────────────
  const rollbackId = own.isError ? undefined : payload(own).rollbackId;
  check("A's apply returned a rollbackId", typeof rollbackId === "string", own.content[0].text.slice(0, 300));
  const [undoneByPeer] = await peerCalls(port, [{ name: "refactor_replace_rollback", arguments: { rollbackId } }]);
  check("a peer process rolling back A's apply is refused", refusedAs(undoneByPeer, "APPLY_OWNED_BY_ANOTHER_SESSION"), undoneByPeer.content[0].text.slice(0, 300));
  check("the peer's refused rollback restored nothing", fs.readFileSync(path.join(repo, "src", "greet.ts"), "utf8").includes("welcomeUser"));
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


// ── MCP-ISSUE-103: a restart keeps a session for the bearer that opened it ─────
{
  const TOKEN_ROTATED = "r4-rotated-token-".padEnd(48, "y");
  const port2 = await freePort();
  const dbDir = path.join(tmp, "restart-db");
  fs.mkdirSync(dbDir, { recursive: true });
  const spawnServer = (token) => {
    const proc = spawn(process.execPath, [path.join(ROOT, "dist", "index.js"), "--transport", "http"], {
      env: {
        ...process.env,
        CODEBASE_INDEX_ALLOWED_ROOTS: tmp,
        CODEBASE_INDEX_DB_PATH: path.join(dbDir, "index.db"),
        CODEBASE_INDEX_HTTP_PORT: String(port2),
        CODEBASE_INDEX_HTTP_TOKEN: token,
        CODEBASE_INDEX_REFACTOR_APPROVAL_SECRET: "test-http-restart-secret-0123456789abcdef",
        CODEBASE_INDEX_WATCH_AUTO_START_ENABLED: "false"
      },
      stdio: ["ignore", "ignore", "pipe"]
    });
    proc.stderr.on("data", (d) => { stderr += d; });
    return proc;
  };
  const stop = (proc) => new Promise((resolve) => { if (proc.exitCode !== null) resolve(); else { proc.once("exit", resolve); proc.kill(); } });
  const greet = () => fs.readFileSync(path.join(repo, "src", "greet.ts"), "utf8");
  let srv = spawnServer(TOKEN);
  try {
    await waitForServer(port2, srv);
    const c = await connect(port2);
    const sid = c.transport.sessionId;
    payload(await c.client.callTool({ name: "index_repository", arguments: { repoId: "r4b", repoPath: repo, mode: "full", docsMode: "on" } }));
    const before = payload(await c.client.callTool({
      name: "refactor_replace_preview", arguments: { repoId: "r4b", find: "greetUser", replaceExpression: "helloUser", mode: "text" }
    }));
    check("restart: a preview before the restart", typeof before.previewId === "string", JSON.stringify(before).slice(0, 300));
    const kept = payload(await c.client.callTool({
      name: "refactor_replace_preview", arguments: { repoId: "r4b", find: "greetUser", replaceExpression: "heyUser", mode: "text" }
    }));
    // MCP-ISSUE-108: applied after the restart from a NEW session of this process, the way Claude Code reconnects.
    const renewed = payload(await c.client.callTool({
      name: "refactor_replace_preview", arguments: { repoId: "r4b", find: "greetUser", replaceExpression: "hiUser", mode: "text" }
    }));
    const [peerBefore] = await peerCalls(port2, [{
      name: "refactor_replace_apply", arguments: { previewId: renewed.previewId, approvalToken: renewed.approvalToken, includeLowConfidence: true }
    }]);
    check("restart: before it, a peer process is refused this process's preview", refusedAs(peerBefore, "PREVIEW_OWNED_BY_ANOTHER_SESSION"), peerBefore.content[0].text.slice(0, 300));

    await stop(srv);
    srv = spawnServer(TOKEN);
    await waitForServer(port2, srv);

    // The same client object, same session id, same bearer: no re-initialize.
    const applied = await c.client.callTool({
      name: "refactor_replace_apply", arguments: { previewId: before.previewId, approvalToken: before.approvalToken, includeLowConfidence: true }
    });
    check("restart: same bearer + old session id is re-adopted, and the pre-restart preview applies", !applied.isError, applied.content[0].text.slice(0, 300));
    check("restart: the apply wrote the file", greet().includes("helloUser"));
    check("restart: still the same session id", c.transport.sessionId === sid);
    const rolled = applied.isError
      ? { isError: true, content: [{ text: "no apply" }] }
      : await c.client.callTool({ name: "refactor_replace_rollback", arguments: { rollbackId: payload(applied).rollbackId } });
    check("restart: ... and rolls back", !rolled.isError, rolled.content[0].text.slice(0, 300));
    check("restart: the rollback restored the file", greet().includes("greetUser") && !greet().includes("helloUser"));
    await c.client.close().catch(() => undefined);

    // MCP-ISSUE-108: the same process opens a NEW session (no old id sent) and still owns its pre-restart preview.
    const fresh = await connect(port2);
    check("restart: the new session has a new id", fresh.transport.sessionId !== sid);
    const renewedApply = await fresh.client.callTool({
      name: "refactor_replace_apply", arguments: { previewId: renewed.previewId, approvalToken: renewed.approvalToken, includeLowConfidence: true }
    });
    check("restart: a new session of the same process applies the pre-restart preview", !renewedApply.isError, renewedApply.content[0].text.slice(0, 300));
    check("restart: that apply wrote the file", greet().includes("hiUser"));
    const renewedRollback = renewedApply.isError
      ? { isError: true, content: [{ text: "no apply" }] }
      : await fresh.client.callTool({ name: "refactor_replace_rollback", arguments: { rollbackId: payload(renewedApply).rollbackId } });
    check("restart: ... and rolls it back", !renewedRollback.isError, renewedRollback.content[0].text.slice(0, 300));
    check("restart: that rollback restored the file", greet().includes("greetUser") && !greet().includes("hiUser"));
    await fresh.client.close().catch(() => undefined);
    const [peerAfter] = await peerCalls(port2, [{
      name: "refactor_replace_apply", arguments: { previewId: kept.previewId, approvalToken: kept.approvalToken, includeLowConfidence: true }
    }]);
    check("restart: after it, a peer process is still refused", refusedAs(peerAfter, "PREVIEW_OWNED_BY_ANOTHER_SESSION"), peerAfter.content[0].text.slice(0, 300));
    check("restart: the peer's refusal wrote nothing", !greet().includes("heyUser"));

    // The bearer rotated across the restart: the old id is not this bearer's.
    await stop(srv);
    srv = spawnServer(TOKEN_ROTATED);
    await waitForServer(port2, srv);
    const status = await rawStatus(port2, {
      authorization: `Bearer ${TOKEN_ROTATED}`, "mcp-session-id": sid, "mcp-protocol-version": "2025-06-18"
    });
    check("restart: a different bearer + the old session id → 404", status === 404, `status ${String(status)}`);
    const other = new Client({ name: "r4-rotated", version: "0" });
    const otherTransport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port2}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${TOKEN_ROTATED}` } }
    });
    await other.connect(otherTransport);
    check("restart: the different bearer got a new session", otherTransport.sessionId !== sid);
    const refused = await other.callTool({
      name: "refactor_replace_apply", arguments: { previewId: kept.previewId, approvalToken: kept.approvalToken, includeLowConfidence: true }
    });
    check("restart: its apply of the old session's preview is refused", refused.isError === true && refused.content[0].text.includes("PREVIEW_OWNED_BY_ANOTHER_SESSION"), refused.content[0].text.slice(0, 300));
    check("restart: the refused apply wrote nothing", !greet().includes("heyUser"));
    await other.close().catch(() => undefined);
  } catch (error) {
    failures.push(`restart section crashed: ${error.stack ?? error}\n     server stderr tail: ${stderr.slice(-1500)}`);
  } finally {
    await stop(srv);
  }
}

if (failures.length > 0) {
  console.error(`test-http-transport: ${failures.length} failure(s), ${passed} passed`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`test-http-transport: all ${passed} checks passed`);
