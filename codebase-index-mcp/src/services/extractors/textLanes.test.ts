import assert from "node:assert/strict";
import test from "node:test";

import { extractGraphData } from "./treeSitterExtractor.js";
import { extractPlainText } from "./plainTextExtractor.js";
import { extractJson } from "./jsonExtractor.js";
import { extractHtml, localAssetSpec } from "./htmlExtractor.js";

/**
 * Release F lanes (MCP-ISSUE-076 text / JSON, MCP-ISSUE-077 HTML / SVG), extractor level: pure source
 * in, rows out. The end-to-end behaviour (resolution, workspace edges, skip report) is in the
 * `test-text-json-lane` and `test-html-svg` harnesses.
 */

const policy = { minLength: 6, maxPerFile: 200 };
const input = (filePath: string, language: string, source: string) => ({ repoId: "r", filePath, language, source });

test("plain text: quoted strings become literals; a # comment does not open one", () => {
  const rows = extractPlainText(input("scripts/deploy.sh", "text", `#!/bin/sh\n# it's the deploy step\necho "deploying gd-020-probe" 'second-value'\n`), policy);
  assert.deepEqual(rows.map((r) => [r.value, r.line]), [["deploying gd-020-probe", 3], ["second-value", 3]]);
  assert.ok(rows.every((r) => r.language === "text" && r.kind === "string" && r.enclosingSymbolId === null));
});

test("plain text: YAML plain scalars are literals, keys and block markers are not", () => {
  const yaml = "name: CI\njobs:\n  test:\n    steps:\n      - run: npm test --workspace core\n      - uses: actions/checkout@v4\n    image: postgres:16-alpine\n    script: |\n";
  const values = extractPlainText(input(".github/workflows/ci.yml", "text", yaml), policy).map((r) => r.value);
  assert.deepEqual(values.sort(), ["actions/checkout@v4", "npm test --workspace core", "postgres:16-alpine"]);
});

test("plain text: JSONL lines contribute their string values, not their keys", () => {
  const jsonl = `${JSON.stringify({ id: "gd-020", escalation_reason: "out_of_scope" })}\n${JSON.stringify({ id: "gd-021" })}\nnot json "but-quoted"\n`;
  const rows = extractPlainText(input("evals/cases/guardrails.jsonl", "text", jsonl), policy);
  assert.deepEqual(rows.map((r) => [r.value, r.line]), [["gd-020", 1], ["out_of_scope", 1], ["gd-021", 2], ["but-quoted", 3]]);
});

test("plain text: the per-file cap and one row per distinct value", () => {
  const source = Array.from({ length: 50 }, (_, i) => `echo "value-${i % 10}-repeated"`).join("\n");
  assert.equal(extractPlainText(input("a.sh", "text", source), policy).length, 10);
  assert.equal(extractPlainText(input("a.sh", "text", source), { minLength: 6, maxPerFile: 3 }).length, 3);
});

test("text and svg files are a module symbol and nothing else", () => {
  for (const [filePath, language, source] of [["Dockerfile", "text", "FROM node:22\n"], ["icon.svg", "svg", "<svg/>"]] as const) {
    const out = extractGraphData(input(filePath, language, source));
    assert.deepEqual(out.symbols.map((s) => s.kind), ["module"], filePath);
    assert.equal(out.edges.length, 0, filePath);
  }
});

test("package.json: npm tokens labelled by section and range; the module is signed with the package name", () => {
  const source = JSON.stringify({
    name: "@fx/app",
    dependencies: { "@fx/core": "workspace:*", vue: "^3.5.0" },
    devDependencies: { vue: "^3.5.0", vitest: "^2.0.0" },
    peerDependencies: { typescript: ">=5" }
  });
  const out = extractGraphData(input("packages/app/package.json", "json", source));
  assert.equal(out.symbols[0]?.signature, "npm:@fx/app");
  const edges = out.edges.map((e) => [e.type, e.toId, e.reason]);
  assert.deepEqual(edges, [
    ["DEPENDS_ON", "npm:@fx/core", "npm dependency (workspace:*)"],
    ["DEPENDS_ON", "npm:vue", "npm dependency (^3.5.0)"],
    ["DEPENDS_ON", "npm:vitest", "npm devDependency (^2.0.0)"],
    ["DEPENDS_ON", "npm:typescript", "npm peerDependency (>=5)"]
  ]);
  assert.ok(out.edges.every((e) => e.fromId === out.symbols[0]?.symbolId));
});

