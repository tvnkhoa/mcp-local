/**
 * eval-graph.mjs
 * Evaluates the quality of the indexed graph in mcp-local-index.db.
 * Run AFTER index-self.mjs:
 *   node scripts/eval-graph.mjs
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.resolve(__dirname, "../mcp-local-index.db");
const repoId = "mcp-local";

const PASS = "PASS";
const WARN = "WARN";
const FAIL = "FAIL";

function badge(status) {
  return status === PASS ? "✅ PASS" : status === WARN ? "⚠️  WARN" : "❌ FAIL";
}

function section(title) {
  console.log(`\n${"─".repeat(60)}`);
  console.log(`  ${title}`);
  console.log("─".repeat(60));
}

const db = new Database(dbPath, { readonly: true });

// ── 1. File coverage ─────────────────────────────────────────
section("1. File Coverage by Language");
const fileLangs = db.prepare(`
  SELECT language, count(*) as cnt
  FROM files
  WHERE repo_id = ?
  GROUP BY language
  ORDER BY cnt DESC
`).all(repoId);

const totalFiles = fileLangs.reduce((s, r) => s + r.cnt, 0);
console.log(`  Total files indexed: ${totalFiles}`);
for (const r of fileLangs) {
  console.log(`  ${String(r.language ?? "null").padEnd(15)} ${r.cnt}`);
}
const fileStatus = totalFiles > 0 ? PASS : FAIL;
console.log(`\n  ${badge(fileStatus)} files indexed: ${totalFiles}`);

// ── 2. Symbol coverage ───────────────────────────────────────
section("2. Symbol Coverage");
const totalSymbols = db.prepare(`SELECT count(*) as cnt FROM symbols WHERE repo_id = ?`).get(repoId).cnt;
const moduleSymbols = db.prepare(`SELECT count(*) as cnt FROM symbols WHERE repo_id = ? AND kind = 'module'`).get(repoId).cnt;
const nonModuleSymbols = totalSymbols - moduleSymbols;
const coverageRatio = totalSymbols > 0 ? nonModuleSymbols / totalSymbols : 0;

console.log(`  Total symbols      : ${totalSymbols}`);
console.log(`  Module nodes       : ${moduleSymbols}`);
console.log(`  Non-module symbols : ${nonModuleSymbols}`);
console.log(`  Coverage ratio     : ${(coverageRatio * 100).toFixed(1)}%`);

const symStatus = coverageRatio >= 0.30 ? PASS : coverageRatio >= 0.10 ? WARN : FAIL;
console.log(`\n  ${badge(symStatus)} non-module ratio ${(coverageRatio * 100).toFixed(1)}% (threshold: ≥30%=PASS, ≥10%=WARN)`);

// ── 3. Edge type breakdown ───────────────────────────────────
section("3. Edge Type Breakdown");
const edgeTypes = db.prepare(`
  SELECT type, count(*) as cnt
  FROM edges
  WHERE repo_id = ?
  GROUP BY type
  ORDER BY cnt DESC
`).all(repoId);

const totalEdges = edgeTypes.reduce((s, r) => s + r.cnt, 0);
for (const r of edgeTypes) {
  console.log(`  ${r.type.padEnd(15)} ${r.cnt}`);
}

const edgeStatus = totalEdges > 0 ? PASS : FAIL;
console.log(`\n  ${badge(edgeStatus)} total edges: ${totalEdges}`);

// ── 4. Blank zones (files with only module symbol) ───────────
section("4. Blank Zones (files with 0 non-module symbols)");
const blankFiles = db.prepare(`
  SELECT s.file_path
  FROM symbols s
  WHERE s.repo_id = ?
  GROUP BY s.file_path
  HAVING count(*) = 1 AND max(s.kind) = 'module'
  ORDER BY s.file_path
  LIMIT 20
`).all(repoId);

const blankCount = db.prepare(`
  SELECT count(*) as cnt FROM (
    SELECT file_path FROM symbols WHERE repo_id = ?
    GROUP BY file_path
    HAVING count(*) = 1 AND max(kind) = 'module'
  )
`).get(repoId).cnt;

console.log(`  Blank zone files: ${blankCount} (showing up to 20)`);
for (const r of blankFiles) {
  console.log(`  - ${r.file_path}`);
}
const blankRatio = totalFiles > 0 ? blankCount / totalFiles : 0;
const blankStatus = blankRatio <= 0.4 ? PASS : blankRatio <= 0.7 ? WARN : FAIL;
console.log(`\n  ${badge(blankStatus)} blank ratio ${(blankRatio * 100).toFixed(1)}% (threshold: ≤40%=PASS, ≤70%=WARN)`);

// ── 5. Top files by edge count ───────────────────────────────
section("5. Top 5 Files by Edge Count");
const topFiles = db.prepare(`
  SELECT s.file_path, count(e.from_id) as edge_cnt
  FROM symbols s
  LEFT JOIN edges e ON e.repo_id = s.repo_id AND e.from_id = s.symbol_id
  WHERE s.repo_id = ?
  GROUP BY s.file_path
  ORDER BY edge_cnt DESC
  LIMIT 5
`).all(repoId);

for (const r of topFiles) {
  console.log(`  ${String(r.edge_cnt).padStart(4)} edges  ${r.file_path}`);
}

// ── 6. FTS5 search quality ───────────────────────────────────
section("6. FTS5 Search Quality");
const testQueries = ["GraphStore", "shouldIndexFile", "runIndexPipeline", "extractGraphData"];

let ftsPass = 0;
let ftsTotal = testQueries.length;

for (const q of testQueries) {
  let results = [];
  try {
    results = db.prepare(`
      SELECT s.name, s.kind, s.file_path
      FROM symbols_fts fts
      INNER JOIN symbols s ON s.rowid = fts.rowid
      WHERE fts.name MATCH ? AND s.repo_id = ?
      ORDER BY rank
      LIMIT 5
    `).all(`"${q.replace(/"/g, '""')}"*`, repoId);
  } catch {
    // FTS not populated
  }

  const status = results.length > 0 ? PASS : FAIL;
  if (results.length > 0) ftsPass++;
  console.log(`  ${badge(status)} match "${q}" → ${results.length} result(s)`);
  for (const r of results.slice(0, 3)) {
    console.log(`           ${r.name} (${r.kind}) @ ${r.file_path}`);
  }
}

const ftsStatus = ftsPass === ftsTotal ? PASS : ftsPass > 0 ? WARN : FAIL;
console.log(`\n  ${badge(ftsStatus)} FTS5: ${ftsPass}/${ftsTotal} queries returned results`);

// ── 7. cross_repo_deps ───────────────────────────────────────
section("7. Cross-repo Dependencies");
const crossCount = db.prepare(`SELECT count(*) as cnt FROM cross_repo_deps WHERE from_repo_id = ?`).get(repoId).cnt;
const crossStatus = crossCount > 0 ? PASS : WARN;
console.log(`  cross_repo_deps rows: ${crossCount}`);
console.log(`\n  ${badge(crossStatus)} cross-repo links (WARN=0 rows, expected if only 1 repo indexed)`);

// ── 8. Resolved edge sample ──────────────────────────────────
section("8. Resolved Edge Sample (get_file_context simulation)");
const sampleFile = db.prepare(`
  SELECT file_path FROM symbols
  WHERE repo_id = ? AND kind != 'module'
  GROUP BY file_path
  ORDER BY count(*) DESC
  LIMIT 1
`).get(repoId);

if (sampleFile) {
  const sampleEdges = db.prepare(`
    SELECT
      e.from_id,
      sf.name as from_name,
      e.to_id,
      st.name as to_name,
      e.type
    FROM symbols s
    INNER JOIN edges e ON e.repo_id = s.repo_id AND e.from_id = s.symbol_id
    LEFT JOIN symbols sf ON sf.repo_id = e.repo_id AND sf.symbol_id = e.from_id
    LEFT JOIN symbols st ON st.repo_id = e.repo_id AND st.symbol_id = e.to_id
    WHERE s.repo_id = ? AND s.file_path = ?
    LIMIT 8
  `).all(repoId, sampleFile.file_path);

  console.log(`  File: ${sampleFile.file_path}`);
  console.log(`  Edges (${sampleEdges.length}):`);
  for (const e of sampleEdges) {
    const fromLabel = e.from_name ?? `[${e.from_id.slice(0, 8)}...]`;
    const toLabel = e.to_name ?? `[unresolved:${e.to_id.slice(0, 8)}...]`;
    console.log(`    ${fromLabel.padEnd(30)} --[${e.type}]--> ${toLabel}`);
  }

  const resolvedCount = sampleEdges.filter((e) => e.to_name !== null).length;
  const resolveRatio = sampleEdges.length > 0 ? resolvedCount / sampleEdges.length : 0;
  const resolveStatus = resolveRatio >= 0.5 ? PASS : resolveRatio > 0 ? WARN : FAIL;
  console.log(`\n  ${badge(resolveStatus)} edge name resolution: ${resolvedCount}/${sampleEdges.length} (${(resolveRatio * 100).toFixed(0)}%)`);
} else {
  console.log("  No non-module symbols found — skipping edge sample");
}

// ── Summary ──────────────────────────────────────────────────
section("SUMMARY");
const checks = [
  ["File coverage", fileStatus],
  ["Symbol coverage ≥30%", symStatus],
  ["Edge count > 0", edgeStatus],
  ["Blank zones ≤40%", blankStatus],
  ["FTS5 search quality", ftsStatus],
];

for (const [label, status] of checks) {
  console.log(`  ${badge(status).padEnd(12)} ${label}`);
}

const failCount = checks.filter(([, s]) => s === FAIL).length;
const warnCount = checks.filter(([, s]) => s === WARN).length;
console.log(`\n  ${failCount} FAIL | ${warnCount} WARN | ${checks.length - failCount - warnCount} PASS`);

db.close();

if (failCount > 0) {
  process.exit(1);
}
