import assert from "node:assert/strict";
import test from "node:test";

import { SchemaKeyScanner, withheldTermUsages, type TermScanIo } from "./termScan.js";

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
