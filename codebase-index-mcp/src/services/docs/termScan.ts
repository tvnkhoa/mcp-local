/**
 * query_docs{ mode:"term" } (R4) — the Zod shape keys of a repo's TS/JS files, read from disk.
 *
 * MCP-ISSUE-131: this scan used to read every file synchronously on the server thread. On wec.aria that is 1 656
 * files, ~3 ms per open on Windows whatever the size, so a cold call took 6-10 s and every other tool call of every
 * session waited behind it (index_status measured 10.3 s instead of 2 ms). Now the reads are async with bounded
 * concurrency, so the event loop stays free and the opens overlap (cold ~1.7 s on wec.aria); per-file keys are cached
 * by mtime+size, so a warm call is the stats alone; concurrent callers for one repo share one scan.
 *
 * MCP-ISSUE-131 (c): the per-file keys are also persisted, one JSON per repo in the freshness state directory, so the
 * first call after a restart is the stats alone too. The file only seeds the cache: every entry is still checked by
 * mtime+size before it is used, and a file with another version, another repo or a bad shape is ignored and rewritten.
 */

import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import type { FieldWithheld } from "../typeResolution/fieldReferences.js";
import { schemaKeys, type SchemaKey } from "./termLookup.js";

/**
 * A term answer's `usages` when the TS lane withheld them. MCP-ISSUE-131: a cold program build outlasts the short wait a
 * term call gives it, so `building` says how to get the full usages — the build continues in the background.
 */
export function withheldTermUsages(term: string, breach: FieldWithheld): Record<string, unknown> {
  const building = breach.kind === "building";
  return {
    status: building ? "building" : "cap_breach",
    coverage: "gap",
    accessesWithheld: true,
    breach,
    ...(building && {
      next:
        `the type program for this repo is still being built in the background (up to a minute on a large repo, once per server process); ` +
        `re-query query_docs(mode:"term", query:"${term}") in a little while for the full usages, or call find_field_accesses(name:"${term}"), which waits up to the query budget for them.`
    })
  };
}

export const TERM_SCAN_MAX_FILES = 5000;
export const TERM_SCAN_MAX_BYTES = 512 * 1024;
/** Files read at once. Above ~8 the libuv pool (4 threads) is the limit; measured on wec.aria: 1 → 7.4 s, 8 → 1.9 s, 32 → 1.7 s. */
export const TERM_SCAN_CONCURRENCY = 16;
/** Cached files across repos; the oldest is dropped past it (one wec.aria worktree is ~1 700 files). */
export const TERM_SCAN_CACHE_MAX = 50_000;

/**
 * MCP-ISSUE-131 (c): the persisted file's format version. Bump it when the entry format or what `schemaKeys` extracts
 * changes — a file of another version is ignored and rewritten.
 */
export const TERM_SCAN_PERSIST_VERSION = 1;
/** A persisted file larger than this is neither loaded nor written (5 000 files cap the entries far below it). */
export const TERM_SCAN_PERSIST_MAX_BYTES = 16 * 1024 * 1024;
/** How long after a scan that changed the entries the repo's file is written; scans in the window coalesce into one write. */
export const TERM_SCAN_PERSIST_DEBOUNCE_MS = 2000;

export type TermScanFile = { relative: string; absolute: string };
export type TermScanResult = { keys: SchemaKey[]; filesScanned: number; capped: boolean };
/** Where a repo's keys persist: the freshness state directory, and the repo identity the file is bound to. */
export type TermScanPersist = { dir: string; repoId: string; repoPath: string };

/** The file-system calls the scanner makes — a seam for unit tests. */
export interface TermScanIo {
  stat(absolute: string): Promise<{ mtimeMs: number; size: number }>;
  readFile(absolute: string): Promise<string>;
}

const nodeIo: TermScanIo = {
  stat: (p) => fs.stat(p),
  readFile: (p) => fs.readFile(p, "utf8")
};

/** Reads and atomic writes of the persisted file — a seam for unit tests. `read` returns null for a missing file. */
export interface TermScanPersistIo {
  read(file: string, maxBytes: number): Promise<string | null>;
  exists(file: string): Promise<boolean>;
  writeAtomic(file: string, text: string): Promise<void>;
}

