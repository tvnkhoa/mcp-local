#!/usr/bin/env node
/**
 * docs-recall.mjs — the measurement MCP-ISSUE-061 Stage 0 asked for, built at Stage 4+.
 *
 * Two numbers, neither of which any existing measurement produces:
 *
 * 1. **Fixed session overhead.** `benchmark:plan:check` gates per-call token savings; the
 *    `mcp-effectiveness-eval` command compares baseline vs MCP per answer. Neither counts what a
 *    session pays before it asks anything — the tool listing plus the always-on policy files — so
 *    both can report success while the server is net-negative. This reports the tool listing at BOTH
 *    sizes, because the answer inverts between them: Claude Code defers tool schemas and sends names
 *    only (~425 tokens), while a client that requests full schemas sends ~11 000. A plan to shrink
 *    the tool surface is worth 2.8% of overhead in the first case and 43% in the second.
 *
 * 2. **Docs recall.** Whether `query_docs{mode:"search"}` actually finds a fact that lives in a
 *    document's body. Before Stage 4 this was 0 for every prose query, because the indexer stored no
 *    prose; the whole point of the stage was to move this number.
 *
 * Self-contained by design: it indexes the workspace's own markdown into an in-memory database, so
 * it needs no credentials, no pre-existing index and no network, and it means the same thing on a
 * fresh clone as it does here.
 *
 * NO-LLM CONSTRAINT: file reads, the project's own parser, SQLite FTS, and arithmetic.
 *
 *   node scripts/docs-recall.mjs            # report
 *   node scripts/docs-recall.mjs --json     # machine-readable
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

import { parseMarkdownFile } from "../dist/services/extractors/markdownParser.js";
import { initGraphSchema } from "../dist/repositories/schema.js";
import { replaceDocsForFileImpl, searchDocsImpl, rebuildDocsFtsImpl } from "../dist/repositories/docsStore.js";
import { buildFtsQuery, buildIntentFtsQuery } from "../dist/services/search/symbolSearchFts.js";
import { QUERY_SET } from "./docs-recall-queries.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE = path.resolve(HERE, "../..");
const TOKENS = (chars) => Math.round(chars / 4);

// ── fixed session overhead ───────────────────────────────────────────────────

/** Files a session loads before it asks anything. Always-on by the host's own rules. */
const POLICY_FILES = [
  "CLAUDE.md",
  ".claude/rules/mcp-hard-mode.md",
  ".claude/rules/mcp-base.md",
  ".claude/rules/codebase-index.md",
  ".claude/rules/db-guardrails.md",
  ".claude/rules/typescript-mcp.md"
];

function measureFixedCost() {
  const policy = [];
  let policyChars = 0;
  for (const rel of POLICY_FILES) {
    const abs = path.join(WORKSPACE, rel);
    if (!existsSync(abs)) continue;
    const chars = readFileSync(abs, "utf8").length;
    policy.push({ file: rel, chars, tokens: TOKENS(chars) });
    policyChars += chars;
  }

  // The contract snapshot IS the tools/list payload — captured from a real stdio boot by
  // `contracts:check`, so this reads the same bytes a client would receive rather than re-deriving
  // them. Reading it avoids booting a second server just to count characters.
  const snapshotPath = path.join(WORKSPACE, "contracts/codebase-index.json");
  let toolsFull = 0;
  let toolsNamesOnly = 0;
  let toolCount = 0;
  if (existsSync(snapshotPath)) {
    const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8"));
    const tools = snapshot.tools ?? [];
    toolCount = tools.length;
    toolsFull = JSON.stringify(tools).length;
    toolsNamesOnly = JSON.stringify(tools.map((t) => t.name)).length;
  }

  return {
    policy,
    policyChars,
    policyTokens: TOKENS(policyChars),
    toolCount,
    toolsFullTokens: TOKENS(toolsFull),
    toolsNamesOnlyTokens: TOKENS(toolsNamesOnly),
    // Deferred is what this workspace's host actually does. Both are reported because the
    // conclusion, and therefore which work is worth doing, differs between them.
    deferredTotalTokens: TOKENS(policyChars) + TOKENS(toolsNamesOnly),
    fullSchemaTotalTokens: TOKENS(policyChars) + TOKENS(toolsFull)
  };
}

// ── corpus ───────────────────────────────────────────────────────────────────

function walkMarkdown(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "dist") continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) walkMarkdown(abs, out);
    else if (entry.name.endsWith(".md")) out.push(abs);
  }
  return out;
}

function buildIndex() {
  const db = new Database(":memory:");
  initGraphSchema(db);
  const files = walkMarkdown(WORKSPACE);
  for (const abs of files) {
    const rel = path.relative(WORKSPACE, abs).split(path.sep).join("/");
    const parsed = parseMarkdownFile({ repoId: "bench", filePath: rel, source: readFileSync(abs, "utf8") });
    replaceDocsForFileImpl(db, "bench", rel, parsed.docs, parsed.mentions);
  }
  rebuildDocsFtsImpl(db);
  const byType = db
    .prepare("select content_type as t, count(*) c from docs where repo_id='bench' group by 1")
    .all();
  return { db, fileCount: files.length, byType };
}

