/**
 * MCP-ISSUE-103: which bearer opened which HTTP session, kept across a server restart.
 *
 * A restart dropped every client's session (an unknown `Mcp-Session-Id` is a 404), and each Claude session
 * then needed a manual `/mcp`. Re-adopting an id on a valid bearer alone would let any bearer claim any id, so
 * the transport records, at initialize, the sha256 of the bearer that opened the session, and re-adopts an
 * unknown id only for a request presenting that same bearer.
 *
 * Owned by the SDK (one JSON file per served process) rather than a server's own database: every server that
 * serves over HTTP gets it, and the transport needs no access to a server's storage. Written owner-only
 * (mode 0600; the directory is the server's state dir, under the user profile) via write-then-rename, so a
 * crash leaves the old file or the new one. Entries older than `maxAgeMs` are dropped when the file is
 * written. A file that cannot be read is treated as empty: re-adoption is a convenience, and refusing is the
 * safe answer.
 */

import fs from "node:fs";
import path from "node:path";

export interface HttpSessionStore {
  /** The hex sha256 of the bearer that initialized `sessionId`, or null. */
  get(sessionId: string): string | null;
  set(sessionId: string, bearerDigestHex: string): void;
  delete(sessionId: string): void;
}

type StoreFile = { version: 1; sessions: Record<string, { bearer: string; at: number }> };

export function fileHttpSessionStore(file: string, maxAgeMs: number, now: () => number = Date.now): HttpSessionStore {
  const read = (): StoreFile => {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as StoreFile;
      if (parsed && parsed.version === 1 && parsed.sessions && typeof parsed.sessions === "object") return parsed;
    } catch {
      // absent or unreadable: nothing to re-adopt
    }
    return { version: 1, sessions: {} };
  };
  const write = (data: StoreFile): void => {
    const cutoff = now() - maxAgeMs;
    for (const [id, entry] of Object.entries(data.sessions)) if (entry.at < cutoff) delete data.sessions[id];
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.${String(process.pid)}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(data), { encoding: "utf8", mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch {
      // best-effort: a session that is not recorded simply cannot be re-adopted
    }
  };
  return {
    get(sessionId) {
      const entry = read().sessions[sessionId];
      return entry && now() - entry.at <= maxAgeMs ? entry.bearer : null;
    },
    set(sessionId, bearerDigestHex) {
      const data = read();
      data.sessions[sessionId] = { bearer: bearerDigestHex, at: now() };
      write(data);
    },
    delete(sessionId) {
      const data = read();
      if (!(sessionId in data.sessions)) return;
      delete data.sessions[sessionId];
      write(data);
    }
  };
}
