import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import Database from "better-sqlite3";

import { GraphStore } from "./graphStore.js";
import { PURGED_BY_CROSS_REPO_COLUMNS, PURGED_BY_REPO_ID, PURGE_EXEMPT } from "./repoPurgeStore.js";

/** MCP-ISSUE-105: remove_repository's purge. */

/** Any column that names a repo: `repo_id`, `from_repo_id`, `source_repo_id`, ... */
const REPO_COLUMN = /repo_id$/;
/** Tables reached through a parent's key; the test fills the key as `<column>-<repo>`, as the parent row gets it. */
const CHILDREN = ["refactor_preview_hunks", "refactor_apply_changes", "refactor_apply_hunks", "refactor_rollbacks"];

type Col = { name: string; type: string };

function withStore(fn: (store: GraphStore, db: Database.Database) => void): void {
  const dir = mkdtempSync(path.join(tmpdir(), "cim-purge-"));
  const store = new GraphStore(path.join(dir, "x.db"));
  const db = new Database(path.join(dir, "x.db"));
  try {
    fn(store, db);
  } finally {
    db.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Every real table and its columns, plus the virtual tables that carry a repo column. */
function schemaTables(db: Database.Database): { name: string; cols: Col[]; virtual: boolean }[] {
  const rows = db.prepare(`select name, sql from sqlite_master where type = 'table'`).all() as { name: string; sql: string | null }[];
  const out: { name: string; cols: Col[]; virtual: boolean }[] = [];
  for (const { name, sql } of rows) {
    if (/_(data|idx|content|docsize|config)$/.test(name) || name.startsWith("sqlite_")) continue; // FTS5 / vec shadow tables
    try {
      out.push({ name, cols: db.prepare(`select name, type from pragma_table_info(?)`).all(name) as Col[], virtual: /^create virtual/i.test(sql ?? "") });
    } catch {
      // a virtual table whose module is not loaded here
    }
  }
  return out;
}

function insertRow(db: Database.Database, table: string, cols: Col[], repo: string, n: number): void {
  const values = cols.map((c) => {
    if (REPO_COLUMN.test(c.name)) return repo;
    if (/int/i.test(c.type)) return n;
    if (/real|floa|doub/i.test(c.type)) return n;
    return `${c.name}-${repo}`;
  });
  db.prepare(`insert into ${table} (${cols.map((c) => c.name).join(", ")}) values (${cols.map(() => "?").join(", ")})`).run(...values);
}

test("every table with a repo column is either purged or exempt with a reason", () => {
  withStore((_store, db) => {
    const purged = new Set<string>([...PURGED_BY_REPO_ID, ...Object.keys(PURGED_BY_CROSS_REPO_COLUMNS)]);
    const found: string[] = [];
    for (const t of schemaTables(db)) {
      for (const c of t.cols) {
        if (!REPO_COLUMN.test(c.name)) continue;
        found.push(`${t.name}.${c.name}`);
        const exempt = (PURGE_EXEMPT[`${t.name}.${c.name}`] ?? "").length > 0;
        assert.ok(purged.has(t.name) !== exempt, `${t.name}.${c.name}: ${exempt ? "both purged and exempt" : "neither purged nor exempt with a reason"}`);
        // the delete must name THIS column: a table purged by `repo_id` that grows `source_repo_id` is not covered
        if (!exempt) {
          const crossCols: readonly string[] = (PURGED_BY_CROSS_REPO_COLUMNS as Record<string, readonly string[]>)[t.name] ?? ["repo_id"];
          assert.ok(crossCols.includes(c.name), `${t.name}.${c.name}: the purge of ${t.name} does not delete by this column`);
        }
      }
    }
    assert.ok(found.includes("edges.repo_id") && found.includes("cross_repo_deps.to_repo_id"), `found: ${found.join(", ")}`);
    for (const t of purged) assert.ok(found.some((f) => f.startsWith(`${t}.`)), `${t} is listed but not in the schema`);
    for (const k of Object.keys(PURGE_EXEMPT)) assert.ok(found.includes(k) || k.startsWith("vec_symbols."), `${k} is exempt but not in the schema`);
  });
});

test("purge removes every row of the repo in every table and leaves the other repo untouched", () => {
  withStore((store, db) => {
    const tables = schemaTables(db).filter((t) => !t.virtual);
    const keyed = tables.filter((t) => t.cols.some((c) => REPO_COLUMN.test(c.name)) || CHILDREN.includes(t.name));
    assert.ok(keyed.length >= 20, `only ${keyed.length} keyed tables`);
    for (const t of keyed) {
      insertRow(db, t.name, t.cols, "gone", 1);
      insertRow(db, t.name, t.cols, "kept", 2);
    }
    const countsBefore = (repo: string) =>
      keyed.map((t) => {
        const own = t.cols.filter((c) => REPO_COLUMN.test(c.name));
        const where = own.length > 0 ? own.map((c) => `${c.name} = ?`).join(" or ") : `1 = 1`;
        const params = own.map(() => repo);
        const rows = own.length > 0 ? (db.prepare(`select count(*) as n from ${t.name} where ${where}`).get(...params) as { n: number }) : { n: -1 };
        return [t.name, rows.n] as const;
      });
    const childTotal = (table: string): number => (db.prepare(`select count(*) as n from ${table}`).get() as { n: number }).n;

    const keptBefore = countsBefore("kept");
    const removed = store.purgeRepository("gone");

    for (const [name, n] of countsBefore("gone")) if (n >= 0) assert.equal(n, 0, `${name} still holds rows of the removed repo`);
    assert.deepEqual(countsBefore("kept"), keptBefore, "the other repo lost rows");
    for (const child of CHILDREN) assert.equal(childTotal(child), 1, `${child}: exactly the kept repo's row must remain`);
    assert.ok((removed.edges ?? 0) >= 1 && (removed.cross_repo_deps ?? 0) >= 1 && (removed.refactor_apply_hunks ?? 0) >= 1, JSON.stringify(removed));
  });
});

test("a cross-repo link INTO the removed repo goes too, one between two other repos stays", () => {
  withStore((store, db) => {
    const link = db.prepare(`insert into cross_repo_deps (from_repo_id, from_symbol_id, to_repo_id, to_symbol_id, type) values (?, 's', ?, 't', 'x')`);
    link.run("other", "gone");
    link.run("gone", "other");
    link.run("other", "kept");
    store.purgeRepository("gone");
    assert.equal((db.prepare(`select count(*) as n from cross_repo_deps`).get() as { n: number }).n, 1);
  });
});

test("a purge that fails after the transaction leaves the repo registered, so a retry reaches what is left", () => {
  withStore((store, db) => {
    store.ensureRepository("half", "D:/gone");
    db.prepare(`insert into symbols (repo_id, symbol_id, name, kind, file_path, line) values ('half', 's1', 'n', 'function', 'a.ts', 1)`).run();
    db.exec(`drop table vec_symbol_map`); // the step after the transaction now throws
    assert.throws(() => store.purgeRepository("half"));
    assert.ok(store.getRepository("half"), "still registered");
    db.exec(`create table vec_symbol_map (repo_id text not null, symbol_id text not null, vec_rowid integer, primary key (repo_id, symbol_id))`);
    store.purgeRepository("half");
    assert.equal(store.getRepository("half"), null);
    assert.equal((db.prepare(`select count(*) as n from symbols where repo_id = 'half'`).get() as { n: number }).n, 0);
  });
});