export const nodePersistIo: TermScanPersistIo = {
  exists: (file) => fs.access(file).then(() => true, () => false),
  async read(file, maxBytes) {
    try {
      const st = await fs.stat(file);
      if (st.size > maxBytes) return null;
      return await fs.readFile(file, "utf8");
    } catch {
      return null;
    }
  },
  async writeAtomic(file, text) {
    // Temp file in the same directory, then rename: a reader sees the old file or the new one, never half of one.
    const tmp = `${file}.${String(process.pid)}.${randomBytes(4).toString("hex")}.tmp`;
    try {
      await fs.writeFile(tmp, text, "utf8");
      await fs.rename(tmp, file);
    } catch (err) {
      await fs.rm(tmp, { force: true }).catch(() => undefined);
      throw err;
    }
  }
};

/**
 * The repo's file name in the freshness state directory. The id hash makes the name exact: `removeRepoStateFiles`
 * deletes this one name, so `wec.aria` never matches `wec.aria-wt-x`, and ids that sanitize alike stay apart.
 */
export function termScanPersistFileName(repoId: string): string {
  const id = repoId.replace(/[^\w.-]/g, "_");
  return `termkeys-${id}-${createHash("sha1").update(repoId).digest("hex").slice(0, 10)}.json`;
}

type Entry = { mtimeMs: number; size: number; keys: SchemaKey[] };
/** One file of a scan: its repo-relative path, its absolute path, its entry. */
type ScanEntry = readonly [relative: string, absolute: string, entry: Entry];

/** The persisted file. `entries` is keyed by repo-relative path; a key is `[key, line, owner]` (its filePath is the entry's). */
type PersistedFile = {
  version: number;
  repoId: string;
  repoPath: string;
  entries: Record<string, { absolute: string; mtimeMs: number; size: number; keys: [string, number, string | null][] }>;
};

/** A persisted file's entries when its header matches this repo and every entry is well formed; null otherwise. */
export function parsePersisted(text: string, persist: Pick<TermScanPersist, "repoId" | "repoPath">): ScanEntry[] | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const file = raw as Partial<PersistedFile>;
  if (file.version !== TERM_SCAN_PERSIST_VERSION || file.repoId !== persist.repoId || file.repoPath !== persist.repoPath) return null;
  if (!file.entries || typeof file.entries !== "object" || Array.isArray(file.entries)) return null;
  const out: ScanEntry[] = [];
  for (const [relative, e] of Object.entries(file.entries)) {
    if (!e || typeof e !== "object" || typeof e.absolute !== "string" || !Number.isFinite(e.mtimeMs) || !Number.isInteger(e.size) || !Array.isArray(e.keys)) return null;
    const keys: SchemaKey[] = [];
    for (const k of e.keys as unknown[]) {
      if (!Array.isArray(k) || k.length !== 3 || typeof k[0] !== "string" || !Number.isInteger(k[1]) || (k[2] !== null && typeof k[2] !== "string")) return null;
      keys.push({ key: k[0], filePath: relative, line: k[1] as number, owner: k[2] as string | null });
    }
    out.push([relative, e.absolute, { mtimeMs: e.mtimeMs, size: e.size, keys }]);
  }
  return out;
}

/** What a persisted file holds, as one hash over relative, absolute, mtime and size (the keys follow from those). */
function signatureOf(entries: readonly ScanEntry[]): string {
  const h = createHash("sha1");
  const sorted = [...entries].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  for (const [relative, absolute, e] of sorted) {
    h.update(relative).update("\u0000").update(absolute).update("\u0000").update(String(e.mtimeMs)).update("\u0000").update(String(e.size)).update("\u0001");
  }
  return h.digest("hex");
}

type PersistState = {
  /** The one async load of the file per process; every scan of the repo awaits it before its first stat. */
  loaded: Promise<void>;
  /** Signature of what the file holds as far as this process knows; null when unknown. */
  signature: string | null;
  /** The latest scan's entries, waiting for the debounce; later scans in the window replace them. */
  pending: { timer: ReturnType<typeof setTimeout>; persist: TermScanPersist; entries: readonly ScanEntry[] } | null;
  writing: Promise<void> | null;
};

