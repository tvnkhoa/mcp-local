/**
 * Release I1 — the TypeScript / Volar programs are built in a worker thread, so a cold field query
 * never blocks the server's event loop.
 *
 * Fixture: the pnpm-shaped contract of test-field-access-exact (a Zod field bag spread into
 * `audit_event_schema`), plus GENERATED_FILES generated readers of `kb_version_ids` — enough program
 * for a cold build that takes seconds, not milliseconds. No test-only hook in the server: the build is
 * slow because the program is big, as it is on wec.aria.
 *
 * Server "build" (CODEBASE_INDEX_QUERY_REFRESH_BUDGET_MS=300, the per-call wait):
 *   (a) a field call and a search_symbols call fired together — search_symbols answers in < 1 s while
 *       the cold build runs;
 *   (b) that field call answers within its wait budget + 1 s with coverage "gap", the reason
 *       "type program still building", and NO list; polling, a later call answers exact with the
 *       full lists; a warm call's round trip (worker messaging included) is < 0.5 s.
 * Server "rss" (CODEBASE_INDEX_TS_LS_MAX_RSS_MB=48, tiny): the field call returns coverage "gap"
 *   (memory) and no list, the worker is discarded, and search_symbols keeps answering afterwards —
 *   twice, around a second field call that spawns a fresh worker.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { makeTempDir } from "./_fixtures.mjs";
import { attachServerStderr } from "./_serverStderr.mjs";

const GENERATED_FILES = Number(process.env.FIELD_WORKER_FIXTURE_FILES ?? 600);
const WAIT_MS = 300;

let passed = 0, failed = 0;
function assert(cond, label, detail = "") {
  if (cond) { console.log(`  PASS  ${label}`); passed++; }
  else { console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`); failed++; }
}
const txt = (r) => Array.isArray(r?.content) ? (r.content.find((x) => x.type === "text")?.text ?? "") : "";
const js = (r) => { try { return JSON.parse(txt(r)); } catch { return null; } };

function writeFixture(tmpDir, generated) {
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
`
  };
  for (let i = 0; i < generated; i++) {
    const body = [];
    for (let k = 0; k < 12; k++) {
      body.push(`export function reader_${i}_${k}(event: AuditEvent, extra: Record<string, number>): number {
  const ids = event.kb_version_ids.filter((id) => id.length > ${k});
  const total = Object.values(extra).reduce((sum, v) => sum + v * ${k}, 0);
  return ids.length + total + event.audit_event_id.length;
}`);
    }
    files[`packages/gen/src/g${Math.floor(i / 100)}/reader${i}.ts`] = `import type { AuditEvent } from "@fx/contracts";\n\n${body.join("\n\n")}\n`;
  }
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(tmpDir, rel)), { recursive: true });
    writeFileSync(join(tmpDir, rel), text, "utf8");
  }
  mkdirSync(join(tmpDir, "node_modules", "@fx"), { recursive: true });
  symlinkSync(join(tmpDir, "packages", "contracts"), join(tmpDir, "node_modules", "@fx", "contracts"), "junction");
  symlinkSync(dirname(createRequire(import.meta.url).resolve("zod/package.json")), join(tmpDir, "node_modules", "zod"), "junction");
}

async function withServer(tmpDir, repoId, extraEnv, label, fn) {
  const transport = new StdioClientTransport({
    command: "node",
    args: ["dist/index.js"],
    env: { ...process.env, CODEBASE_INDEX_ALLOWED_ROOTS: tmpDir, CODEBASE_INDEX_DB_PATH: join(tmpDir, `index-${label}.db`), CODEBASE_INDEX_LLM_ENABLED: "false", ...extraEnv },
    stderr: "pipe"
  });
  const client = new Client({ name: `field-worker-${label}`, version: "0.1.0" });
  await client.connect(transport);
  attachServerStderr(transport, `test-field-access-worker:${label}`);
  try {
    const indexed = js(await client.callTool({ name: "index_repository", arguments: { repoId, repoPath: tmpDir, mode: "full" } }, undefined, { timeout: 600_000 }));
    assert(indexed && !indexed.error, `[${label}] index_repository`, JSON.stringify(indexed)?.slice(0, 300));
    await fn(client);
  } finally {
    await Promise.race([client.close().catch(() => {}), new Promise((r) => setTimeout(r, 3000))]);
  }
}

async function timed(promise) {
  const t0 = performance.now();
  const value = await promise;
  return { value, ms: Math.round(performance.now() - t0) };
}

const fieldArgs = (repoId) => ({ repoId, name: "kb_version_ids", ownerName: "audit_event_schema", profile: "compact" });

// ── (a) + (b): a cold build in the worker ──
const bigDir = makeTempDir("field-worker-");
const bigRepo = `field-worker-${Date.now()}`;
writeFixture(bigDir, GENERATED_FILES);
await withServer(bigDir, bigRepo, { CODEBASE_INDEX_QUERY_REFRESH_BUDGET_MS: String(WAIT_MS) }, "build", async (client) => {
  const searchArgs = { repoId: bigRepo, query: "buildAuditRecord", strategy: "name", limit: 5, profile: "compact" };
  const baseline = await timed(client.callTool({ name: "search_symbols", arguments: searchArgs }));
  const fieldCall = timed(client.callTool({ name: "find_field_accesses", arguments: fieldArgs(bigRepo) }));
  await new Promise((r) => setTimeout(r, 50));
  const search = await timed(client.callTool({ name: "search_symbols", arguments: searchArgs }));
  const field = await fieldCall;
  const cold = js(field.value);
  console.log(`  info  search_symbols before: ${baseline.ms} ms, during the cold build: ${search.ms} ms; cold field call: ${field.ms} ms`);
  assert(txt(search.value).includes("buildAuditRecord"), "(a) search_symbols answers during the cold build", txt(search.value).slice(0, 200));
  assert(search.ms < 1000, "(a) ... in < 1 s", `${search.ms} ms`);
  assert(field.ms < WAIT_MS + 1000, "(b) the field call answers within its wait budget + 1 s", `${field.ms} ms`);
  assert(cold?.coverage?.confidence === "gap", "(b) coverage is 'gap' while the program builds", JSON.stringify(cold)?.slice(0, 400));
  assert(/type program still building/.test(cold?.coverage?.knownGaps?.[0] ?? ""), "(b) the reason says the type program is still building", JSON.stringify(cold?.coverage));
  assert(cold?.accessesWithheld === true && cold?.reads === undefined && cold?.writes === undefined && cold?.readCount == null, "(b) and NO partial list", JSON.stringify(cold)?.slice(0, 400));

  let exact = null;
  let polls = 0;
  const deadline = Date.now() + 240_000;
  while (Date.now() < deadline) {
    polls++;
    const res = js(await client.callTool({ name: "find_field_accesses", arguments: fieldArgs(bigRepo) }));
    if (res?.coverage?.confidence === "exact") { exact = res; break; }
    if (polls % 10 === 1) console.log("  info  poll", polls, res?.coverage?.knownGaps?.[0], res?.typeResolution?.totalMs);
    assert(res?.coverage?.confidence === "gap" && res?.reads === undefined, `(b) poll ${polls}: still a gap with no list`, JSON.stringify(res)?.slice(0, 300));
    await new Promise((r) => setTimeout(r, 500));
  }
  console.log(`  info  exact after ${polls} poll(s); typeResolution ${JSON.stringify(exact?.typeResolution)}`);
  assert(exact !== null, "(b) once the build finishes, a call answers exact");
  assert(exact?.readCount === GENERATED_FILES * 12 && exact?.writeCount === 1, "(b) with the complete counts", JSON.stringify({ readCount: exact?.readCount, writeCount: exact?.writeCount }));

  // A field with few references: the warm cost is findReferences over the files naming it, so a
  // field read in every generated file measures the fixture, not the messaging.
  const warm = await timed(client.callTool({ name: "find_field_accesses", arguments: { repoId: bigRepo, name: "audit_kind", profile: "compact" } }));
  const warmRes = js(warm.value);
  console.log(`  info  warm call: ${warm.ms} ms client-side; typeResolution ${JSON.stringify(warmRes?.typeResolution)}`);
  assert(warmRes?.coverage?.confidence === "exact" && warmRes?.typeResolution?.cold === false, "a warm call answers exact", JSON.stringify(warmRes?.typeResolution));
  assert(typeof warmRes?.typeResolution?.roundTripMs === "number" && warmRes.typeResolution.roundTripMs < 500, "a warm call's round trip (worker messaging included) is < 0.5 s", JSON.stringify(warmRes?.typeResolution));
});

// ── (c): a memory-cap breach inside the worker ──
const smallDir = makeTempDir("field-worker-rss-");
const smallRepo = `field-worker-rss-${Date.now()}`;
writeFixture(smallDir, 20);
await withServer(smallDir, smallRepo, { CODEBASE_INDEX_TS_LS_MAX_RSS_MB: "48" }, "rss", async (client) => {
  const res = js(await client.callTool({ name: "find_field_accesses", arguments: fieldArgs(smallRepo) }));
  console.log(`  info  (c) ${res?.coverage?.knownGaps?.[0]}`);
  assert(res?.coverage?.confidence === "gap", "(c) a memory-cap breach is coverage 'gap'", JSON.stringify(res)?.slice(0, 400));
  assert(res?.accessesWithheld === true && res?.reads === undefined && res?.readCount == null, "(c) and returns no list", JSON.stringify(res)?.slice(0, 400));
  assert(/CODEBASE_INDEX_TS_LS_MAX_RSS_MB/.test(res?.coverage?.knownGaps?.[0] ?? ""), "(c) the reason names the memory cap", JSON.stringify(res?.coverage));
  const search = await timed(client.callTool({ name: "search_symbols", arguments: { repoId: smallRepo, query: "buildAuditRecord", strategy: "name", limit: 5, profile: "compact" } }));
  assert(txt(search.value).includes("buildAuditRecord") && search.ms < 1000, "(c) search_symbols still answers after the breach", `${search.ms} ms`);
  const again = js(await client.callTool({ name: "find_field_accesses", arguments: fieldArgs(smallRepo) }));
  assert(again?.coverage?.confidence === "gap" && again?.reads === undefined, "(c) a second field call (fresh worker) is a gap again, not a crash", JSON.stringify(again)?.slice(0, 300));
  const health = js(await client.callTool({ name: "health_check", arguments: { repoId: smallRepo } }));
  assert(health && !health.error, "(c) the server keeps answering other tools", JSON.stringify(health)?.slice(0, 200));
});

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
