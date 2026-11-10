/**
 * MCP-ISSUE-108: which client process is behind a loopback HTTP session — its pid from the socket, the pid's
 * start time, and the owner key built from both. Split out of `httpTransport.ts` (size cap); re-exported there.
 */

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { defaultEnvSource } from "@mcp/core";

/** The only address this transport binds. Not configurable, by design. */
export const HTTP_LOOPBACK_HOST = "127.0.0.1";

/** Pid of the row `127.0.0.1:<remotePort>` -> `127.0.0.1:<serverPort>` ESTABLISHED in `netstat -ano -p TCP` output. */
export function parseNetstatClientPid(output: string, remotePort: number, serverPort: number): number | null {
  const local = `${HTTP_LOOPBACK_HOST}:${String(remotePort)}`;
  const foreign = `${HTTP_LOOPBACK_HOST}:${String(serverPort)}`;
  for (const line of output.split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length >= 5 && cols[0] === "TCP" && cols[1] === local && cols[2] === foreign && cols[3] === "ESTABLISHED") {
      const pid = Number(cols[4]);
      return Number.isInteger(pid) && pid > 0 ? pid : null;
    }
  }
  return null;
}

/** A Windows system binary by absolute path, so a same-named file earlier on PATH is never run. */
function windowsSystemExe(...relativeToSystem32: string[]): string {
  return path.win32.join(defaultEnvSource()["SystemRoot"] ?? "C:\\Windows", "System32", ...relativeToSystem32);
}

export function resolveClientPidViaNetstat(remotePort: number, serverPort: number): Promise<number | null> {
  if (process.platform !== "win32") return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile(windowsSystemExe("NETSTAT.EXE"), ["-ano", "-p", "TCP"], { windowsHide: true, timeout: 10_000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
      resolve(error === null ? parseNetstatClientPid(stdout, remotePort, serverPort) : null);
    });
  });
}

/**
 * MCP-ISSUE-108: a process's start time, as an opaque string; null when unknown. win32 asks PowerShell for the
 * start time in ticks (null for a process it may not inspect), Linux reads the start field of /proc/<pid>/stat,
 * anything else is null. Never throws.
 */
export function resolveProcessStartTime(pid: number): Promise<string | null> {
  if (!Number.isInteger(pid) || pid <= 0) return Promise.resolve(null);
  if (process.platform === "linux") {
    return readFile(`/proc/${String(pid)}/stat`, "utf8").then(
      // Field 22, counted after the parenthesised command name (which may itself hold spaces).
      (stat) => stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] ?? null,
      () => null
    );
  }
  if (process.platform !== "win32") return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile(
      windowsSystemExe("WindowsPowerShell", "v1.0", "powershell.exe"),
      ["-NoProfile", "-NonInteractive", "-Command", `(Get-Process -Id ${String(pid)} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`],
      { windowsHide: true, timeout: 15_000 },
      (error, stdout) => {
        const ticks = stdout.trim();
        resolve(error === null && /^\d+$/.test(ticks) ? ticks : null);
      }
    );
  });
}

/**
 * MCP-ISSUE-108: the owner key of a client process — pid, start time and (over HTTP) a prefix of the bearer's
 * sha256 — or null when the pid or its start time is unknown. Null is fail-closed: the caller keys on the
 * session id instead, which does not survive a restart.
 */
export async function clientIdentityOf(
  pid: number | null,
  bearerDigestHex: string | null,
  startTimeOf: (pid: number) => Promise<string | null>
): Promise<string | null> {
  if (pid === null) return null;
  const started = await startTimeOf(pid).catch(() => null);
  if (started === null || started === "") return null;
  return `pid:${String(pid)}@${started}${bearerDigestHex === null ? "" : `/${bearerDigestHex.slice(0, 16)}`}`;
}