export class SchemaKeyScanner {
  private readonly cache = new Map<string, Entry>();
  private readonly inflight = new Map<string, Promise<TermScanResult>>();
  private readonly persisted = new Map<string, PersistState>();

  constructor(
    private readonly io: TermScanIo = nodeIo,
    private readonly opts: {
      concurrency?: number;
      cacheMax?: number;
      maxFiles?: number;
      maxBytes?: number;
      persistIo?: TermScanPersistIo;
      persistDebounceMs?: number;
      persistMaxBytes?: number;
    } = {}
  ) {}

  /**
   * Keys in `files` order. A second call for the same repo and the same file list while one runs joins it. With
   * `persist`, the repo's file in the state directory seeds the cache once per process, and a scan that changed what
   * the file holds rewrites it after the debounce, off the request path.
   */
  scan(scopeKey: string, files: readonly TermScanFile[], persist?: TermScanPersist): Promise<TermScanResult> {
    const list = createHash("sha1");
    for (const f of files) list.update(f.absolute).update("\u0000").update(f.relative).update("\u0001");
    const key = `${scopeKey}\u0000${persist ? path.join(persist.dir, termScanPersistFileName(persist.repoId)) : ""}\u0000${list.digest("hex")}`;
    const running = this.inflight.get(key);
    if (running) return running;
    const started = this.runPersisted(files, persist).finally(() => {
      if (this.inflight.get(key) === started) this.inflight.delete(key);
    });
    this.inflight.set(key, started);
    return started;
  }

  get cachedFiles(): number {
    return this.cache.size;
  }

  /** Start every pending write now and wait for all writes (tests; a caller that is about to exit). */
  async flush(): Promise<void> {
    for (const [file, state] of this.persisted) this.startWrite(file, state);
    await Promise.all([...this.persisted.values()].map((s) => s.writing));
  }

  private async runPersisted(files: readonly TermScanFile[], persist: TermScanPersist | undefined): Promise<TermScanResult> {
    if (!persist) return (await this.run(files)).result;
    const file = path.join(persist.dir, termScanPersistFileName(persist.repoId));
    let state = this.persisted.get(file);
    if (!state) {
      const created: PersistState = { loaded: Promise.resolve(), signature: null, pending: null, writing: null };
      created.loaded = this.load(file, persist, created);
      this.persisted.set(file, created);
      state = created;
    }
    await state.loaded;
    const { result, entries } = await this.run(files);
    this.schedule(file, persist, state, entries);
    return result;
  }

  /** Seed the cache from the repo's file. A missing, unreadable, oversized, corrupt or foreign file seeds nothing. Never throws. */
  private async load(file: string, persist: TermScanPersist, state: PersistState): Promise<void> {
    const maxBytes = this.opts.persistMaxBytes ?? TERM_SCAN_PERSIST_MAX_BYTES;
    let text: string | null;
    try {
      text = await (this.opts.persistIo ?? nodePersistIo).read(file, maxBytes);
    } catch {
      return;
    }
    if (text === null || text.length > maxBytes) return;
    const entries = parsePersisted(text, persist);
    if (!entries) return;
    let seeded = 0;
    for (const [relative, absolute, entry] of entries) {
      const cacheKey = `${absolute}\u0000${relative}`;
      // This process's own entry is never older than the file's: it wins.
      if (this.cache.has(cacheKey)) continue;
      this.remember(cacheKey, entry);
      seeded++;
    }
    if (seeded === entries.length) state.signature = signatureOf(entries);
  }

  /**
   * After a scan: keep its entries for the debounced check. Nothing else runs on the request path — the signature,
   * the existence check and the JSON all happen when the timer fires. The timer is armed once per window and not
   * re-armed, so a steady stream of scans cannot starve the write.
   */
  private schedule(file: string, persist: TermScanPersist, state: PersistState, entries: readonly ScanEntry[]): void {
    if (state.pending) {
      state.pending = { ...state.pending, persist, entries };
      return;
    }
    const timer = setTimeout(() => this.startWrite(file, state), this.opts.persistDebounceMs ?? TERM_SCAN_PERSIST_DEBOUNCE_MS);
    timer.unref?.();
    state.pending = { timer, persist, entries };
  }

