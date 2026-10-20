/**
 * R2 "full Vue" (MCP-ISSUE-074) over real stdio: a fixture Vue app in a temp dir.
 *
 * App.vue imports AppCard.vue, ReadFailure.vue, OnlyInTemplate.vue and DynamicPanel.vue; it binds
 * props, a v-model and listeners, renders `<component :is>` with two imported branches, one dynamic
 * branch (a call) and one pair of intrinsic strings, calls `save(x)` from `@click`, and handles
 * `@close="onClose"`. AppCard declares props/model/emits and emits from script and template.
 * Unused.vue is rendered by nobody — the control for dead_code_scan.
 *
 * Asserts, through the tools a caller would actually use: language/kind/lines (stage 1), USES_COMPONENT
 * incl. per-branch `:is` and the labelled gaps (stage 2), prop/listener/handler/expression edges with
 * real .vue lines (stage 3), and the cross-tool contract — get_file_summary, search_symbols,
 * find_impact_files, get_call_chain, dead_code_scan, find_implementations.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execFileSync } from "child_process";
import { mkdirSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { makeTempDir } from "./_fixtures.mjs";
import { attachServerStderr } from "./_serverStderr.mjs";

let passed = 0, failed = 0;
function assert(cond, label, detail = "") {
  if (cond) { console.log(`  PASS  ${label}`); passed++; }
  else { console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`); failed++; }
}
const txt = (r) => Array.isArray(r?.content) ? (r.content.find((x) => x.type === "text")?.text ?? "") : "";
const js = (r) => { try { return JSON.parse(txt(r)); } catch { return null; } };
const posix = (p) => String(p).replace(/\\/g, "/");
const short = (v) => JSON.stringify(v)?.slice(0, 600);
/** 1-indexed line of the first line of `file` containing `needle` — the fixture is the oracle. */
const lineOf = (file, needle) => FIXTURE[file].split("\n").findIndex((l) => l.includes(needle)) + 1;

const FIXTURE = {
  "src/App.vue": `<script setup lang="ts">
import { ref } from 'vue'
import AppCard from './components/AppCard.vue'
import ReadFailure from './components/ReadFailure.vue'
import OnlyInTemplate from './components/OnlyInTemplate.vue'
import DynamicPanel from './components/DynamicPanel.vue'
import { formatTitle } from './lib/format'

const show = ref(true)
const view = ref('card')
const items = ref([{ id: 1, name: 'a' }])
const x = 1

function save(value: number) {
  return value
}

const onClose = () => {
  show.value = false
}

function pickView() {
  return AppCard
}
</script>

<template>
  <div class="app">
    <AppCard :title="formatTitle('Hello')" v-model="view" @close="onClose">
      <button @click="save(x)">Save</button>
    </AppCard>
    <read-failure v-if="!show" reason="boom" @retry="onClose" />
    <component :is="show ? DynamicPanel : ReadFailure" />
    <component :is="pickView()" />
    <component :is="show ? 'div' : 'span'" />
    <OnlyInTemplate v-for="item in items" :key="item.id" :label="item.name" />
    <RouterView />
  </div>
</template>

<style scoped>
.app {
  color: var(--accent);
}
</style>
`,
  "src/components/AppCard.vue": `<script setup lang="ts">
const props = defineProps<{ title: string; subtitle?: string }>()
const model = defineModel<string>()
const emit = defineEmits<{ (e: 'close'): void; (e: 'pin', id: number): void }>()

function onHeaderClick() {
  emit('close')
}

function neverUsed() {
  return props.title
}
</script>

<template>
  <section :class="['card', { pinned: model }, dynamicClass]">
    <h2 @click="onHeaderClick">{{ title }}</h2>
    <p>{{ props.subtitle }}</p>
    <button @click="$emit('pin', 1)">pin</button>
    <slot />
  </section>
</template>

<style scoped>
.card { border: 1px solid var(--accent); }
.pinned { outline: 0; }
</style>
`,
  "src/components/ReadFailure.vue": `<script setup>
defineProps({ reason: { type: String, required: true } })
defineEmits(['retry'])
</script>

<template>
  <div class="failure">{{ reason }} <button @click="$emit('retry')">retry</button></div>
</template>
`,
  "src/components/OnlyInTemplate.vue": `<script setup lang="ts">
interface Props {
  label: string
}
defineProps<Props>()
</script>

<template><span>{{ label }}</span></template>
`,
  "src/components/DynamicPanel.vue": `<script setup lang="ts">
defineProps<{ mode?: string }>()
</script>

<template><aside>panel</aside></template>
`,
  "src/components/Unused.vue": `<script setup lang="ts">
defineProps<{ x: number }>()
</script>

<template><i>unused</i></template>
`,
  "src/styles/tokens.css": `:root {
  --accent: #333;
}
`,
  "src/lib/format.ts": `export function formatTitle(s: string): string {
  return s.trim();
}
`
};

