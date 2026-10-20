import assert from "node:assert/strict";
import test from "node:test";

import {
  classNamesFromStatic,
  classNamesInSelector,
  cssClassToken,
  cssVarReferences,
  cssVarToken,
  extractCss
} from "./cssExtractor.js";
import { makeSymbolId, stableId } from "./extractorPrimitives.js";
import { extractGraphData } from "./treeSitterExtractor.js";

const INPUT = { repoId: "r", filePath: "src/styles/app.css" };
const ID_INPUT = { ...INPUT, language: "css", source: "" };
const MODULE_ID = stableId(`r:src/styles/app.css:module`);

const SOURCE = [
  "/* tokens — .not-a-class and var(--not-a-use) live in a comment */", // 1
  ":root {", // 2
  "  --text-tertiary: #8a8a8a;", // 3
  "  --text-muted: var(--text-tertiary);", // 4
  "}", // 5
  "[data-theme=\"dark\"] {", // 6
  "  --text-tertiary: #6b6b6b;", // 7
  "}", // 8
  ".card .title,", // 9
  ".card .subtitle {", // 10
  "  color: var(--text-tertiary);", // 11
  "  box-shadow:", // 12
  "    0 0 1px var(--shadow-color),", // 13
  "    0 1px 2px var(--shadow-color);", // 14
  "}", // 15
  ".btn {", // 16
  "  &:hover { color: var(--text-muted); }", // 17
  "}", // 18
  "@media (max-width: 600px) {", // 19
  "  .btn { padding: 0; }", // 20
  "  .md\\:flex { display: flex; }", // 21
  "}", // 22
  "body { background: var(--bg); }", // 23
  "@keyframes pulse { from { opacity: var(--o); } to { opacity: 1; } }", // 24
  "@import url('./tokens.css');", // 25
  "@import \"./theme.css\" layer(theme);" // 26
].join("\n");

