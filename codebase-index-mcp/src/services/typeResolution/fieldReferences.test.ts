import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import ts from "typescript";

import { classify } from "./fieldClassify.js";
import { findFieldReferences, type FieldAnswer } from "./fieldReferences.js";
import { cachedRepoIds, collectProgramFilesFromDisk, dropRepoLanguageService, getRepoLanguageService, isProgramFile } from "./languageServiceHost.js";

/**
 * R3 exact on small real programs: the classifier, the per-declaration grouping (homonyms), the Zod
 * parse pass (a write `findReferences` cannot see) and the cap. Zod is the server's own install,
 * linked into the fixture, so `z.infer` and `.parse(unknown)` behave as in a real repo.
 */

// ── classifier (pure syntax) ────────────────────────────────────────────────

function classifyAt(source: string, marker: string): string {
  const sf = ts.createSourceFile("x.ts", source, ts.ScriptTarget.Latest, true);
  const pos = source.indexOf(marker);
  assert.ok(pos >= 0, `marker ${marker} not in source`);
  const c = classify(sf, pos);
  return `${c.kind}:${c.how}`;
}

test("classify: definitions, writes and reads by syntax", () => {
  assert.equal(classifyAt("const s = z.object({ fld: z.string() });", "fld"), "DEFINITION:zod-shape-key");
  assert.equal(classifyAt("interface T { fld: string }", "fld"), "DEFINITION:property-signature");
  assert.equal(classifyAt("const o: T = { fld: 'x' };", "fld"), "WRITE:object-literal-key (construction)");
  assert.equal(classifyAt("o.fld = 'y';", "fld"), "WRITE:assignment");
  assert.equal(classifyAt("o.fld += 'y';", "fld"), "WRITE:compound-assignment");
  assert.equal(classifyAt("o.cnt++;", "cnt"), "WRITE:increment");
  assert.equal(classifyAt("({ fld: a } = o);", "fld"), "WRITE:destructuring-assignment-target");
  assert.equal(classifyAt("const { fld } = o;", "fld"), "READ:destructuring (binding element)");
  assert.equal(classifyAt("use(o.fld);", "fld"), "READ:property-access");
  assert.equal(classifyAt("use(o['fld']);", "fld"), "READ:element-access (literal key)");
});

// ── fixture ──────────────────────────────────────────────────────────────────

const zodDir = path.dirname(createRequire(import.meta.url).resolve("zod/package.json"));

function writeFixture(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cim-r3-"));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  fs.mkdirSync(path.join(dir, "node_modules"), { recursive: true });
  fs.symlinkSync(zodDir, path.join(dir, "node_modules", "zod"), "junction");
  return dir;
}

const FILES: Record<string, string> = {
  "tsconfig.json": JSON.stringify({ compilerOptions: { target: "es2022", module: "nodenext", moduleResolution: "nodenext", strict: true, types: [] } }),
  "package.json": JSON.stringify({ name: "fx", type: "module" }),
  "src/contract.ts": `import { z } from "zod";
const common_fields = {
  audit_id: z.string(),
  kb_ids: z.array(z.string()),
};
export const audit_schema = z.object({
  ...common_fields,
  kind: z.literal("turn"),
});
export type Audit = z.infer<typeof audit_schema>;
`,
  "src/writer.ts": `import { audit_schema } from "./contract.js";
export function buildAudit(ids: string[]) {
  return audit_schema.parse({
    audit_id: "a1",
    kb_ids: ids,
    kind: "turn",
  });
}
export function buildFromVariable(ids: string[]) {
  const line = { audit_id: "a2", kb_ids: ids, kind: "turn" };
  return audit_schema.parse(line);
}
export function relay(input: unknown) {
  return audit_schema.parse(input);
}
`,
  "src/reader.ts": `import type { Audit } from "./contract.js";
export function count(a: Audit): number {
  return a.kb_ids.length;
}
export function firstId(a: Audit): string | undefined {
  const { kb_ids } = a;
  return kb_ids[0];
}
export function dynamic(a: Audit, key: keyof Audit): unknown {
  return a[key];
}
`,
  "src/homonyms.ts": `export interface Reply { kb_ids: string[] }
export function kb_ids(r: Reply): string[] { return r.kb_ids; }
`,
  "src/View.vue": `<template><div>{{ entry.kb_ids }}</div></template>\n`
};

function ok(a: FieldAnswer): Extract<FieldAnswer, { status: "ok" }> {
  assert.equal(a.status, "ok", JSON.stringify(a).slice(0, 600));
  return a as Extract<FieldAnswer, { status: "ok" }>;
}

