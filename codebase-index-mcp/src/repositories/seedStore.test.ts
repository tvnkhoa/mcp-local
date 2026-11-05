import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import Database from "better-sqlite3";

import { GraphStore } from "./graphStore.js";
import { SEED_TABLES, SeedError, seedFromParent, unhandledSeedTables } from "./seedStore.js";
import { ftsIntegrityCheck } from "./scopedRunStore.js";
import { createIndexRunner } from "../services/indexing/indexRunner.js";

/** IX-9 U2 (MCP-ISSUE-119): seeding a worktree's index by copying its parent's rows. */

const git = (dir: string, ...args: string[]): void => {
  execFileSync("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", ...args], { stdio: "ignore" });
};

const FILES: Record<string, string> = {
  "src/a.ts": 'export function alpha(): string { return beta() + "lit-alpha-value"; }\n// alpha comment prose\nexport function beta(): string { return "b"; }\n',
  "src/b.ts": 'import { alpha } from "./a";\nexport class Gamma { run(): string { return alpha(); } }\n',
  "docs/guide.md": "# Guide\n\nCall `alpha` then `Gamma`.\n"
};

function makeRepo(): string {
  const root = mkdtempSync(path.join(tmpdir(), "cim-seed-"));
  for (const [rel, content] of Object.entries(FILES)) {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), content);
  }
  git(root, "init", "-q");
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "base");
  return root;
}

const slash = (p: string): string => p.replace(/\\/g, "/");

async function fullIndex(dbPath: string, repoId: string, repoPath: string, namespace?: string): Promise<void> {
  const store = new GraphStore(dbPath);
  try {
    if (namespace !== undefined) {
      store.ensureRepository(repoId, slash(repoPath));
      store.setIdNamespace(repoId, namespace);
    }
    const run = createIndexRunner({
      store,
      limits: { subtxSize: 20, checkpointEveryNBatches: 1, largeFileThresholdBytes: 512 * 1024, maxFileSizeBytes: 500 * 1024, parseWorkers: 0, parseJobTimeoutMs: 20_000 },
      resolvePerformanceProfileOverride: () => "standard"
    });
    await run(repoId, slash(repoPath), "full", true, 1000, 50, {});
  } finally {
    store.close();
  }
}

const COPIED = Object.entries(SEED_TABLES).filter(([, v]) => v.action === "copy").map(([k]) => k);

