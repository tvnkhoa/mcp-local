/**
 * R3 exact for `.vue` — `find_field_accesses` sees Vue SFC sites through Volar, over real MCP stdio.
 *
 * Fixture (a pnpm-shaped monorepo in a temp dir, a git repo so the freshness gate has a tree to read):
 *   contracts — `document_list_entry_schema` (z.strictObject) with `proposed_tag_change`;
 *   portal    — `TagRowMarks.vue`: `<script setup lang="ts">` importing the contract type, a script
 *               write `row.proposed_tag_change = null`, and a template read
 *               `v-if="entry.proposed_tag_change !== null"`; its own tsconfig (bundler, DOM);
 *   api       — a wire object `{ proposed_tag_change: … }` returned with no declared type: an
 *               `untyped-object-key` non-match (the shape of wec.aria's commhub.ts:283);
 *   core      — a write via `document_list_entry_schema.parse({...})`.
 *
 * `vue` itself cannot be installed into a temp fixture, and this server does not ship it
 * (`@vue/language-core` brings the compiler, not `vue`'s types). So the fixture carries a minimal
 * `packages/portal/node_modules/vue` type stub — exactly what Volar's generated code imports
 * (`defineProps`, `defineComponent`, `ShallowUnwrapRef`, `ComponentPublicInstance`,
 * `GlobalComponents`, `GlobalDirectives`, `vue/jsx-runtime`). Without it the lane refuses to run
 * (`vue` does not resolve → template types would be `any`) and the `.vue` file stays a named gap.
 *
 * A second repo is the same tree plus `node_modules/vue-tsc` at 2.2.10: a Vue major mismatch with
 * our pinned language-core 3.x, so `.vue` stays a named gap with that reason.
 *
 * Last, release D acceptance note (1): with the index behind the tree (an uncommitted edit, a 1 ms
 * refresh budget) the answer's freshness note is scoped to the index-derived part and `coverage`
 * carries no "previous index" line.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execFileSync } from "node:child_process";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { makeTempDir } from "./_fixtures.mjs";
import { attachServerStderr } from "./_serverStderr.mjs";

let passed = 0, failed = 0;
function assert(cond, label, detail = "") {
  if (cond) { console.log(`  PASS  ${label}`); passed++; }
  else { console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`); failed++; }
}
const txt = (r) => Array.isArray(r?.content) ? (r.content.find((x) => x.type === "text")?.text ?? "") : "";
const js = (r) => { try { return JSON.parse(txt(r)); } catch { return null; } };
const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, "-c", "user.email=t@t", "-c", "user.name=t", ...args], { stdio: "pipe" });

const VUE_STUB = {
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

const FILES = {
  ".gitignore": "node_modules/\n.index/\n",
  "package.json": JSON.stringify({ name: "fx-root", private: true, type: "module" }),
  "tsconfig.base.json": JSON.stringify({ compilerOptions: { target: "es2023", module: "nodenext", moduleResolution: "nodenext", strict: true, types: [] } }),
  "packages/contracts/package.json": JSON.stringify({ name: "@fx/contracts", type: "module", exports: { ".": "./src/index.ts" } }),
  "packages/contracts/src/index.ts": `export * from "./entities/document-list.js";\n`,
  "packages/contracts/src/entities/document-list.ts": `import { z } from "zod";

export const document_list_entry_schema = z.strictObject({
  document_id: z.string(),
  proposed_tag_change: z.string().nullable(),
});

export type DocumentListEntry = z.infer<typeof document_list_entry_schema>;
`,
  "packages/portal/tsconfig.json": JSON.stringify({ extends: "../../tsconfig.base.json", compilerOptions: { noEmit: true, module: "preserve", moduleResolution: "bundler", lib: ["es2023", "dom"], jsx: "preserve", types: [] }, include: ["src"] }),
  "packages/portal/src/TagRowMarks.vue": `<script setup lang="ts">
import type { DocumentListEntry } from "@fx/contracts";

const props = defineProps<{ entry: DocumentListEntry }>();

function dismiss(row: DocumentListEntry): void {
  row.proposed_tag_change = null;
}
</script>

<template>
  <span v-if="entry.proposed_tag_change !== null" class="mark" @click="dismiss(props.entry)">tag</span>
</template>
`,
  "packages/portal/src/format.ts": `export function label(text: string): string {\n  return text.trim();\n}\n`,
  "packages/api/src/commhub.ts": `import type { DocumentListEntry } from "@fx/contracts";

export function toCommHubWire(entry: DocumentListEntry) {
  return {
    document_id: entry.document_id,
    proposed_tag_change: entry.proposed_tag_change ?? "none",
  };
}
`,
  "packages/core/src/build.ts": `import { document_list_entry_schema } from "@fx/contracts";

export function buildEntry(id: string) {
  return document_list_entry_schema.parse({ document_id: id, proposed_tag_change: null });
}
`
};

const zodDir = dirname(createRequire(import.meta.url).resolve("zod/package.json"));
function writeRepo(dir, extra = {}) {
  const all = { ...FILES, ...Object.fromEntries(Object.entries(VUE_STUB).map(([k, v]) => [`packages/portal/node_modules/vue/${k}`, v])), ...extra };
  for (const [rel, text] of Object.entries(all)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text, "utf8");
  }
  mkdirSync(join(dir, "node_modules", "@fx"), { recursive: true });
  symlinkSync(join(dir, "packages", "contracts"), join(dir, "node_modules", "@fx", "contracts"), "junction");
  symlinkSync(zodDir, join(dir, "node_modules", "zod"), "junction");
  git(dir, "init", "-q");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "fixture");
}

const tmpDir = makeTempDir("field-vue-");
const repoA = join(tmpDir, "repo-a");
const repoB = join(tmpDir, "repo-b");
writeRepo(repoA);
writeRepo(repoB, { "node_modules/vue-tsc/package.json": JSON.stringify({ name: "vue-tsc", version: "2.2.10" }) });
const stamp = Date.now();
const idA = `field-vue-a-${stamp}`;
const idB = `field-vue-b-${stamp}`;

async function withServer(extraEnv, label, fn) {
  mkdirSync(join(tmpDir, ".index"), { recursive: true });
  const transport = new StdioClientTransport({
    command: "node",
    args: ["dist/index.js"],
    env: { ...process.env, CODEBASE_INDEX_ALLOWED_ROOTS: tmpDir, CODEBASE_INDEX_DB_PATH: join(tmpDir, ".index", `index-${label}.db`), CODEBASE_INDEX_LLM_ENABLED: "false", ...extraEnv },
    stderr: "pipe"
  });
  const client = new Client({ name: `field-vue-${label}`, version: "0.1.0" });
  await client.connect(transport);
  attachServerStderr(transport, `test-field-access-vue:${label}`);
  try {
    await fn(client);
  } finally {
    await Promise.race([client.close().catch(() => {}), new Promise((r) => setTimeout(r, 3000))]);
  }
}

const at = (rows) => (rows ?? []).map((r) => `${r.file}:${r.line}`);
const ask = async (client, repoId, extra = {}) =>
  js(await client.callTool({ name: "find_field_accesses", arguments: { repoId, name: "proposed_tag_change", ownerName: "document_list_entry_schema", profile: "compact", ...extra } }));

// A prop declared only in a .vue file: the Vue lane indexes it as a graph `property`, and that must not
// send the field back to the graph's lower bound (release E live check: kb_version_ids fell back).
writeFileSync(join(repoA, "packages/portal/src/BadgeOnly.vue"), `<script setup lang="ts">\nconst props = defineProps<{ badge_only_count: number }>()\n</script>\n\n<template>\n  <span>{{ props.badge_only_count }}</span>\n</template>\n`, "utf8");

await withServer({}, "vue", async (client) => {
  for (const [id, path] of [[idA, repoA], [idB, repoB]]) {
    const indexed = js(await client.callTool({ name: "index_repository", arguments: { repoId: id, repoPath: path, mode: "full" } }));
    assert(indexed && !indexed.error, `index_repository ${id}`, JSON.stringify(indexed)?.slice(0, 300));
  }

  const res = await ask(client, idA);
  assert(res?.engine === "typescript-language-service", "answered by the TypeScript LanguageService", JSON.stringify(res)?.slice(0, 400));
  assert(res?.coverage?.confidence === "exact", "coverage is exact", JSON.stringify(res?.coverage));
  assert(res?.typeResolution?.vue?.status === "in-program" && res.typeResolution.vue.vueFiles === 2 && res.typeResolution.vue.languageCore === "3.3.11", "the .vue file is in the Vue program (Volar, pinned language-core)", JSON.stringify(res?.typeResolution?.vue));
  // Release E acceptance note (1): an unmapped generated hit is either a named gap or named here, as a
  // duplicate in a file whose every mention is covered — never a bare count.
  const unmapped = res?.typeResolution?.vue;
  assert((unmapped?.unmappedGenerated ?? 0) === 0 || (unmapped?.unmappedGeneratedFiles ?? []).reduce((n, f) => n + f.count, 0) + (res?.coverage?.gaps ?? []).filter((g) => /no source mapping/.test(g.reason)).length > 0, "every unmapped generated hit is accounted for, as a named duplicate file or a gap", JSON.stringify(unmapped));
  assert(res?.declaration?.file === "packages/contracts/src/entities/document-list.ts" && res?.declaration?.line === 5, "declaration is the contract key", JSON.stringify(res?.declaration));
  const reads = at(res?.reads);
  const writes = at(res?.writes);
  assert(reads.includes("packages/portal/src/TagRowMarks.vue:12"), "template read `entry.proposed_tag_change !== null` at its real .vue line", reads.join(", "));
  const tpl = (res?.reads ?? []).find((r) => r.file === "packages/portal/src/TagRowMarks.vue");
  assert(tpl?.enclosingName === "<template>" && /\(template\)$/.test(tpl?.how ?? ""), "the template read is labelled as such", JSON.stringify(tpl));
  assert(writes.includes("packages/portal/src/TagRowMarks.vue:7"), "script write `row.proposed_tag_change = null`", writes.join(", "));
  const scriptWrite = (res?.writes ?? []).find((r) => r.file === "packages/portal/src/TagRowMarks.vue");
  assert(scriptWrite?.enclosingName === "dismiss" && scriptWrite?.how === "assignment", "the script write names its function", JSON.stringify(scriptWrite));
  assert(reads.includes("packages/api/src/commhub.ts:6"), "the api read beside the untyped key", reads.join(", "));
  assert(writes.includes("packages/core/src/build.ts:4"), "the core write via parse", writes.join(", "));
  assert(!at(res?.coverage?.gaps).some((g) => g.endsWith(".vue")) && (res?.coverage?.gaps ?? []).length === 0, "no .vue gap once Vue is in the program", JSON.stringify(res?.coverage?.gaps));
  const untyped = (res?.nonMatches ?? []).filter((n) => n.kind === "untyped-object-key");
  assert(untyped.length === 1 && untyped[0].file === "packages/api/src/commhub.ts" && untyped[0].line === 6 && untyped[0].container === "toCommHubWire", "the wire key with no declared field is an untyped-object-key non-match", JSON.stringify(res?.nonMatches));
  assert(!(res?.nonMatches ?? []).some((n) => n.file === "packages/core/src/build.ts"), "the parse write is not also a non-match", JSON.stringify(res?.nonMatches));

  const vueOnly = js(await client.callTool({ name: "find_field_accesses", arguments: { repoId: idA, name: "badge_only_count", profile: "compact" } }));
  assert(vueOnly?.engine === "typescript-language-service", "a .vue-only prop (a graph property after the Vue lane) is still answered by the TypeScript lane", JSON.stringify(vueOnly)?.slice(0, 400));

  const warm = await ask(client, idA, { mode: "read", profile: "nano" });
  assert(warm?.coverage === "exact" && warm?.readCount === 2 && warm?.typeResolution?.cold === false, "warm nano call: counts and the coverage word", JSON.stringify(warm)?.slice(0, 400));

  const mm = await ask(client, idB);
  assert(mm?.coverage?.confidence === "exact" && mm?.typeResolution?.vue?.status === "fallback", "a Vue major mismatch: the lane falls back", JSON.stringify(mm?.typeResolution?.vue));
  const mmGap = (mm?.coverage?.gaps ?? []).find((g) => g.file === "packages/portal/src/TagRowMarks.vue");
  assert(mmGap?.line === 7 && mmGap.reason.includes("vue language-core major mismatch (ours 3.3.11, repo 2.2.10)"), "and the .vue file is a named gap with the reason", JSON.stringify(mm?.coverage?.gaps));
  assert(!at(mm?.reads).concat(at(mm?.writes)).some((s) => s.includes(".vue")), "no .vue site is claimed under a mismatch", JSON.stringify(mm)?.slice(0, 300));
});

// Release D acceptance note (1): freshness is scoped, "exact" and "previous index" never meet.
await withServer({ CODEBASE_INDEX_QUERY_REFRESH_BUDGET_MS: "1" }, "fresh", async (client) => {
  await client.callTool({ name: "index_repository", arguments: { repoId: idA, repoPath: repoA, mode: "full" } });
  writeFileSync(join(repoA, "packages/portal/src/format.ts"), `export function label(text: string): string {\n  return text.trim().toUpperCase();\n}\n`, "utf8");
  const res = await ask(client, idA);
  assert(res?.freshness && res.freshness.state !== "fresh" && res.freshness.state !== "refreshed", "the index is behind the tree (precondition)", JSON.stringify(res?.freshness));
  assert(typeof res?.freshness?.appliesTo === "string" && res.freshness.appliesTo.startsWith("index-derived parts only"), "the freshness note names what is index-derived", JSON.stringify(res?.freshness));
  assert(!/previous index/i.test(JSON.stringify(res)), "no 'previous index' line anywhere in a TypeScript-lane answer", JSON.stringify(res?.coverage));
  assert(!(res?.coverage?.knownGaps ?? []).some((g) => g.startsWith("index not current")), "coverage.knownGaps carries no freshness line", JSON.stringify(res?.coverage));
});

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
