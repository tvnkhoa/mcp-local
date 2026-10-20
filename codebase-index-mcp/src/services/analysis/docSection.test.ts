import assert from "node:assert/strict";
import test from "node:test";

import { extractSection, listHeadings, matchHeadings, nearestHeadings } from "./docSection.js";

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
