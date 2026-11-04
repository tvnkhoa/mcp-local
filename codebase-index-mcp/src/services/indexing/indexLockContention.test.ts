import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import Database from "better-sqlite3";

import { GraphStore } from "../../repositories/graphStore.js";
import { truncateCheckpointNoWait } from "../../repositories/writeStore.js";
import { createIndexRunner, FTS_PER_FILE_META_KEY, runWithBookkeeping } from "./indexRunner.js";
import type { IndexMode, IndexRunResult } from "../../types/index.js";

/**
 * MCP-ISSUE-111 — one SQLite file holds every repo, and "database is locked" reached index runs and reads.
 * These pin the four parts of the fix that do not need a server: the gate's bookkeeping written by the run,
 * IMMEDIATE write transactions, a TRUNCATE checkpoint that never waits on a reader, and a full run that keeps
 * the FTS tables per file instead of rebuilding every repo's. The cross-repo queue is in freshness.test.ts;
 * the server-level acceptance (reads during another repo's run) is scripts/test/test-index-lock-contention.mjs.
 */

const git = (dir: string, ...args: string[]): void => {
  execFileSync("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", ...args], { stdio: "ignore" });
};

function makeRepo(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), "cim-lock-"));
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), content);
  }
  git(root, "init", "-q");
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "base");
  return root;
}

async function index(dbPath: string, repoId: string, repoPath: string, mode: IndexMode): Promise<IndexRunResult> {
  const store = new GraphStore(dbPath);
  try {
    const run = createIndexRunner({
      store,
      limits: { subtxSize: 20, checkpointEveryNBatches: 1, largeFileThresholdBytes: 512 * 1024, maxFileSizeBytes: 500 * 1024, parseWorkers: 0, parseJobTimeoutMs: 20_000 },
      resolvePerformanceProfileOverride: () => "standard"
    });
    return await run(repoId, repoPath.replace(/\\/g, "/"), mode, true, 1000, 50);
  } finally {
    store.close();
  }
}

/** Per FTS table: the (rowid, indexed columns) FTS holds for one repo, against what its content table holds. */
function ftsVsContent(db: Database.Database, repoId: string): Record<string, { fts: string[]; content: string[] }> {
  const tables = [
    { fts: "symbols_fts", table: "symbols", cols: "name, signature, symbol_id" },
    { fts: "literals_fts", table: "string_literals", cols: "value, literal_id" },
    { fts: "docs_fts", table: "docs", cols: "text, doc_id" },
    { fts: "comments_fts", table: "code_comments", cols: "text" }
  ];
  const out: Record<string, { fts: string[]; content: string[] }> = {};
  for (const t of tables) {
    // An external-content FTS table reads its columns from the content table, so a select on it says nothing about
    // its index; the docsize shadow table holds one row per rowid the index has.
    const ftsRowids = (db.prepare(`select id from ${t.fts}_docsize`).raw().all() as [number][]).map((r) => r[0]);
    const content = db.prepare(`select rowid from ${t.table} where repo_id = ?`).raw().all(repoId) as [number][];
    const contentSet = new Set(content.map((r) => r[0]));
    out[t.fts] = {
      fts: ftsRowids.filter((id) => contentSet.has(id)).map(String).sort(),
      content: [...contentSet].map(String).sort()
    };
  }
  return out;
}

function integrity(db: Database.Database): void {
  for (const t of ["symbols_fts", "literals_fts", "comments_fts", "docs_fts"]) db.prepare(`insert into ${t}(${t}) values('integrity-check')`).run();
}

test("MCP-ISSUE-111: runWithBookkeeping writes the pending set before the run, the key and trigger after a good run only", async () => {
  const writes: string[] = [];
  const store = {
    recordPendingReindexFiles: (_r: string, paths: string[], reason: string) => writes.push(`pending ${paths.join(",")} (${reason})`),
    markRunTreeKey: (runId: string, key: string) => writes.push(`key ${runId} ${key}`),
    markRunTrigger: (runId: string, trigger: string) => writes.push(`trigger ${runId} ${trigger}`)
  };
  const ok = await runWithBookkeeping(store, "r", { pendingReindex: { paths: ["a.ts"], reason: "why" }, coveredKey: "K", trigger: "query" }, async () => {
    writes.push("run");
    return { runId: "r1", status: "ok" } as IndexRunResult;
  });
  assert.equal(ok.runId, "r1");
  assert.deepEqual(writes, ["pending a.ts (why)", "run", "key r1 K", "trigger r1 query"]);

  writes.length = 0;
  await runWithBookkeeping(store, "r", { coveredKey: "K", trigger: "query" }, async () => ({ runId: "r2", status: "failed" }) as IndexRunResult);
  assert.deepEqual(writes, [], "a failed run covers nothing");

  writes.length = 0;
  const throwing = { ...store, markRunTreeKey: () => { throw new Error("SQLITE_BUSY"); } };
  await runWithBookkeeping(throwing, "r", { coveredKey: "K", trigger: "query" }, async () => ({ runId: "r3" }) as IndexRunResult);
  assert.deepEqual(writes, ["trigger r3 query"], "the after-writes are best-effort, each on its own");
});

