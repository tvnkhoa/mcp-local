#!/usr/bin/env node
/**
 * Remove a repository and everything scoped to it from the index (migration-plan step S-40).
 *
 * The registry accumulates entries that no longer correspond to anything: a repo indexed twice
 * under two ids, or a typo'd repoId whose path does not exist. They are not harmless — every agent
 * and developer that runs `list_repositories` sees them and has to work out which is real.
 *
 * Written as a script rather than run as ad-hoc SQL because the next stale entry deserves better
 * than someone hand-writing DELETEs against a 335 MB file. Two details make hand-written SQL
 * wrong here:
 *
 *   - `vec_symbols` is a `vec0` virtual table with **no `repo_id`**. It is reached through
 *     `vec_symbol_map.vec_rowid`, so the map rows must be read BEFORE they are deleted or the
 *     vectors are orphaned and unreachable.
 *   - The three FTS5 tables are **external-content** (`content='symbols'`, …). A plain DELETE
 *     against them is not how FTS5 external content is maintained; the index is rebuilt from the
 *     content table instead — which is exactly what `symbolSearch.ts` already does.
 *
 * Usage:
 *   node scripts/prune-repo.mjs --db <path> --repo <id> [--repo <id>] [--dry-run] [--vacuum]
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

function parse(argv) {
  const out = { repos: [], dryRun: false, vacuum: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--repo") { out.repos.push(argv[i + 1]); i += 1; }
    else if (argv[i] === "--db") { out.db = argv[i + 1]; i += 1; }
    else if (argv[i] === "--dry-run") out.dryRun = true;
    else if (argv[i] === "--vacuum") out.vacuum = true;
  }
  return out;
}

const ARGS = parse(process.argv.slice(2));

if (ARGS.db === undefined || ARGS.repos.length === 0) {
  console.error("Usage: node scripts/prune-repo.mjs --db <path> --repo <id> [--repo <id>] [--dry-run] [--vacuum]");
  process.exit(2);
}
if (!fs.existsSync(ARGS.db)) {
  console.error(`Database not found: ${ARGS.db}`);
  process.exit(2);
}

const db = new Database(ARGS.db);
try {
  require("sqlite-vec").load(db);
} catch (error) {
  // Not fatal for the non-vector tables, but `vec_symbols` cannot be cleaned without it, and
  // leaving orphaned vectors silently would be worse than refusing.
  console.error(`sqlite-vec failed to load (${error.message}); vec_symbols cannot be pruned.`);
  process.exit(1);
}

const FTS_TABLES = new Map([
  ["symbols_fts", "symbols"],
  ["literals_fts", "string_literals"],
  ["docs_fts", "docs"]
]);

/** Real tables carrying `repo_id`, in no particular order — nothing here has FK dependencies. */
const repoScoped = db
  .prepare("SELECT name, sql FROM sqlite_master WHERE type='table'")
  .all()
  .filter((row) => !/VIRTUAL TABLE/i.test(row.sql ?? ""))
  .filter((row) => {
    const columns = db.prepare(`PRAGMA table_info("${row.name}")`).all().map((c) => c.name);
    return columns.includes("repo_id");
  })
  .map((row) => row.name);

console.log(`db      : ${path.resolve(ARGS.db)}`);
console.log(`repos   : ${ARGS.repos.join(", ")}`);
console.log(`tables  : ${repoScoped.join(", ")}`);

let grandTotal = 0;
const plan = [];
for (const repoId of ARGS.repos) {
  const counts = repoScoped
    .map((table) => [table, db.prepare(`SELECT COUNT(*) c FROM "${table}" WHERE repo_id = ?`).get(repoId).c])
    .filter(([, c]) => c > 0);
  const vecRowids = db
    .prepare("SELECT vec_rowid FROM vec_symbol_map WHERE repo_id = ? AND vec_rowid IS NOT NULL")
    .all(repoId)
    .map((r) => r.vec_rowid);
  const subtotal = counts.reduce((s, [, c]) => s + c, 0) + vecRowids.length;
  grandTotal += subtotal;
  plan.push({ repoId, counts, vecRowids });

  console.log(`\n${repoId}  (${subtotal} rows)`);
  if (counts.length === 0 && vecRowids.length === 0) {
    console.log("  nothing to remove — no such repo_id in this database");
    continue;
  }
  for (const [table, c] of counts) console.log(`  ${table.padEnd(20)} ${c}`);
  if (vecRowids.length > 0) console.log(`  ${"vec_symbols".padEnd(20)} ${vecRowids.length}`);
}

if (grandTotal === 0) {
  console.log("\nNothing to do.");
  process.exit(0);
}

if (ARGS.dryRun) {
  console.log(`\n--dry-run: ${grandTotal} rows would be removed. Nothing was written.`);
  process.exit(0);
}

const before = db.pragma("page_count", { simple: true }) * db.pragma("page_size", { simple: true });

db.exec("BEGIN");
try {
  for (const { repoId, vecRowids } of plan) {
    // Vectors first: their ids come from the map rows that are about to be deleted.
    const deleteVec = db.prepare("DELETE FROM vec_symbols WHERE rowid = ?");
    for (const rowid of vecRowids) deleteVec.run(rowid);
    for (const table of repoScoped) {
      db.prepare(`DELETE FROM "${table}" WHERE repo_id = ?`).run(repoId);
    }
  }
  db.exec("COMMIT");
} catch (error) {
  db.exec("ROLLBACK");
  console.error(`\nFAILED, rolled back: ${error.message}`);
  process.exit(1);
}

// External-content FTS5: rebuild from the content table rather than deleting rows. This is the
// same call `symbolSearch.ts` makes after an index run.
for (const [fts] of FTS_TABLES) {
  try {
    db.exec(`INSERT INTO ${fts}(${fts}) VALUES('rebuild')`);
    db.exec(`INSERT INTO ${fts}(${fts}) VALUES('optimize')`);
    console.log(`rebuilt ${fts}`);
  } catch (error) {
    console.error(`WARN: ${fts} rebuild failed: ${error.message}`);
  }
}

if (ARGS.vacuum) {
  console.log("vacuuming…");
  db.exec("VACUUM");
}

const after = db.pragma("page_count", { simple: true }) * db.pragma("page_size", { simple: true });
const remaining = db.prepare("SELECT repo_id FROM repositories ORDER BY repo_id").all().map((r) => r.repo_id);

console.log(`\nremoved ${grandTotal} rows`);
console.log(`size    ${(before / 1e6).toFixed(1)} MB -> ${(after / 1e6).toFixed(1)} MB${ARGS.vacuum ? "" : "  (pass --vacuum to reclaim)"}`);
console.log(`repos   ${remaining.length}: ${remaining.join(", ")}`);
db.close();
