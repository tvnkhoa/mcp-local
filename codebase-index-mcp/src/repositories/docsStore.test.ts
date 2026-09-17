import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";

import { initGraphSchema } from "./schema.js";
import {
  replaceDocsForFileImpl,
  upsertDocsImpl,
  upsertDocMentionsImpl,
  findStaleDocsImpl,
  rebuildDocsFtsImpl
} from "./docsStore.js";
import { parseMarkdownFile } from "../services/extractors/markdownParser.js";
import type { DocMentionRecord } from "../types/index.js";

/**
 * MCP-ISSUE-049, second round.
 *
 * The relabelling half of the staleness fix shipped correct and reproduced unchanged for the
 * consumer repo, because it was verified by indexing into a *throwaway* database. `doc_mentions`
 * was written by upsert alone and deleted by nothing, in a table whose primary key includes
 * `mention_type` — so correcting a mention's label inserted a second row beside a legacy row that
 * no re-index, `mode:"full"` included, could remove. A fresh DB has no legacy row, so the assertion
 * passed on the only database that could not exhibit the bug.
 *
 * These tests exercise the SECOND pass. A single-pass assertion is what let this through.
 */

function db(): Database.Database {
  const conn = new Database(":memory:");
  initGraphSchema(conn);
  return conn;
}

const FILE = "docs/02-flows/_archive/sender-email-caching.md";
const DOC = {
  repoId: "hub",
  docId: "d1",
  filePath: FILE,
  headingPath: FILE,
  contentType: "heading" as const,
  text: "Sender email caching",
  level: 1
};
const mention = (mentionType: DocMentionRecord["mentionType"], confidence: number): DocMentionRecord => ({
  repoId: "hub",
  docId: "d1",
  symbolId: "sym-parse",
  mentionType,
  confidence,
  mentionText: "Parse"
});

test("re-indexing a doc replaces its mentions instead of accumulating them", () => {
  const conn = db();

  // Pass 1: the pre-fix build, which labelled a fenced `Parse(` as prose.
  upsertDocsImpl(conn, [DOC]);
  upsertDocMentionsImpl(conn, [mention("backtick", 1.0)]);
  assert.equal(findStaleDocsImpl(conn, "hub", ["sym-parse"]).total, 1, "precondition: the false positive exists");

  // Pass 2: the corrected build re-indexes the same file and labels it `code_call`.
  replaceDocsForFileImpl(conn, "hub", FILE, [DOC], [mention("code_call", 0.5)]);

  const types = conn.prepare("select mention_type from doc_mentions").all() as { mention_type: string }[];
  assert.deepEqual(types.map((r) => r.mention_type), ["code_call"], "the legacy row is gone, not shadowed");
  assert.equal(findStaleDocsImpl(conn, "hub", ["sym-parse"]).total, 0, "the false positive clears on re-index");

  // Asserted as a pair: a count of zero is equally satisfied by having broken the lane outright.
  assert.equal(findStaleDocsImpl(conn, "hub", ["sym-parse"], true).total, 1, "the mention is still reachable on opt-in");
});

test("a mention dropped from a doc does not survive the re-index", () => {
  const conn = db();
  upsertDocsImpl(conn, [DOC]);
  upsertDocMentionsImpl(conn, [mention("backtick", 1.0)]);

  // The doc is edited and no longer mentions the symbol at all.
  replaceDocsForFileImpl(conn, "hub", FILE, [DOC], []);

  assert.equal(findStaleDocsImpl(conn, "hub", ["sym-parse"], true).total, 0);
});

test("nothing inside a fenced block reaches the prose signal", () => {
  const source = [
    "# Real Heading",
    "Prose mentioning `TenantId`.",
    "```bash",
    "# Not a heading — a shell comment naming `Parse`",
    "dotnet run Parse(x)",
    "```",
    "More prose about `Codec`."
  ].join("\n");

  const { docs, mentions } = parseMarkdownFile({ repoId: "r", filePath: "d.md", source });

  // The heading match used to run regardless of fence state, so this `# comment` became a real
  // heading: it published a doc node and reset the heading path for every line that followed.
  const headings = docs.filter((d) => d.contentType === "heading").map((d) => d.text);
  assert.deepEqual(headings, ["d.md", "Real Heading"]);

  const prose = mentions.filter((m) => m.mentionType !== "code_call").map((m) => m.mentionText);
  assert.deepEqual(prose.sort(), ["Codec", "TenantId"], "only real prose mentions carry the prose label");

  // Both fenced occurrences — the backticked one in the comment and the `Parse(` call — are code
  // provenance. The backtick branch of `extractMentionsFromCode` kept saying otherwise.
  const code = mentions.filter((m) => m.mentionType === "code_call").map((m) => m.mentionText);
  assert.ok(code.includes("Parse"), "the fenced identifier is recorded, as code");
  assert.ok(!prose.includes("Parse"), "and never as prose");
});


/**
 * MCP-ISSUE-061(o). `docs_fts` is an external-content FTS5 table, and the old rebuild cleared it with
 * `DELETE FROM docs_fts` — which requires reading each row's current text back out of `docs` to know
 * which terms to drop. Every row `replaceDocsForFileImpl` had already deleted therefore left its
 * terms behind pointing at a dead rowid, and the next MATCH raised
 * `SQLITE_CORRUPT_VTAB: fts5: missing row N`.
 *
 * It went unnoticed for one reason: BOTH the rebuild and the search path catch and continue, so a
 * corrupt index looked exactly like a repo with no docs lane, and `mode:"search"` quietly served
 * unranked LIKE substring hits instead. On the live workspace database every repo was in this state.
 *
 * The delete-then-rebuild sequence below is the minimum that reproduces it. A single-pass test
 * cannot: a freshly built index is always consistent.
 */
test("docs_fts survives a file's docs being replaced", () => {
  const conn = db();

  const rows = (fp: string, n: number) =>
    Array.from({ length: n }, (_, i) => ({
      repoId: "hub",
      docId: `${fp}:${i}`,
      filePath: fp,
      headingPath: `${fp}#h${i}`,
      contentType: "prose" as const,
      text: `the pipeline resolves edges in pass ${i}`,
      level: 2
    }));

  upsertDocsImpl(conn, [...rows("a.md", 3), ...rows("b.md", 3)]);
  rebuildDocsFtsImpl(conn);

  // The operation that orphaned the index: one file's docs deleted and re-written.
  replaceDocsForFileImpl(conn, "hub", "a.md", rows("a.md", 2), []);
  rebuildDocsFtsImpl(conn);

  const matched = conn
    .prepare(
      `select count(*) as c from docs_fts
       inner join docs on docs.doc_id = docs_fts.doc_id
       where docs_fts match ? and docs.repo_id = ?`
    )
    .get("pipeline", "hub") as { c: number };

  // Five rows survive the replace (2 + 3); all five must be reachable through FTS.
  assert.equal(matched.c, 5, "docs_fts must answer MATCH after a replace, not raise SQLITE_CORRUPT_VTAB");
});
