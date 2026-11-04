import assert from "node:assert/strict";
import test from "node:test";

import { extractSection, headingAtLine, listHeadings, matchHeadings, matchHeadingsContaining, nearestHeadings } from "./docSection.js";
import { queryDocsSchema } from "../../types/schemas/readMetadata.js";

/**
 * `query_docs{ mode:"section" }` — a section addressed by heading, never by line number. wec.aria's
 * agents read docs with `sed -n` line ranges about 1 170 times; a line range is stale after any edit
 * above it, a heading is not.
 */

const DOC = [
  "# 10 — Canonical model", //               1
  "",
  "Intro prose.",
  "",
  "## 0. `tenant`, not `dealer`", //          5
  "",
  "Tenant text.",
  "",
  "```md",
  "# not a heading, inside a fence", //       10
  "```",
  "",
  "### 0.1 Sub", //                           13
  "",
  "Sub text.",
  "",
  "## 3.7 Retrieval", //                      17
  "",
  "Retrieval text.",
  "",
  "## 3.70 Something else", //                21
  "",
  "Setext heading",
  "--------------", //                        24
  "",
  "After setext."
];

test("headings inside a fenced block are not headings", () => {
  const headings = listHeadings(DOC);
  assert.ok(!headings.some((h) => h.text.includes("inside a fence")));
  assert.deepEqual(headings.map((h) => h.line), [1, 5, 13, 17, 21, 23]);
  assert.equal(headings.find((h) => h.line === 23)?.level, 2, "setext with dashes is level 2");
});

test("a prefix matches case-insensitively with inline markup ignored", () => {
  const m = matchHeadings(listHeadings(DOC), "0. tenant, NOT");
  assert.equal(m[0]?.line, 5);
});

test("an exact heading wins over a longer heading that merely starts with it", () => {
  const m = matchHeadings(listHeadings(DOC), "3.7 retrieval");
  assert.equal(m[0]?.line, 17);
  const prefixOnly = matchHeadings(listHeadings(DOC), "3.7");
  assert.equal(prefixOnly.length, 2, "3.7 and 3.70 both start with '3.7'");
  assert.equal(prefixOnly[0]?.line, 17, "document order when neither is exact");
});

test("a section runs to the next heading of the same or higher level, and lists its subsections", () => {
  const headings = listHeadings(DOC);
  const s = extractSection(DOC, headings, headings.find((h) => h.line === 5)!, 10_000, []);
  assert.equal(s.startLine, 5);
  assert.equal(s.endLine, 16);
  assert.equal(s.sectionEndLine, 16);
  assert.equal(s.truncated, false);
  assert.ok(s.text.includes("Sub text."), "subsection bodies are part of the section");
  assert.ok(!s.text.includes("Retrieval text."));
  assert.deepEqual(s.subsections.map((h) => h.text), ["0.1 Sub"]);
});

test("the budget cuts at a line boundary and says where", () => {
  const long = ["## Big", ...Array.from({ length: 200 }, (_, i) => `row ${String(i)} ${"x".repeat(40)}`)];
  const headings = listHeadings(long);
  const s = extractSection(long, headings, headings[0]!, 200, []);
  assert.equal(s.truncated, true);
  assert.ok(s.truncatedAtLine !== undefined && s.truncatedAtLine > 2);
  assert.equal(s.endLine, s.truncatedAtLine! - 1);
  assert.equal(s.sectionEndLine, 201);
  assert.ok(s.text.length <= 200 * 4);
});

test("on a miss, headings are ranked by likeness to what was asked, not listed in document order", () => {
  // Release A listed the first ten headings whatever the prefix was (wec.aria acceptance nit a).
  const headings = listHeadings(DOC);
  assert.equal(nearestHeadings(headings, "retrieval")[0]?.line, 17);
  assert.equal(nearestHeadings(headings, "retreival")[0]?.line, 17, "a typo still finds it");
  assert.equal(nearestHeadings(headings, "setext head")[0]?.line, 23);
  assert.ok(nearestHeadings(headings, "zzz").length > 0, "never an empty hint when the file has headings");
});

