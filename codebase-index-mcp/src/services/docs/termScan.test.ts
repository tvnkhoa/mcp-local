import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { nodePersistIo, SchemaKeyScanner, termScanPersistFileName, TERM_SCAN_PERSIST_VERSION, withheldTermUsages, type TermScanIo, type TermScanPersistIo } from "./termScan.js";

const ZOD = (key: string): string => `import { z } from "zod";\nexport const shape = z.object({\n  ${key}: z.string()\n});\n`;

/** In-memory files whose reads resolve on a later turn of the event loop, counting every read. */
function fakeIo(files: Record<string, { text: string; mtimeMs?: number }>): TermScanIo & { reads: string[]; inFlight: number; maxInFlight: number } {
  const io = {
    reads: [] as string[],
    inFlight: 0,
    maxInFlight: 0,
    async stat(p: string) {
      const f = files[p];
      if (!f) throw new Error(`ENOENT ${p}`);
      await new Promise((r) => setImmediate(r));
      return { mtimeMs: f.mtimeMs ?? 1, size: f.text.length };
    },
    async readFile(p: string) {
      io.inFlight++;
      io.maxInFlight = Math.max(io.maxInFlight, io.inFlight);
      io.reads.push(p);
      await new Promise((r) => setImmediate(r));
      io.inFlight--;
      return files[p]!.text;
    }
  };
  return io;
}

const list = (names: string[]) => names.map((n) => ({ relative: n, absolute: `/r/${n}` }));

test("MCP-ISSUE-131: keys come back in file order whatever order the reads finish, with filesScanned counting readable files", async () => {
  const io = fakeIo({ "/r/a.ts": { text: ZOD("alpha_id") }, "/r/b.ts": { text: "export const x = 1;\n" }, "/r/c.ts": { text: ZOD("gamma_id") } });
  const scan = await new SchemaKeyScanner(io, { concurrency: 3 }).scan("r", list(["a.ts", "b.ts", "missing.ts", "c.ts"]));
  assert.deepEqual(scan.keys.map((k) => [k.key, k.filePath, k.line, k.owner]), [["alpha_id", "a.ts", 3, "shape"], ["gamma_id", "c.ts", 3, "shape"]]);
  assert.equal(scan.filesScanned, 3, "the missing file is skipped, the zod-free one counts");
  assert.equal(scan.capped, false);
});

test("MCP-ISSUE-131: reads overlap up to the concurrency bound, never past it", async () => {
  const files: Record<string, { text: string }> = {};
  const names = Array.from({ length: 20 }, (_, i) => `f${String(i)}.ts`);
  for (const n of names) files[`/r/${n}`] = { text: ZOD(`k_${n.replace(/\W/g, "")}`) };
  const io = fakeIo(files);
  const scan = await new SchemaKeyScanner(io, { concurrency: 4 }).scan("r", list(names));
  assert.equal(scan.keys.length, 20);
  assert.ok(io.maxInFlight > 1, `reads overlapped (max in flight ${String(io.maxInFlight)})`);
  assert.ok(io.maxInFlight <= 4, `bounded by the concurrency (max in flight ${String(io.maxInFlight)})`);
});

test("MCP-ISSUE-131: the scan yields to the event loop — a timer set before it fires before it ends", async () => {
  const io = fakeIo({ "/r/a.ts": { text: ZOD("alpha_id") }, "/r/b.ts": { text: ZOD("beta_id") } });
  let ticked = false;
  setImmediate(() => (ticked = true));
  const pending = new SchemaKeyScanner(io).scan("r", list(["a.ts", "b.ts"]));
  assert.equal(ticked, false);
  await pending;
  assert.equal(ticked, true);
});

test("MCP-ISSUE-131: an unchanged file is served from the cache; a changed mtime re-reads it", async () => {
  const files = { "/r/a.ts": { text: ZOD("alpha_id"), mtimeMs: 1 }, "/r/b.ts": { text: ZOD("beta_id"), mtimeMs: 1 } };
  const io = fakeIo(files);
  const scanner = new SchemaKeyScanner(io);
  await scanner.scan("r", list(["a.ts", "b.ts"]));
  assert.equal(io.reads.length, 2);
  const warm = await scanner.scan("r", list(["a.ts", "b.ts"]));
  assert.equal(io.reads.length, 2, "warm scan reads nothing");
  assert.deepEqual(warm.keys.map((k) => k.key), ["alpha_id", "beta_id"]);
  files["/r/b.ts"] = { text: ZOD("beta_v2"), mtimeMs: 2 };
  const changed = await scanner.scan("r", list(["a.ts", "b.ts"]));
  assert.deepEqual(io.reads, ["/r/a.ts", "/r/b.ts", "/r/b.ts"]);
  assert.deepEqual(changed.keys.map((k) => k.key), ["alpha_id", "beta_v2"]);
});