// ── recall ───────────────────────────────────────────────────────────────────

const TOP_N = 5;

function runQuerySet(db) {
  const results = [];
  for (const q of QUERY_SET) {
    const rows = searchDocsImpl(db, "bench", q.query, TOP_N, buildFtsQuery, buildIntentFtsQuery, false, null, false);
    const paths = rows.map((r) => r.filePath.replace(/\\/g, "/"));
    // `expectFiles` is a SET for intent queries: these documents cross-reference deliberately, so
    // keying recall to one file would measure where I think an answer belongs rather than whether it
    // was found. A phrase query keeps a single expectation — it was generated from text occurring in
    // exactly one file.
    const expected = q.expectFiles ?? [q.expectFile];
    const rank = paths.findIndex((p) => expected.includes(p));
    results.push({
      id: q.id,
      kind: q.kind,
      query: q.query,
      expectFile: expected.join(" | "),
      hit: rank >= 0,
      rank: rank >= 0 ? rank + 1 : null,
      returned: rows.length,
      topFile: paths[0] ?? null,
      topType: rows[0]?.contentType ?? null
    });
  }
  return results;
}

function summarize(results) {
  const per = (kind) => {
    const set = kind ? results.filter((r) => r.kind === kind) : results;
    const hits = set.filter((r) => r.hit).length;
    return { total: set.length, hits, recall: set.length ? +(hits / set.length).toFixed(2) : 0 };
  };
  return { all: per(null), phrase: per("phrase"), intent: per("intent") };
}

// ── report ───────────────────────────────────────────────────────────────────

const asJson = process.argv.includes("--json");

const fixed = measureFixedCost();
const { db, fileCount, byType } = buildIndex();
const results = runQuerySet(db);
const summary = summarize(results);

if (asJson) {
  console.log(JSON.stringify({ fixed, corpus: { fileCount, byType }, summary, results }, null, 2));
  process.exit(0);
}

console.log("── fixed session overhead ──────────────────────────────────────────");
for (const p of fixed.policy) {
  console.log(`  ${p.file.padEnd(34)} ${String(p.chars).padStart(6)} ch  ~${String(p.tokens).padStart(5)} tok`);
}
console.log(`  ${"policy total".padEnd(34)} ${String(fixed.policyChars).padStart(6)} ch  ~${String(fixed.policyTokens).padStart(5)} tok`);
console.log("");
console.log(`  tool listing (${fixed.toolCount} tools)`);
console.log(`    names only, schemas deferred        ~${String(fixed.toolsNamesOnlyTokens).padStart(5)} tok   <- what this host sends`);
console.log(`    full schemas                        ~${String(fixed.toolsFullTokens).padStart(5)} tok`);
console.log("");
console.log(`  SESSION TOTAL, deferred schemas       ~${String(fixed.deferredTotalTokens).padStart(5)} tok`);
console.log(`  SESSION TOTAL, full schemas           ~${String(fixed.fullSchemaTotalTokens).padStart(5)} tok`);
const policyShare = Math.round((fixed.policyTokens / fixed.deferredTotalTokens) * 100);
console.log(`  policy files are ${policyShare}% of the deferred total — that is where the weight is.`);

console.log("");
console.log("── corpus ──────────────────────────────────────────────────────────");
console.log(`  ${fileCount} markdown files  ·  ` + byType.map((r) => `${r.t} ${r.c}`).join("  ·  "));

console.log("");
console.log(`── docs recall (expected file in top ${TOP_N}) ────────────────────────────`);
for (const r of results) {
  const mark = r.hit ? `hit @${r.rank}` : "MISS   ";
  console.log(`  ${r.id.padEnd(5)} ${mark}  ${r.query}`);
  if (!r.hit) {
    console.log(`        expected ${r.expectFile}`);
    console.log(`        top was  ${r.topFile ?? "(nothing returned)"}${r.topType ? ` [${r.topType}]` : ""}`);
  }
}
console.log("");
console.log(`  phrase queries : ${summary.phrase.hits}/${summary.phrase.total}  (recall ${summary.phrase.recall})`);
console.log(`  intent queries : ${summary.intent.hits}/${summary.intent.total}  (recall ${summary.intent.recall})`);
console.log(`  OVERALL        : ${summary.all.hits}/${summary.all.total}  (recall ${summary.all.recall})`);
console.log("");
console.log("  The plan's Stage 0 target was >=15/20. This is a report, not a gate — wire it into");
console.log("  verify:all only once the number is stable, or it will fail on every doc edit.");
