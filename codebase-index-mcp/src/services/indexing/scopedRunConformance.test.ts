import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import Database from "better-sqlite3";

import { GraphStore } from "../../repositories/graphStore.js";
import { createIndexRunner } from "./indexRunner.js";
import { runIndexPipeline } from "./indexPipeline.js";
import { stableId } from "../extractors/extractorPrimitives.js";
import type { IndexMode } from "../../types/index.js";

/**
 * Release J (MCP-ISSUE-085): a scoped run (`dirty`, `incremental`) lands on exactly the graph a full run
 * builds from the same tree. The wec.aria scenarios are measured in the registry entry; these are the
 * fixture cases CI can hold: the drift the fix is for, the C# package-name pre-scan a dirty run used to
 * miss, and another repo's full-text index staying untouched by a scoped run in the shared DB.
 */

const git = (dir: string, ...args: string[]): void => {
  execFileSync("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", ...args], { stdio: "ignore" });
};

function writeTree(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), content);
  }
}

function makeRepo(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), "cim-scoped-"));
  writeTree(root, files);
  git(root, "init", "-q");
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "base");
  return root;
}

async function index(dbPath: string, repoId: string, repoPath: string, mode: IndexMode): Promise<string | undefined> {
  const store = new GraphStore(dbPath);
  try {
    const run = createIndexRunner({
      store,
      limits: { subtxSize: 20, checkpointEveryNBatches: 1, largeFileThresholdBytes: 512 * 1024, maxFileSizeBytes: 500 * 1024, parseWorkers: 0, parseJobTimeoutMs: 20_000 },
      resolvePerformanceProfileOverride: () => "standard"
    });
    return (await run(repoId, repoPath.replace(/\\/g, "/"), mode, true, 1000, 50)).scope;
  } finally {
    store.close();
  }
}

/** One repo's rows, every column, as a sorted multiset per table — what a full run and a scoped run must share. */
function snapshot(dbPath: string, repoId: string): Record<string, string[]> {
  const db = new Database(dbPath, { readonly: true });
  try {
    const out: Record<string, string[]> = {};
    for (const table of ["files", "symbols", "edges", "doc_mentions", "string_literals", "code_comments", "routes"]) {
      const cols = (db.prepare(`select name from pragma_table_info(?)`).all(table) as { name: string }[])
        .map((c) => c.name)
        .filter((c) => !/_at$/.test(c));
      out[table] = (db.prepare(`select ${cols.map((c) => `"${c}"`).join(", ")} from "${table}" where repo_id = ?`).raw().all(repoId) as unknown[][])
        .map((r) => JSON.stringify(r))
        .sort();
    }
    // No repo_id column: the links this repo makes or receives.
    out.cross_repo_deps = (db.prepare(`select * from cross_repo_deps where from_repo_id = ? or to_repo_id = ?`).raw().all(repoId, repoId) as unknown[][])
      .map((r) => JSON.stringify(r))
      .sort();
    return out;
  } finally {
    db.close();
  }
}

function ftsIntegrity(dbPath: string): void {
  const db = new Database(dbPath);
  try {
    for (const t of ["symbols_fts", "literals_fts", "comments_fts", "docs_fts"]) db.prepare(`insert into ${t}(${t}) values('integrity-check')`).run();
  } finally {
    db.close();
  }
}

/** Index `base`, apply `edit`, then compare a scoped run of each mode against a full run on the edited tree. Returns each mode's scope. */
async function assertScopedEqualsFull(
  name: string,
  base: Record<string, string>,
  edit: (root: string) => void
): Promise<Record<"dirty" | "incremental", string>> {
  const scopes = { dirty: "", incremental: "" };
  for (const mode of ["dirty", "incremental"] as const) {
    const repo = makeRepo(base);
    const work = mkdtempSync(path.join(tmpdir(), "cim-scoped-db-"));
    try {
      const scopedDb = path.join(work, "scoped.db");
      const fullDb = path.join(work, "full.db");
      await index(scopedDb, "r", repo, "full");
      edit(repo);
      const scope = await index(scopedDb, "r", repo, mode);
      assert.match(scope ?? "", /^scoped: /, `${name}/${mode}: ran scoped (${String(scope)})`);
      scopes[mode] = scope ?? "";
      await index(fullDb, "r", repo, "full");
      const a = snapshot(scopedDb, "r");
      const b = snapshot(fullDb, "r");
      for (const table of Object.keys(b)) assert.deepEqual(a[table], b[table], `${name}/${mode}: ${table} differs from a full run`);
      ftsIntegrity(scopedDb);
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
    }
  }
  return scopes;
}