test("custom properties: one css_variable symbol per definition site, named with the dashes", () => {
  const { symbols } = extractCss(SOURCE, INPUT);
  const vars = symbols.filter((s) => s.kind === "css_variable");
  assert.deepEqual(
    vars.map((s) => [s.name, s.line]),
    [["--text-tertiary", 3], ["--text-muted", 4], ["--text-tertiary", 7]]
  );
  // Ids come from makeSymbolId on the 0-indexed row, the one place an id is minted.
  assert.equal(vars[0]!.symbolId, makeSymbolId(ID_INPUT, "css_variable", "--text-tertiary", 2));
  assert.notEqual(vars[0]!.symbolId, vars[2]!.symbolId);
  assert.match(vars[2]!.signature ?? "", /--text-tertiary: #6b6b6b @ \[data-theme="dark"\]/);
});

test("classes: one css_class symbol per name per file, nested rules, @media and escapes included", () => {
  const { symbols } = extractCss(SOURCE, INPUT);
  const classes = symbols.filter((s) => s.kind === "css_class");
  assert.deepEqual(
    classes.map((s) => [s.name, s.line]),
    [[".card", 9], [".title", 9], [".subtitle", 9], [".btn", 16], [".md:flex", 21]]
  );
  const btn = classes.find((s) => s.name === ".btn")!;
  assert.match(btn.signature ?? "", /\(2 rules\)/);
  // A comment is not a class and not a use.
  assert.equal(classes.some((s) => s.name === ".not-a-class"), false);
});

test("var() uses: from the subject class, the defining variable, or the module — always as cssvar: tokens", () => {
  const { symbols, edges } = extractCss(SOURCE, INPUT);
  const idOf = (name: string, line?: number): string =>
    symbols.find((s) => s.name === name && (line === undefined || s.line === line))!.symbolId;
  const has = (from: string, to: string): boolean => edges.some((e) => e.fromId === from && e.toId === to && e.type === "USES_CSS_VAR");

  assert.ok(has(idOf("--text-muted"), cssVarToken("--text-tertiary")), "--a: var(--b) is --a → --b");
  assert.ok(has(idOf(".title"), "cssvar:--text-tertiary"));
  assert.ok(has(idOf(".subtitle"), "cssvar:--text-tertiary"));
  assert.ok(has(idOf(".title"), "cssvar:--shadow-color"), "multi-line declaration value");
  assert.ok(has(idOf(".btn"), "cssvar:--text-muted"), "&:hover walks out to the parent rule's class");
  assert.ok(has(MODULE_ID, "cssvar:--bg"), "a class-less rule falls back to the module");
  assert.equal(edges.some((e) => e.toId === "cssvar:--not-a-use"), false);
  // A keyframe is not an owner, and its var() still counts as a use (from the module).
  assert.ok(has(MODULE_ID, "cssvar:--o"));
  // Duplicate uses in one rule collapse to one edge.
  assert.equal(edges.filter((e) => e.fromId === idOf(".title") && e.toId === "cssvar:--shadow-color").length, 1);
  for (const e of edges.filter((x) => x.type === "USES_CSS_VAR")) {
    assert.equal(e.reason, "unresolved css variable token");
    assert.equal(e.confidence, 0.5);
  }
});

test("@import → IMPORTS import:<spec> from the module, url() and quoted forms", () => {
  const { edges } = extractCss(SOURCE, INPUT);
  const imports = edges.filter((e) => e.type === "IMPORTS").map((e) => [e.fromId, e.toId]);
  assert.deepEqual(imports, [[MODULE_ID, "import:./tokens.css"], [MODULE_ID, "import:./theme.css"]]);
});

test("a remote @import is an external boundary at extraction, not an unresolved import", () => {
  const { edges } = extractCss("@import url('https://fonts.googleapis.com/css2?family=Poppins');\n@import '//cdn.example/x.css';", INPUT);
  assert.equal(edges.length, 2);
  for (const e of edges) {
    assert.equal(e.reason, "external boundary");
    assert.equal(e.confidence, 0.1);
  }
});

test("lineOffset shifts lines and ids; scoped is recorded in the signature", () => {
  const block = ".a { color: var(--x); }\n.b { --x: red; }";
  const { symbols } = extractCss(block, { repoId: "r", filePath: "src/C.vue" }, 40, { scoped: true });
  const a = symbols.find((s) => s.name === ".a")!;
  const x = symbols.find((s) => s.name === "--x")!;
  assert.equal(a.line, 41);
  assert.equal(x.line, 42);
  assert.equal(x.symbolId, makeSymbolId({ repoId: "r", filePath: "src/C.vue", language: "css", source: "" }, "css_variable", "--x", 41));
  assert.match(a.signature ?? "", /\[scoped\]$/);
});

test("a syntax error throws (the pipeline counts it as a parse failure)", () => {
  assert.throws(() => extractCss(".a { color: red;", INPUT));
});

test("extractGraphData routes language css through the postcss lane with a module symbol", () => {
  const out = extractGraphData({ repoId: "r", filePath: "src/styles/app.css", language: "css", source: SOURCE });
  assert.equal(out.symbols[0]!.kind, "module");
  assert.equal(out.symbols[0]!.symbolId, MODULE_ID);
  assert.ok(out.symbols.some((s) => s.kind === "css_variable"));
  assert.ok(out.edges.some((e) => e.toId === "cssvar:--text-tertiary"));
});

test("helpers: static class attribute, selector classes, var references, tokens", () => {
  assert.deepEqual(classNamesFromStatic("  btn btn-primary {{ x }} btn  is-active "), ["btn", "btn-primary", "is-active"]);
  assert.deepEqual(classNamesInSelector('a[href$=".pdf"].link > .icon:not(.x)'), ["link", "icon", "x"]);
  assert.deepEqual(cssVarReferences("calc(var(--a) + var( --b, var(--c)))"), ["--a", "--b", "--c"]);
  assert.equal(cssClassToken("btn"), "cssclass:.btn");
  assert.equal(cssClassToken(".btn"), "cssclass:.btn");
});
