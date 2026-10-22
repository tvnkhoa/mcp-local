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
  assert.equal(resetMentionsForScope(conn, "r", { names: [], oldIds: ["old-id"], pathKeys: [] }).size, 1, "unbound by the old-id rule alone");
  resolveMentionsImpl(conn, "r");
  assert.equal(row(conn, "d1", "Store")?.symbolId, null, "and nothing re-binds it — as a full run decides");
});

test("owner rule: real code over test code, then kind rank, then ambiguous; all-test candidates keep the normal rule", () => {
  const conn = db();
  sym(conn, "src-block", "block", "function", ".claude/scripts/write-gate.mjs");
  sym(conn, "test-block-a", "block", "function", "packages/portal/test/text-contrast.test.ts");
  sym(conn, "test-scope", "scope", "function", "packages/ingest/test/topic-hold-live.test.ts"); // a better kind rank, but test code
  sym(conn, "src-scope", "scope", "property", "packages/ingest/src/store.ts");
  sym(conn, "t1", "turn", "function", "packages/a/test/one.test.ts");
  sym(conn, "t2", "turn", "function", "packages/b/test/two.test.ts");
  doc(conn, "d1", "a doc");
  for (const t of ["block", "scope", "turn"]) mention(conn, "d1", t);
  resolveMentionsImpl(conn, "r");
  assert.equal(row(conn, "d1", "block")?.symbolId, "src-block", "the test candidate is dropped, one real one binds");
  assert.equal(row(conn, "d1", "scope")?.symbolId, "src-scope", "the filter runs BEFORE kind rank: a test function no longer beats a property");
  assert.equal(row(conn, "d1", "turn")?.candidateCount, 2, "all candidates in test code: the normal rule, still tied");
});

test("release L1: a superseded SQL definition is dropped when its current one is a candidate and wins decisively", () => {
  const conn = db();
  // tenant_profile on wec.aria: the baseline (current) and the archive/ site it superseded — dropped on tier.
  sym(conn, "tp-base", "tenant_profile", "sql_table", "db/migrations/0001-baseline.sql", 1042);
  sym(conn, "tp-arch", "tenant_profile", "sql_table", "db/migrations/archive/0012-tenant-profile.sql", 96);
  // A function replaced by a later numbered migration and restored by its .down.sql — dropped on tier and number.
  sym(conn, "f-base", "usage_in_period", "sql_function", "db/migrations/0001-baseline.sql", 469);
  sym(conn, "f-43", "usage_in_period", "sql_function", "db/migrations/0043-errored.sql", 20);
  sym(conn, "f-down", "usage_in_period", "sql_function", "db/migrations/0043-errored.down.sql", 6);
  // Decided only by the tie-break (same number, two files; two sites in one file) — not decisive, stays ambiguous.
  sym(conn, "same-a", "pair_table", "sql_table", "db/migrations/0005-a.sql", 1);
  sym(conn, "same-b", "pair_table", "sql_table", "db/migrations/0005-b.sql", 1);
  sym(conn, "line-1", "twice_fn", "sql_function", "db/migrations/0007-x.sql", 1);
  sym(conn, "line-2", "twice_fn", "sql_function", "db/migrations/0007-x.sql", 40);
  // The current site lives in test code, so the test filter removes it: only superseded sites remain, and all stay.
  sym(conn, "only-test", "fixture_table", "sql_table", "packages/db/test/0009-fixture.sql", 1);
  sym(conn, "only-a1", "fixture_table", "sql_table", "db/migrations/archive/0001-fixture.sql", 1);
  sym(conn, "only-a2", "fixture_table", "sql_table", "db/migrations/archive/0002-fixture.sql", 1);
  doc(conn, "d1", "a doc");
  for (const t of ["tenant_profile", "usage_in_period", "pair_table", "twice_fn", "fixture_table"]) mention(conn, "d1", t);
  resolveMentionsImpl(conn, "r");
  assert.equal(row(conn, "d1", "tenant_profile")?.symbolId, "tp-base", "baseline beats archive/ on tier");
  assert.equal(row(conn, "d1", "usage_in_period")?.symbolId, "f-43", "0043 beats 0001 on number and the .down.sql on tier");
  assert.equal(row(conn, "d1", "pair_table")?.candidateCount, 2, "same number in two files: a tie-break, not decisive");
  assert.equal(row(conn, "d1", "twice_fn")?.candidateCount, 2, "two sites in one file: a tie-break, not decisive");
  assert.deepEqual(JSON.parse(row(conn, "d1", "fixture_table")?.candidateIds ?? "[]"), ["only-a1", "only-a2"], "only superseded sites match: all kept");
});

