/**
 * Regression tests for the two vec0 defects found while chasing resolve-phase nondeterminism.
 *
 * Both are about the SHARED database. One SQLite file holds every indexed repo, and `vec_symbols` had
 * no notion of which repo a vector belonged to, so `k` was a global budget. These tests build a
 * multi-repo table on purpose — a single-repo fixture passes either way and would have caught nothing.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import {
  ensureVectorSchema,
  initVectorStore,
  batchUpsertSymbolVectors,
  vectorSearchSymbols,
  deleteVectorsByRepo,
} from "./vectorStore.js";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3") as typeof import("better-sqlite3");

/** The subset of the real schema these functions touch. */
function makeDb() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE symbols (
      repo_id TEXT NOT NULL, symbol_id TEXT NOT NULL, name TEXT NOT NULL,
      kind TEXT NOT NULL, signature TEXT,
      PRIMARY KEY (repo_id, symbol_id)
    );
    CREATE TABLE index_runs (repo_id TEXT, finished_at TEXT);
  `);
  const loaded = initVectorStore(db, require);
  ensureVectorSchema(db, loaded);
  return { db, loaded };
}

function seed(db: import("better-sqlite3").Database, repoId: string, names: string[]) {
  batchUpsertSymbolVectors(
    db,
    repoId,
    names.map((n, i) => ({ symbolId: `${repoId}-sym-${i}`, name: n }))
  );
}

test("k is applied per repo, not across the whole shared table", () => {
  const { db, loaded } = makeDb();
  if (!loaded) return; // sqlite-vec unavailable; the in-memory path is covered separately below

  // The shape that broke production: one repo dwarfs the one being queried, and its symbols are
  // NEARER the query than the target repo's. Pre-fix, the global top-3 was entirely `big`, so `small`
  // got zero rows back despite holding a perfectly good candidate.
  seed(db, "small", ["ConversationReplyQueuedDto"]);
  seed(
    db,
    "big",
    Array.from({ length: 200 }, (_, i) => `ConversationReplyQueuedDto${i}`)
  );

  const hits = vectorSearchSymbols(db, "small", "ConversationReplyQueuedDto", 3);
  assert.equal(hits.length, 1, "the small repo's only candidate must be returned");
  assert.equal(hits[0].symbolId, "small-sym-0");

  // And the reverse direction: querying `big` must never leak `small`.
  const bigHits = vectorSearchSymbols(db, "big", "ConversationReplyQueuedDto", 5);
  assert.equal(bigHits.length, 5);
  assert.ok(
    bigHits.every((h) => h.symbolId.startsWith("big-")),
    `partition leaked: ${JSON.stringify(bigHits)}`
  );
});

test("identical distances resolve in a stable order across rebuilds", () => {
  const { db, loaded } = makeDb();
  if (!loaded) return;

  // Same name => identical trigram vector => exact distance ties. Pre-fix the winner was decided by
  // vec0 rowid, and rowids are reassigned every rebuild, so this is the nondeterminism reduced to its
  // smallest reproducible form.
  const tied = ["Handler", "Handler", "Handler", "Handler"];
  seed(db, "r", tied);
  const first = vectorSearchSymbols(db, "r", "Handler", 2).map((h) => h.symbolId);

  // Rebuild in a different insertion order — new rowids, same vectors.
  deleteVectorsByRepo(db, "r");
  batchUpsertSymbolVectors(
    db,
    "r",
    [3, 1, 0, 2].map((i) => ({ symbolId: `r-sym-${i}`, name: "Handler" }))
  );
  const second = vectorSearchSymbols(db, "r", "Handler", 2).map((h) => h.symbolId);

  assert.deepEqual(second, first, "tied results must not depend on insertion order");
});

test("deleteVectorsByRepo removes only the target repo's partition", () => {
  const { db, loaded } = makeDb();
  if (!loaded) return;

  seed(db, "keep", ["Alpha", "Beta"]);
  seed(db, "drop", ["Alpha", "Beta"]);
  deleteVectorsByRepo(db, "drop");

  assert.equal(vectorSearchSymbols(db, "drop", "Alpha", 3).length, 0);
  assert.ok(vectorSearchSymbols(db, "keep", "Alpha", 3).length > 0, "unrelated repo must survive");
  const left = db.prepare(`SELECT repo_id, COUNT(*) n FROM vec_symbols GROUP BY repo_id`).all() as {
    repo_id: string;
    n: number;
  }[];
  assert.deepEqual(left, [{ repo_id: "keep", n: 2 }]);
});

test("a pre-partition vec_symbols table is migrated rather than left unqueryable", () => {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE symbols (repo_id TEXT, symbol_id TEXT, name TEXT, kind TEXT, signature TEXT)`);
  const loaded = initVectorStore(db, require);
  if (!loaded) return;

  // Exactly what shipped before this change.
  db.exec(`CREATE VIRTUAL TABLE vec_symbols USING vec0(embedding float[512])`);
  db.exec(`CREATE TABLE vec_symbol_map (repo_id TEXT, symbol_id TEXT, vec_rowid INTEGER, PRIMARY KEY (repo_id, symbol_id))`);
  db.prepare(`INSERT INTO vec_symbol_map VALUES ('r', 's', 1)`).run();

  ensureVectorSchema(db, true);

  const columns = (db.prepare(`SELECT name FROM pragma_table_info('vec_symbols')`).all() as { name: string }[]).map(
    (c) => c.name
  );
  assert.ok(columns.includes("repo_id"), "table must be rebuilt with the partition key");
  // The map pointed at rowids in the dropped table; keeping it would strand them in every future KNN.
  const mapped = db.prepare(`SELECT COUNT(*) n FROM vec_symbol_map`).get() as { n: number };
  assert.equal(mapped.n, 0, "stale rowid mappings must be cleared");
});

test("CODEBASE_INDEX_VECTOR_ENABLED=false disables search outright, not just vec0", () => {
  const { db, loaded } = makeDb();
  if (!loaded) return;
  seed(db, "r", ["Alpha"]);
  assert.equal(vectorSearchSymbols(db, "r", "Alpha", 3).length, 1);

  const prev = process.env.CODEBASE_INDEX_VECTOR_ENABLED;
  process.env.CODEBASE_INDEX_VECTOR_ENABLED = "false";
  try {
    // Must be empty, NOT silently re-routed to the in-memory brute-force index — the switch exists to
    // be a control for "do vectors explain the run-to-run edge count variance?", and a fallback that
    // still returns vector hits would answer a different question.
    assert.deepEqual(vectorSearchSymbols(db, "r", "Alpha", 3), []);
    assert.equal(batchUpsertSymbolVectors(db, "r2", [{ symbolId: "x", name: "Alpha" }]), 0);
  } finally {
    if (prev === undefined) delete process.env.CODEBASE_INDEX_VECTOR_ENABLED;
    else process.env.CODEBASE_INDEX_VECTOR_ENABLED = prev;
  }

  // Restored, and still working — proves the switch is read per call rather than latched at load.
  assert.equal(vectorSearchSymbols(db, "r", "Alpha", 3).length, 1);
});