test("a second same-named declaration re-decides an unchanged caller's resolved edge, as a full run does", async () => {
  // The drift MCP-ISSUE-085 fixes: caller.ts resolved `helper` into util.ts; extra.ts then declares another
  // `helper`. A full run labels the call ambiguous; a dirty run used to keep the old by-name edge.
  await assertScopedEqualsFull(
    "ambiguous",
    {
      "src/util.ts": "export function helper(): number {\n  return 1;\n}\n",
      "src/caller.ts": "export function main(): number {\n  return helper();\n}\n",
      "src/extra.ts": "export const unrelated = 1;\n"
    },
    (root) => writeTree(root, { "src/extra.ts": "export const unrelated = 1;\n\nexport function helper(): number {\n  return 2;\n}\n" })
  );
});

test("deleting a file that others import and call, with a doc naming it twice, lands as a full run does", async () => {
  // Release K: a dirty run whose ONLY change was a deleted file never queued its dependents (the hook ran
  // after the last extraction batch, and there was none), so caller.ts kept edges into nothing that the
  // safety net then deleted — a full run keeps them as tokens. And the doc's two `helper` rows: one bound
  // row in the scoped run once unbound, two NULL rows in the full run. Found on wec.aria by the
  // `mention-prefix-delete` conformance case.
  await assertScopedEqualsFull(
    "delete-only",
    {
      "src/util.ts": "export function helper(): number {\n  return 1;\n}\n",
      "src/caller.ts": "import { helper } from \"./util\";\n\nexport function main(): number {\n  return helper();\n}\n",
      "docs/notes.md": "# Notes\n\nCall `helper` first; `helper` is cheap.\n"
    },
    (root) => rmSync(path.join(root, "src/util.ts"))
  );
});

test("a doc mention bound to real code over test code moves to the test symbol when the real one is deleted", async () => {
  // Release K4, owner rule: test-code candidates are dropped while a real one exists, kept when all are
  // tests. `widget` binds to src/widget.ts; deleting that declaration must bind it to the test helper in
  // the scoped run exactly as a full run does.
  await assertScopedEqualsFull(
    "test-path-rule",
    {
      "src/widget.ts": "export function widget(): number {\n  return 1;\n}\n\nexport const keep = 1;\n",
      "test/widget.test.ts": "export function widget(): number {\n  return 2;\n}\n",
      "docs/notes.md": "# Notes\n\nThe `widget` helper.\n"
    },
    (root) => writeTree(root, { "src/widget.ts": "export const keep = 1;\n" })
  );
});

test("files that stay dirty across refreshes are not re-extracted, and the graph still equals a full run", async () => {
  // Release K3: a peer session's uncommitted edits stay in the tree; every refresh re-extracted them.
  // A dirty file whose content hash matches the run that indexed it is skipped, as incremental mode does.
  const repo = makeRepo({
    "src/a.ts": "export function alpha(): number {\n  return 1;\n}\n",
    "src/b.ts": "export function beta(): number {\n  return alpha();\n}\n",
    "src/c.ts": "export const gamma = 3;\n"
  });
  const work = mkdtempSync(path.join(tmpdir(), "cim-scoped-db-"));
  try {
    const scopedDb = path.join(work, "scoped.db");
    const fullDb = path.join(work, "full.db");
    await index(scopedDb, "r", repo, "full");
    // The peer's edits, indexed once by a refresh.
    writeTree(repo, {
      "src/a.ts": "export function alpha(): number {\n  return 10;\n}\n\nexport function alphaTwo(): number {\n  return alpha();\n}\n",
      "src/c.ts": "export const gamma = 30;\n"
    });
    await index(scopedDb, "r", repo, "dirty");
    // Then this session's 1-file add: only it is re-extracted.
    writeTree(repo, { "src/probe.ts": "export function probe(): number {\n  return beta();\n}\n" });
    assert.match((await index(scopedDb, "r", repo, "dirty")) ?? "", /^scoped: 1 changed, /, "the two static dirty files are skipped by hash");
    await index(fullDb, "r", repo, "full");
    const a = snapshot(scopedDb, "r");
    const b = snapshot(fullDb, "r");
    for (const table of Object.keys(b)) assert.deepEqual(a[table], b[table], `static-dirty: ${table} differs from a full run`);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  }
});

