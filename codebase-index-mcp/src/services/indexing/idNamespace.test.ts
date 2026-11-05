import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import Database from "better-sqlite3";

import { GraphStore } from "../../repositories/graphStore.js";
import { createIndexRunner } from "./indexRunner.js";
import { bindRunRepoId } from "./indexPipeline.js";
import { stableId } from "../extractors/extractorPrimitives.js";

/**
 * IX-9 U1 (MCP-ISSUE-119): a repository's id namespace. Ids are minted under the namespace, rows are
 * written under the run's repoId, and an unset namespace leaves every id exactly as before.
 */

const git = (dir: string, ...args: string[]): void => {
  execFileSync("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", ...args], { stdio: "ignore" });
};

const FILES: Record<string, string> = {
  "src/a.ts": 'export function alpha(): string { return beta() + "lit-alpha-value"; }\nexport function beta(): string { return "b"; }\n',
  "src/b.ts": 'import { alpha } from "./a";\nexport class Gamma { run(): string { return alpha(); } }\n',
  "docs/guide.md": "# Guide\n\nCall `alpha` then `Gamma`.\n"
};

function makeRepo(): string {
  const root = mkdtempSync(path.join(tmpdir(), "cim-idns-"));
  for (const [rel, content] of Object.entries(FILES)) {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), content);
  }
  git(root, "init", "-q");
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "base");
  return root;
}

async function fullIndex(dbPath: string, repoId: string, repoPath: string, namespace?: string): Promise<void> {
  const store = new GraphStore(dbPath);
  try {
    if (namespace !== undefined) {
      store.ensureRepository(repoId, repoPath.replace(/\\/g, "/"));
      assert.equal(store.setIdNamespace(repoId, namespace), true);
    }
    const run = createIndexRunner({
      store,
      limits: { subtxSize: 20, checkpointEveryNBatches: 1, largeFileThresholdBytes: 512 * 1024, maxFileSizeBytes: 500 * 1024, parseWorkers: 0, parseJobTimeoutMs: 20_000 },
      resolvePerformanceProfileOverride: () => "standard"
    });
    await run(repoId, repoPath.replace(/\\/g, "/"), "full", true, 1000, 50, {});
  } finally {
    store.close();
  }
}

const TABLES = ["files", "symbols", "edges", "routes", "string_literals", "docs", "doc_mentions", "code_comments"];

/** One repo's rows without repo_id and timestamps, as a sorted multiset per table. */
function rows(dbPath: string, repoId: string): Record<string, string[]> {
  const db = new Database(dbPath, { readonly: true });
  try {
    const out: Record<string, string[]> = {};
    for (const table of TABLES) {
      const cols = (db.prepare(`select name from pragma_table_info(?)`).all(table) as { name: string }[])
        .map((c) => c.name)
        .filter((c) => c !== "repo_id" && !/_at$/.test(c));
      out[table] = (db.prepare(`select ${cols.map((c) => `"${c}"`).join(", ")} from "${table}" where repo_id = ?`).raw().all(repoId) as unknown[][])
        .map((r) => JSON.stringify(r))
        .sort();
    }
    return out;
  } finally {
    db.close();
  }
}

function countByRepo(dbPath: string): Record<string, number> {
  const db = new Database(dbPath, { readonly: true });
  try {
    const out: Record<string, number> = {};
    for (const table of TABLES) {
      for (const r of db.prepare(`select repo_id as repoId, count(*) as n from "${table}" group by repo_id`).all() as { repoId: string; n: number }[]) {
        out[`${table}:${r.repoId}`] = r.n;
      }
    }
    return out;
  } finally {
    db.close();
  }
}

test("an unset namespace mints ids from the repoId exactly as before", async () => {
  const repo = makeRepo();
  const dir = mkdtempSync(path.join(tmpdir(), "cim-idns-db-"));
  try {
    const dbPath = path.join(dir, "g.db");
    await fullIndex(dbPath, "parent", repo);
    const db = new Database(dbPath, { readonly: true });
    try {
      const alpha = db.prepare(`select symbol_id as id from symbols where repo_id = ? and name = 'alpha'`).get("parent") as { id: string };
      // makeSymbolId's preimage, row 0 (extractorPrimitives.ts): the pre-U1 spelling.
      assert.equal(alpha.id, stableId("parent:src/a.ts:function:alpha:0"));
      const ns = db.prepare(`select id_namespace as ns from repositories where repo_id = ?`).get("parent") as { ns: string | null };
      assert.equal(ns.ns, null);
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test("a repo sharing a namespace gets the parent's ids, written under its own repoId", async () => {
  const repo = makeRepo();
  const dir = mkdtempSync(path.join(tmpdir(), "cim-idns-db-"));
  try {
    const dbPath = path.join(dir, "g.db");
    await fullIndex(dbPath, "parent", repo);
    const parentRows = rows(dbPath, "parent");
    const before = countByRepo(dbPath);
    await fullIndex(dbPath, "child", repo, "parent");

    const childRows = rows(dbPath, "child");
    assert.ok(childRows.symbols.length > 0 && childRows.edges.length > 0 && childRows.string_literals.length > 0 && childRows.docs.length > 0);
    for (const table of TABLES) assert.deepEqual(childRows[table], parentRows[table], `${table}: same ids and content as the parent`);

    // Nothing was written under the namespace: the parent's rows are untouched, and every child row is under "child".
    const after = countByRepo(dbPath);
    for (const [key, n] of Object.entries(before)) assert.equal(after[key], n, `${key} unchanged`);
    for (const table of TABLES) {
      assert.equal(after[`${table}:child`] ?? 0, before[`${table}:parent`] ?? 0, `${table}: child row count = parent row count`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test("get/setIdNamespace: unknown repo refused, a namespace equal to the repoId or null is stored as unset", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "cim-idns-db-"));
  try {
    const store = new GraphStore(path.join(dir, "g.db"));
    try {
      assert.equal(store.setIdNamespace("nobody", "x"), false, "unknown repo");
      store.ensureRepository("r", "C:/r");
      assert.equal(store.getIdNamespace("r"), "r");
      store.setIdNamespace("r", "ns");
      assert.equal(store.getIdNamespace("r"), "ns");
      store.setIdNamespace("r", "r");
      assert.equal(store.getIdNamespace("r"), "r");
      store.setIdNamespace("r", "ns");
      store.setIdNamespace("r", null);
      assert.equal(store.getIdNamespace("r"), "r");
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bindRunRepoId re-binds every record list to the run's repoId", () => {
  const extracted = {
    symbols: [{ repoId: "ns" }],
    edges: [{ repoId: "ns" }, { repoId: "ns" }],
    routes: [{ repoId: "ns" }],
    docs: [{ repoId: "ns" }],
    mentions: [{ repoId: "ns" }],
    literals: [{ repoId: "ns" }]
  };
  bindRunRepoId(extracted, "run");
  for (const list of Object.values(extracted)) for (const r of list) assert.equal(r.repoId, "run");
  const sparse = { symbols: [{ repoId: "ns" }], edges: [] };
  bindRunRepoId(sparse, "run");
  assert.equal(sparse.symbols[0]!.repoId, "run");
});
