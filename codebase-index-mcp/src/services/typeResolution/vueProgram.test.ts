import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { findFieldReferences, type FieldAnswer } from "./fieldReferences.js";
import { collectProgramFilesFromDisk, dropRepoLanguageService, getRepoLanguageService } from "./languageServiceHost.js";
import { detectRepoVueVersion, loadVolar, planVueProgram, versionMismatch } from "./vueProgram.js";

/**
 * R3 exact for `.vue` (the Volar lane) on a small real program, plus the untyped-object-key
 * non-matches. The fixture cannot install `vue`, so it carries a minimal `node_modules/vue` type stub
 * — exactly the declarations Volar's generated code imports (`defineProps`, `defineComponent`,
 * `ShallowUnwrapRef`, `ComponentPublicInstance`, `GlobalComponents`, `GlobalDirectives` and
 * `vue/jsx-runtime`'s `JSX.IntrinsicElements`). Without it `vue` does not resolve and the lane
 * refuses to run (asserted below), because every template expression would be typed `any`.
 */

const zodDir = path.dirname(createRequire(import.meta.url).resolve("zod/package.json"));

export const VUE_STUB: Record<string, string> = {
  "package.json": JSON.stringify({ name: "vue", version: "3.5.0", types: "index.d.ts", exports: { ".": { types: "./index.d.ts" }, "./jsx-runtime": { types: "./jsx-runtime.d.ts" } } }),
  "index.d.ts": [
    "export declare function defineProps<T>(): Readonly<T>;",
    "export declare function defineEmits<T>(): T;",
    "export declare function defineSlots<T>(): T;",
    "export declare function defineExpose<T>(exposed?: T): void;",
    "export declare function defineModel<T>(): T;",
    "export declare function defineOptions(options: unknown): void;",
    "export declare function withDefaults<T, D>(props: T, defaults: D): T;",
    "export declare function defineComponent<T>(options: T): T;",
    "export type ShallowUnwrapRef<T> = T;",
    "export interface ComponentPublicInstance { $attrs: Record<string, unknown> }",
    "export interface GlobalComponents {}",
    "export interface GlobalDirectives {}",
    ""
  ].join("\n"),
  "jsx-runtime.d.ts": "export namespace JSX { interface IntrinsicElements { [name: string]: Record<string, unknown> } }\n"
};

const FILES: Record<string, string> = {
  "package.json": JSON.stringify({ name: "fx", type: "module" }),
  "tsconfig.json": JSON.stringify({ compilerOptions: { target: "es2022", module: "preserve", moduleResolution: "bundler", strict: true, lib: ["es2023", "dom"], jsx: "preserve", types: [] } }),
  "src/contract.ts": `import { z } from "zod";
export const entry_schema = z.object({
  document_id: z.string(),
  proposed_tag_change: z.string().nullable(),
});
export type Entry = z.infer<typeof entry_schema>;
`,
  "src/RowMarks.vue": `<script setup lang="ts">
import type { Entry } from "./contract";

const props = defineProps<{ entry: Entry }>();

function clearProposal(row: Entry): void {
  row.proposed_tag_change = null;
}
</script>

<template>
  <span v-if="entry.proposed_tag_change !== null" @click="clearProposal(props.entry)">!</span>
</template>
`,
  "src/Unrelated.vue": `<script setup lang="ts">
defineProps<{ proposed_tag_change: string }>();
</script>

<template>
  <b>{{ proposed_tag_change }}</b>
</template>
`,
  "src/wire.ts": `import type { Entry } from "./contract";
export function toWire(entry: Entry) {
  return { id: entry.document_id, proposed_tag_change: "n/a" };
}
export function typed(): Entry {
  return { document_id: "d", proposed_tag_change: null };
}
`
};