test("a dirty run reads every .csproj's package names, so a .cs file extracts as in a full run", async () => {
  // `using Acme.Things;` becomes a nuget:acme contract edge only when some project references `Acme`.
  // The dirty run sees just the edited .cs file; it used to pre-scan only dirty .csproj files.
  await assertScopedEqualsFull(
    "csharp-packages",
    {
      "src/A/A.csproj": '<Project Sdk="Microsoft.NET.Sdk">\n  <ItemGroup>\n    <PackageReference Include="Acme" Version="1.0.0" />\n  </ItemGroup>\n</Project>\n',
      "src/B/Use.cs": "using Acme.Things;\n\nnamespace B\n{\n    public class Use\n    {\n        public int Run() { return 1; }\n    }\n}\n"
    },
    (root) =>
      writeTree(root, {
        "src/B/Use.cs": "using Acme.Things;\n\nnamespace B\n{\n    public class Use\n    {\n        public int Run() { return 2; }\n\n        public int Other() { return Run(); }\n    }\n}\n"
      })
  );
});

test("a scoped run leaves another repo's rows and full-text answers in the shared DB untouched", async () => {
  // Before release J every run rebuilt the external-content FTS tables, which re-read every repo; a scoped
  // run now forgets and indexes only its own files' rows.
  const other = makeRepo({ "src/alpha.ts": "// alpha comment words\nexport function alphaService(): string {\n  return \"alpha literal\";\n}\n" });
  const repo = makeRepo({ "src/main.ts": "export function mainEntry(): number {\n  return 1;\n}\n" });
  const work = mkdtempSync(path.join(tmpdir(), "cim-scoped-db-"));
  try {
    const dbPath = path.join(work, "shared.db");
    await index(dbPath, "other", other, "full");
    await index(dbPath, "r", repo, "full");
    const answers = (): unknown => {
      const db = new Database(dbPath, { readonly: true });
      try {
        return {
          symbols: db.prepare(`select s.symbol_id from symbols_fts f join symbols s on s.rowid = f.rowid where symbols_fts match 'alphaService' and s.repo_id = 'other' order by 1`).all(),
          literals: db.prepare(`select l.literal_id from literals_fts f join string_literals l on l.rowid = f.rowid where literals_fts match 'alpha' and l.repo_id = 'other' order by 1`).all(),
          comments: db.prepare(`select c.rowid from comments_fts f join code_comments c on c.rowid = f.rowid where comments_fts match 'alpha' and c.repo_id = 'other' order by 1`).all()
        };
      } finally {
        db.close();
      }
    };
    const before = { rows: snapshot(dbPath, "other"), answers: answers() };
    assert.ok(JSON.stringify(before.answers).includes("symbol_id"), "the other repo answers the probes");
    writeTree(repo, { "src/main.ts": "export function mainEntry(): number {\n  return 2;\n}\n\nexport function alphaService(): number {\n  return 3;\n}\n" });
    assert.match((await index(dbPath, "r", repo, "dirty")) ?? "", /^scoped: /);
    assert.deepEqual(snapshot(dbPath, "other"), before.rows, "the other repo's rows");
    assert.deepEqual(answers(), before.answers, "the other repo's full-text answers");
    ftsIntegrity(dbPath);
  } finally {
    for (const d of [other, repo, work]) rmSync(d, { recursive: true, force: true });
  }
});