test("tsconfig: JSONC is parsed; extends / references / paths become import tokens", () => {
  const source = `{
  // comment
  "extends": ["./tsconfig.base", "@vue/tsconfig/tsconfig.dom.json"],
  "compilerOptions": { "baseUrl": "./src", "paths": { "@core": ["../packages/core/index.ts"], "@/*": ["*"], }, },
  "references": [{ "path": "./packages/core" }, { "path": "packages/app/tsconfig.app.json" }],
}`;
  const { edges } = extractJson(input("tsconfig.json", "json", source), "mod", policy);
  const byTo = Object.fromEntries(edges.map((e) => [e.toId, e]));
  assert.ok(byTo["import:./tsconfig.base.json"] && byTo["import:./tsconfig.base.json"].reason === undefined, "relative extends gets .json and stays resolvable");
  assert.equal(byTo["import:@vue/tsconfig/tsconfig.dom.json"]?.reason, "npm_package");
  assert.ok(byTo["import:./packages/core/tsconfig.json"], "a directory reference means its tsconfig.json");
  assert.ok(byTo["import:./packages/app/tsconfig.app.json"]);
  assert.ok(byTo["import:./packages/core/index.ts"], "a paths target is joined to baseUrl");
  assert.match(byTo["import:./src/*"]?.reason ?? "", /^tsconfig paths glob \(@\/\* → \.\/src\/\*\)$/);
  assert.ok(edges.every((e) => e.type === "IMPORTS"));
});

test("json: other files are text level, and string values are literals on their own line", () => {
  const source = `{\n  "title": "Release notes",\n  "items": ["first-entry", "second-entry"]\n}\n`;
  const { edges, literals } = extractJson(input("data/notes.json", "json", source), "mod", policy);
  assert.equal(edges.length, 0);
  assert.deepEqual(literals.map((l) => [l.value, l.line]), [["Release notes", 2], ["first-entry", 3], ["second-entry", 3]]);
});

test("json: an unparseable file keeps its quoted strings and is not an error", () => {
  const out = extractGraphData(input("fixtures/broken.json", "json", `{ "name": "half-written`));
  assert.deepEqual(out.symbols.map((s) => s.kind), ["module"]);
  assert.equal(out.edges.length, 0);
});

test("html: script/link/img/use references become import tokens; remote, templated and commented ones do not", () => {
  const page = `<link rel="icon" href="/favicon.svg"><link rel=stylesheet href='./src/app.css'>
<script type="module" src="/src/main.ts"></script><script src="https://cdn.example/x.js"></script>
<!-- <script src="/src/old.ts"></script> --><img src="/logo.png"><img src="img/hero.svg?v=2">
<svg><use xlink:href="./sprite.svg#home"/></svg><script src="%BASE_URL%/env.js"></script>`;
  const { edges } = extractHtml(input("index.html", "html", page), "mod");
  assert.deepEqual(edges.map((e) => e.toId), [
    "import:./public/favicon.svg",
    "import:./src/app.css",
    "import:./src/main.ts",
    "import:./img/hero.svg",
    "import:./sprite.svg"
  ]);
  assert.ok(edges.every((e) => e.type === "IMPORTS" && e.reason === undefined));
});

test("localAssetSpec: a Vue template only takes module-shaped urls", () => {
  assert.equal(localAssetSpec("../assets/icon.svg", false), "../assets/icon.svg");
  assert.equal(localAssetSpec("@/assets/icon.svg", false), "@/assets/icon.svg");
  assert.equal(localAssetSpec("~pkg/icons/x.svg", false), "pkg/icons/x.svg");
  assert.equal(localAssetSpec("/public-url.svg", false), null);
  assert.equal(localAssetSpec("data:image/svg+xml;base64,AAA", true), null);
});

test("vue template: <img src> and <use href> of an svg are imports from the component", () => {
  const source = `<template>
  <img src="../assets/icon.svg" />
  <svg><use href="../assets/sprite.svg#home" /></svg>
  <img src="/public.svg" /><img src="./photo.png" />
</template>
<script setup lang="ts">
const a = 1;
</script>
`;
  const out = extractGraphData(input("src/components/Card.vue", "vue", source));
  const imports = out.edges.filter((e) => e.type === "IMPORTS").map((e) => e.toId).sort();
  assert.deepEqual(imports, ["import:../assets/icon.svg", "import:../assets/sprite.svg"]);
  const component = out.symbols.find((s) => s.kind === "component");
  assert.ok(component && out.edges.filter((e) => e.type === "IMPORTS").every((e) => e.fromId === component.symbolId));
});