function writeFixture(extra: Record<string, string> = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cim-r3-vue-"));
  const all: Record<string, string> = { ...FILES, ...Object.fromEntries(Object.entries(VUE_STUB).map(([k, v]) => [`node_modules/vue/${k}`, v])), ...extra };
  for (const [rel, text] of Object.entries(all)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  fs.symlinkSync(zodDir, path.join(dir, "node_modules", "zod"), "junction");
  return dir;
}

function ok(a: FieldAnswer): Extract<FieldAnswer, { status: "ok" }> {
  assert.equal(a.status, "ok", JSON.stringify(a).slice(0, 800));
  return a as Extract<FieldAnswer, { status: "ok" }>;
}

test("vue version gate: lockfile and node_modules, major mismatch only", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cim-vue-ver-"));
  try {
    assert.equal(detectRepoVueVersion(dir), null);
    fs.writeFileSync(path.join(dir, "pnpm-lock.yaml"), "packages:\n\n  vue-tsc@3.3.11(typescript@5.9.3):\n    resolution: {}\n");
    assert.deepEqual(detectRepoVueVersion(dir), { version: "3.3.11", source: "pnpm-lock.yaml" });
    fs.mkdirSync(path.join(dir, "node_modules", "vue-tsc"), { recursive: true });
    fs.writeFileSync(path.join(dir, "node_modules", "vue-tsc", "package.json"), JSON.stringify({ version: "2.2.10" }));
    assert.deepEqual(detectRepoVueVersion(dir), { version: "2.2.10", source: "node_modules/vue-tsc/package.json" }, "node_modules wins over the lockfile");
    assert.equal(versionMismatch("3.3.11", "3.0.1"), null, "a minor difference is not a mismatch");
    assert.equal(versionMismatch("3.3.11", null), null, "an unknown version is not a mismatch");
    assert.equal(versionMismatch("3.3.11", "2.2.10"), "vue language-core major mismatch (ours 3.3.11, repo 2.2.10)");
    const loaded = loadVolar();
    assert.ok("api" in loaded && loaded.api.version === "3.3.11", "the pinned @vue/language-core loads");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("planVueProgram: options from the tsconfig owning the most .vue files", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cim-vue-plan-"));
  try {
    for (const rel of ["tsconfig.base.json", "packages/web/tsconfig.json", "packages/web/src/A.vue", "packages/web/src/B.vue", "packages/admin/C.vue"]) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), "{}");
    }
    const plan = planVueProgram(dir, ["packages/web/src/A.vue", "packages/web/src/B.vue", "packages/admin/C.vue"], path.join(dir, "tsconfig.base.json"));
    assert.equal(plan.tsconfig, path.join(dir, "packages/web/tsconfig.json"));
    assert.deepEqual(plan.ownerConfigs, [path.join(dir, "packages/web/tsconfig.json"), path.join(dir, "tsconfig.base.json")]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("findFieldReferences: .vue template and script sites through Volar, untyped keys as non-matches", () => {
  const dir = writeFixture();
  const repoId = `r3-vue-${String(Date.now())}`;
  try {
    const svc = getRepoLanguageService({ repoId, repoPath: dir, runKey: "r1", relativeFiles: collectProgramFilesFromDisk(dir) });
    // Two candidates: the contract key and Unrelated.vue's own prop.
    const both = findFieldReferences(svc, "proposed_tag_change");
    assert.equal(both.status, "ambiguous", JSON.stringify(both).slice(0, 600));
    assert.ok(both.status === "ambiguous" && both.candidates.some((c) => c.file === "src/Unrelated.vue" && c.line === 2 && c.ownerName === "Unrelated.vue props" && c.readCount === 1), JSON.stringify(both.status === "ambiguous" && both.candidates));

    const answer = ok(findFieldReferences(svc, "proposed_tag_change", { ownerName: "entry_schema" }));
    assert.equal(answer.meta.vue?.status, "in-program", JSON.stringify(answer.meta.vue));
    const at = (kind: string): string[] => answer.sites.filter((s) => s.kind === kind).map((s) => `${s.file}:${String(s.line)}`);
    assert.ok(at("READ").includes("src/RowMarks.vue:12"), `template read at the real .vue line: ${at("READ").join(",")}`);
    assert.ok(at("WRITE").includes("src/RowMarks.vue:7"), `script write: ${at("WRITE").join(",")}`);
    assert.ok(at("WRITE").includes("src/wire.ts:6"), "a typed construction is a write");
    const template = answer.sites.find((s) => s.file === "src/RowMarks.vue" && s.line === 12)!;
    assert.equal(template.enclosingName, "<template>");
    assert.ok(template.how.endsWith("(template)"), template.how);
    assert.equal(answer.sites.filter((s) => s.file === "src/RowMarks.vue" && s.line === 12).length, 1, "the v-if duplicated into the event handler is one site");
    assert.ok(!answer.sites.some((s) => s.file === "src/Unrelated.vue"), "another declaration's prop is not a site");
    assert.deepEqual(answer.gaps, [], JSON.stringify(answer.gaps));

    const untyped = answer.nonMatches.filter((n) => n.kind === "untyped-object-key").map((n) => `${n.file}:${String(n.line)}:${String(n.container)}`);
    assert.deepEqual(untyped, ["src/wire.ts:3:toWire"], "the wire key with no declared field is named; the typed construction is not");
  } finally {
    dropRepoLanguageService(repoId);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("findFieldReferences: a Vue major mismatch keeps .vue as named gaps", () => {
  const dir = writeFixture({ "node_modules/vue-tsc/package.json": JSON.stringify({ name: "vue-tsc", version: "2.2.10" }) });
  const repoId = `r3-vue-mm-${String(Date.now())}`;
  try {
    const svc = getRepoLanguageService({ repoId, repoPath: dir, runKey: "r1", relativeFiles: collectProgramFilesFromDisk(dir) });
    const answer = ok(findFieldReferences(svc, "proposed_tag_change", { ownerName: "entry_schema" }));
    assert.equal(answer.meta.vue?.status, "fallback");
    assert.ok(!answer.sites.some((s) => s.file.endsWith(".vue")), "no .vue site is claimed");
    const gap = answer.gaps.find((g) => g.file === "src/RowMarks.vue");
    assert.ok(gap?.reason.includes("vue language-core major mismatch (ours 3.3.11, repo 2.2.10)"), JSON.stringify(answer.gaps));
  } finally {
    dropRepoLanguageService(repoId);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