// MCP-ISSUE-101 part 3: a declaration an edit only moved keeps its identity — its old id is re-pointed and its
// callers are NOT re-extracted — unless the move changes an order a resolver keeps the first of.

const dependents = (scope: string): number => Number(/(\d+) dependent/.exec(scope)?.[1] ?? NaN);
const shiftDown = (root: string, rel: string, lines: number): void => {
  const file = path.join(root, rel);
  writeFileSync(file, "\n".repeat(lines) + readFileSync(file, "utf8"));
};
const UTIL = "export function helper(): number {\n  return 1;\n}\n\nexport class Box {\n  open(): number {\n    return helper();\n  }\n}\n";
const CALLER = 'import { helper, Box } from "./util";\n\nexport function main(): number {\n  return helper() + new Box().open();\n}\n';

test("a row shift re-points the callers' edges instead of re-extracting them, and lands as a full run does", async () => {
  const scopes = await assertScopedEqualsFull("shift", { "src/util.ts": UTIL, "src/caller.ts": CALLER }, (root) => shiftDown(root, "src/util.ts", 3));
  assert.equal(dependents(scopes.dirty), 0, scopes.dirty);
  assert.equal(dependents(scopes.incremental), 0, scopes.incremental);
});

test("renaming or removing an exported symbol still re-extracts its callers", async () => {
  for (const [name, edited] of [
    ["rename", UTIL.replace("function helper", "function helper2").replace("return helper()", "return helper2()")],
    ["remove", UTIL.replace("export function helper(): number {\n  return 1;\n}\n\n", "").replace("return helper()", "return 1")]
  ] as const) {
    const scopes = await assertScopedEqualsFull(name, { "src/util.ts": UTIL, "src/caller.ts": CALLER }, (root) => writeTree(root, { "src/util.ts": "\n\n" + edited }));
    assert.ok(dependents(scopes.dirty) >= 1 && dependents(scopes.incremental) >= 1, `${name}: ${scopes.dirty} / ${scopes.incremental}`);
  }
});

test("a signature change alone (no row moves) re-extracts the callers", async () => {
  const scopes = await assertScopedEqualsFull("signature", { "src/util.ts": UTIL, "src/caller.ts": CALLER }, (root) =>
    writeTree(root, { "src/util.ts": UTIL.replace("helper(): number", "helper(x?: number): number") })
  );
  assert.ok(dependents(scopes.dirty) >= 1 && dependents(scopes.incremental) >= 1, `${scopes.dirty} / ${scopes.incremental}`);
});

test("a shift that moves an id past a namesake's in ANOTHER file re-extracts nothing: the tie breaks on the path", async () => {
  // caller.ts imports neither helper, so its call is a by-name tie. Before MCP-ISSUE-101 part 4 the lower
  // symbol_id won, so this shift flipped the winner; now src/a.ts wins on its path whatever its id.
  const idAt = (rel: string, row: number): string => stableId(`r:${rel}:function:helper:${String(row)}`);
  const other = idAt("src/b.ts", 0);
  const before = idAt("src/a.ts", 0) < other;
  const flips = Array.from({ length: 60 }, (_, k) => k + 1).find((k) => idAt("src/a.ts", k) < other !== before);
  assert.ok(flips !== undefined);
  const scopes = await assertScopedEqualsFull(
    "id-order-flip-cross-file",
    {
      "src/a.ts": "export function helper(): number {\n  return 1;\n}\n",
      "src/b.ts": "export function helper(): number {\n  return 2;\n}\n",
      "src/caller.ts": "export function main(): number {\n  return helper();\n}\n"
    },
    (root) => shiftDown(root, "src/a.ts", flips)
  );
  assert.equal(dependents(scopes.dirty), 0, scopes.dirty);
  assert.equal(dependents(scopes.incremental), 0, scopes.incremental);
});