  /**
   * Write the pending entries, after any write of the same file still in flight so two renames never race. Skipped when
   * they match what the file holds and the file is still there; a file deleted or replaced behind this process's back
   * (remove_repository, a hand clean-up) is therefore written again by the next scan, never left missing for good.
   */
  private startWrite(file: string, state: PersistState): void {
    const pending = state.pending;
    if (!pending) return;
    clearTimeout(pending.timer);
    state.pending = null;
    const io = this.opts.persistIo ?? nodePersistIo;
    const maxBytes = this.opts.persistMaxBytes ?? TERM_SCAN_PERSIST_MAX_BYTES;
    const writing: Promise<void> = (state.writing ?? Promise.resolve())
      .then(async () => {
        const signature = signatureOf(pending.entries);
        if (signature === state.signature && (await io.exists(file))) return;
        const { persist, entries } = pending;
        const body: PersistedFile = { version: TERM_SCAN_PERSIST_VERSION, repoId: persist.repoId, repoPath: persist.repoPath, entries: {} };
        for (const [relative, absolute, e] of entries) {
          body.entries[relative] = { absolute, mtimeMs: e.mtimeMs, size: e.size, keys: e.keys.map((k) => [k.key, k.line, k.owner]) };
        }
        const text = JSON.stringify(body);
        if (Buffer.byteLength(text, "utf8") > maxBytes) return;
        await io.writeAtomic(file, text);
        state.signature = signature;
      })
      .then(
        () => undefined,
        () => {
          // Unwritable state directory, or a rename refused while a reader holds the file (Windows): a later changed
          // scan tries again. The in-memory cache is unaffected.
          state.signature = null;
        }
      )
      .finally(() => {
        if (state.writing === writing) state.writing = null;
      });
    state.writing = writing;
  }

  private async run(all: readonly TermScanFile[]): Promise<{ result: TermScanResult; entries: ScanEntry[] }> {
    const maxFiles = this.opts.maxFiles ?? TERM_SCAN_MAX_FILES;
    const maxBytes = this.opts.maxBytes ?? TERM_SCAN_MAX_BYTES;
    const files = all.slice(0, maxFiles);
    const perFile: (Entry | null)[] = new Array<Entry | null>(files.length).fill(null);
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < files.length) {
        const at = next++;
        const file = files[at]!;
        try {
          const st = await this.io.stat(file.absolute);
          if (st.size > maxBytes) continue;
          // The keys carry the repo-relative path, so a file two registered repos share (mcp-local holds
          // codebase-index-mcp) is cached once per repo-relative spelling.
          const cacheKey = `${file.absolute}\u0000${file.relative}`;
          const cached = this.cache.get(cacheKey);
          if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
            this.remember(cacheKey, cached);
            perFile[at] = cached;
            continue;
          }
          const entry: Entry = { mtimeMs: st.mtimeMs, size: st.size, keys: schemaKeys(await this.io.readFile(file.absolute), file.relative) };
          this.remember(cacheKey, entry);
          perFile[at] = entry;
        } catch {
          continue;
        }
      }
    };
    const width = Math.max(1, Math.min(this.opts.concurrency ?? TERM_SCAN_CONCURRENCY, files.length));
    await Promise.all(Array.from({ length: width }, worker));
    const keys: SchemaKey[] = [];
    const entries: ScanEntry[] = [];
    for (let i = 0; i < perFile.length; i++) {
      const e = perFile[i];
      if (!e) continue;
      keys.push(...e.keys);
      entries.push([files[i]!.relative, files[i]!.absolute, e]);
    }
    return { result: { keys, filesScanned: entries.length, capped: all.length > maxFiles }, entries };
  }

  private remember(cacheKey: string, entry: Entry): void {
    this.cache.delete(cacheKey);
    this.cache.set(cacheKey, entry);
    const max = this.opts.cacheMax ?? TERM_SCAN_CACHE_MAX;
    while (this.cache.size > max) this.cache.delete(this.cache.keys().next().value as string);
  }
}
