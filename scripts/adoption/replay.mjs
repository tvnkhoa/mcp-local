// Value replay: does ONE codebase-index call answer what an agent grepped for?
//
//   node scripts/adoption/replay.mjs freeze <transcriptsDir> <repoPath> [--force]
//   node scripts/adoption/replay.mjs run <repoId> [--db <graph.db>]
//
// `freeze` draws ~50 real grep patterns from the transcripts, weighted by what agents searched for
// most (the ranks from mine-patterns.mjs), and writes replay-sample.json beside this file. The sample
// is frozen on purpose: every release report compares against the same patterns.
//
// `run` replays each pattern against the BUILT server modules (codebase-index-mcp/dist) and a git
// grep-equivalent baseline over the repo's tracked files, then prints the hit rate per rank.
//   - code-shaped patterns: one `search_regex` call; a hit when it returns >= 90% of the files the
//     baseline finds.
//   - doc-shaped patterns (markdown structure, citations, prose): the same, OR one `query_docs`
//     search whose top 5 include a file the baseline finds.
// No MCP transport is involved, so this measures the tools, not the host. Needs `npm run build` in
// codebase-index-mcp first.
//
//   node scripts/adoption/replay.mjs perf-shapes <transcriptsDir>
//   node scripts/adoption/replay.mjs perf <repoId> [--repeats 5] [--out <prefix>] [--via stdio,handler]
//                                     [--max <n> | --only <id,id>] [--work-dir <dir>] [--reuse-index]
//   node scripts/adoption/replay.mjs perf-compare <runA.json> <runB.json>
//
// ── perf: grep vs MCP — METHODOLOGY, FROZEN (release I7). Change it only with a new baseline. ──────
// Every frozen pattern (replay-sample.json, ids 1..51 in file order) is run both ways.
//
// GREP SIDE — what an agent runs, over the TRACKED files of the sample's repoPath:
//   `git grep <-n|-l> -I -P -e <pattern>` (git grep, not rg; PCRE, so \b \s \d read as the replay's JS
//   regex reads them; grep's BRE `\|` is translated to `|` exactly as the replay's toJsRegex does;
//   -I skips binaries). Follow-up rule, applied mechanically by rank class:
//     - doc ranks (docs: true → r2 markdown/citations, r4 prose): `git grep -n`, then ONE region read
//       of the first hit, `sed -n 'L,L+29p' <file>` (Git for Windows' usr/bin/sed). 2 commands when
//       there is a hit, 1 when there is none.
//     - every other rank: the output shape the pattern was ORIGINALLY asked with, frozen in
//       replay-perf-shapes.json (`perf-shapes` derives it once from the transcripts: Grep tool
//       files_with_matches/count or grep/rg -l/-c → "files" → `git grep -l`; else "lines" →
//       `git grep -n`; majority vote over the pattern's invocations, a tie is "lines"). 1 command.
//   Timing: one discarded pass first (warms the filesystem cache), then `repeats` timed passes of the
//   whole sequence, each command spawned (spawnSync) and wall-clocked; the pattern's number is the
//   median. Output = the raw stdout bytes of every command in the sequence, summed.
//
// MCP SIDE — the one call `run` makes: search_regex { pattern, limit 500, contextLines 0,
//   outputMode "files" } (default profile: compact). For doc ranks the `query_docs` search `run` also
//   credits is measured beside it (warm only) and reported under `docs`; it is not added to the MCP
//   time/tokens, and MCP calls stay 1. Output = the JSON text the call returns.
//   Two lanes over the same index DB:
//     - stdio — THE HEADLINE: the BUILT server (codebase-index-mcp/dist/index.js) spawned over stdio
//       with the MCP SDK client. The R1 freshness gate applies, so this is what an agent gets.
//       COLD = the first tools/call after spawn + initialize, one fresh server per pattern (spawn and
//       handshake reported apart as coldStartupMs). WARM = one server for the whole run: one
//       discarded call per pattern, then `repeats` timed calls; median.
//     - handler — A DIAGNOSTIC, labelled "handler only (no freshness gate)": the built handler module
//       called in-process through the server's own zod schema and serializer. COLD = the call in a
//       fresh child node process (import + DB open excluded; process wall = coldProcessMs). WARM as
//       above.
//   Index: a temp DB (--work-dir, default <os tmp>/codebase-index-perf/<repoId>) holding ONLY the repo,
//   built at the start of every run by the built server (index_repository mode full, docsMode on;
//   --reuse-index skips the rebuild). perf never opens the central DB.
//   Server env: CODEBASE_INDEX_DB_PATH=<temp db>, CODEBASE_INDEX_ALLOWED_ROOTS=<repoPath>, watch
//   auto-start off, telemetry off, GIT_OPTIONAL_LOCKS=0; CODEBASE_INDEX_QUERY_REFRESH_ENABLED /
//   _QUERY_REFRESH_BUDGET_MS / _PERFORMANCE_PROFILE / _MAX_LIMIT pass through from the caller's
//   environment and are recorded in the result.
//
// SIZE: tokens ≈ ceil(bytes / 4) on both sides — an estimate, not a tokenizer.
// CALLS: MCP 1; grep = the commands in the sequence (1 or 2).
// COMPLETENESS: recall vs the grep-equivalent baseline exactly as `run` computes it (hit = recall
//   >= 0.9, or for doc ranks a query_docs top-5 file in the baseline). "+context" is set when any MCP
//   row carries a field grep cannot produce: enclosingSymbol, section / sectionTitle / heading /
//   headingPath / breadcrumb, target / resolvedTarget / resolvedPath (perf-lib CONTEXT_FIELDS).
// WINS: per pattern, score = log2(grep ms / MCP warm ms) + log2((grep tok + 1) / (MCP tok + 1))
//   − 2 if the MCP call misses + 1 if +context; the 5 lowest are grep's clearest wins, the 5 highest
//   MCP's, each with the components that decided it.
// STATISTICS: median and p90 by linear interpolation, over the per-pattern medians.
// TREE + LOAD: HEAD and the dirty-file count (`git status --porcelain`, GIT_OPTIONAL_LOCKS=0) are
//   recorded at start and end. The script NEVER changes the repo to make it clean or dirty: whoever
//   runs it states the tree state. CPU busy % (2 s os.cpus sample), Win32 LoadPercentage and the six
//   busiest processes are recorded at start and end. Run on an otherwise quiet machine.
// STABILITY: run perf twice and compare with `perf-compare`; a re-run's medians should land within
//   ±20% of the reference run's.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { cls, collectInvocations, collectPatterns } from './mine-patterns.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const SAMPLE_FILE = path.join(HERE, 'replay-sample.json');
const DIST = path.join(ROOT, 'codebase-index-mcp', 'dist');
const DEFAULT_DB = path.join(ROOT, 'mcp-local-index-central.db');