test("guard (a): a shift that flips the id order of two overloads in one file re-extracts the caller", async () => {
  // Both Foo overloads move down together, so their line order holds (guard (b) is silent), but the shift is
  // chosen so their ids trade order. The receiver-typed call binds to the first Foo by (file_path, id).
  const idAt = (row: number): string => stableId(`r:src/Lib.cs:method:Foo:${String(row)}`);
  const before = idAt(2) < idAt(3);
  const flips = Array.from({ length: 80 }, (_, k) => k + 1).find((k) => idAt(2 + k) < idAt(3 + k) !== before);
  assert.ok(flips !== undefined);
  const lib = "namespace App {\n  public class Lib {\n    public int Foo(int x) { return x; }\n    public int Foo(string s) { return 0; }\n  }\n}\n";
  const scopes = await assertScopedEqualsFull(
    "id-order-flip-same-file",
    {
      "src/Lib.cs": lib,
      "src/Use.cs": 'namespace App {\n  public class Use {\n    public int Run(Lib l) { return l.Foo(1); }\n  }\n}\n'
    },
    // Inside the class: the file and namespace symbols keep their rows, so only the overloads move.
    (root) => writeTree(root, { "src/Lib.cs": lib.replace("public class Lib {\n", `public class Lib {\n${"\n".repeat(flips)}`) })
  );
  assert.ok(dependents(scopes.dirty) >= 1 && dependents(scopes.incremental) >= 1, `${scopes.dirty} / ${scopes.incremental}`);
});

test("two same-named C# overloads swapped in place re-extract the callers", async () => {
  // Each overload takes the other's row and so the other's id; pairing by signature alone would swap the
  // callers' targets. Both guards fire: the name's (line, id) order and its id order flip.
  const lib = (first: string, second: string): string => `namespace App {\n  public class Lib {\n    ${first}\n    ${second}\n  }\n}\n`;
  const intFoo = "public int Foo(int x) { return x; }";
  const strFoo = "public int Foo(string s) { return 0; }";
  const scopes = await assertScopedEqualsFull(
    "overload-swap",
    {
      "src/Lib.cs": lib(intFoo, strFoo),
      "src/Use.cs": 'namespace App {\n  public class Use {\n    public int Run(Lib l) { return l.Foo(1) + l.Foo("a"); }\n  }\n}\n'
    },
    (root) => writeTree(root, { "src/Lib.cs": lib(strFoo, intFoo) })
  );
  assert.ok(dependents(scopes.dirty) >= 1 && dependents(scopes.incremental) >= 1, `${scopes.dirty} / ${scopes.incremental}`);
});

test("guard (b) alone: overloads that trade line order but keep their id order re-extract, so an ambiguous mention's candidates follow the lines", async () => {
  // Foo(string) moves above Foo(int) with a gap, chosen so the two ids keep their relative order (guard (a)
  // is silent). The doc's ambiguous `Foo` lists its candidates in (path, line, id) order, which flipped.
  const idAt = (row: number): string => stableId(`r:src/Lib.cs:method:Foo:${String(row)}`);
  const lib = (body: string): string => `namespace App {\n  public class Lib {\n${body}  }\n}\n`;
  const intFoo = "    public int Foo(int x) { return x; }\n";
  const strFoo = "    public int Foo(string s) { return 0; }\n";
  const gap = Array.from({ length: 80 }, (_, g) => g + 1).find((g) => idAt(2) < idAt(3) === idAt(3 + g) < idAt(2));
  assert.ok(gap !== undefined);
  const scopes = await assertScopedEqualsFull(
    "overload-line-order",
    { "src/Lib.cs": lib(intFoo + strFoo), "docs/notes.md": "# Notes\n\nCall `Foo` once.\n" },
    (root) => writeTree(root, { "src/Lib.cs": lib(strFoo + "\n".repeat(gap) + intFoo) })
  );
  assert.match(scopes.dirty, /^scoped: 1 changed/);
});