function rows(dbPath: string, repoId: string): Record<string, string[]> {
  const db = new Database(dbPath, { readonly: true });
  try {
    const out: Record<string, string[]> = {};
    for (const table of COPIED) {
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

function withTmp(fn: (dir: string) => Promise<void>): () => Promise<void> {
  return async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "cim-seed-db-"));
    try {
      await fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

test("SEED_TABLES names every table of a fresh graph DB (fails when the schema gains an unhandled table)", withTmp(async (dir) => {
  const dbPath = path.join(dir, "g.db");
  new GraphStore(dbPath).close();
  const db = new Database(dbPath);
  try {
    assert.deepEqual(unhandledSeedTables(db), []);
    db.exec(`create table brand_new_repo_table (repo_id text not null, x text)`);
    assert.deepEqual(unhandledSeedTables(db), ["brand_new_repo_table"]);
  } finally {
    db.close();
  }
  const store = new GraphStore(dbPath);
  try {
    assert.throws(() => seedFromParent(store, { parentRepoId: "p", childRepoId: "c", childRepoPath: "C:/c" }), (e: unknown) => e instanceof SeedError && e.code === "SCHEMA_UNHANDLED");
  } finally {
    store.close();
  }
}));

test("a parent with no ok run is refused as PARENT_NOT_INDEXED, and nothing is written", withTmp(async (dir) => {
  const store = new GraphStore(path.join(dir, "g.db"));
  try {
    store.ensureRepository("p", "C:/p");
    assert.throws(() => seedFromParent(store, { parentRepoId: "p", childRepoId: "c", childRepoPath: "C:/c" }), (e: unknown) => e instanceof SeedError && e.code === "PARENT_NOT_INDEXED");
    assert.throws(() => seedFromParent(store, { parentRepoId: "nobody", childRepoId: "c", childRepoPath: "C:/c" }), (e: unknown) => e instanceof SeedError && e.code === "PARENT_NOT_INDEXED");
    assert.equal(store.getIdNamespace("c"), "c");
  } finally {
    store.close();
  }
}));

test("a seeded child holds the parent's rows under its own repoId, equal to a full index under the same namespace", withTmp(async (dir) => {
  const repo = makeRepo();
  try {
    const dbPath = path.join(dir, "g.db");
    await fullIndex(dbPath, "parent", repo);
    await fullIndex(dbPath, "fullchild", repo, "parent");
    const parentBefore = rows(dbPath, "parent");

    const store = new GraphStore(dbPath);
    let result;
    try {
      result = seedFromParent(store, { parentRepoId: "parent", childRepoId: "seeded", childRepoPath: slash(repo) });
      assert.equal(store.getIdNamespace("seeded"), "parent");
      // Idempotent: a second seed replaces, it does not duplicate.
      const again = seedFromParent(store, { parentRepoId: "parent", childRepoId: "seeded", childRepoPath: slash(repo) });
      assert.deepEqual(again.tablesCopied, result.tablesCopied);
    } finally {
      store.close();
    }
    assert.match(result.parentIndexedSha, /^[0-9a-f]{40}$/);
    assert.ok(result.tablesCopied.symbols! > 0 && result.tablesCopied.edges! > 0 && result.tablesCopied.docs! > 0);
    assert.ok(result.durationMs >= 0);

    const seeded = rows(dbPath, "seeded");
    const full = rows(dbPath, "fullchild");
    for (const table of COPIED) {
      assert.deepEqual(seeded[table], parentBefore[table], `${table}: seeded = parent`);
      assert.deepEqual(seeded[table], full[table], `${table}: seeded = full under the same namespace`);
      assert.equal(result.tablesCopied[table], seeded[table]!.length, `${table}: tablesCopied`);
    }
    assert.deepEqual(rows(dbPath, "parent"), parentBefore, "parent untouched");
    // Rowid order is the tie-break of equal-ranked answers: the copy keeps the parent's (a full run's) order.
    const order = (repoId: string): string[] => {
      const db = new Database(dbPath, { readonly: true });
      try {
        return (db.prepare("select file_path || '|' || name as k from symbols where repo_id = ? order by rowid").all(repoId) as { k: string }[]).map((r) => r.k);
      } finally {
        db.close();
      }
    };
    assert.deepEqual(order("seeded"), order("parent"), "symbols keep the parent's rowid order");

    const db = new Database(dbPath);
    try {
      ftsIntegrityCheck(db);
      const ftsIds = (table: string, col: string, match: string, repoId: string): string[] =>
        (db.prepare(`select ${col} as id from ${table} where ${table} match ? and repo_id = ? order by 1`).all(match, repoId) as { id: string }[]).map((r) => r.id);
      assert.deepEqual(ftsIds("symbols_fts", "symbol_id", "alpha", "seeded"), ftsIds("symbols_fts", "symbol_id", "alpha", "fullchild"));
      assert.ok(ftsIds("symbols_fts", "symbol_id", "alpha", "seeded").length > 0);
      assert.deepEqual(ftsIds("docs_fts", "doc_id", "Gamma", "seeded"), ftsIds("docs_fts", "doc_id", "Gamma", "fullchild"));
      assert.deepEqual(ftsIds("literals_fts", "literal_id", "alpha", "seeded"), ftsIds("literals_fts", "literal_id", "alpha", "fullchild"));
      const comments = (repoId: string): number =>
        (db.prepare(`select count(*) as n from comments_fts f join code_comments c on c.rowid = f.rowid where comments_fts match 'prose' and c.repo_id = ?`).get(repoId) as { n: number }).n;
      assert.equal(comments("seeded"), comments("fullchild"));

      const runs = db.prepare(`select mode, status, commit_sha as sha from index_runs where repo_id = ?`).all("seeded") as { mode: string; status: string; sha: string }[];
      assert.deepEqual(runs, [{ mode: "seed", status: "ok", sha: result.parentIndexedSha }]);
      const vec = (repoId: string): number => (db.prepare(`select count(*) as n from vec_symbol_map where repo_id = ?`).get(repoId) as { n: number }).n;
      assert.equal(vec("seeded"), vec("fullchild"));
    } finally {
      db.close();
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}));

test("IX-9: clearRepositoryIndex drops the seeded child's index, keeps its registration and the parent, FTS consistent", withTmp(async (dir) => {
  const repo = makeRepo();
  try {
    const dbPath = path.join(dir, "g.db");
    await fullIndex(dbPath, "parent", repo);
    const parentBefore = rows(dbPath, "parent");
    const store = new GraphStore(dbPath);
    try {
      assert.equal(store.seedBaseSha("seeded"), null);
      const seeded = seedFromParent(store, { parentRepoId: "parent", childRepoId: "seeded", childRepoPath: slash(repo) });
      assert.equal(store.seedBaseSha("parent"), seeded.parentIndexedSha, "the ancestry check reads the row the seed copies");
      assert.equal(store.seedBaseSha("seeded"), seeded.parentIndexedSha);
      const counts = store.clearRepositoryIndex("seeded");
      assert.ok((counts.symbols ?? 0) > 0);
      assert.equal(store.seedBaseSha("seeded"), null, "no run left: the next registration seeds again");
      assert.equal(store.getIdNamespace("seeded"), "parent", "registration (namespace) kept");
      ftsIntegrityCheck((store as unknown as { db: Database.Database }).db);
    } finally {
      store.close();
    }
    const after = rows(dbPath, "seeded");
    for (const [table, list] of Object.entries(after)) assert.equal(list.length, 0, `${table} cleared`);
    assert.deepEqual(rows(dbPath, "parent"), parentBefore, "parent untouched");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}));

// ── IX-9 review H1 / M1 / L1 ─────────────────────────────────────────────────

async function indexRun(dbPath: string, repoId: string, repoPath: string, mode: "full" | "incremental" | "dirty", extras: Record<string, unknown> = {}): Promise<void> {
  const store = new GraphStore(dbPath);
  try {
    const run = createIndexRunner({
      store,
      limits: { subtxSize: 20, checkpointEveryNBatches: 1, largeFileThresholdBytes: 512 * 1024, maxFileSizeBytes: 500 * 1024, parseWorkers: 0, parseJobTimeoutMs: 20_000 },
      resolvePerformanceProfileOverride: () => "standard"
    });
    await run(repoId, slash(repoPath), mode, true, 1000, 50, extras);
  } finally {
    store.close();
  }
}

/** A copy of the repo's newest run row with some columns overridden (every NOT NULL counter filled). */
function addRunLike(db: Database.Database, repoId: string, over: Record<string, unknown>): void {
  const base = db.prepare(`select * from index_runs where repo_id = ? order by rowid desc limit 1`).get(repoId) as Record<string, unknown>;
  const row = { ...base, ...over };
  const cols = Object.keys(row);
  db.prepare(`insert into index_runs (${cols.map((c) => `"${c}"`).join(", ")}) values (${cols.map(() => "?").join(", ")})`).run(...cols.map((c) => row[c]));
}

function rawDb<T>(dbPath: string, fn: (db: Database.Database) => T): T {
  const db = new Database(dbPath);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

test("H1: a failed parent run after the base (batches may have landed) refuses the seed — PARENT_UNVOUCHED, nothing written", withTmp(async (dir) => {
  const repo = makeRepo();
  try {
    const dbPath = path.join(dir, "g.db");
    await fullIndex(dbPath, "parent", repo);
    // A later incremental that committed a batch of newer content, then failed: the row says failed, the rows are newer.
    rawDb(dbPath, (db) => {
      db.prepare(`update symbols set name = 'alphaFromAFailedRun' where repo_id = 'parent' and name = 'alpha'`).run();
      addRunLike(db, "parent", { run_id: "failed-run", mode: "incremental", status: "failed", started_at: "2999-01-01T00:00:00.000Z", finished_at: "2999-01-01T00:00:01.000Z" });
    });
    const store = new GraphStore(dbPath);
    try {
      assert.match(store.seedRefusal("parent") ?? "", /incremental run since the last complete one ended failed/);
      assert.equal(store.seedBaseSha("parent"), null, "the ancestry check gets no commit to vouch for");
      assert.throws(
        () => seedFromParent(store, { parentRepoId: "parent", childRepoId: "child", childRepoPath: slash(repo) }),
        (e: unknown) => e instanceof SeedError && e.code === "PARENT_UNVOUCHED"
      );
    } finally {
      store.close();
    }
    for (const [table, list] of Object.entries(rows(dbPath, "child"))) assert.equal(list.length, 0, `${table}: nothing seeded`);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}));

test("H1: a dirty parent run since the base is carried — the child's first scoped run re-reads it; child = full index", withTmp(async (dir) => {
  const repo = makeRepo();
  try {
    const dbPath = path.join(dir, "g.db");
    await fullIndex(dbPath, "parent", repo);
    // The parent indexes a working-tree edit (a dirty run, keyed), then the edit is reverted on disk.
    const original = FILES["src/a.ts"]!;
    writeFileSync(path.join(repo, "src/a.ts"), original.replace("beta()", "beta() + dirtyOnly()") + "export function dirtyOnly(): string { return \"d\"; }\n");
    const head = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    await indexRun(dbPath, "parent", repo, "dirty", { knownDirtyPaths: ["src/a.ts"], bookkeeping: { coveredKey: JSON.stringify({ head, files: { "src/a.ts": "dirty-hash" } }) } });
    writeFileSync(path.join(repo, "src/a.ts"), original);
    await fullIndex(dbPath, "fullchild", repo, "parent");

    const store = new GraphStore(dbPath);
    try {
      assert.equal(store.seedRefusal("parent"), null, "a keyed ok dirty run is vouched for");
      seedFromParent(store, { parentRepoId: "parent", childRepoId: "seeded", childRepoPath: slash(repo) });
    } finally {
      store.close();
    }
    const seedRow = rawDb(dbPath, (db) => db.prepare(`select mode, tree_key as k, tree_dirty as d, skip_reason as s from index_runs where repo_id = 'seeded'`).get()) as { mode: string; k: string; d: number; s: unknown };
    assert.equal(seedRow.mode, "seed");
    assert.deepEqual(Object.keys(JSON.parse(seedRow.k).files), ["src/a.ts"], "the parent's dirty path is carried in the seed row's tree key");
    assert.equal(seedRow.d, 1);
    assert.ok(rows(dbPath, "seeded").symbols!.some((r) => r.includes("dirtyOnly")), "the copy holds the parent's dirty content");

    await indexRun(dbPath, "seeded", repo, "incremental");
    assert.deepEqual(rows(dbPath, "seeded"), rows(dbPath, "fullchild"), "after its first scoped run the child equals a full index");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}));

test("M1: a fast-skip row is not the seed base; the seed row carries no skip_reason", withTmp(async (dir) => {
  const repo = makeRepo();
  try {
    const dbPath = path.join(dir, "g.db");
    await fullIndex(dbPath, "parent", repo);
    rawDb(dbPath, (db) => {
      addRunLike(db, "parent", { run_id: "skip-run", mode: "incremental", status: "ok", started_at: "2999-01-01T00:00:00.000Z", finished_at: "2999-01-01T00:00:01.000Z", skip_reason: "HEAD unchanged" });
    });
    const store = new GraphStore(dbPath);
    try {
      seedFromParent(store, { parentRepoId: "parent", childRepoId: "seeded", childRepoPath: slash(repo) });
    } finally {
      store.close();
    }
    const seedRow = rawDb(dbPath, (db) => db.prepare(`select skip_reason as s, started_at as at from index_runs where repo_id = 'seeded'`).get()) as { s: unknown; at: string };
    assert.equal(seedRow.s, null);
    assert.notEqual(seedRow.at, "2999-01-01T00:00:00.000Z");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}));

test("L1: clear keeps other repos' cross_repo_deps into the child and drops the child's own links out", withTmp(async (dir) => {
  const repo = makeRepo();
  try {
    const dbPath = path.join(dir, "g.db");
    await fullIndex(dbPath, "parent", repo);
    const store = new GraphStore(dbPath);
    try {
      seedFromParent(store, { parentRepoId: "parent", childRepoId: "seeded", childRepoPath: slash(repo) });
      rawDb(dbPath, (db) => {
        const ins = db.prepare(`insert into cross_repo_deps (from_repo_id, from_symbol_id, to_repo_id, to_symbol_id, type) values (?, ?, ?, ?, 'CALLS')`);
        ins.run("other", "o1", "seeded", "s1");
        ins.run("seeded", "s2", "other", "o2");
      });
      store.clearRepositoryIndex("seeded");
    } finally {
      store.close();
    }
    const left = rawDb(dbPath, (db) => db.prepare(`select from_repo_id as f from cross_repo_deps order by f`).all()) as { f: string }[];
    assert.deepEqual(left.map((r) => r.f), ["other"]);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}));