test("the budget never cuts inside a table: it stops at the last block boundary", () => {
  // Release A cut docs/10 at a line inside a table and returned a header with no rows (nit b).
  const doc = [
    "## Rules",
    "",
    "Intro paragraph.",
    "",
    "| # | Rule |",
    "|---|---|",
    ...Array.from({ length: 40 }, (_, i) => `| ${String(i)} | rule text ${"y".repeat(30)} |`),
    "",
    "After the table."
  ];
  const headings = listHeadings(doc);
  const s = extractSection(doc, headings, headings[0]!, 200, []);
  assert.equal(s.truncated, true);
  assert.ok(!s.text.includes("| # | Rule |"), "the table is left out whole, not started");
  assert.ok(s.text.includes("Intro paragraph."));
  assert.equal(s.truncatedAtLine, 5, "reading on starts at the table header");
});

test("a single block larger than the whole budget still falls back to a line cut", () => {
  const doc = ["## Big", ...Array.from({ length: 100 }, (_, i) => `line ${String(i)} ${"z".repeat(40)}`)];
  const headings = listHeadings(doc);
  const s = extractSection(doc, headings, headings[0]!, 200, []);
  assert.equal(s.truncated, true);
  assert.ok(s.text.split("\n").length > 1, "more than the heading is returned");
});

// MCP-ISSUE-116 (IX-6): two more ways to address a section.

const BOARD_README = [
  "# Board", //                       1
  "",
  "Intro.",
  "",
  "## Commands", //                   5
  "",
  "board next",
  "",
  "## Discoveries", //                9
  "",
  "A discovery is filed with `discover`.",
  "",
  "### Format", //                   13
  "",
  "One line each.",
  "",
  "## Notes" //                      17
];

test("headingContains finds 'Discoveries' from 'discover' (wec.aria's case)", () => {
  const m = matchHeadingsContaining(listHeadings(BOARD_README), "discover");
  assert.equal(m.length, 1);
  assert.equal(m[0]?.text, "Discoveries");
  assert.equal(m[0]?.line, 9);
});

test("headingContains is case-insensitive, markup-blind, and puts an exact heading first", () => {
  const headings = listHeadings(DOC);
  assert.equal(matchHeadingsContaining(headings, "TENANT")[0]?.line, 5);
  const m = matchHeadingsContaining(headings, "sub");
  assert.equal(m[0]?.line, 13);
  const withExact = matchHeadingsContaining(listHeadings(["## A thing", "", "## Thing"]), "thing");
  assert.equal(withExact[0]?.line, 3, "exact beats an earlier longer heading");
  assert.equal(withExact.length, 2, "ambiguity is returned, not hidden");
  assert.deepEqual(matchHeadingsContaining(headings, "zzz"), []);
});

test("headingAtLine returns the innermost section holding the line", () => {
  const headings = listHeadings(BOARD_README);
  assert.equal(headingAtLine(headings, 11)?.text, "Discoveries");
  assert.equal(headingAtLine(headings, 14)?.text, "Format", "inside a subsection: the subsection");
  assert.equal(headingAtLine(headings, 9)?.text, "Discoveries", "the heading line itself");
  assert.equal(headingAtLine(headings, 17)?.text, "Notes", "the last line is covered");
  assert.equal(headingAtLine(headings, 1)?.text, "Board", "the first line is covered");
});

test("headingAtLine: a line before the first heading is in no section", () => {
  assert.equal(headingAtLine(listHeadings(["preamble", "", "## First"]), 1), undefined);
});

test("a section found by line extracts the same text as by heading", () => {
  const headings = listHeadings(BOARD_README);
  const s = extractSection(BOARD_README, headings, headingAtLine(headings, 11)!, 10_000, []);
  assert.equal(s.startLine, 9);
  assert.equal(s.sectionEndLine, 16);
  assert.ok(s.text.includes("One line each."));
});

test("mode=section requires filePath and exactly one of headingPrefix, headingContains, line", () => {
  const schema = queryDocsSchema(100);
  const ok = (extra: Record<string, unknown>): boolean =>
    schema.safeParse({ repoId: "r", mode: "section", filePath: "a.md", ...extra }).success;
  assert.equal(ok({ headingPrefix: "3.7" }), true);
  assert.equal(ok({ headingContains: "discover" }), true);
  assert.equal(ok({ line: 12 }), true);
  assert.equal(ok({}), false, "none");
  assert.equal(ok({ headingPrefix: "a", line: 3 }), false, "two");
  assert.equal(ok({ headingContains: "a", line: 3 }), false, "two");
  assert.equal(ok({ line: 0 }), false, "lines are 1-based");
  assert.equal(schema.safeParse({ repoId: "r", mode: "section", headingContains: "x" }).success, false, "filePath required");
});
