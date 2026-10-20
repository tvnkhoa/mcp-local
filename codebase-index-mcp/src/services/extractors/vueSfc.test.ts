import { test } from "node:test";
import assert from "node:assert/strict";

import { maskOutsideRanges, maskVueToScripts, splitVueSfc } from "./vueSfc.js";
import { extractGraphData } from "./treeSitterExtractor.js";

const SFC = [
  "<script lang=\"ts\">", //                         1
  "export const shared = 1", //                      2
  "</script>", //                                    3
  "", //                                             4
  "<script setup lang=\"ts\">", //                   5
  "import Child from './Child.vue'", //              6
  "defineProps<{ title: string }>()", //             7
  "function save(x: number) { return x }", //        8
  "</script>", //                                    9
  "", //                                             10
  "<template>", //                                   11
  "  <Child :title=\"title\" @click=\"save(1)\" />", // 12
  "</template>", //                                  13
  "", //                                             14
  "<style scoped lang=\"scss\">", //                 15
  ".a { color: var(--x); }", //                      16
  "</style>", //                                     17
  "<style module>.b{}</style>" //                    18
].join("\n");

test("splitVueSfc: both script blocks, in file order, with file lines and lang/setup", () => {
  const split = splitVueSfc(SFC, "src/Comp.vue");
  assert.deepEqual(split.errors, []);
  assert.equal(split.scripts.length, 2);
  assert.deepEqual(split.scripts.map((s) => [s.startLine, s.lang, s.setup]), [[1, "ts", false], [5, "ts", true]]);
  assert.equal(SFC.slice(split.scripts[1]!.startOffset, split.scripts[1]!.endOffset), split.scripts[1]!.content);
  assert.equal(split.template?.startLine, 11);
  assert.ok(split.template?.ast, "template AST is exposed");
});

test("splitVueSfc: style blocks are exposed for the CSS lane (content, line, lang, scoped, module)", () => {
  const split = splitVueSfc(SFC, "src/Comp.vue");
  assert.deepEqual(
    split.styles.map((s) => ({ line: s.startLine, lang: s.lang, scoped: s.scoped, module: s.module, hasVar: s.content.includes("var(--x)") })),
    [
      { line: 15, lang: "scss", scoped: true, module: false, hasVar: true },
      { line: 18, lang: "css", scoped: false, module: true, hasVar: false }
    ]
  );
});

test("splitVueSfc: a malformed file degrades to errors, never throws", () => {
  const split = splitVueSfc("<template><div></template>", "src/Bad.vue");
  assert.ok(split.errors.length > 0);
});

test("maskOutsideRanges keeps length and every line break", () => {
  const source = "ab\ncd\r\nef";
  const masked = maskOutsideRanges(source, [{ start: 3, end: 5 }]);
  assert.equal(masked.length, source.length);
  assert.equal(masked, "  \ncd\r\n  ");
});

test("maskVueToScripts leaves only script content, on its original lines", () => {
  const masked = maskVueToScripts(SFC);
  const lines = masked.split("\n");
  assert.equal(lines.length, SFC.split("\n").length);
  assert.equal(lines[7], "function save(x: number) { return x }");
  assert.equal(lines[11]!.trim(), "", "template text is blanked");
  assert.equal(lines[15]!.trim(), "", "style text is blanked");
});

test("extractGraphData(vue): symbols and edges carry the real .vue line", () => {
  const out = extractGraphData({ repoId: "r", filePath: "src/Comp.vue", language: "vue", source: SFC });
  const save = out.symbols.find((s) => s.name === "save");
  assert.equal(save?.line, 8);
  const title = out.symbols.find((s) => s.name === "title" && s.kind === "property");
  assert.equal(title?.line, 7);
  const component = out.symbols.find((s) => s.kind === "component");
  assert.equal(component?.name, "Comp");
  assert.equal(title?.parentSymbolId, component?.symbolId);
  const call = out.edges.find((e) => e.type === "CALLS" && e.toId === save?.symbolId);
  assert.match(call?.reason ?? "", /template call \(line 12\)/);
  assert.ok(out.edges.some((e) => e.type === "USES_COMPONENT" && e.toId === "component:./Child.vue"));
});
