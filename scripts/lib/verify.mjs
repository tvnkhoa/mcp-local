// Spawn an MCP server process and confirm it responds to a JSON-RPC `initialize`.
// Extracted from codebase-index-mcp/scripts/setup.mjs, generalized over entry + env.

import { spawn } from "node:child_process";

// A healthy stdio MCP server answers `initialize` regardless of backend
// credentials (creds only matter on tool calls), so we treat a valid response
// as the authoritative health signal. Resolves to { ok:boolean, message:string }.
export function verifyServer(entryPath, env = {}) {
  return new Promise((resolve) => {
    const proc = spawn("node", [entryPath], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let settled = false;
    let stdout = "";

    function settle(okFlag, message) {
      if (settled) return;
      settled = true;
      clearTimeout(aliveTimer);
      clearTimeout(writeTimer);
      try { proc.kill(); } catch {}
      resolve({ ok: okFlag, message });
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