// Rank → (classes from mine-patterns `cls`, how many patterns to draw). Order is priority: a pattern
// that fits several classes is filed under the first rank that claims it.
const RANKS = [
  { rank: 1, name: 'snake_case names', classes: ['snake_case name (docs/10 / contracts field)'], take: 13, docs: false },
  { rank: 2, name: 'markdown structure + citations', classes: ['citation (docs/15 #N, adr, SPEC, 09 #)', 'markdown structure (heading, **Status**, §, table row)'], take: 9, docs: true },
  { rank: 3, name: 'code identifiers', classes: ['PascalCase type / component', 'import / export', 'definition site (^export / ^const / ^function)', 'camelCase identifier', 'multi-alternative regex (3+ terms)'], take: 16, docs: false },
  { rank: 4, name: 'English prose', classes: ['English prose phrase (doc sentence)'], take: 4, docs: true },
  { rank: 5, name: 'CSS + Vue', classes: ['CSS token / class / style', 'Vue template / component'], take: 5, docs: false },
  { rank: 6, name: 'routes + board/json state', classes: ['route / endpoint', 'board / json state'], take: 4, docs: false },
  { rank: 7, name: 'test names', classes: ['test name'], take: 1, docs: false }
];

const MAX_BYTES = 4_000_000;

function trackedTextFiles(repoPath) {
  const out = execFileSync('git', ['-C', repoPath, 'ls-files', '-z'], { maxBuffer: 64 * 1024 * 1024 }).toString('utf8');
  const files = [];
  for (const rel of out.split('\0').filter(Boolean)) {
    const abs = path.join(repoPath, rel);
    let buf;
    try {
      if (fs.statSync(abs).size > MAX_BYTES) continue;
      buf = fs.readFileSync(abs);
    } catch { continue; }
    if (buf.subarray(0, 512).includes(0)) continue;
    files.push({ rel: rel.replace(/\\/g, '/'), text: buf.toString('utf8') });
  }
  return files;
}