test("guard (a) counts an unmoved namesake in the written file: class B's get moves past class A's", async () => {
  // Leader's review probe: A.get keeps its row (and id); blank lines push B.get to a row whose id sorts on
  // the other side of A.get's. caller.ts's `o.get()` is a by-name tie between the two, so it must re-extract.
  const idAt = (row: number): string => stableId(`r:src/a.ts:method:get:${String(row)}`);
  const mk = (gap: number): string =>
    `export class A {\n  get(): number { return 1; }\n}\n${"\n".repeat(gap)}export class B {\n  get(): number { return 2; }\n}\n`;
  const before = idAt(1) < idAt(4);
  const gap = Array.from({ length: 80 }, (_, k) => k + 1).find((k) => idAt(1) < idAt(4 + k) !== before);
  assert.ok(gap !== undefined);
  const scopes = await assertScopedEqualsFull(
    "same-file-unmoved-namesake",
    { "src/a.ts": mk(0), "src/caller.ts": "export function main(o: any): number {\n  return o.get();\n}\n" },
    (root) => writeTree(root, { "src/a.ts": mk(gap) })
  );
  assert.ok(dependents(scopes.dirty) >= 1 && dependents(scopes.incremental) >= 1, `${scopes.dirty} / ${scopes.incremental}`);
});

test("a 6-file row shift with cross-file callers lands as a full run does", async () => {
  const files: Record<string, string> = {};
  for (let i = 0; i < 6; i++) {
    const next = (i + 1) % 6;
    files[`src/m${String(i)}.ts`] =
      `import { f${String(next)}, K${String(next)} } from "./m${String(next)}";\n\n` +
      `export function f${String(i)}(): number {\n  return 1;\n}\n\nexport class K${String(i)} {\n  run(): number {\n    return f${String(next)}() + new K${String(next)}().run();\n  }\n}\n`;
  }
  files["src/main.ts"] = 'import { f0, K3 } from "./m0";\n\nexport function main(): number {\n  return f0() + new K3().run();\n}\n';
  await assertScopedEqualsFull("six-file-shift", files, (root) => {
    for (let i = 0; i < 6; i++) shiftDown(root, `src/m${String(i)}.ts`, i + 2);
  });
});

