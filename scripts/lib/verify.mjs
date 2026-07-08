// Spawn an MCP server process and confirm it responds to a JSON-RPC `initialize`.
// Extracted from codebase-index-mcp/scripts/setup.mjs, generalized over entry + env.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// A healthy stdio MCP server answers `initialize` regardless of backend
// credentials (creds only matter on tool calls), so we treat a valid response
// as the authoritative health signal. Resolves to { ok:boolean, message:string }.
export function verifyServer(entryPath, env = {}) {
  return new Promise((resolve) => {
    // The handshake opens the server's persistence layer on startup — for codebase-index that
    // creates a SQLite DB. Confine any such side effect to a throwaway temp dir (cwd + an
    // isolated CODEBASE_INDEX_DB_PATH) so a health/install probe never drops a stray *.db into
    // the workspace root. The DB path is irrelevant to `initialize` (creds/paths only matter on
    // tool calls), so overriding it does not weaken the health signal.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-verify-"));
    const cleanup = () => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ } };

    const proc = spawn("node", [entryPath], {
      cwd: tmpDir,
      env: { ...process.env, ...env, CODEBASE_INDEX_DB_PATH: path.join(tmpDir, "verify.db") },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let closed = false;
    proc.on("close", () => { closed = true; });

    let settled = false;
    let stdout = "";

    function settle(okFlag, message) {
      if (settled) return;
      settled = true;
      clearTimeout(aliveTimer);
      clearTimeout(writeTimer);
      // On the success path the child is still alive and holds verify.db (an immediate rmSync
      // would EBUSY on Windows). Wait for it to exit — releasing the file handle — before
      // cleaning up and resolving, with a fallback so a wedged child can't hang the probe.
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        clearTimeout(fallback);
        cleanup();
        resolve({ ok: okFlag, message });
      };
      const fallback = setTimeout(finish, 2000);
      if (typeof fallback.unref === "function") fallback.unref();
      if (closed) finish();
      else proc.once("close", finish);
      try { proc.kill(); } catch { finish(); }
    }

    // No `initialize` response within 10s → not healthy (e.g. hung on a bad
    // connection). Liveness alone is NOT treated as success.
    const aliveTimer = setTimeout(
      () => settle(false, "no initialize response within 10s"),
      10_000,
    );

    const initRequest = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "mcp-verify", version: "1.0.0" },
      },
    }) + "\n";

    // A proper JSON-RPC reply to our id:1 initialize (not a stray log line that
    // merely contains "result"). Scans complete lines seen so far.
    function sawInitializeResult() {
      for (const line of stdout.split("\n")) {
        const t = line.trim();
        if (!t.startsWith("{")) continue;
        try {
          const msg = JSON.parse(t);
          if (msg.id === 1 && msg.result && (msg.result.serverInfo || msg.result.capabilities)) {
            return true;
          }
        } catch { /* partial/non-JSON line */ }
      }
      return false;
    }

    proc.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      if (sawInitializeResult()) settle(true, "responded to initialize");
    });
    proc.stderr.on("data", () => {}); // suppress startup logs
    proc.stdin.on("error", () => {}); // ignore EPIPE if the child died first
    proc.on("error", (e) => settle(false, `spawn failed: ${e.message}`));
    proc.on("close", (code) => {
      // A stdio server that exits before answering initialize is not healthy.
      settle(false, code === 0 ? "exited before responding" : `exited (code ${code})`);
    });

    // Give the server a moment to boot, then send the handshake.
    const writeTimer = setTimeout(() => {
      try { proc.stdin.write(initRequest); } catch { /* child already gone */ }
    }, 500);
  });
}
