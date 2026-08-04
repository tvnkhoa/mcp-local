import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";

import { initGraphSchema } from "./schema.js";
import {
  replaceDocsForFileImpl,
  upsertDocsImpl,
  upsertDocMentionsImpl,
  findStaleDocsImpl
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
  assert.equal(findStaleDocsImpl(conn, "hub", ["sym-parse"]).length, 1, "precondition: the false positive exists");

  // Pass 2: the corrected build re-indexes the same file and labels it `code_call`.
  replaceDocsForFileImpl(conn, "hub", FILE, [DOC], [mention("code_call", 0.5)]);

  const types = conn.prepare("select mention_type from doc_mentions").all() as { mention_type: string }[];
  assert.deepEqual(types.map((r) => r.mention_type), ["code_call"], "the legacy row is gone, not shadowed");
  assert.equal(findStaleDocsImpl(conn, "hub", ["sym-parse"]).length, 0, "the false positive clears on re-index");

  // Asserted as a pair: a count of zero is equally satisfied by having broken the lane outright.
  assert.equal(findStaleDocsImpl(conn, "hub", ["sym-parse"], true).length, 1, "the mention is still reachable on opt-in");
});

test("a mention dropped from a doc does not survive the re-index", () => {
  const conn = db();
  upsertDocsImpl(conn, [DOC]);
  upsertDocMentionsImpl(conn, [mention("backtick", 1.0)]);

  // The doc is edited and no longer mentions the symbol at all.
  replaceDocsForFileImpl(conn, "hub", FILE, [DOC], []);

  assert.equal(findStaleDocsImpl(conn, "hub", ["sym-parse"], true).length, 0);
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
