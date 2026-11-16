import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  assertAssemblyFresh,
  checkAssemblyFreshness,
  listSourceMigrations,
  projectDir,
  resolveBuiltAssembly,
  splitPrefixedOutput
} from "./assemblyFreshness.js";

/** A fake EF project: Migrations/<id>.cs (+ Designer + snapshot), and a fake built assembly. */
function fixture(ids: string[], opts: { sourceMs: number; dllMs: number }): { project: string; verbose: string[]; dll: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "asm-fresh-"));
  const migrations = path.join(root, "src", "Infrastructure", "Migrations");
  fs.mkdirSync(migrations, { recursive: true });
  const at = (file: string, ms: number): void => {
    fs.writeFileSync(file, "// fixture\n");
    fs.utimesSync(file, ms / 1000, ms / 1000);
  };
  for (const id of ids) {
    at(path.join(migrations, `${id}.cs`), opts.sourceMs);
    // Designer and snapshot are not migration sources; make them newest to prove they are ignored.
    at(path.join(migrations, `${id}.Designer.cs`), opts.sourceMs + 3_600_000);
  }
  at(path.join(migrations, "AppDbContextModelSnapshot.cs"), opts.sourceMs + 3_600_000);
  const bin = path.join(root, "out dir", "bin", "Web", "debug");
  fs.mkdirSync(bin, { recursive: true });
  const dll = path.join(bin, "Acme.Infrastructure.dll");
  at(dll, opts.dllMs);
  return {
    project: path.join(root, "src", "Infrastructure", "Infrastructure.csproj"),
    verbose: [`Using assembly 'Acme.Infrastructure'.`, `Using startup assembly 'Acme.Web'.`, `Using application base '${bin}'.`],
    dll,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true })
  };
}

const T0 = Date.UTC(2026, 10, 9, 9, 15);
const DAY = 86_400_000;
const IDS = ["20260101000000_Init", "20260102000000_AddA"];

test("prefixed output splits into data and verbose; unprefixed output stays whole", () => {
  const out = splitPrefixedOutput(
    "verbose: Using assembly 'X'.\r\nverbose: Using application base 'D:\\b'.\r\ndata:    [\r\ndata:      {\"id\": \"1_A\"}\r\ndata:    ]\r\ninfo:    done\r\n"
  );
  assert.deepEqual(JSON.parse(out.data), [{ id: "1_A" }]);
  assert.deepEqual(out.verbose, ["Using assembly 'X'.", "Using application base 'D:\\b'."]);
  const plain = '[{"id":"1_A"}]';
  assert.deepEqual(splitPrefixedOutput(plain), { data: plain, verbose: [] });
});

test("the assembly path comes from EF's verbose lines, else its --assembly argument", () => {
  assert.equal(
    resolveBuiltAssembly(["Using assembly 'Acme.Infra'.", "Using application base 'D:\\a b\\bin'."]),
    path.join("D:\\a b\\bin", "Acme.Infra.dll")
  );
  assert.equal(resolveBuiltAssembly(["dotnet exec --depsfile x.json ef.dll migrations list --assembly D:\\o\\A.dll --startup-assembly D:\\o\\W.dll"]), "D:\\o\\A.dll");
  assert.equal(resolveBuiltAssembly(["Finding DbContext classes..."]), undefined);
});

test("projectDir accepts the .csproj or its folder", () => {
  assert.equal(projectDir(path.join("p", "Infra", "Infra.csproj")), path.join("p", "Infra"));
  assert.equal(projectDir(path.join("p", "Infra")), path.join("p", "Infra"));
});

test("fresh: same ids, assembly built after the newest source → fresh, no refusal", (t) => {
  const f = fixture(IDS, { sourceMs: T0, dllMs: T0 + DAY });
  t.after(f.cleanup);
  const r = checkAssemblyFreshness(f.project, IDS, f.verbose);
  assert.equal(r.status, "fresh");
  assert.equal(r.assemblyPath, f.dll);
  assert.deepEqual(r.reasons, []);
  assert.equal(r.newestSource?.id, "20260102000000_AddA", "Designer/snapshot files are not sources");
  assertAssemblyFresh(r);
});

test("stale: a source id the assembly does not list → stale, refuses MIGRATION_ASSEMBLY_STALE", (t) => {
  const ids = [...IDS, "20261116000000_AddNew"];
  const f = fixture(ids, { sourceMs: T0, dllMs: T0 + DAY });
  t.after(f.cleanup);
  const r = checkAssemblyFreshness(f.project, IDS, f.verbose);
  assert.equal(r.status, "stale");
  assert.deepEqual(r.missingFromAssembly, ["20261116000000_AddNew"]);
  assert.match(r.remedy ?? "", /Build the EF startup project/);
  assert.throws(() => assertAssemblyFresh(r), (e: { code?: string }) => e.code === "MIGRATION_ASSEMBLY_STALE");
});

test("stale: an assembly id with no source file (an other-branch build) → refuses", (t) => {
  const f = fixture(IDS, { sourceMs: T0, dllMs: T0 + DAY });
  t.after(f.cleanup);
  const r = checkAssemblyFreshness(f.project, [...IDS, "20261020000000_UatConsolidated"], f.verbose);
  assert.equal(r.status, "stale");
  assert.deepEqual(r.missingFromSource, ["20261020000000_UatConsolidated"]);
  assert.throws(() => assertAssemblyFresh(r), (e: { code?: string }) => e.code === "MIGRATION_ASSEMBLY_STALE");
});

test("branch switch: source mtime newer but ids equal → possibly_stale, warns, never refuses", (t) => {
  const f = fixture(IDS, { sourceMs: T0 + DAY, dllMs: T0 });
  t.after(f.cleanup);
  const r = checkAssemblyFreshness(f.project, IDS, f.verbose);
  assert.equal(r.status, "possibly_stale");
  assert.match(r.reasons.join(" "), /newer than the built assembly/);
  assertAssemblyFresh(r); // does not throw
});

test("no Migrations folder, or no assembly path reported → nothing invented", (t) => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "asm-none-"));
  t.after(() => fs.rmSync(empty, { recursive: true, force: true }));
  assert.equal(listSourceMigrations(path.join(empty, "X.csproj")), null);
  assert.equal(checkAssemblyFreshness(path.join(empty, "X.csproj"), IDS, []).status, "no_source");
  const f = fixture(IDS, { sourceMs: T0 + DAY, dllMs: T0 });
  t.after(f.cleanup);
  const r = checkAssemblyFreshness(f.project, IDS, []);
  assert.equal(r.status, "fresh", "the timestamp check needs the reported assembly");
  assert.match(r.note ?? "", /only the migration ids/);
});