/**
 * Read as ripgrep / the Grep tool read it (ERE-like: `\(` is a literal paren), except grep's BRE
 * alternation `\|`, which is translated. A pattern that is not valid JS is skipped.
 */
function toJsRegex(p) {
  const src = p.replace(/\\\|/g, '|');
  try { return new RegExp(src); } catch { return null; }
}

function baselineFiles(files, re) {
  return files.filter((f) => re.test(f.text)).map((f) => f.rel);
}

function rankOf(pattern) {
  const classes = cls(pattern);
  return RANKS.find((r) => r.classes.some((c) => classes.includes(c))) ?? null;
}

const stableKey = (s) => createHash('sha1').update(s).digest('hex');

function freeze(transcriptsDir, repoPath, force) {
  if (fs.existsSync(SAMPLE_FILE) && !force) throw new Error(`${SAMPLE_FILE} exists — the sample is frozen. Pass --force only to start a new baseline.`);
  const files = trackedTextFiles(repoPath);
  const seen = new Set();
  const byRank = new Map(RANKS.map((r) => [r.rank, []]));
  // Deterministic order: by hash, not by transcript order, so the draw is spread across sessions.
  const patterns = [...new Set(collectPatterns(transcriptsDir))].sort((a, b) => (stableKey(a) < stableKey(b) ? -1 : 1));
  for (const p of patterns) {
    if (p.length < 3 || p.length > 120 || seen.has(p)) continue;
    const r = rankOf(p);
    if (!r) continue;
    const bucket = byRank.get(r.rank);
    if (bucket.length >= r.take) continue;
    const re = toJsRegex(p);
    if (!re) continue;
    const hits = baselineFiles(files, re);
    if (hits.length === 0) continue; // only patterns that still mean something at this HEAD
    seen.add(p);
    bucket.push({ rank: r.rank, pattern: p, baselineFilesAtFreeze: hits.length });
  }
  const head = execFileSync('git', ['-C', repoPath, 'rev-parse', '--short=12', 'HEAD']).toString().trim();
  const sample = {
    frozenAt: new Date().toISOString().slice(0, 10),
    repoPath: repoPath.replace(/\\/g, '/'),
    repoHead: head,
    ranks: RANKS.map(({ rank, name, take, docs }) => ({ rank, name, take, docs })),
    patterns: RANKS.flatMap((r) => byRank.get(r.rank))
  };
  fs.writeFileSync(SAMPLE_FILE, JSON.stringify(sample, null, 1) + '\n');
  console.log(`froze ${sample.patterns.length} patterns at ${head}: ` + RANKS.map((r) => `r${r.rank}=${byRank.get(r.rank).length}/${r.take}`).join(' '));
}

/**
 * Freeze the output shape each sample pattern was originally asked with (`outputShapeOf` in
 * mine-patterns.mjs) into replay-perf-shapes.json: majority vote over its invocations, tie = "lines".
 */