test("findFieldReferences: per-declaration answer with the Zod parse pass, gaps and homonyms", () => {
  const dir = writeFixture(FILES);
  const repoId = `r3-unit-${String(Date.now())}`;
  try {
    const files = collectProgramFilesFromDisk(dir);
    assert.ok(files.every(isProgramFile) && !files.some((f) => f.includes("node_modules")), files.join(","));
    const svc = getRepoLanguageService({ repoId, repoPath: dir, runKey: "r1", relativeFiles: files });

    // Two property-like declarations share the name: the contract key and Reply.kb_ids.
    const first = findFieldReferences(svc, "kb_ids");
    assert.equal(first.status, "ambiguous");
    assert.ok(first.status === "ambiguous" && first.candidates.length === 2, JSON.stringify(first));
    assert.ok(first.meta.cold && first.meta.programFiles > 0);
    // The function of the same name is a named non-match, not a candidate.
    assert.deepEqual(first.nonMatches.map((n) => `${n.file}:${n.kind}`), ["src/homonyms.ts:function"]);

    const answer = ok(findFieldReferences(svc, "kb_ids", { ownerName: "audit_schema" }));
    assert.equal(answer.meta.cold, false, "second call is warm");
    assert.equal(answer.selected.declarationKind, "zod-field-bag");
    assert.deepEqual(answer.selected.spreadInto, ["audit_schema"]);
    const at = (kind: string): string[] => answer.sites.filter((s) => s.kind === kind).map((s) => `${s.file}:${String(s.line)}`);
    assert.deepEqual(at("DEFINITION").slice(0, 1), ["src/contract.ts:4"]);
    assert.deepEqual(at("WRITE"), ["src/writer.ts:5", "src/writer.ts:10"], "both parse writes: literal and variable initializer");
    assert.ok(answer.sites.filter((s) => s.kind === "WRITE").every((s) => s.viaParse));
    assert.deepEqual(at("READ"), ["src/reader.ts:3", "src/reader.ts:6"], "property access and destructuring through z.infer");
    assert.ok(!answer.sites.some((s) => s.file === "src/homonyms.ts"), "Reply.kb_ids is another field");

    const gapAt = answer.gaps.map((g) => `${g.file}:${String(g.line)}`);
    assert.ok(gapAt.includes("src/writer.ts:14"), `parse(param) is a named gap: ${gapAt.join(",")}`);
    assert.ok(gapAt.includes("src/reader.ts:10"), `a[key] is a named gap: ${gapAt.join(",")}`);
    assert.ok(gapAt.includes("src/View.vue:1"), `.vue mention is a named gap: ${gapAt.join(",")}`);

    // Pick by file + line selects the homonym interface instead.
    const reply = ok(findFieldReferences(svc, "kb_ids", { declarationFile: "src/homonyms.ts", declarationLine: 1 }));
    assert.equal(reply.selected.ownerName, "Reply");
    assert.deepEqual(reply.sites.filter((s) => s.kind === "READ").map((s) => s.line), [2]);

    // A pick that matches nothing says so.
    assert.equal(findFieldReferences(svc, "kb_ids", { ownerName: "Nope" }).status, "pick_not_found");
  } finally {
    dropRepoLanguageService(repoId);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("findFieldReferences: a cap breach withholds the answer", () => {
  const dir = writeFixture(FILES);
  const repoId = `r3-cap-${String(Date.now())}`;
  try {
    const svc = getRepoLanguageService({ repoId, repoPath: dir, runKey: "r1", relativeFiles: collectProgramFilesFromDisk(dir) });
    const breach = findFieldReferences(svc, "kb_ids", { ownerName: "audit_schema" }, { budgetMs: 1, maxRssMb: 100_000 });
    assert.equal(breach.status, "cap_breach");
    assert.ok(breach.status === "cap_breach" && breach.breach.kind === "time");
    assert.ok(!("sites" in breach), "no partial list");
    const memory = findFieldReferences(svc, "kb_ids", { ownerName: "audit_schema" }, { budgetMs: 60_000, maxRssMb: 1 });
    assert.ok(memory.status === "cap_breach" && memory.breach.kind === "memory");
    assert.ok(!cachedRepoIds().includes(repoId), "a memory breach drops the host");
  } finally {
    dropRepoLanguageService(repoId);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("getRepoLanguageService: LRU of two, refreshed in place on a new run", () => {
  const ids = ["lru-a", "lru-b", "lru-c"].map((x) => `${x}-${String(Date.now())}`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cim-r3-lru-"));
  try {
    fs.writeFileSync(path.join(dir, "a.ts"), "export const a = 1;\n");
    const first = getRepoLanguageService({ repoId: ids[0]!, repoPath: dir, runKey: "1", relativeFiles: ["a.ts"] });
    assert.equal(getRepoLanguageService({ repoId: ids[0]!, repoPath: dir, runKey: "2", relativeFiles: ["a.ts"] }), first, "same host, refreshed");
    assert.equal(first.runKey, "2");
    getRepoLanguageService({ repoId: ids[1]!, repoPath: dir, runKey: "1", relativeFiles: ["a.ts"] });
    getRepoLanguageService({ repoId: ids[2]!, repoPath: dir, runKey: "1", relativeFiles: ["a.ts"] });
    const cached = cachedRepoIds();
    assert.ok(!cached.includes(ids[0]!) && cached.includes(ids[1]!) && cached.includes(ids[2]!), cached.join(","));
  } finally {
    ids.forEach(dropRepoLanguageService);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