test("a run cancelled right after the shifted file's write leaves no edge into an id that is gone", async () => {
  // The re-point runs in the write's own transaction. When it ran later, with the dependents, a run stopped
  // after the batch commit left caller.ts's edges into util.ts's old ids, behind a content hash already current.
  const repo = makeRepo({ "src/util.ts": UTIL, "src/caller.ts": CALLER });
  const work = mkdtempSync(path.join(tmpdir(), "cim-scoped-db-"));
  try {
    const dbPath = path.join(work, "scoped.db");
    await index(dbPath, "r", repo, "full");
    shiftDown(repo, "src/util.ts", 3);
    const store = new GraphStore(dbPath);
    const abort = new AbortController();
    try {
      await runIndexPipeline(store, {
        repoId: "r",
        repoPath: repo.replace(/\\/g, "/"),
        mode: "dirty",
        maxFiles: 1000,
        batchSize: 50,
        parseWorkers: 0,
        onlyRelativePaths: new Set(["src/util.ts"]),
        abortSignal: abort.signal,
        onProgress: (p) => {
          if (p.filesIndexed >= 1) abort.abort();
        }
      });
    } finally {
      store.close();
    }
    const db = new Database(dbPath, { readonly: true });
    try {
      const dangling = db
        .prepare(`select count(*) n from edges where repo_id = 'r' and to_id not like '%:%' and to_id not in (select symbol_id from symbols where repo_id = 'r')`)
        .get() as { n: number };
      assert.equal(dangling.n, 0);
      const intoUtil = db
        .prepare(
          `select count(*) n from edges e join symbols s on s.repo_id = e.repo_id and s.symbol_id = e.from_id
           join symbols t on t.repo_id = e.repo_id and t.symbol_id = e.to_id
           where e.repo_id = 'r' and s.file_path = 'src/caller.ts' and t.file_path = 'src/util.ts'`
        )
        .get() as { n: number };
      assert.ok(intoUtil.n >= 1, "caller.ts still resolves into util.ts, at the new ids");
    } finally {
      db.close();
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  }
});

// MCP-ISSUE-106: an incremental run after a HEAD move re-reads only what git names (the diff from the last complete
// run's commit, the dirty set, and every path indexed while dirty since). Each case moves HEAD and must land on the
// rows a full run builds on the same tree — or walk the tree, where git cannot vouch for the change.

const G1_BASE: Record<string, string> = {
  "src/util.ts": "export function helper(): number {\n  return 1;\n}\n\nexport function spare(): number {\n  return 2;\n}\n",
  "src/caller.ts": 'import { helper } from "./util";\n\nexport function main(): number {\n  return helper();\n}\n',
  "src/old-name.ts": 'import { spare } from "./util";\n\nexport function useSpare(): number {\n  return spare();\n}\n',
  "src/doomed.ts": 'import { helper } from "./util";\n\nexport function doomed(): number {\n  return helper() + 1;\n}\n',
  "docs/notes.md": "# Notes\n\n`helper` and `useSpare` and `doomed`.\n"
};

const commitAll = (root: string, message: string): void => {
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", message);
};

/** Record a tree key naming `paths` on the latest run, as the server's wrapper (index.ts) does after every run. */
function markLatestTreeKey(dbPath: string, paths: string[]): void {
  const s = new GraphStore(dbPath);
  try {
    const latest = s.getLatestRun("r");
    assert.ok(latest);
    s.markRunTreeKey(latest.runId, JSON.stringify({ head: latest.commitSha, files: Object.fromEntries(paths.map((p) => [p, "x"])) }));
  } finally {
    s.close();
  }
}

/** Index G1_BASE full, run `before` then `move` (which moves HEAD), then compare an incremental run with a full run. Returns its scope. */
async function assertIncrementalAfterMoveEqualsFull(
  name: string,
  move: (root: string) => void,
  before?: (root: string, dbPath: string) => Promise<void>
): Promise<string> {
  const repo = makeRepo(G1_BASE);
  const work = mkdtempSync(path.join(tmpdir(), "cim-g1-db-"));
  try {
    const scopedDb = path.join(work, "scoped.db");
    const fullDb = path.join(work, "full.db");
    await index(scopedDb, "r", repo, "full");
    if (before) await before(repo, scopedDb);
    move(repo);
    const scope = (await index(scopedDb, "r", repo, "incremental")) ?? "";
    await index(fullDb, "r", repo, "full");
    const a = snapshot(scopedDb, "r");
    const b = snapshot(fullDb, "r");
    for (const table of Object.keys(b)) assert.deepEqual(a[table], b[table], `${name}: ${table} differs from a full run (${scope})`);
    ftsIntegrity(scopedDb);
    return scope;
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  }
}

test("G1: a commit that adds, modifies, deletes and renames files is git-scoped and lands as a full run does", async () => {
  const scope = await assertIncrementalAfterMoveEqualsFull("commit-amdr", (root) => {
    writeTree(root, {
      "src/util.ts": "export function helper(): number {\n  return 10;\n}\n\nexport function spare(): number {\n  return 2;\n}\n",
      "src/added.ts": 'import { helper } from "./util";\n\nexport function added(): number {\n  return helper();\n}\n'
    });
    rmSync(path.join(root, "src/doomed.ts"));
    git(root, "mv", "src/old-name.ts", "src/new-name.ts");
    commitAll(root, "amdr");
  });
  assert.match(scope, /git-scoped from [0-9a-f]{12}: 5 path\(s\) \(5 from the diff, 0 indexed dirty since\)/, scope);
});

test("G1: a merge commit is git-scoped and lands as a full run does", async () => {
  const scope = await assertIncrementalAfterMoveEqualsFull("merge", (root) => {
    git(root, "checkout", "-q", "-b", "side");
    writeTree(root, { "src/side.ts": 'import { spare } from "./util";\n\nexport function side(): number {\n  return spare();\n}\n' });
    commitAll(root, "side");
    git(root, "checkout", "-q", "-");
    writeTree(root, { "src/caller.ts": 'import { helper } from "./util";\n\nexport function main(): number {\n  return helper() * 2;\n}\n' });
    commitAll(root, "main");
    git(root, "merge", "-q", "--no-ff", "-m", "merge", "side");
  });
  assert.match(scope, /git-scoped from [0-9a-f]{12}: 2 path\(s\)/, scope);
});

test("G1: HEAD moved backwards (checkout of an older commit) is git-scoped and lands as a full run does", async () => {
  const scope = await assertIncrementalAfterMoveEqualsFull(
    "backwards",
    (root) => git(root, "checkout", "-q", "HEAD~1"),
    async (root, dbPath) => {
      writeTree(root, { "src/later.ts": 'import { helper } from "./util";\n\nexport function later(): number {\n  return helper();\n}\n' });
      rmSync(path.join(root, "src/doomed.ts"));
      commitAll(root, "later");
      await index(dbPath, "r", root, "incremental");
    }
  );
  assert.match(scope, /git-scoped from [0-9a-f]{12}: 2 path\(s\)/, scope);
});

test("G1: a .gitignore change walks the tree, and lands as a full run does", async () => {
  const scope = await assertIncrementalAfterMoveEqualsFull("gitignore", (root) => {
    writeTree(root, { ".gitignore": "src/doomed.ts\n" });
    git(root, "rm", "-q", "--cached", "src/doomed.ts");
    commitAll(root, "ignore doomed");
  });
  assert.match(scope, /tree walk: \.gitignore changed/, scope);
});

test("G1: an untracked new file after a commit is git-scoped and lands as a full run does", async () => {
  const scope = await assertIncrementalAfterMoveEqualsFull("untracked", (root) => {
    writeTree(root, { "src/caller.ts": 'import { helper } from "./util";\n\nexport function main(): number {\n  return helper() + 3;\n}\n' });
    commitAll(root, "edit");
    writeTree(root, { "src/fresh.ts": 'import { spare } from "./util";\n\nexport function fresh(): number {\n  return spare();\n}\n' });
  });
  assert.match(scope, /git-scoped from [0-9a-f]{12}: 2 path\(s\) \(1 from the diff, 0 indexed dirty since\)/, scope);
});

test("G1: a file indexed dirty by an earlier dirty run and reverted since is re-read through the tree keys", async () => {
  // The hole: util.ts's edit is indexed by a dirty run, then reverted, and HEAD moves on another file. The edit is
  // in neither the diff nor the dirty set — only the dirty run's tree key names src/util.ts.
  const scope = await assertIncrementalAfterMoveEqualsFull(
    "reverted-dirty",
    (root) => {
      git(root, "checkout", "-q", "--", "src/util.ts");
      writeTree(root, { "src/caller.ts": 'import { helper } from "./util";\n\nexport function main(): number {\n  return helper() + 4;\n}\n' });
      commitAll(root, "other");
    },
    async (root, dbPath) => {
      writeTree(root, { "src/util.ts": "export function helperRenamed(): number {\n  return 1;\n}\n\nexport function spare(): number {\n  return 2;\n}\n" });
      await index(dbPath, "r", root, "dirty");
      markLatestTreeKey(dbPath, ["src/util.ts"]);
    }
  );
  assert.match(scope, /git-scoped from [0-9a-f]{12}: 2 path\(s\) \(1 from the diff, 1 indexed dirty since\)/, scope);
});

test("G1: a dirty run with no tree key since the base walks the tree", async () => {
  const scope = await assertIncrementalAfterMoveEqualsFull(
    "unkeyed-dirty",
    (root) => {
      git(root, "checkout", "-q", "--", "src/util.ts");
      git(root, "commit", "-q", "--allow-empty", "-m", "noop");
    },
    async (root, dbPath) => {
      writeTree(root, { "src/util.ts": "export function helperRenamed(): number {\n  return 1;\n}\n" });
      await index(dbPath, "r", root, "dirty");
    }
  );
  assert.match(scope, /tree walk: a dirty run over a dirty tree recorded no tree key/, scope);
});