test("MCP-ISSUE-131: concurrent scans of one repo share one pass; the cache drops its oldest file past the cap", async () => {
  const io = fakeIo({ "/r/a.ts": { text: ZOD("alpha_id") }, "/r/b.ts": { text: ZOD("beta_id") }, "/r/c.ts": { text: ZOD("gamma_id") } });
  const scanner = new SchemaKeyScanner(io, { cacheMax: 2 });
  const [one, two] = await Promise.all([scanner.scan("r", list(["a.ts", "b.ts", "c.ts"])), scanner.scan("r", list(["a.ts", "b.ts", "c.ts"]))]);
  assert.equal(one, two, "the second caller joined the first scan");
  assert.equal(io.reads.length, 3);
  assert.equal(scanner.cachedFiles, 2);
  await scanner.scan("r", list(["c.ts"]));
  assert.equal(io.reads.length, 3, "the newest file is still cached");
  await scanner.scan("r", list(["a.ts"]));
  assert.equal(io.reads.length, 4, "the oldest was dropped and is read again");
});

test("MCP-ISSUE-131: files past maxFiles and over maxBytes are not read; capped says so", async () => {
  const io = fakeIo({ "/r/a.ts": { text: ZOD("alpha_id") }, "/r/big.ts": { text: ZOD("big_key") + "x".repeat(100) }, "/r/c.ts": { text: ZOD("gamma_id") } });
  const scan = await new SchemaKeyScanner(io, { maxFiles: 2, maxBytes: 120 }).scan("r", list(["a.ts", "big.ts", "c.ts"]));
  assert.deepEqual(scan.keys.map((k) => k.key), ["alpha_id"]);
  assert.equal(scan.filesScanned, 1);
  assert.equal(scan.capped, true);
  assert.deepEqual(io.reads, ["/r/a.ts"]);
});

test("MCP-ISSUE-131: a withheld 'building' usages block says how to get the full usages", () => {
  const building = withheldTermUsages("requested_action", { kind: "building", detail: "type program still building for 'wec.aria' (2.1 s so far)" });
  assert.equal(building.status, "building");
  assert.equal(building.accessesWithheld, true);
  assert.match(String(building.next), /re-query query_docs\(mode:"term", query:"requested_action"\)/);
  assert.match(String(building.next), /find_field_accesses\(name:"requested_action"\)/);
  const breach = withheldTermUsages("requested_action", { kind: "memory", detail: "heap" });
  assert.equal(breach.status, "cap_breach");
  assert.equal("next" in breach, false, "only a build in progress promises a later answer");
});

test("MCP-ISSUE-131 review: a file two nested repos share keeps each repo's relative path", async () => {
  const io = fakeIo({ "/ws/server/src/a.ts": { text: ZOD("alpha_id") } });
  const scanner = new SchemaKeyScanner(io);
  const outer = await scanner.scan("ws", [{ relative: "server/src/a.ts", absolute: "/ws/server/src/a.ts" }]);
  const inner = await scanner.scan("server", [{ relative: "src/a.ts", absolute: "/ws/server/src/a.ts" }]);
  assert.equal(outer.keys[0]!.filePath, "server/src/a.ts");
  assert.equal(inner.keys[0]!.filePath, "src/a.ts", "not the outer repo's spelling from the cache");
});

test("MCP-ISSUE-131 review: concurrent scans of one repo with different file lists of the same length do not share a pass", async () => {
  const io = fakeIo({ "/r/a.ts": { text: ZOD("alpha_id") }, "/r/b.ts": { text: ZOD("beta_id") } });
  const scanner = new SchemaKeyScanner(io);
  const [one, two] = await Promise.all([scanner.scan("r", list(["a.ts"])), scanner.scan("r", list(["b.ts"]))]);
  assert.deepEqual(one.keys.map((k) => k.key), ["alpha_id"]);
  assert.deepEqual(two.keys.map((k) => k.key), ["beta_id"]);
});

// ---- MCP-ISSUE-131 (c): the per-repo key cache persisted in the freshness state directory ----

function stateDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cim-termkeys-"));
}

const persistFor = (dir: string, repoId = "r", repoPath = "/r") => ({ dir, repoId, repoPath });

test("MCP-ISSUE-131 (c): a fresh scanner seeded from the repo's file reads no unchanged file; keys and order are the same", async () => {
  const dir = stateDir();
  try {
    const files = { "/r/a.ts": { text: ZOD("alpha_id") }, "/r/b.ts": { text: "export const x = 1;\n" }, "/r/c.ts": { text: ZOD("gamma_id") } };
    const first = new SchemaKeyScanner(fakeIo(files));
    const cold = await first.scan("r", list(["a.ts", "b.ts", "c.ts"]), persistFor(dir));
    await first.flush();
    const file = path.join(dir, termScanPersistFileName("r"));
    const body = JSON.parse(fs.readFileSync(file, "utf8")) as { version: number; repoId: string; repoPath: string; entries: Record<string, unknown> };
    assert.deepEqual([body.version, body.repoId, body.repoPath, Object.keys(body.entries)], [TERM_SCAN_PERSIST_VERSION, "r", "/r", ["a.ts", "b.ts", "c.ts"]]);
    const io = fakeIo(files);
    const restarted = await new SchemaKeyScanner(io).scan("r", list(["a.ts", "b.ts", "c.ts"]), persistFor(dir));
    assert.deepEqual(io.reads, [], "the restart costs the stats only");
    assert.deepEqual(restarted, cold);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("MCP-ISSUE-131 (c): an entry whose file changed since it was persisted is re-read (mtime, then size)", async () => {
  const dir = stateDir();
  try {
    const files: Record<string, { text: string; mtimeMs?: number }> = { "/r/a.ts": { text: ZOD("alpha_id"), mtimeMs: 1 }, "/r/b.ts": { text: ZOD("beta_id"), mtimeMs: 1 } };
    const first = new SchemaKeyScanner(fakeIo(files));
    await first.scan("r", list(["a.ts", "b.ts"]), persistFor(dir));
    await first.flush();
    files["/r/b.ts"] = { text: ZOD("beta_id"), mtimeMs: 2 };
    const io = fakeIo(files);
    const second = new SchemaKeyScanner(io);
    await second.scan("r", list(["a.ts", "b.ts"]), persistFor(dir));
    await second.flush();
    assert.deepEqual(io.reads, ["/r/b.ts"], "same size, new mtime");
    files["/r/a.ts"] = { text: ZOD("alpha_v22"), mtimeMs: 1 };
    const io2 = fakeIo(files);
    const scan = await new SchemaKeyScanner(io2).scan("r", list(["a.ts", "b.ts"]), persistFor(dir));
    assert.deepEqual(io2.reads, ["/r/a.ts"], "same mtime, new size; b.ts came from the rewritten file");
    assert.deepEqual(scan.keys.map((k) => k.key), ["alpha_v22", "beta_id"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("MCP-ISSUE-131 (c): a corrupt, other-version, other-repo or malformed file is ignored, never trusted, and rewritten", async () => {
  const files = { "/r/a.ts": { text: ZOD("alpha_id") } };
  const good = { version: TERM_SCAN_PERSIST_VERSION, repoId: "r", repoPath: "/r", entries: { "a.ts": { absolute: "/r/a.ts", mtimeMs: 1, size: ZOD("alpha_id").length, keys: [["poisoned", 3, "shape"]] } } };
  const bad: [string, string][] = [
    ["corrupt", "{\"version\":1,"],
    ["other version", JSON.stringify({ ...good, version: TERM_SCAN_PERSIST_VERSION + 1 })],
    ["other repo id", JSON.stringify({ ...good, repoId: "other" })],
    ["other repo path", JSON.stringify({ ...good, repoPath: "/elsewhere" })],
    ["malformed key", JSON.stringify({ ...good, entries: { "a.ts": { ...good.entries["a.ts"], keys: [["poisoned", "3", "shape"]] } } })],
    ["malformed entry", JSON.stringify({ ...good, entries: { "a.ts": { absolute: "/r/a.ts", mtimeMs: 1 } } })],
    ["not an object", "[1,2,3]"]
  ];
  for (const [label, text] of bad) {
    const dir = stateDir();
    try {
      const file = path.join(dir, termScanPersistFileName("r"));
      fs.writeFileSync(file, text);
      const io = fakeIo(files);
      const scanner = new SchemaKeyScanner(io);
      const scan = await scanner.scan("r", list(["a.ts"]), persistFor(dir));
      assert.deepEqual(io.reads, ["/r/a.ts"], `${label}: the file was read from disk`);
      assert.deepEqual(scan.keys.map((k) => k.key), ["alpha_id"], `${label}: nothing from the bad file`);
      await scanner.flush();
      const rewritten = JSON.parse(fs.readFileSync(file, "utf8")) as typeof good;
      assert.equal(rewritten.version, TERM_SCAN_PERSIST_VERSION, `${label}: rewritten`);
      assert.deepEqual(rewritten.entries["a.ts"].keys, [["alpha_id", 3, "shape"]], `${label}: rewritten with the real keys`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  // The control: the same file, well formed, IS trusted (its mtime+size match), so each case above failed on its defect.
  const dir = stateDir();
  try {
    fs.writeFileSync(path.join(dir, termScanPersistFileName("r")), JSON.stringify(good));
    const io = fakeIo(files);
    const scan = await new SchemaKeyScanner(io).scan("r", list(["a.ts"]), persistFor(dir));
    assert.deepEqual([io.reads, scan.keys.map((k) => k.key)], [[], ["poisoned"]]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("MCP-ISSUE-131 (c): the file is loaded once per repo, lazily; writes are debounced, coalesced, and skipped when nothing changed", async () => {
  const files: Record<string, { text: string; mtimeMs?: number }> = { "/r/a.ts": { text: ZOD("alpha_id"), mtimeMs: 1 } };
  const reads: string[] = [];
  const writes: string[] = [];
  const persistIo: TermScanPersistIo = {
    read(file) {
      reads.push(file);
      return Promise.resolve(null);
    },
    exists: () => Promise.resolve(writes.length > 0),
    writeAtomic(_file, text) {
      writes.push(text);
      return Promise.resolve();
    }
  };
  const scanner = new SchemaKeyScanner(fakeIo(files), { persistIo, persistDebounceMs: 30 });
  assert.equal(reads.length, 0, "nothing is loaded before the first scan");
  await scanner.scan("r", list(["a.ts"]), persistFor("/state"));
  files["/r/a.ts"] = { text: ZOD("alpha_v2"), mtimeMs: 2 };
  await scanner.scan("r", list(["a.ts"]), persistFor("/state"));
  assert.equal(writes.length, 0, "no write on the request path");
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(reads.length, 1, "one load for the repo");
  assert.equal(writes.length, 1, "two changed scans in the window: one write");
  assert.match(writes[0]!, /alpha_v2/);
  await scanner.scan("r", list(["a.ts"]), persistFor("/state"));
  await scanner.flush();
  assert.equal(writes.length, 1, "an unchanged scan writes nothing");
  await scanner.scan("other", list(["a.ts"]), persistFor("/state", "other"));
  await scanner.flush();
  assert.deepEqual([reads.length, writes.length], [2, 2], "another repo has its own file");
});

test("MCP-ISSUE-131 (c) review: a file deleted behind the process's back is written again by the next scan, even an unchanged one", async () => {
  const dir = stateDir();
  try {
    const files = { "/r/a.ts": { text: ZOD("alpha_id") } };
    const scanner = new SchemaKeyScanner(fakeIo(files));
    await scanner.scan("r", list(["a.ts"]), persistFor(dir));
    await scanner.flush();
    const file = path.join(dir, termScanPersistFileName("r"));
    assert.ok(fs.existsSync(file));
    fs.rmSync(file); // remove_repository, or a hand clean-up
    await scanner.scan("r", list(["a.ts"]), persistFor(dir));
    await scanner.flush();
    assert.ok(fs.existsSync(file), "rewritten although no source file changed");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("MCP-ISSUE-131 (c) review: a scan does no persist work on the request path — the write check runs when the timer fires", async () => {
  let checks = 0;
  const persistIo: TermScanPersistIo = {
    read: () => Promise.resolve(null),
    exists: () => {
      checks++;
      return Promise.resolve(true);
    },
    writeAtomic: () => Promise.resolve()
  };
  const scanner = new SchemaKeyScanner(fakeIo({ "/r/a.ts": { text: ZOD("alpha_id") } }), { persistIo, persistDebounceMs: 60_000 });
  for (let i = 0; i < 3; i++) await scanner.scan("r", list(["a.ts"]), persistFor("/state"));
  assert.equal(checks, 0, "nothing ran yet: three scans share one armed timer");
  await scanner.flush();
  await scanner.scan("r", list(["a.ts"]), persistFor("/state"));
  await scanner.flush();
  assert.equal(checks, 1, "the first window wrote (no signature yet); the second checked the file and skipped");
});

test("MCP-ISSUE-131 (c): a file over the size bound is neither written nor loaded", async () => {
  const dir = stateDir();
  try {
    const files = { "/r/a.ts": { text: ZOD("alpha_id") } };
    const small = new SchemaKeyScanner(fakeIo(files), { persistMaxBytes: 50 });
    await small.scan("r", list(["a.ts"]), persistFor(dir));
    await small.flush();
    assert.deepEqual(fs.readdirSync(dir), [], "not written");
    const normal = new SchemaKeyScanner(fakeIo(files));
    await normal.scan("r", list(["a.ts"]), persistFor(dir));
    await normal.flush();
    assert.equal(fs.readdirSync(dir).length, 1);
    const io = fakeIo(files);
    await new SchemaKeyScanner(io, { persistMaxBytes: 50 }).scan("r", list(["a.ts"]), persistFor(dir));
    assert.deepEqual(io.reads, ["/r/a.ts"], "not loaded");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("MCP-ISSUE-131 (c): the write is atomic — temp file then rename, no temp left behind, a failed write keeps the old file", async () => {
  const dir = stateDir();
  try {
    const file = path.join(dir, termScanPersistFileName("r"));
    await nodePersistIo.writeAtomic(file, "one");
    await nodePersistIo.writeAtomic(file, "two");
    assert.deepEqual(fs.readdirSync(dir), [path.basename(file)], "no temp file left");
    assert.equal(fs.readFileSync(file, "utf8"), "two");
    // A target that cannot be replaced (a non-empty directory): the rename fails and the temp file is removed.
    const blocked = path.join(dir, "blocked.json");
    fs.mkdirSync(blocked);
    fs.writeFileSync(path.join(blocked, "x"), "x");
    await assert.rejects(nodePersistIo.writeAtomic(blocked, "three"));
    assert.deepEqual(fs.readdirSync(dir).sort(), [path.basename(file), "blocked.json"].sort(), "no temp file left after a failure");
    assert.equal(fs.readFileSync(path.join(blocked, "x"), "utf8"), "x", "the old target is untouched");
    // The scanner swallows a failed write: the scan still answers.
    const failing: TermScanPersistIo = { read: () => Promise.resolve(null), exists: () => Promise.resolve(false), writeAtomic: () => Promise.reject(new Error("EPERM")) };
    const scanner = new SchemaKeyScanner(fakeIo({ "/r/a.ts": { text: ZOD("alpha_id") } }), { persistIo: failing });
    const scan = await scanner.scan("r", list(["a.ts"]), persistFor(dir));
    await scanner.flush();
    assert.deepEqual(scan.keys.map((k) => k.key), ["alpha_id"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("MCP-ISSUE-131 (c): this process's own cache entry wins over the persisted one", async () => {
  const dir = stateDir();
  try {
    const files = { "/r/a.ts": { text: ZOD("alpha_id") } };
    const stale = { version: TERM_SCAN_PERSIST_VERSION, repoId: "r", repoPath: "/r", entries: { "a.ts": { absolute: "/r/a.ts", mtimeMs: 1, size: ZOD("alpha_id").length, keys: [["from_file", 3, "shape"]] } } };
    fs.writeFileSync(path.join(dir, termScanPersistFileName("r")), JSON.stringify(stale));
    const io = fakeIo(files);
    const scanner = new SchemaKeyScanner(io);
    await scanner.scan("r", list(["a.ts"]));
    const scan = await scanner.scan("r", list(["a.ts"]), persistFor(dir));
    assert.deepEqual([io.reads.length, scan.keys.map((k) => k.key)], [1, ["alpha_id"]]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("MCP-ISSUE-131 (c): the file name is exact per repo id — no id's name is a prefix of another's", () => {
  const a = termScanPersistFileName("wec.aria");
  const b = termScanPersistFileName("wec.aria-wt-tech-fix");
  assert.ok(!b.startsWith(a.replace(/\.json$/, "")), `${b} does not extend ${a}`);
  assert.notEqual(termScanPersistFileName("a/b"), termScanPersistFileName("a_b"), "ids that sanitize alike stay apart");
  assert.match(a, /^termkeys-wec\.aria-[0-9a-f]{10}\.json$/);
});