const repo = makeTempDir("vue-components-");
const repoId = `vue-${Date.now()}`;
mkdirSync(join(repo, ".index"), { recursive: true });
for (const [rel, content] of Object.entries(FIXTURE)) {
  mkdirSync(dirname(join(repo, rel)), { recursive: true });
  writeFileSync(join(repo, rel), content);
}
writeFileSync(join(repo, ".gitignore"), ".index/\n");
const git = (...args) => execFileSync("git", ["-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", ...args], { stdio: "pipe" });
git("init", "-q");
git("add", ".");
git("commit", "-q", "-m", "fixture");

const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/index.js"],
  env: { ...process.env, CODEBASE_INDEX_ALLOWED_ROOTS: repo, CODEBASE_INDEX_DB_PATH: join(repo, ".index", "index.db"), CODEBASE_INDEX_LLM_ENABLED: "false" },
  stderr: "pipe"
});
const client = new Client({ name: "test-vue-components", version: "0.1.0" });
await client.connect(transport);
attachServerStderr(transport, "test-vue-components");
const call = async (name, args) => js(await client.callTool({ name, arguments: { repoId, ...args } }));
const sql = async (query) => (await call("query_graph", { sql: query, limit: 500, profile: "standard" }))?.rows ?? [];

try {
  const run = await call("index_repository", { repoPath: repo, mode: "full" });
  assert((run?.parseFailures ?? run?.summary?.parseFailures ?? 0) === 0, "full index: no parse failures", short(run));

  // ── Stage 1: language, component symbol, interface, real lines ───────────────────────────
  const files = await sql("select path, language from files where repo_id = :repoId and path like '%.vue' order by path");
  assert(files.length === 6 && files.every((f) => f.language === "vue"), ".vue files are indexed with language 'vue'", short(files));

  const summary = await call("get_file_summary", { filePath: "src/components/AppCard.vue", profile: "standard" });
  const sumText = JSON.stringify(summary);
  assert(/"AppCard"/.test(sumText) && /component/.test(sumText) && /onHeaderClick/.test(sumText), "get_file_summary(AppCard.vue) lists the component and its script functions", short(summary));

  const members = await sql(`select s.name, s.kind, s.line from symbols s join symbols c on c.symbol_id = s.parent_symbol_id and c.repo_id = s.repo_id
    where s.repo_id = :repoId and c.kind = 'component' and c.name = 'AppCard' order by s.line, s.name`);
  const memberNames = members.map((m) => `${m.name}@${m.line}`).sort();
  assert(JSON.stringify(memberNames) === JSON.stringify(["modelValue@3", "onClose@4", "onPin@4", "onUpdate:modelValue@3", "subtitle@2", "title@2"]),
    "defineProps/defineModel/defineEmits members are the component's children at their real .vue lines", short(members));

  const fns = await sql("select name, line from symbols where repo_id = :repoId and file_path like '%AppCard.vue' and kind = 'function' order by line");
  assert(fns.find((f) => f.name === "onHeaderClick")?.line === 6 && fns.find((f) => f.name === "neverUsed")?.line === 10, "script functions carry the .vue line, not the block-relative one", short(fns));

  const runtimeProps = await sql(`select s.name, s.line from symbols s join symbols c on c.symbol_id = s.parent_symbol_id
    where s.repo_id = :repoId and c.name = 'ReadFailure' and c.kind = 'component' order by s.name`);
  assert(JSON.stringify(runtimeProps.map((p) => `${p.name}@${p.line}`)) === JSON.stringify(["onRetry@3", "reason@2"]), "runtime defineProps({...}) / defineEmits([...]) are read too", short(runtimeProps));

  const search = await call("search_symbols", { query: "AppCard", strategy: "name", profile: "standard" });
  const hits = search?.results ?? search?.symbols ?? search?.items ?? [];
  assert(hits.slice(0, 3).some((h) => h.kind === "component" && h.name === "AppCard"), "search_symbols('AppCard') finds the component (top 3, beside its module)", short(hits.slice?.(0, 3) ?? search));

  const macroNoise = await sql("select to_id from edges where repo_id = :repoId and to_id in ('callee' || char(58) || 'defineProps', 'callee' || char(58) || 'defineEmits', 'callee' || char(58) || 'defineModel', 'callee' || char(58) || 'emit')");
  assert(macroNoise.length === 0, "compiler macros and the emit binding leave no unresolvable callee tokens", short(macroNoise));

  // ── Stage 2: USES_COMPONENT, :is per branch, labelled gaps ───────────────────────────────
  const uses = await sql(`select t.name as target, t.kind, e.reason from edges e
    join symbols f on f.symbol_id = e.from_id and f.repo_id = e.repo_id
    join symbols t on t.symbol_id = e.to_id and t.repo_id = e.repo_id
    where e.repo_id = :repoId and e.type = 'USES_COMPONENT' and f.name = 'App' order by t.name`);
  const usedNames = [...new Set(uses.map((u) => u.target))];
  assert(JSON.stringify(usedNames) === JSON.stringify(["AppCard", "DynamicPanel", "OnlyInTemplate", "ReadFailure"]) && uses.every((u) => u.kind === "component"),
    "App.vue USES_COMPONENT each imported child (kebab <read-failure> too) — resolved to the child's component symbol", short(uses));

  const gaps = (await sql("select to_id, reason, confidence from edges where repo_id = :repoId and type = 'USES_COMPONENT' order by to_id"))
    .filter((g) => String(g.to_id).startsWith("component:"));
  const dynamicGap = gaps.find((g) => g.to_id === "component:pickView()");
  assert(dynamicGap && /dynamic :is/.test(dynamicGap.reason) && dynamicGap.confidence < 0.5, "a dynamic :is branch is kept as a labelled gap", short(gaps));
  assert(gaps.some((g) => g.to_id === "component:RouterView" && /not imported/.test(g.reason)), "an un-imported (global) tag is a labelled gap", short(gaps));
  assert(!gaps.some((g) => /div|span/.test(g.to_id)), "intrinsic :is strings ('div' / 'span') are ignored", short(gaps));

  // ── Stage 3: bindings, handlers, expressions, emits ──────────────────────────────────────
  const writes = await sql(`select t.name as member, c.name as owner, e.assigned_expression as expr from edges e
    join symbols t on t.symbol_id = e.to_id and t.repo_id = e.repo_id
    left join symbols c on c.symbol_id = t.parent_symbol_id and c.repo_id = t.repo_id
    where e.repo_id = :repoId and e.type = 'PROPERTY_WRITE' order by t.name`);
  const titleWrite = writes.find((w) => w.member === "title" && w.owner === "AppCard");
  assert(titleWrite?.expr === "formatTitle('Hello')", ":title on <AppCard> → PROPERTY_WRITE to AppCard's title prop, with the bound expression", short(writes));
  assert(writes.some((w) => w.member === "onClose" && w.owner === "AppCard" && w.expr === "onClose"), "@close on <AppCard> → PROPERTY_WRITE to AppCard's onClose listener member", short(writes));
  assert(writes.some((w) => w.member === "modelValue") && writes.some((w) => w.member === "onUpdate:modelValue"), "v-model on a child binds modelValue and onUpdate:modelValue", short(writes));
  assert(writes.some((w) => w.member === "reason" && w.owner === "ReadFailure" && w.expr === '"boom"'), "a static attribute on a child is a prop write too", short(writes));
  assert(writes.some((w) => w.member === "label"), "a prop declared through `interface Props` resolves as well", short(writes));

  const handler = await sql(`select f.name as fromName, t.name as handler, t.line, e.reason from edges e
    join symbols f on f.symbol_id = e.from_id and f.repo_id = e.repo_id
    join symbols t on t.symbol_id = e.to_id and t.repo_id = e.repo_id
    where e.repo_id = :repoId and e.type = 'CALLS' and f.kind = 'component' order by f.name, t.name`);
  const onClose = handler.find((h) => h.fromName === "App" && h.handler === "onClose");
  const closeDecl = lineOf("src/App.vue", "const onClose =");
  const closeSite = lineOf("src/App.vue", "@close=\"onClose\"");
  assert(onClose && onClose.line === closeDecl && onClose.reason.includes(`@close handler (line ${closeSite})`), `@close="onClose" → CALLS onClose (App.vue:${closeDecl}), template site App.vue:${closeSite}`, short(handler));
  const save = handler.find((h) => h.fromName === "App" && h.handler === "save");
  const saveSite = lineOf("src/App.vue", "save(x)");
  assert(save && save.reason.includes(`template call (line ${saveSite})`), `@click="save(x)" → CALLS save, inline expression at its real line (${saveSite})`, short(handler));
  assert(handler.some((h) => h.fromName === "App" && h.handler === "formatTitle"), "a call inside a bound expression resolves to an imported function", short(handler));
  assert(handler.some((h) => h.fromName === "App" && h.handler === "pickView"), "a call inside a dynamic :is is still a call", short(handler));
  assert(handler.some((h) => h.fromName === "AppCard" && h.handler === "onPin" && /\$emit 'pin'/.test(h.reason)), "$emit('pin') in a template → CALLS the onPin member", short(handler));

  const scriptEmit = await sql(`select f.name as fromName, t.name as target from edges e
    join symbols f on f.symbol_id = e.from_id and f.repo_id = e.repo_id
    join symbols t on t.symbol_id = e.to_id and t.repo_id = e.repo_id
    where e.repo_id = :repoId and e.type = 'CALLS' and t.name = 'onClose' and t.kind = 'property'`);
  assert(scriptEmit.some((r) => r.fromName === "onHeaderClick"), "emit('close') in script → CALLS AppCard's onClose member from the enclosing function", short(scriptEmit));

  const propReads = await sql(`select f.name as fromName, t.name as prop, e.reason from edges e
    join symbols f on f.symbol_id = e.from_id and f.repo_id = e.repo_id
    join symbols t on t.symbol_id = e.to_id and t.repo_id = e.repo_id
    where e.repo_id = :repoId and e.type = 'PROPERTY_REF' and t.kind = 'property' and f.file_path like '%AppCard.vue'`);
  assert(propReads.some((r) => r.fromName === "AppCard" && r.prop === "title" && r.reason.includes(`line ${lineOf("src/components/AppCard.vue", "{{ title }}")})`)), "{{ title }} → PROPERTY_REF to the own prop at the interpolation line", short(propReads));
  assert(propReads.some((r) => r.fromName === "neverUsed" && r.prop === "title"), "props.title in script → PROPERTY_REF to the prop", short(propReads));

  // ── CSS (MCP-ISSUE-075 lane, wired through the SFC split) ───────────────────────────────
  const varUsers = await sql(`select f.name as fromName, f.kind as fromKind, f.file_path as fromFile, f.line as fromLine from edges e
    join symbols f on f.symbol_id = e.from_id and f.repo_id = e.repo_id
    join symbols t on t.symbol_id = e.to_id and t.repo_id = e.repo_id
    where e.repo_id = :repoId and e.type = 'USES_CSS_VAR' and t.name = '--accent' and t.kind = 'css_variable' order by f.file_path`);
  const appStyleLine = lineOf("src/App.vue", ".app {");
  assert(varUsers.some((u) => posix(u.fromFile) === "src/App.vue" && u.fromName === ".app" && u.fromLine === appStyleLine),
    `who uses --accent: App.vue's <style> rule .app at its .vue line (${appStyleLine})`, short(varUsers));
  assert(varUsers.some((u) => posix(u.fromFile) === "src/components/AppCard.vue" && u.fromName === ".card"), "who uses --accent: AppCard.vue's .card", short(varUsers));

  const classUses = await sql(`select f.name as fromName, t.name as cls, posix_file from (select e.*, t.file_path as posix_file from edges e join symbols t on t.symbol_id = e.to_id and t.repo_id = e.repo_id where e.repo_id = :repoId and e.type = 'USES_CSS_CLASS') x
    join symbols f on f.symbol_id = x.from_id and f.repo_id = x.repo_id
    join symbols t on t.symbol_id = x.to_id and t.repo_id = x.repo_id order by t.name`);
  const classNames = [...new Set(classUses.map((c) => `${c.fromName}:${c.cls}`))].sort();
  assert(JSON.stringify(classNames) === JSON.stringify(["App:.app", "AppCard:.card", "AppCard:.pinned"]),
    "template class=\"app\" and literal :class (array string, object key) → USES_CSS_CLASS to the <style> classes; the dynamic entry is not emitted", short(classUses));

  // ── Cross-tool ───────────────────────────────────────────────────────────────────────────
  const impact = await call("find_impact_files", { filePath: "src/components/ReadFailure.vue", profile: "standard" });
  assert(JSON.stringify(impact).includes("src/App.vue"), "find_impact_files(ReadFailure.vue): App.vue is impacted (template use)", short(impact));

  const cardId = (await sql("select symbol_id from symbols where repo_id = :repoId and kind = 'component' and name = 'AppCard'"))[0]?.symbol_id;
  const chain = await call("get_call_chain", { symbolId: cardId, direction: "callers", profile: "standard" });
  assert(JSON.stringify(chain).includes("App.vue"), "get_call_chain(AppCard, callers) reaches App via USES_COMPONENT", short(chain));

  const closeId = (await sql("select symbol_id from symbols where repo_id = :repoId and kind = 'function' and name = 'onClose'"))[0]?.symbol_id;
  const handlerChain = await call("get_call_chain", { symbolId: closeId, direction: "callers", profile: "standard" });
  assert(/"App"/.test(JSON.stringify(handlerChain)), "get_call_chain(onClose, callers) names the template (App component)", short(handlerChain));

  const dead = await call("dead_code_scan", { language: "vue", includePrivate: true, limit: 100, profile: "standard" });
  const deadNames = (dead?.symbols ?? dead?.candidates ?? []).map((c) => c.name);
  assert(deadNames.includes("Unused"), "dead_code_scan lists the component nobody renders or imports (control)", short(dead));
  assert(deadNames.includes("neverUsed"), "dead_code_scan lists a script function nobody calls (control)", short(deadNames));
  for (const live of ["OnlyInTemplate", "DynamicPanel", "AppCard", "ReadFailure", "onHeaderClick"]) {
    assert(!deadNames.includes(live), `dead_code_scan: ${live} is used only from a template — not dead`, short(deadNames));
  }

  const impl = await call("find_implementations", { interfaceName: "AppCard", profile: "standard" });
  assert(typeof impl?.notApplicable === "string" && /not applicable for a Vue component/.test(impl.notApplicable), "find_implementations(AppCard) says it is not applicable for a Vue component", short(impl));

  const regex = await call("search_regex", { pattern: "onHeaderClick", language: "vue", profile: "standard" });
  assert(JSON.stringify(regex).includes("AppCard.vue"), "search_regex(language: 'vue') searches .vue files", short(regex));

  // Incremental parity: a whole-file rewrite that shifts every line of AppCard.vue keeps App's edges resolved.
  writeFileSync(join(repo, "src/components/AppCard.vue"), "\n\n" + FIXTURE["src/components/AppCard.vue"]);
  await call("index_repository", { repoPath: repo, mode: "incremental" });
  const after = await sql(`select t.name as member, t.line from edges e join symbols t on t.symbol_id = e.to_id and t.repo_id = e.repo_id
    join symbols f on f.symbol_id = e.from_id and f.repo_id = e.repo_id
    where e.repo_id = :repoId and e.type = 'PROPERTY_WRITE' and f.name = 'App' and t.name = 'title'`);
  assert(after.length === 1 && after[0].line === 4, "incremental: App's :title edge follows AppCard's title prop to its new line (4)", short(after));
  const dangling = await sql("select count(*) as n from edges e where e.repo_id = :repoId and e.to_id not like '%' || char(58) || '%' and not exists (select 1 from symbols s where s.repo_id = e.repo_id and s.symbol_id = e.to_id)");
  assert((dangling[0]?.n ?? 1) === 0, "incremental: no dangling resolved edges", short(dangling));
} finally {
  await client.close();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
