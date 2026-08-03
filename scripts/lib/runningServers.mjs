/**
 * Detect an MCP server process that is still running an older build than the one on disk.
 *
 * Why this exists. `mcp:doctor` spawns a *fresh* process for its `start` check, so it structurally
 * cannot see the state of the server the agent is actually talking to. On 2026-08-03 that gap hid a
 * total failure: the long-running `codebase-index` server held a pre-restructure module graph, so
 * `extractionWorkerPool` resolved `dist/extractors/extractionWorker.js` — a path that no longer
 * existed after the standard-structure move and a rebuild. Every tree-sitter parse failed or timed
 * out; the docs lane, which spawns no worker, still succeeded. A full re-index produced 57 symbols
 * and 0 edges where the previous run of the same tree produced 2097 and 6233, and reported `ok`.
 *
 * Meanwhile `mcp:doctor` reported PASS 4/4 and `health_check` reported the index fresh at HEAD.
 * Nothing in the workspace could see the problem, because nothing looked at the running process.
 *
 * B-12 added the sibling check — orphaned `dist/*.js` with no source. This is the other half: a
 * `dist/` that is *correct on disk* but *newer than the process that loaded it*.
 *
 * A warning, never a failure: a server started before a rebuild is the normal state during
 * development, and the remedy (restart the MCP server) is the agent's to perform, not the repo's.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * Newest mtime among `dist/**\/*.js`, in epoch ms, or `null` when there is no build.
 *
 * The newest file, not `dist/index.js`: the incident above turned on a *worker* module moving, and
 * an entry point that happens not to be rewritten would report a build older than it is.
 */
export function newestBuildTime(distRoot) {
  if (!fs.existsSync(distRoot)) return null;
  let newest = null;
  const walk = (dir) => {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, item.name);
      if (item.isDirectory()) { walk(full); continue; }
      if (!item.name.endsWith(".js")) continue;
      const mtime = fs.statSync(full).mtimeMs;
      if (newest === null || mtime > newest) newest = mtime;
    }
  };
  walk(distRoot);
  return newest;
}

/**
 * Parse `Get-CimInstance Win32_Process | ConvertTo-Json`.
 *
 * `ConvertTo-Json` emits a bare object rather than a one-element array when exactly one process
 * matches, which is the single most common way a parser like this breaks in the field.
 * `CreationDate` arrives as an ISO-8601 string under `-Depth`-limited serialization, and as
 * `/Date(…)/` under some hosts — both are handled.
 */
export function parseWindowsProcesses(json) {
  let parsed;
  try { parsed = JSON.parse(json); } catch { return []; }
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  return rows.flatMap((row) => {
    if (!row || typeof row !== "object") return [];
    const commandLine = typeof row.CommandLine === "string" ? row.CommandLine : "";
    if (!commandLine) return [];
    const raw = row.CreationDate;
    let startedAt = null;
    if (typeof raw === "string") {
      const epoch = /\/Date\((\d+)\)\//.exec(raw);
      startedAt = epoch ? Number(epoch[1]) : Date.parse(raw);
    } else if (raw && typeof raw === "object" && typeof raw.value === "string") {
      startedAt = Date.parse(raw.value);
    }
    if (startedAt === null || Number.isNaN(startedAt)) return [];
    return [{ pid: Number(row.ProcessId), commandLine, startedAt }];
  });
}

/** Parse `ps -eo pid=,lstart=,args=` — three fields, the middle one containing spaces. */
export function parsePosixProcesses(text) {
  return text.split("\n").flatMap((line) => {
    // pid, then a fixed 24-char ctime ("Sun Aug  3 12:14:35 2026"), then the command.
    const m = /^\s*(\d+)\s+(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.*)$/.exec(line);
    if (!m) return [];
    const startedAt = Date.parse(m[2]);
    if (Number.isNaN(startedAt)) return [];
    return [{ pid: Number(m[1]), commandLine: m[3], startedAt }];
  });
}

/**
 * Every live node process, with its start time. Returns `null` — not `[]` — when the platform
 * query fails, so callers can say "could not check" instead of "nothing is running".
 */
export function listNodeProcesses() {
  try {
    if (process.platform === "win32") {
      const out = execFileSync(
        "powershell",
        ["-NoProfile", "-NonInteractive", "-Command",
          "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | " +
          "Select-Object ProcessId,CommandLine,@{n='CreationDate';e={$_.CreationDate.ToString('o')}} | " +
          "ConvertTo-Json -Compress"],
        { encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "ignore"], windowsHide: true }
      );
      return parseWindowsProcesses(out.trim() || "[]");
    }
    const out = execFileSync("ps", ["-eo", "pid=,lstart=,args="], {
      encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "ignore"]
    });
    return parsePosixProcesses(out).filter((p) => /\bnode\b/.test(p.commandLine));
  } catch {
    return null;
  }
}

/**
 * Processes running `entryPath` that started before the newest file in `distRoot`.
 *
 * `null` means "could not determine" (no build, or the process query failed) and must be reported
 * as such — reporting it as clean is how the original gap was created.
 */
export function findStaleRunningServers(entryPath, distRoot, processes = listNodeProcesses()) {
  const builtAt = newestBuildTime(distRoot);
  if (builtAt === null || processes === null) return null;

  // Windows paths are case-insensitive and drive-letter casing is not stable.
  const needle = entryPath.replace(/\\/g, "/").toLowerCase();
  return processes
    .filter((p) => p.commandLine.replace(/\\/g, "/").toLowerCase().includes(needle))
    .filter((p) => p.startedAt < builtAt)
    .map((p) => ({ pid: p.pid, startedAt: p.startedAt, builtAt, behindMs: builtAt - p.startedAt }));
}
