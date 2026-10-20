import assert from "node:assert/strict";
import test from "node:test";

import { parseCitationConfig } from "./citationConfig.js";
import { commentLines, extractComments, findCitations, markdownProseLines } from "./annotationScanner.js";

/**
 * Release C: citations (R5/R6) and code comments (prose search) read from a file's text. The patterns
 * below are wec.aria's shorthand — the server ships none of its own.
 */

const CONFIG = JSON.stringify({
  version: 1,
  registryDoc: "docs/10-canonical-model.md",
  citations: [
    { id: "decision-row", pattern: "(?:docs/)?15 #(\\d{1,4})", target: "docs/15-decision-log.md", anchor: { kind: "tableRow", column: 1, value: "{1}" } },
    { id: "adr", pattern: "\\badr/(\\d{4})\\b", target: "docs/adr/{1}-*.md", anchor: { kind: "file" } },
    { id: "inv", pattern: "<!--inv:by=test:([^#>]+)#([^>]*?)-->", target: "{1}", anchor: { kind: "testName", value: "{2}" } }
  ]
});

test("config: compiles valid entries, names and skips invalid ones, never fails the whole file for one entry", () => {
  const raw = JSON.parse(CONFIG) as { citations: unknown[] };
  raw.citations.push({ id: "bad", pattern: "(unclosed", target: "x", anchor: { kind: "file" } });
  raw.citations.push({ id: "noval", pattern: "x", target: "y", anchor: { kind: "tableRow" } });
  const load = parseCitationConfig(JSON.stringify(raw));
  assert.equal(load.config?.citations.length, 3);
  assert.equal(load.errors.length, 2);
  assert.ok(load.errors.some((e) => e.includes("(bad): invalid regex")));
  assert.ok(load.errors.some((e) => e.includes("(noval)") && e.includes("needs anchor.value")));
  assert.equal(parseCitationConfig("{ not json").config, null);
  assert.equal(parseCitationConfig(JSON.stringify({ version: 2, citations: [] })).config, null, "unknown version refuses the file");
});

test("markdown: citations outside fences, several per line, with substituted targets and anchors", () => {
  const md = [
    "# Doc",
    "See docs/15 #737 and 15 #726, per adr/0021.",
    "```",
    "15 #999 inside a fence is an example, not a citation",
    "```",
    "<!--inv:by=test:packages/core/test/tools.test.ts#has no identity key-->"
  ].join("\n");
  const hits = findCitations(markdownProseLines(md), parseCitationConfig(CONFIG).config!.citations);
  assert.deepEqual(
    hits.map((h) => [h.patternId, h.line, h.targetSpec, h.anchorValue]),
    [
      ["decision-row", 2, "docs/15-decision-log.md", "737"],
      ["decision-row", 2, "docs/15-decision-log.md", "726"],
      ["adr", 2, "docs/adr/0021-*.md", null],
      ["inv", 6, "packages/core/test/tools.test.ts", "has no identity key"]
    ]
  );
});

test("TS comments: line runs merge, block comments strip markers, strings are not comments", () => {
  const ts = [
    "// A stage threw before",
    "// the turn ended (15 #737).",
    "const url = \"http://example.com // not a comment\";",
    "/**",
    " * Retrieval misses go to the content team.",
    " * adr/0021 §B",
    " */",
    "export function f() { return 1; } // trailing note"
  ].join("\n");
  const chunks = extractComments(ts, "typescript");
  assert.deepEqual(chunks.map((c) => [c.startLine, c.endLine]), [[1, 2], [5, 6], [8, 8]]);
  assert.equal(chunks[0]!.text, "A stage threw before\nthe turn ended (15 #737).");
  assert.ok(!chunks.some((c) => c.text.includes("not a comment")));
  const hits = findCitations(commentLines(chunks), parseCitationConfig(CONFIG).config!.citations);
  assert.deepEqual(hits.map((h) => [h.patternId, h.line]), [["decision-row", 2], ["adr", 6]]);
});

test("Python comments use #, and a # inside a string is not one", () => {
  const py = ["x = '# not a comment'", "# real one: adr/0057", "y = 2"].join("\n");
  const chunks = extractComments(py, "python");
  assert.deepEqual(chunks.map((c) => c.text), ["real one: adr/0057"]);
});