test("release L1: a repo with no numbered migration drops nothing (unknown layout)", () => {
  const conn = db();
  sym(conn, "schema", "accounts", "sql_table", "db/schema.sql", 1);
  sym(conn, "down", "accounts", "sql_table", "db/rollback.down.sql", 1);
  doc(conn, "d1", "a doc");
  mention(conn, "d1", "accounts");
  resolveMentionsImpl(conn, "r");
  assert.equal(row(conn, "d1", "accounts")?.candidateCount, 2, "tiers differ, but no numbered layout: as in K, ambiguous");
});

test("release L2: stale puts resolved rows first and folds ambiguous rows into one group per text; counts add up", () => {
  const conn = db();
  sym(conn, "changed", "requested_action", "function", "wire/commhub.ts");
  sym(conn, "rival", "requested_action", "function", "wire/console.ts");
  sym(conn, "check-a", "check", "function", "a.ts");
  sym(conn, "check-b", "check", "function", "b.ts");
  sym(conn, "only", "PanelState", "type", "panel.ts");
  for (const d of ["a1", "a2", "a3", "b1", "c1"]) doc(conn, d, "a doc");
  for (const d of ["a1", "a2", "a3"]) mention(conn, d, "requested_action");
  mention(conn, "b1", "check");
  mention(conn, "c1", "PanelState");
  mention(conn, "a1", "PanelState");
  resolveMentionsImpl(conn, "r");
  const ids = ["changed", "check-a", "only"];

  const flat = findStaleDocsImpl(conn, "r", ids, false, 50);
  assert.equal(flat.total, 6);
  assert.deepEqual(flat.rows.map((r) => r.match ?? "resolved"), ["resolved", "resolved", "ambiguous", "ambiguous", "ambiguous", "ambiguous"], "resolved rows first");

  const g = findStaleDocsImpl(conn, "r", ids, false, 50, true);
  assert.equal(g.total, 6);
  assert.equal(g.resolvedCount, 2);
  assert.deepEqual(g.rows.map((r) => r.symbolName), ["PanelState", "PanelState"], "rows page only resolved rows");
  assert.deepEqual(g.groups!.map((x) => [x.mentionText, x.rows, x.sections, x.listsSymbolIds]), [["requested_action", 3, 3, ["changed"]], ["check", 1, 1, ["check-a"]]], "sections desc, then text");
  assert.equal(g.resolvedCount + g.groups!.reduce((n, x) => n + x.rows, 0), g.total, "every row accounted for");
  assert.equal(g.groups![0]!.samples.length, 3);

  const paged = findStaleDocsImpl(conn, "r", ids, false, 1, true);
  assert.equal(paged.rows.length, 1, "limit pages resolved rows");
  assert.equal(paged.groups!.length, 2, "groups are not paged by limit");
});

test("release L3: an EF snapshot symbol yields to its code twin — the mapped property, or the DbSet of the entity", () => {
  const conn = db();
  const snap = "Migrations/AppDbContextModelSnapshot.cs";
  sym(conn, "prop", "TotalMs", "property", "Model/Run.cs");
  sym(conn, "col", "TotalMs", "sql_column", snap);
  sym(conn, "cls", "Package", "class", "Model/Package.cs");
  sym(conn, "table", "Packages", "sql_table", snap);
  sym(conn, "lonely", "audit_rows", "sql_table", snap);
  conn.prepare(`insert into symbols (repo_id, symbol_id, file_path, name, kind, line, signature) values ('r', 'dbset', 'Data/AppDbContext.cs', 'Packages', 'property', 9, 'public DbSet<Package> Packages { get; set; }')`).run();
  const map = (from: string, to: string): void => {
    conn.prepare(`insert into edges (repo_id, from_id, to_id, type, confidence, reason) values ('r', ?, ?, 'EF_MAPS', 0.95, 'ef_resolved x')`).run(from, to);
  };
  map("col", "prop");
  map("table", "cls");
  doc(conn, "d1", "a doc");
  for (const t of ["TotalMs", "Packages", "audit_rows"]) mention(conn, "d1", t);
  resolveMentionsImpl(conn, "r");
  assert.equal(row(conn, "d1", "TotalMs")?.symbolId, "prop", "the column maps to this property: one concept, not a tie");
  assert.equal(row(conn, "d1", "Packages")?.symbolId, "dbset", "the table's entity is Package, and DbSet<Package> Packages is its twin");
  assert.equal(row(conn, "d1", "audit_rows")?.symbolId, "lonely", "an EF table with no code twin of that name binds itself");
});