test("MCP-ISSUE-111: a deferred read-then-write transaction fails SQLITE_BUSY at once; the store's IMMEDIATE one holds the lock from BEGIN", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "cim-imm-"));
  const dbPath = path.join(dir, "index.db");
  const store = new GraphStore(dbPath);
  const other = new Database(dbPath);
  try {
    other.pragma("busy_timeout = 0");
    store.setIndexMeta("x", "0");
    const raw = new Database(dbPath);
    raw.pragma("busy_timeout = 30000");
    try {
      // The cause, reproduced: deferred BEGIN, a read takes a snapshot, another connection commits, the upgrade
      // to a write lock is refused immediately — busy_timeout cannot help a stale snapshot.
      const deferred = raw.transaction(() => {
        raw.prepare("select value from index_meta where key = 'x'").get();
        other.prepare("insert into index_meta (key, value) values ('y', '1') on conflict(key) do update set value = excluded.value").run();
        raw.prepare("update index_meta set value = '2' where key = 'x'").run();
      });
      const t0 = Date.now();
      assert.throws(() => deferred(), (e: unknown) => {
        const code = (e as { code?: string }).code ?? "";
        return /^SQLITE_BUSY/.test(code) && /locked/i.test((e as Error).message);
      });
      assert.ok(Date.now() - t0 < 5_000, "it fails at once, not after busy_timeout");
    } finally {
      raw.close();
    }
    // The fix: the store's write transaction owns the write lock from BEGIN, so the other writer is the one that
    // waits (here: fails at once, its busy_timeout being 0) and the store's transaction commits.
    let otherError = "";
    store.runInTransaction(() => {
      store.getIndexMeta("x");
      try {
        other.prepare("update index_meta set value = '3' where key = 'y'").run();
      } catch (e) {
        otherError = (e as { code?: string }).code ?? String(e);
      }
      store.setIndexMeta("x", "4");
    });
    assert.match(otherError, /^SQLITE_BUSY/);
    assert.equal(store.getIndexMeta("x"), "4");
  } finally {
    other.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("MCP-ISSUE-111: the TRUNCATE checkpoint returns at once while a reader holds the WAL, and restores busy_timeout", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "cim-ckpt-"));
  const dbPath = path.join(dir, "index.db");
  const writer = new Database(dbPath);
  const reader = new Database(dbPath);
  try {
    writer.pragma("journal_mode = WAL");
    writer.pragma("busy_timeout = 30000");
    writer.pragma("wal_autocheckpoint = 0");
    writer.exec("create table t (v text)");
    reader.exec("begin");
    reader.prepare("select count(*) from t").get();
    const insert = writer.prepare("insert into t (v) values (?)");
    for (let i = 0; i < 200; i++) insert.run(`row ${String(i)}`);
    const t0 = Date.now();
    assert.equal(truncateCheckpointNoWait(writer), false, "a reader still in the WAL: not reset");
    assert.ok(Date.now() - t0 < 2_000, `no wait on the reader (${String(Date.now() - t0)} ms; busy_timeout is 30 s)`);
    assert.equal(Number(writer.pragma("busy_timeout", { simple: true })), 30000);
    reader.exec("commit");
    assert.equal(truncateCheckpointNoWait(writer), true, "no reader: the WAL is reset");
  } finally {
    reader.close();
    writer.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("MCP-ISSUE-111: a full run keeps FTS per file — deleted files leave it, another repo's rows are untouched, no global rebuild after the first", async () => {
  const work = mkdtempSync(path.join(tmpdir(), "cim-ftsfull-"));
  const dbPath = path.join(work, "index.db");
  const repoA = makeRepo({
    "src/a.ts": "// alpha comment that the comments lane indexes\nexport function alphaOne(): number {\n  return 1;\n}\nexport const label = 'alpha literal value';\n",
    "src/b.ts": "import { alphaOne } from './a';\nexport function betaTwo(): number {\n  return alphaOne() + 1;\n}\n",
    "docs/readme.md": "# Alpha\n\nalphaOne is documented here.\n"
  });
  const repoB = makeRepo({ "src/other.ts": "// other comment that the comments lane indexes\nexport function otherThing(): string {\n  return 'other literal value';\n}\n" });
  try {
    await index(dbPath, "a", repoA, "full");
    await index(dbPath, "b", repoB, "full");
    let db = new Database(dbPath, { readonly: true });
    const metaAfterFirst = (db.prepare("select value from index_meta where key = ?").get(FTS_PER_FILE_META_KEY) as { value: string } | undefined)?.value;
    const bBefore = ftsVsContent(db, "b");
    const bRowsBefore = db.prepare("select rowid, * from symbols where repo_id = 'b' order by rowid").all();
    db.close();
    assert.ok(metaAfterFirst, "the first full run of the DB rebuilt once and recorded it");
    assert.ok(bBefore.comments_fts!.content.length > 0, "the fixture has comment rows, so comments_fts is checked for real");

    // Delete one file and rename a function in another, then a second full run of repo a.
    unlinkSync(path.join(repoA, "src/b.ts"));
    writeFileSync(path.join(repoA, "src/a.ts"), "export function alphaRenamed(): number {\n  return 1;\n}\n");
    git(repoA, "add", "-A");
    git(repoA, "commit", "-q", "-m", "edit");
    const second = await index(dbPath, "a", repoA, "full");
    assert.equal(second.status === "failed", false);
    assert.equal((second as { ftsRebuildMs?: number }).ftsRebuildMs ?? 0, 0, "no global FTS rebuild once the DB is per-file");

    db = new Database(dbPath);
    try {
      integrity(db);
      for (const [table, v] of Object.entries(ftsVsContent(db, "a"))) assert.deepEqual(v.fts, v.content, `${table}: repo a's FTS rows are exactly its content rows`);
      const names = (db.prepare(`select s.name from symbols_fts f join symbols s on s.rowid = f.rowid where symbols_fts match ? and s.repo_id = 'a'`).all('"alpha"*') as { name: string }[]).map((r) => r.name).sort();
      assert.deepEqual(names, ["alphaRenamed"], "the renamed symbol is found, the old one and the deleted file's are gone");
      assert.equal((db.prepare(`select count(*) as n from symbols where repo_id = 'a' and file_path = 'src/b.ts'`).get() as { n: number }).n, 0);
      assert.deepEqual(ftsVsContent(db, "b"), bBefore, "repo b's FTS rows are untouched");
      assert.deepEqual(db.prepare("select rowid, * from symbols where repo_id = 'b' order by rowid").all(), bRowsBefore);
      const other = db.prepare(`select s.name from symbols_fts f join symbols s on s.rowid = f.rowid where symbols_fts match ? and s.repo_id = 'b'`).all('"otherThing"*');
      assert.equal(other.length, 1, "repo b still answers its own search");
    } finally {
      db.close();
    }

    // Follow-up: remove_repository on a per-file DB forgets only that repo's FTS rows — no all-repo rebuild.
    const store = new GraphStore(dbPath);
    try {
      store.purgeRepository("b");
    } finally {
      store.close();
    }
    db = new Database(dbPath);
    try {
      integrity(db);
      for (const [table, v] of Object.entries(ftsVsContent(db, "a"))) assert.deepEqual(v.fts, v.content, `${table}: repo a untouched by purging b`);
      for (const t of ["symbols_fts", "literals_fts", "docs_fts", "comments_fts"]) {
        const total = (db.prepare(`select count(*) as n from ${t}_docsize`).get() as { n: number }).n;
        assert.equal(total, ftsVsContent(db, "a")[t]!.content.length, `${t}: no row of b left`);
      }
    } finally {
      db.close();
    }
  } finally {
    rmSync(repoA, { recursive: true, force: true });
    rmSync(repoB, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  }
});

test("MCP-ISSUE-111 follow-up 4: immediateTransaction takes the write lock at BEGIN, and nests as a savepoint", async () => {
  const { immediateTransaction } = await import("../../repositories/sqliteTx.js");
  const dir = mkdtempSync(path.join(tmpdir(), "cim-imm2-"));
  const dbPath = path.join(dir, "t.db");
  const a = new Database(dbPath);
  const b = new Database(dbPath);
  try {
    a.pragma("journal_mode = WAL");
    a.exec("create table t (v integer)");
    b.pragma("busy_timeout = 0");
    let otherError = "";
    const inner = immediateTransaction(a, (v: number) => a.prepare("insert into t (v) values (?)").run(v));
    immediateTransaction(a, () => {
      a.prepare("select count(*) from t").get();
      try {
        b.prepare("insert into t (v) values (99)").run();
      } catch (e) {
        otherError = (e as { code?: string }).code ?? String(e);
      }
      inner(1);
    })();
    assert.match(otherError, /^SQLITE_BUSY/, "the other writer is held off from BEGIN");
    assert.deepEqual(a.prepare("select v from t").all(), [{ v: 1 }]);
  } finally {
    b.close();
    a.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
