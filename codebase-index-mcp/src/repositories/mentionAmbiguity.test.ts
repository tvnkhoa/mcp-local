import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";

import { initGraphSchema, runGraphMigrations } from "./schema.js";
import {
  countAmbiguousMentionTargetsImpl,
  findDocCoverageImpl,
  findDriftingDocsImpl,
  findStaleDocsImpl,
  rebuildDocsFtsImpl,
  resolveMentionsImpl,
  searchDocsImpl,
  upsertDocMentionsImpl,
  upsertDocsImpl
} from "./docsStore.js";
import { resetMentionsForScope } from "./scopedRunStore.js";

/**
 * Release K4 (MCP-ISSUE-089): a doc mention several symbols match equally is an answer — "ambiguous, N
 * candidates" — never a pick. Release J made the pick deterministic (first by path); on wec.aria 6 593
 * backtick mentions were such picks, and `query_docs stale` then blamed one arbitrary symbol.
 */

function db(): Database.Database {
  const conn = new Database(":memory:");
  initGraphSchema(conn);
  runGraphMigrations(conn, false);
  return conn;
}
const sym = (conn: Database.Database, id: string, name: string, kind: string, filePath: string, line = 1): void => {
  conn.prepare(`insert into symbols (repo_id, symbol_id, file_path, name, kind, line) values ('r', ?, ?, ?, ?, ?)`).run(id, filePath, name, kind, line);
};
const doc = (conn: Database.Database, docId: string, text: string): void => {
  upsertDocsImpl(conn, [{ repoId: "r", docId, filePath: `docs/${docId}.md`, headingPath: docId, contentType: "heading", text, level: 1 }]);
};
const mention = (conn: Database.Database, docId: string, mentionText: string, mentionType: "backtick" | "code_call" | "filepath" = "backtick"): void => {
  upsertDocMentionsImpl(conn, [{ repoId: "r", docId, symbolId: null as unknown as string, mentionType, confidence: 0.8, mentionText }]);
};
const row = (conn: Database.Database, docId: string, text: string) =>
  conn.prepare(`select symbol_id as symbolId, candidate_count as candidateCount, candidate_ids as candidateIds from doc_mentions where repo_id = 'r' and doc_id = ? and mention_text = ?`).get(docId, text) as
    | { symbolId: string | null; candidateCount: number | null; candidateIds: string | null }
    | undefined;

test("one best-rank candidate binds; two equal ones leave the mention ambiguous with both, in canonical order", () => {
  const conn = db();
  sym(conn, "fn-b", "turn", "function", "packages/b/turn.ts");
  sym(conn, "fn-a", "turn", "function", "packages/a/turn.ts");
  sym(conn, "cls", "Codec", "class", "src/codec.ts");
  sym(conn, "m-codec", "Codec", "method", "src/other.ts"); // a worse rank: the class still wins alone
  doc(conn, "d1", "a doc");
  mention(conn, "d1", "turn");
  mention(conn, "d1", "Codec");
  resolveMentionsImpl(conn, "r");

  assert.deepEqual(row(conn, "d1", "turn"), { symbolId: null, candidateCount: 2, candidateIds: JSON.stringify(["fn-a", "fn-b"]) }, "no pick: both, path order");
  assert.deepEqual(row(conn, "d1", "Codec"), { symbolId: "cls", candidateCount: null, candidateIds: null }, "kind rank decides a mixed-kind name");
});

test("the dotted-suffix and dotted-prefix steps refuse to pick too", () => {
  const conn = db();
  sym(conn, "a-parse", "A.Parse", "method", "a.ts");
  sym(conn, "b-parse", "B.Parse", "method", "b.ts");
  sym(conn, "x-one", "X.one", "method", "x.ts");
  sym(conn, "x-two", "X.two", "method", "x.ts", 2);
  sym(conn, "y-one", "Y.only", "method", "y.ts");
  doc(conn, "d1", "a doc");
  for (const t of ["Parse", "X", "Y"]) mention(conn, "d1", t);
  resolveMentionsImpl(conn, "r");
  assert.equal(row(conn, "d1", "Parse")?.candidateCount, 2, "suffix: ambiguous, with its candidates (MCP-ISSUE-049 already refused the pick)");
  assert.equal(row(conn, "d1", "X")?.candidateCount, 2, "prefix: was first-wins, now ambiguous");
  assert.equal(row(conn, "d1", "Y")?.symbolId, "y-one", "a single prefix candidate still binds");
});

