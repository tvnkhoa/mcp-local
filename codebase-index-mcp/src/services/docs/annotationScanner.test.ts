import assert from "node:assert/strict";
import test from "node:test";

import { parseCitationConfig } from "./citationConfig.js";
import { commentLines, extractComments, extractPropertyStrings, findCitations, markdownProseLines } from "./annotationScanner.js";

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

/** Format v1.1 `scan.codeStrings`: only literals assigned to a named property are scanned. */

test("config v1.1: scan.codeStrings keeps identifiers, names and skips the rest, caps at 20", () => {
  const raw = JSON.parse(CONFIG) as Record<string, unknown>;
  raw.scan = { codeStrings: ["owner", "not-an-id", 42, "owner", "$ref"] };
  const load = parseCitationConfig(JSON.stringify(raw));
  assert.deepEqual(load.config?.codeStrings, ["owner", "$ref"]);
  assert.equal(load.errors.filter((e) => e.startsWith("scan.codeStrings")).length, 2);
  assert.deepEqual(parseCitationConfig(CONFIG).config?.codeStrings, [], "absent means no string is scanned");
  raw.scan = { codeStrings: Array.from({ length: 22 }, (_, k) => `p${String(k)}`) };
  const capped = parseCitationConfig(JSON.stringify(raw));
  assert.equal(capped.config?.codeStrings.length, 20);
  assert.equal(capped.errors.length, 2);
});

test("property strings: owner: '…' matches, other properties and bare strings do not", () => {
  const js = [
    "export const STEPS = [",
    "  { id: 'lint', owner: 'docs/15 #116 (gate owner)', note: 'docs/15 #9 is not an owner' },",
    "  { id: 'x', label: \"15 #3\" },",
    "];",
    "call('docs/15 #4');",
    "const same = a == 'docs/15 #5';"
  ].join("\n");
  const lines = extractPropertyStrings(js, "javascript", ["owner"]);
  assert.deepEqual(lines, [{ line: 2, text: "docs/15 #116 (gate owner)" }]);
  const hits = findCitations(lines, parseCitationConfig(CONFIG).config!.citations);
  assert.deepEqual(hits.map((h) => [h.patternId, h.line, h.anchorValue]), [["decision-row", 2, "116"]]);
  assert.deepEqual(extractPropertyStrings(js, "javascript", []), [], "no names, no strings");
});

test("property strings: class field, member assignment, quoted key, C# initializer, Python", () => {
  const ts = [
    "class Step {",
    "  owner = 'adr/0021';",
    "  constructor() { this.owner = \"adr/0022\"; }",
    "}",
    "const o = { \"owner\": 'adr/0023', owner2: 'adr/0024' };"
  ].join("\n");
  assert.deepEqual(extractPropertyStrings(ts, "typescript", ["owner"]).map((l) => [l.line, l.text]), [[2, "adr/0021"], [3, "adr/0022"], [5, "adr/0023"]]);
  const cs = ["var s = new Step {", "  Owner = @\"docs\\15 \"\"#7\"\"\",", "  Name = \"Owner = 'x'\"", "};"].join("\n");
  assert.deepEqual(extractPropertyStrings(cs, "csharp", ["Owner"]), [{ line: 2, text: "docs\\15 \"#7\"" }]);
  const py = ["STEP = dict(owner='adr/0031')", "x = {\"owner\": \"\"\"adr/0032\n  adr/0033\"\"\"}", "# owner = 'adr/0034'"].join("\n");
  assert.deepEqual(extractPropertyStrings(py, "python", ["owner"]).map((l) => [l.line, l.text.trim()]), [[1, "adr/0031"], [2, "adr/0032"], [3, "adr/0033"]]);
});

test("property strings: a string inside a comment is not counted; escaped quotes do not end the literal", () => {
  const js = [
    "// owner: 'docs/15 #1' is how a step names its owner",
    "/* { owner: 'docs/15 #2' } */",
    "const s = { owner: 'it\\'s docs/15 #3, \"quoted\"', next: 'docs/15 #4' };",
    "const t = { owner: \"a \\\" docs/15 #5\" };"
  ].join("\n");
  const lines = extractPropertyStrings(js, "javascript", ["owner"]);
  assert.deepEqual(lines, [
    { line: 3, text: "it's docs/15 #3, \"quoted\"" },
    { line: 4, text: "a \" docs/15 #5" }
  ]);
  // The comment citations are found once, by the comment scanner; the strings add only their own.
  const all = [...commentLines(extractComments(js, "javascript")), ...lines];
  const rows = findCitations(all, parseCitationConfig(CONFIG).config!.citations).map((h) => h.anchorValue).sort();
  assert.deepEqual(rows, ["1", "2", "3", "5"]);
});

test("property strings: multi-line template keeps real line numbers; ${} cuts the static parts", () => {
  const ts = [
    "const a = 1;",
    "const step = {",
    "  owner: `first line",
    "docs/15 #20 on line four",
    "and ${pick({ owner: 'docs/15 #99' })} docs/15 #21`,",
    "  after: `docs/15 #22`,",
    "};",
    "const b = { owner: `15 #${n}` };"
  ].join("\n");
  const lines = extractPropertyStrings(ts, "typescript", ["owner"]);
  assert.deepEqual(lines, [
    { line: 3, text: "first line" },
    { line: 4, text: "docs/15 #20 on line four" },
    { line: 5, text: "and " },
    { line: 5, text: " docs/15 #21" },
    { line: 8, text: "15 #" }
  ]);
  const hits = findCitations(lines, parseCitationConfig(CONFIG).config!.citations);
  assert.deepEqual(hits.map((h) => [h.line, h.anchorValue]), [[4, "20"], [5, "21"]]);
});
