import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import Database from "better-sqlite3";

import { GraphStore } from "../../repositories/graphStore.js";
import { createIndexRunner } from "./indexRunner.js";
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
    for (const table of ["files", "symbols", "edges", "doc_mentions", "string_literals", "code_comments"]) {
      const cols = (db.prepare(`select name from pragma_table_info(?)`).all(table) as { name: string }[])
        .map((c) => c.name)
        .filter((c) => !/_at$/.test(c));
      out[table] = (db.prepare(`select ${cols.map((c) => `"${c}"`).join(", ")} from "${table}" where repo_id = ?`).raw().all(repoId) as unknown[][])
        .map((r) => JSON.stringify(r))
        .sort();
    }
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

/** Index `base`, apply `edit`, then compare a scoped run of each mode against a full run on the edited tree. */
async function assertScopedEqualsFull(name: string, base: Record<string, string>, edit: (root: string) => void): Promise<void> {
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
