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
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { cls, collectPatterns } from './mine-patterns.mjs';

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
      const res = store.searchRegex(repoId, { pattern: re.source, limit: 500, contextLines: 0 });
      regexFiles = new Set(res.matches.map((m) => m.filePath.replace(/\\/g, '/')));
      truncated = Boolean(res.truncated);
    } catch (e) { regexError = String(e.message ?? e).slice(0, 120); }
    const covered = [...base].filter((f) => regexFiles.has(f)).length;
    const recall = base.size === 0 ? 1 : covered / base.size;
    let docsHit = null;
    if (rank.docs) {
      const q = docsQueryOf(s.pattern);
      if (q.length >= 2) {
        try {
          const r = JSON.parse(handleQueryDocs({ repoId, mode: 'search', query: q.slice(0, 200), limit: 5, includeSymbols: false, includeCodeMentions: false, profile: 'compact' }, ctx).content[0].text);
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
} else {
  console.error('usage: replay.mjs freeze <transcriptsDir> <repoPath> [--force] | run <repoId> [--db <path>] [--json]');
  process.exit(2);
}