function perfShapes(transcriptsDir) {
  const sample = JSON.parse(fs.readFileSync(SAMPLE_FILE, 'utf8'));
  const inv = collectInvocations(transcriptsDir);
  const shapes = {};
  for (const p of sample.patterns) {
    const v = inv.filter((x) => x.pattern === p.pattern);
    const files = v.filter((x) => x.shape === 'files').length;
    shapes[p.pattern] = { shape: files * 2 > v.length ? 'files' : 'lines', files, invocations: v.length };
  }
  const out = { derivedAt: new Date().toISOString().slice(0, 10), transcripts: path.basename(transcriptsDir), rule: 'majority of invocations asked for files (Grep files_with_matches/count, grep/rg -l/-c); tie = lines', shapes };
  fs.writeFileSync(path.join(HERE, 'replay-perf-shapes.json'), JSON.stringify(out, null, 1) + '\n');
  const n = Object.values(shapes).filter((x) => x.shape === 'files').length;
  console.log(`froze shapes for ${sample.patterns.length} patterns: ${n} files, ${sample.patterns.length - n} lines`);
}

function docsQueryOf(p) {
  return p.replace(/\\[bswdBSWD]/g, ' ').replace(/[\^$.*+?()[\]{}|\\#>`]/g, ' ').replace(/\s+/g, ' ').trim();
}

async function run(repoId, dbPath) {
  const sample = JSON.parse(fs.readFileSync(SAMPLE_FILE, 'utf8'));
  const { GraphStore } = await import(pathToFileURL(path.join(DIST, 'repositories/graphStore.js')).href);
  const { handleQueryDocs } = await import(pathToFileURL(path.join(DIST, 'tools/handlers/impactHandler.js')).href);
  const store = new GraphStore(dbPath);
  const repo = store.getRepository(repoId);
  if (!repo) throw new Error(`unknown repoId ${repoId}`);
  const files = trackedTextFiles(repo.repoPath);
  const ctx = { store, constants: { DOCS_TOOLS_ENABLED: true }, asText: (p) => ({ content: [{ type: 'text', text: JSON.stringify(p) }] }) };

  const rows = [];
  for (const s of sample.patterns) {
    const rank = sample.ranks.find((r) => r.rank === s.rank);
    const re = toJsRegex(s.pattern);
    const base = new Set(baselineFiles(files, re));
    let regexFiles = new Set();
    let regexError = null;
    let truncated = false;
    try {
      // The one call an agent asking "which files" should make: outputMode "files" (release B). A
      // build without it (release A) ignores the option and answers with match rows, capped at 500.
      const res = store.searchRegex(repoId, { pattern: re.source, limit: 500, contextLines: 0, outputMode: 'files' });
      regexFiles = new Set((res.files ?? res.matches).map((m) => m.filePath.replace(/\\/g, '/')));
      truncated = Boolean(res.truncated);
    } catch (e) { regexError = String(e.message ?? e).slice(0, 120); }
    const covered = [...base].filter((f) => regexFiles.has(f)).length;
    const recall = base.size === 0 ? 1 : covered / base.size;
    let docsHit = null;
    if (rank.docs) {
      const q = docsQueryOf(s.pattern);
      if (q.length >= 2) {
        try {
          // handleQueryDocs is async since release I1; reading .content synchronously threw, and the catch
          // below scored every doc-rank pattern as a docs miss.
          const r = JSON.parse((await handleQueryDocs({ repoId, mode: 'search', query: q.slice(0, 200), limit: 5, includeSymbols: false, includeCodeMentions: false, profile: 'compact' }, ctx)).content[0].text);
          docsHit = (r.results ?? []).some((x) => base.has(String(x.filePath).replace(/\\/g, '/')));
        } catch { docsHit = false; }
      }
    }
    const hit = recall >= 0.9 || docsHit === true;
    const missed = [...base].filter((f) => !regexFiles.has(f));
    const missedExt = [...new Set(missed.map((f) => path.extname(f) || path.basename(f)))].slice(0, 6);
    // Why a miss missed: the one call hit its result cap, or the files are not in the index at all.
    const why = hit ? null : truncated ? 'result_cap' : 'not_indexed';
    rows.push({ rank: s.rank, pattern: s.pattern, baselineFiles: base.size, recall: Number(recall.toFixed(2)), docsHit, hit, ...(why && { why }), ...(missedExt.length && { missedExt }), ...(regexError && { regexError }) });
  }
  store.close();

  const head = execFileSync('git', ['-C', repo.repoPath, 'rev-parse', '--short=12', 'HEAD']).toString().trim();
  console.log(`replay ${repoId} @ ${head} — sample frozen ${sample.frozenAt} @ ${sample.repoHead}, ${rows.length} patterns`);
  let hits = 0;
  for (const r of sample.ranks) {
    const rs = rows.filter((x) => x.rank === r.rank);
    const h = rs.filter((x) => x.hit).length;
    hits += h;
    console.log(`  rank ${r.rank} ${r.name.padEnd(32)} ${String(h).padStart(2)}/${rs.length}`);
  }
  console.log(`  total ${' '.repeat(34)}${String(hits).padStart(2)}/${rows.length}`);
  const by = (w) => rows.filter((x) => x.why === w).length;
  console.log(`  misses: ${by('not_indexed')} not_indexed (files outside the index), ${by('result_cap')} result_cap (one call's 500-match cap)`);
  if (process.argv.includes('--json')) console.log(JSON.stringify(rows, null, 1));
  else for (const r of rows.filter((x) => !x.hit)) console.log(`  miss r${r.rank} ${r.why} recall=${r.recall}${r.docsHit === false ? ' docs=no' : ''} ${JSON.stringify(r.pattern).slice(0, 70)}${r.missedExt ? ' missed ' + r.missedExt.join(',') : ''}`);
}

const [cmd, a, b] = process.argv.slice(2);
if (cmd === 'freeze') freeze(a, b, process.argv.includes('--force'));
else if (cmd === 'run') {
  const i = process.argv.indexOf('--db');
  await run(a, i > 0 ? process.argv[i + 1] : DEFAULT_DB);
} else if (cmd === 'perf-shapes') perfShapes(a);
else if (cmd === 'perf') {
  const { perf } = await import('./perf.mjs');
  const opt = (name, dflt) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : dflt; };
  const repeats = Number(opt('--repeats', '5'));
  if (!Number.isInteger(repeats) || repeats < 1) throw new Error('--repeats must be a positive integer');
  const via = opt('--via', 'stdio,handler').split(',').filter((v) => v === 'stdio' || v === 'handler');
  if (via.length === 0) throw new Error('--via takes stdio, handler or both');
  await perf({
    repoId: a, sample: JSON.parse(fs.readFileSync(SAMPLE_FILE, 'utf8')), trackedTextFiles, baselineFiles, toJsRegex, repeats, via,
    outPrefix: opt('--out', null), maxN: Number(opt('--max', '0')) || null,
    only: opt('--only', null)?.split(',').map(Number) ?? null,
    workDir: opt('--work-dir', path.join(os.tmpdir(), 'codebase-index-perf', a)),
    reuseIndex: process.argv.includes('--reuse-index')
  });
} else if (cmd === 'perf-compare') {
  const { compare } = await import('./perf.mjs');
  compare(a, b);
} else {
  console.error('usage: replay.mjs freeze <transcriptsDir> <repoPath> [--force] | run <repoId> [--db <path>] [--json] | perf-shapes <transcriptsDir> | perf <repoId> [--repeats 5] [--out <prefix>] [--via stdio,handler] [--max n | --only ids] [--work-dir dir] [--reuse-index] | perf-compare <a.json> <b.json>');
  process.exit(2);
}
