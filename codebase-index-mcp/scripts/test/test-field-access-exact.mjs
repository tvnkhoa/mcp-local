/**
 * R3 exact — `find_field_accesses` on a TS/JS field answers from the TypeScript LanguageService.
 *
 * Fixture: a pnpm-shaped monorepo in a temp dir (`@fx/contracts` linked into node_modules the way a
 * workspace symlink is, zod linked from this server's own install):
 *   contracts  — a field bag spread into a `z.object`, and the `z.infer` type;
 *   core       — a writer via `audit_event_schema.parse({...literal})` and one via a variable initializer;
 *   api        — a reader by property access, a destructuring read, a same-named FUNCTION (homonym),
 *                and an `obj[key]` dynamic access (a named gap);
 *   portal     — a .vue file mentioning the field (a named gap: Vue is not in the program yet).
 * Then a second server with CODEBASE_INDEX_TS_LS_COLD_START_MS=1: coverage "gap" and NO list.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
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

const tmpDir = makeTempDir("field-exact-");
const repoId = `field-exact-${Date.now()}`;
const files = {
  "package.json": JSON.stringify({ name: "fx-root", private: true, type: "module" }),
  "tsconfig.base.json": JSON.stringify({ compilerOptions: { target: "es2023", module: "nodenext", moduleResolution: "nodenext", strict: true, types: [] } }),
  "packages/contracts/package.json": JSON.stringify({ name: "@fx/contracts", type: "module", exports: { ".": "./src/index.ts" } }),
  "packages/contracts/src/index.ts": `export * from "./entities/audit-event.js";\n`,
  "packages/contracts/src/entities/audit-event.ts": `import { z } from "zod";

const audit_event_common_fields = {
  audit_event_id: z.string(),
  kb_version_ids: z.array(z.string()),
};

export const audit_event_schema = z.object({
  ...audit_event_common_fields,
  audit_kind: z.literal("turn"),
});

export type AuditEvent = z.infer<typeof audit_event_schema>;
`,
  "packages/core/src/audit.ts": `import { audit_event_schema } from "@fx/contracts";

export function buildAuditRecord(ids: string[]) {
  return audit_event_schema.parse({
    audit_event_id: "aud_1",
    audit_kind: "turn",
    kb_version_ids: [...new Set(ids)],
  });
}
`,
  "packages/core/src/audit-var.ts": `import { audit_event_schema } from "@fx/contracts";

export function buildFromLine(ids: string[]) {
  const line = { audit_event_id: "aud_2", audit_kind: "turn", kb_version_ids: ids };
  return audit_event_schema.parse(line);
}
`,
  "packages/api/src/reader.ts": `import type { AuditEvent } from "@fx/contracts";

export function versionCount(event: AuditEvent): number {
  return event.kb_version_ids.length;
}
`,
  "packages/api/src/destructure.ts": `import type { AuditEvent } from "@fx/contracts";

export function firstVersion(event: AuditEvent): string | undefined {
  const { kb_version_ids } = event;
  return kb_version_ids[0];
}
`,
  "packages/api/src/wire.ts": `export function kb_version_ids(citations: { id: string }[]): string[] {
  return citations.map((c) => c.id);
}
`,
  "packages/api/src/dynamic.ts": `import type { AuditEvent } from "@fx/contracts";

export function pluck(event: AuditEvent, key: keyof AuditEvent): unknown {
  return event[key];
}
`,
  "packages/portal/src/View.vue": `<template>
  <span>{{ entry.kb_version_ids.length }}</span>
</template>
`
};
for (const [rel, text] of Object.entries(files)) {
  mkdirSync(dirname(join(tmpDir, rel)), { recursive: true });
  writeFileSync(join(tmpDir, rel), text, "utf8");
}
// pnpm shape: the workspace package and zod are links in node_modules (realpath gives one identity).
mkdirSync(join(tmpDir, "node_modules", "@fx"), { recursive: true });
symlinkSync(join(tmpDir, "packages", "contracts"), join(tmpDir, "node_modules", "@fx", "contracts"), "junction");
symlinkSync(dirname(createRequire(import.meta.url).resolve("zod/package.json")), join(tmpDir, "node_modules", "zod"), "junction");

async function withServer(extraEnv, label, fn) {
  const transport = new StdioClientTransport({
    command: "node",
    args: ["dist/index.js"],
    env: { ...process.env, CODEBASE_INDEX_ALLOWED_ROOTS: tmpDir, CODEBASE_INDEX_DB_PATH: join(tmpDir, `index-${label}.db`), CODEBASE_INDEX_LLM_ENABLED: "false", ...extraEnv },
    stderr: "pipe"
  });
  const client = new Client({ name: `field-exact-${label}`, version: "0.1.0" });
  await client.connect(transport);
  attachServerStderr(transport, `test-field-access-exact:${label}`);
  try {
    const indexed = js(await client.callTool({ name: "index_repository", arguments: { repoId, repoPath: tmpDir, mode: "full" } }));
    assert(indexed && !indexed.error, `[${label}] index_repository`, JSON.stringify(indexed)?.slice(0, 300));
    await fn(client);
  } finally {
    await Promise.race([client.close().catch(() => {}), new Promise((r) => setTimeout(r, 3000))]);
  }
}

const at = (rows) => (rows ?? []).map((r) => `${r.file}:${r.line}`);

await withServer({}, "exact", async (client) => {
  const res = js(await client.callTool({ name: "find_field_accesses", arguments: { repoId, name: "kb_version_ids", profile: "compact" } }));
  assert(res?.engine === "typescript-language-service", "answered by the TypeScript LanguageService", JSON.stringify(res)?.slice(0, 400));
  assert(res?.coverage?.confidence === "exact", "coverage is exact", JSON.stringify(res?.coverage));
  assert(res?.declaration?.file === "packages/contracts/src/entities/audit-event.ts" && res?.declaration?.line === 5, "declaration is the field-bag key", JSON.stringify(res?.declaration));
  assert((res?.declaration?.spreadInto ?? []).includes("audit_event_schema"), "the bag is spread into audit_event_schema", JSON.stringify(res?.declaration));
  const writes = at(res?.writes);
  assert(writes.includes("packages/core/src/audit.ts:7"), "core writer via .parse({ literal }) found by the parse pass", writes.join(", "));
  assert(writes.includes("packages/core/src/audit-var.ts:4"), "core writer via a variable initializer passed to .parse", writes.join(", "));
  assert((res?.writes ?? []).every((w) => w.viaParse === true), "both writes are labelled viaParse");
  const reads = at(res?.reads);
  assert(reads.includes("packages/api/src/reader.ts:4"), "api reader by property access through z.infer", reads.join(", "));
  assert(reads.includes("packages/api/src/destructure.ts:4"), "destructuring read", reads.join(", "));
  assert(!reads.concat(writes).some((s) => s.startsWith("packages/api/src/wire.ts")), "the same-named function contributes no site");
  assert((res?.nonMatches ?? []).some((n) => n.file === "packages/api/src/wire.ts" && n.kind === "function"), "the homonym function is a named non-match", JSON.stringify(res?.nonMatches));
  const gaps = at(res?.coverage?.gaps);
  assert(gaps.includes("packages/api/src/dynamic.ts:4"), "obj[key] is a named gap", gaps.join(", "));
  assert(gaps.includes("packages/portal/src/View.vue:2"), ".vue file is a named gap", gaps.join(", "));
  assert(res?.typeResolution?.cold === true && res.typeResolution.coldMs > 0 && res.typeResolution.programFiles > 0, "timings and program size are reported", JSON.stringify(res?.typeResolution));

  const warm = js(await client.callTool({ name: "find_field_accesses", arguments: { repoId, name: "kb_version_ids", ownerName: "audit_event_schema", mode: "write", profile: "compact" } }));
  assert(warm?.typeResolution?.cold === false && typeof warm.typeResolution.warmMs === "number", "second call is warm", JSON.stringify(warm?.typeResolution));
  assert(warm?.writeCount === 2 && warm?.reads === undefined, "mode=write returns only the write list (counts stay complete)", JSON.stringify(warm)?.slice(0, 300));

  const nano = js(await client.callTool({ name: "find_field_accesses", arguments: { repoId, name: "kb_version_ids", profile: "nano" } }));
  assert(nano?.coverage === "exact" && nano?.readCount === 2 && nano?.writeCount === 2, "nano carries counts and the coverage word", JSON.stringify(nano)?.slice(0, 300));

  const wrongPick = js(await client.callTool({ name: "find_field_accesses", arguments: { repoId, name: "kb_version_ids", ownerName: "NoSuchSchema" } }));
  assert(wrongPick?.property == null && wrongPick?.ambiguity && Array.isArray(wrongPick?.candidates) && wrongPick.candidates.length === 1, "a pick matching nothing lists the candidates", JSON.stringify(wrongPick)?.slice(0, 300));
});

await withServer({ CODEBASE_INDEX_TS_LS_COLD_START_MS: "1" }, "cap", async (client) => {
  const res = js(await client.callTool({ name: "find_field_accesses", arguments: { repoId, name: "kb_version_ids", profile: "compact" } }));
  assert(res?.coverage?.confidence === "gap", "a cap breach is coverage 'gap'", JSON.stringify(res)?.slice(0, 400));
  assert(res?.accessesWithheld === true && res?.reads === undefined && res?.writes === undefined && res?.readCount == null, "and returns no partial list", JSON.stringify(res)?.slice(0, 400));
  assert(typeof res?.coverage?.knownGaps?.[0] === "string" && res.coverage.knownGaps[0].includes("CODEBASE_INDEX_TS_LS_COLD_START_MS"), "the breach names the cap", JSON.stringify(res?.coverage));
});

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
