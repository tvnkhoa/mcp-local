/**
 * query_docs{ mode:"term" } (R4) — the Zod shape keys of a repo's TS/JS files, read from disk.
 *
 * MCP-ISSUE-131: this scan used to read every file synchronously on the server thread. On wec.aria that is 1 656
 * files, ~3 ms per open on Windows whatever the size, so a cold call took 6-10 s and every other tool call of every
 * session waited behind it (index_status measured 10.3 s instead of 2 ms). Now the reads are async with bounded
 * concurrency, so the event loop stays free and the opens overlap (cold ~1.7 s on wec.aria); per-file keys are cached
 * by mtime+size, so a warm call is the stats alone; concurrent callers for one repo share one scan.
 */

import { createHash } from "node:crypto";
import fs from "node:fs/promises";

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

export type TermScanFile = { relative: string; absolute: string };
export type TermScanResult = { keys: SchemaKey[]; filesScanned: number; capped: boolean };

/** The file-system calls the scanner makes — a seam for unit tests. */
export interface TermScanIo {
  stat(absolute: string): Promise<{ mtimeMs: number; size: number }>;
  readFile(absolute: string): Promise<string>;
}

const nodeIo: TermScanIo = {
  stat: (p) => fs.stat(p),
  readFile: (p) => fs.readFile(p, "utf8")
};

type Entry = { mtimeMs: number; size: number; keys: SchemaKey[] };

export class SchemaKeyScanner {
  private readonly cache = new Map<string, Entry>();
  private readonly inflight = new Map<string, Promise<TermScanResult>>();

  constructor(
    private readonly io: TermScanIo = nodeIo,
    private readonly opts: { concurrency?: number; cacheMax?: number; maxFiles?: number; maxBytes?: number } = {}
  ) {}

  /** Keys in `files` order. A second call for the same repo and the same file list while one runs joins it. */
  scan(scopeKey: string, files: readonly TermScanFile[]): Promise<TermScanResult> {
    const list = createHash("sha1");
    for (const f of files) list.update(f.absolute).update("\u0000").update(f.relative).update("\u0001");
    const key = `${scopeKey}\u0000${list.digest("hex")}`;
    const running = this.inflight.get(key);
    if (running) return running;
    const started = this.run(files).finally(() => {
      if (this.inflight.get(key) === started) this.inflight.delete(key);
    });
    this.inflight.set(key, started);
    return started;
  }

  get cachedFiles(): number {
    return this.cache.size;
  }

  private async run(all: readonly TermScanFile[]): Promise<TermScanResult> {
    const maxFiles = this.opts.maxFiles ?? TERM_SCAN_MAX_FILES;
    const maxBytes = this.opts.maxBytes ?? TERM_SCAN_MAX_BYTES;
    const files = all.slice(0, maxFiles);
    const perFile: (SchemaKey[] | null)[] = new Array<SchemaKey[] | null>(files.length).fill(null);
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
            perFile[at] = cached.keys;
            continue;
          }
          const keys = schemaKeys(await this.io.readFile(file.absolute), file.relative);
          this.remember(cacheKey, { mtimeMs: st.mtimeMs, size: st.size, keys });
          perFile[at] = keys;
        } catch {
          continue;
        }
      }
    };
    const width = Math.max(1, Math.min(this.opts.concurrency ?? TERM_SCAN_CONCURRENCY, files.length));
    await Promise.all(Array.from({ length: width }, worker));
    const keys: SchemaKey[] = [];
    let filesScanned = 0;
    for (const k of perFile) {
      if (k === null) continue;
      filesScanned++;
      keys.push(...k);
    }
    return { keys, filesScanned, capped: all.length > maxFiles };
  }

  private remember(cacheKey: string, entry: Entry): void {
    this.cache.delete(cacheKey);
    this.cache.set(cacheKey, entry);
    const max = this.opts.cacheMax ?? TERM_SCAN_CACHE_MAX;
    while (this.cache.size > max) this.cache.delete(this.cache.keys().next().value as string);
  }
}