test("an ambiguous mention is re-decided every run: a removed rival binds it, and its candidate list never outlives it", () => {
  const conn = db();
  sym(conn, "fn-a", "turn", "function", "a.ts");
  sym(conn, "fn-b", "turn", "function", "b.ts");
  doc(conn, "d1", "a doc");
  mention(conn, "d1", "turn");
  resolveMentionsImpl(conn, "r");
  assert.equal(row(conn, "d1", "turn")?.candidateCount, 2);
  conn.prepare(`delete from symbols where symbol_id = 'fn-b'`).run();
  resolveMentionsImpl(conn, "r");
  assert.deepEqual(row(conn, "d1", "turn"), { symbolId: "fn-a", candidateCount: null, candidateIds: null });
});

test("every reader says ambiguous rather than naming one symbol or saying nothing", () => {
  const conn = db();
  sym(conn, "fn-a", "turn", "function", "a.ts");
  sym(conn, "fn-b", "turn", "function", "b.ts");
  doc(conn, "d1", "turn handling");
  mention(conn, "d1", "turn");
  resolveMentionsImpl(conn, "r");

  // stale: a changed candidate lists the doc, marked ambiguous
  const stale = findStaleDocsImpl(conn, "r", ["fn-b"]);
  assert.equal(stale.total, 1);
  assert.equal(stale.rows[0]?.match, "ambiguous");
  assert.equal(stale.rows[0]?.candidateCount, 2);

  // coverage: not documented by it, but counted beside
  const cov = findDocCoverageImpl(conn, "r", "b.ts");
  assert.ok(!cov.rows[0]?.hasDocs);
  assert.equal(cov.rows[0]?.ambiguousMentionCount, 1);

  // drift: not missing, so not drift — and counted
  const drift = findDriftingDocsImpl(conn, "r");
  assert.equal(drift.rows.some((r) => r.mentionText === "turn"), false);
  assert.equal(drift.ambiguousExcluded, 1);

  // search: listed with its candidate count
  rebuildDocsFtsImpl(conn);
  const found = searchDocsImpl(conn, "r", "turn", 10, (q) => q, (q) => q) as unknown as { ambiguousMentions?: unknown[] }[];
  assert.deepEqual(found[0]?.ambiguousMentions, [{ mentionText: "turn", ambiguous: true, candidateCount: 2 }]);

  // doc freshness: skipped, and counted
  assert.equal(countAmbiguousMentionTargetsImpl(conn, "r", true), 1);
});

test("a scoped run unbinds a mention whose target was one of the run's old ids, whatever form its text took", () => {
  const conn = db();
  sym(conn, "old-id", "Store.save", "method", "store.ts");
  doc(conn, "d1", "a doc");
  mention(conn, "d1", "Store"); // the prefix form: not a K name, nor a lower-case form of one
  resolveMentionsImpl(conn, "r");
  assert.equal(row(conn, "d1", "Store")?.symbolId, "old-id");

  // The method is deleted. Its name is in K; the mention text is only its prefix.
  conn.prepare(`delete from symbols where symbol_id = 'old-id'`).run();
  assert.equal(resetMentionsForScope(conn, "r", { names: [], oldIds: ["old-id"], pathKeys: [] }), 1, "unbound by the old-id rule alone");
  resolveMentionsImpl(conn, "r");
  assert.equal(row(conn, "d1", "Store")?.symbolId, null, "and nothing re-binds it — as a full run decides");
});
