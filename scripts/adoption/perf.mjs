// `replay.mjs perf` — grep vs MCP time, output size, calls and completeness over the frozen sample.
// The methodology is frozen in replay.mjs's header; the pure parts live in perf-lib.mjs. This file
// also runs as a child (`--handler-child`) for the handler lane's cold number.
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  FOLLOW_UP_LINES, advantage, filesOfGrep, firstHit, grepPlan, hasExtraContext, median,
  recallOf, renderLaneTable, renderWins, round, summarize, toPcre, tokensOf, topWins
} from './perf-lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const SERVER_DIR = path.join(ROOT, 'codebase-index-mcp');
const DIST = path.join(SERVER_DIR, 'dist');
const SHAPES_FILE = path.join(HERE, 'replay-perf-shapes.json');
const SDK = path.join(SERVER_DIR, 'node_modules', '@modelcontextprotocol', 'sdk', 'dist', 'esm', 'client');
const MAX_LIMIT = 500;
const CALL_TIMEOUT_MS = 10 * 60_000;
const INDEX_TIMEOUT_MS = 60 * 60_000;
// git must never take optional locks (index stat refresh) in the measured repo: the run is read-only.
const GIT_ENV = { ...process.env, GIT_OPTIONAL_LOCKS: '0' };
// Server knobs a runner may set; recorded in the result, passed through to the stdio server.
const KNOBS = ['CODEBASE_INDEX_QUERY_REFRESH_ENABLED', 'CODEBASE_INDEX_QUERY_REFRESH_BUDGET_MS', 'CODEBASE_INDEX_PERFORMANCE_PROFILE', 'CODEBASE_INDEX_MAX_LIMIT'];

const now = () => Number(process.hrtime.bigint()) / 1e6;

// ── the two MCP calls, exactly as `replay.mjs run` makes them ────────────────────────────────────
export function docsQueryOf(p) {
  return p.replace(/\\[bswdBSWD]/g, ' ').replace(/[\^$.*+?()[\]{}|\\#>`]/g, ' ').replace(/\s+/g, ' ').trim();
}
const regexArgs = (repoId, pattern) => ({ repoId, pattern: new RegExp(pattern.replace(/\\\|/g, '|')).source, limit: MAX_LIMIT, contextLines: 0, outputMode: 'files' });
const docsArgs = (repoId, pattern) => ({ repoId, mode: 'search', query: docsQueryOf(pattern).slice(0, 200), limit: 5, includeSymbols: false, includeCodeMentions: false, profile: 'compact' });

// ── environment ──────────────────────────────────────────────────────────────────────────────────
function cpuBusyPct(sampleMs = 2000) {
  const snap = () => os.cpus().reduce((a, c) => { const t = Object.values(c.times).reduce((x, y) => x + y, 0); return { idle: a.idle + c.times.idle, total: a.total + t }; }, { idle: 0, total: 0 });
  const a = snap();
  const until = Date.now() + sampleMs;
  while (Date.now() < until) { /* busy-wait would skew it; sleep via Atomics instead */ Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100); }
  const b = snap();
  return round(100 * (1 - (b.idle - a.idle) / (b.total - a.total)), 1);
}

function sampleLoad(label) {
  const out = { label, at: new Date().toISOString(), cpuBusyPct: cpuBusyPct(), freeMemMb: Math.round(os.freemem() / 2 ** 20), totalMemMb: Math.round(os.totalmem() / 2 ** 20) };
  if (process.platform === 'win32') {
    const ps = (cmd) => {
      const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { encoding: 'utf8', timeout: 30_000 });
      return r.status === 0 ? r.stdout.trim() : null;
    };
    const lp = ps('(Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average');
    out.win32LoadPercentage = lp === null || lp === '' ? null : Number(lp);
    // Busiest processes right now (% of ONE core, 1 s sample), not cumulative CPU seconds.
    const top = ps("(Get-Counter '\\Process(*)\\% Processor Time' -SampleInterval 1 -MaxSamples 1).CounterSamples | Where-Object { $_.InstanceName -notin @('_total','idle') } | Sort-Object CookedValue -Descending | Select-Object -First 6 | ForEach-Object { $_.InstanceName + '=' + [math]::Round($_.CookedValue) }");
    out.topProcessesPctOfOneCore = top ? top.split(/\r?\n/).filter(Boolean) : null;
  } else out.loadavg = os.loadavg().map((v) => round(v, 2));
  return out;
}

function treeState(repoPath) {
  const head = execFileSync('git', ['-C', repoPath, 'rev-parse', 'HEAD'], { env: GIT_ENV }).toString().trim();
  const porcelain = execFileSync('git', ['-C', repoPath, 'status', '--porcelain'], { env: GIT_ENV, maxBuffer: 64 * 2 ** 20 }).toString();
  const dirty = porcelain.split('\n').filter(Boolean);
  return { head, dirtyFiles: dirty.length, state: dirty.length ? 'dirty' : 'clean', dirtySample: dirty.slice(0, 10) };
}

// ── grep lane ────────────────────────────────────────────────────────────────────────────────────
function sedPath() {
  const exec = execFileSync('git', ['--exec-path']).toString().trim(); // …/mingw64/libexec/git-core
  const gitSed = path.resolve(exec, '..', '..', '..', 'usr', 'bin', process.platform === 'win32' ? 'sed.exe' : 'sed');
  return fs.existsSync(gitSed) ? gitSed : 'sed';
}

function runCmd(file, args, cwd) {
  const t0 = now();
  const r = spawnSync(file, args, { cwd, env: GIT_ENV, maxBuffer: 512 * 2 ** 20 });
  const ms = now() - t0;
  return { ms, stdout: r.stdout ?? Buffer.alloc(0), status: r.status, stderr: String(r.stderr ?? '').slice(0, 200) };
}

/** One pass of the frozen grep sequence for a pattern. Returns the commands, total ms and stdout bytes. */
function grepPass(repoPath, plan, pattern, sed) {
  const list = runCmd('git', ['-C', repoPath, 'grep', plan.listFlag, '-I', '-P', '-e', toPcre(pattern)], repoPath);
  const cmds = [{ cmd: `git grep ${plan.listFlag} -I -P -e <pattern>`, ms: list.ms, bytes: list.stdout.length, status: list.status }];
  const text = list.stdout.toString('utf8');
  if (plan.followUp === 'region') {
    const hit = firstHit(text);
    if (hit) {
      const read = runCmd(sed, ['-n', `${hit.line},${hit.line + FOLLOW_UP_LINES - 1}p`, hit.file], repoPath);
      cmds.push({ cmd: `sed -n '${hit.line},${hit.line + FOLLOW_UP_LINES - 1}p' ${hit.file}`, ms: read.ms, bytes: read.stdout.length, status: read.status });
    }
  }
  return { cmds, ms: cmds.reduce((a, c) => a + c.ms, 0), bytes: cmds.reduce((a, c) => a + c.bytes, 0), listText: text, error: list.status > 1 ? list.stderr : null };
}

// ── stdio lane (the built server: the R1 freshness gate applies) ─────────────────────────────────
async function sdk() {
  const { Client } = await import(pathToFileURL(path.join(SDK, 'index.js')).href);
  const { StdioClientTransport } = await import(pathToFileURL(path.join(SDK, 'stdio.js')).href);
  return { Client, StdioClientTransport };
}

function serverEnv(dbPath, repoPath) {
  const env = {
    CODEBASE_INDEX_DB_PATH: dbPath,
    CODEBASE_INDEX_ALLOWED_ROOTS: repoPath,
    CODEBASE_INDEX_WATCH_AUTO_START_ENABLED: 'false',
    CODEBASE_INDEX_TELEMETRY_ENABLED: 'false',
    GIT_OPTIONAL_LOCKS: '0'
  };
  for (const k of KNOBS) if (process.env[k] !== undefined) env[k] = process.env[k];
  return env;
}

async function startServer(dbPath, repoPath) {
  const { Client, StdioClientTransport } = await sdk();
  const t0 = now();
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(DIST, 'index.js')], cwd: SERVER_DIR, env: { ...process.env, ...serverEnv(dbPath, repoPath) }, stderr: 'ignore' });
  const client = new Client({ name: 'replay-perf', version: '1.0.0' });
  await client.connect(transport);
  return { client, startupMs: now() - t0, close: () => client.close() };
}

async function callStdio(client, tool, args, timeout = CALL_TIMEOUT_MS) {
  const t0 = now();
  try {
    const res = await client.callTool({ name: tool, arguments: args }, undefined, { timeout, resetTimeoutOnProgress: true });
    const ms = now() - t0;
    const text = res.content?.[0]?.text ?? '';
    return { ms, text, isError: Boolean(res.isError) };
  } catch (e) {
    return { ms: now() - t0, text: '', isError: true, error: String(e.message ?? e).slice(0, 200) };
  }
}

async function buildIndex(dbPath, repoId, repoPath) {
  for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) fs.rmSync(f, { force: true });
  fs.rmSync(path.join(path.dirname(dbPath), '.codebase-index-state'), { recursive: true, force: true });
  const s = await startServer(dbPath, repoPath);
  const t0 = now();
  const r = await callStdio(s.client, 'index_repository', { repoId, repoPath, mode: 'full', docsMode: 'on' }, INDEX_TIMEOUT_MS);
  await s.close();
  if (r.isError) throw new Error(`index_repository failed: ${r.error ?? r.text.slice(0, 300)}`);
  const run = JSON.parse(r.text);
  // Fold the WAL into the file so the DB is one self-contained file.
  const Database = createRequire(path.join(SERVER_DIR, 'package.json'))('better-sqlite3');
  const db = new Database(dbPath);
  db.pragma('wal_checkpoint(TRUNCATE)');
  db.close();
  return { ms: round(now() - t0, 0), runId: run.runId ?? run.run?.runId ?? null, summary: JSON.stringify(run).slice(0, 400) };
}

// ── handler lane (in-process, NO freshness gate) ─────────────────────────────────────────────────
async function loadHandlers() {
  const imp = (p) => import(pathToFileURL(path.join(DIST, p)).href);
  const [{ GraphStore }, { handleSearchRegex }, { handleQueryDocs }, { searchRegexSchema }, { queryDocsSchema }, { asText }] = await Promise.all([
    imp('repositories/graphStore.js'), imp('tools/handlers/searchHandler.js'), imp('tools/handlers/impactHandler.js'),
    imp('types/schemas/search.js'), imp('types/schemas/readMetadata.js'), imp('middleware/responseFormatter.js')
  ]);
  return { GraphStore, handleSearchRegex, handleQueryDocs, searchRegexSchema, queryDocsSchema, asText };
}

function handlerCaller(h, store) {
  const ctx = { store, constants: { DOCS_TOOLS_ENABLED: true, MAX_RESULT_LIMIT: MAX_LIMIT }, asText: (p, prof = 'standard') => h.asText(p, prof, undefined, false, 0) };
  // handleQueryDocs is async, handleSearchRegex is not: await both.
  return async (tool, args) => {
    const t0 = now();
    try {
      const res = await (tool === 'search_regex'
        ? h.handleSearchRegex(h.searchRegexSchema(MAX_LIMIT).parse(args), ctx)
        : h.handleQueryDocs(h.queryDocsSchema(MAX_LIMIT).parse(args), ctx));
      return { ms: now() - t0, text: res.content[0].text, isError: Boolean(res.isError) };
    } catch (e) {
      return { ms: now() - t0, text: '', isError: true, error: String(e.message ?? e).slice(0, 200) };
    }
  };
}

async function handlerChild(dbPath, tool, argsB64) {
  const t0 = now();
  const h = await loadHandlers();
  const t1 = now();
  const store = new h.GraphStore(dbPath);
  const t2 = now();
  const r = await handlerCaller(h, store)(tool, JSON.parse(Buffer.from(argsB64, 'base64').toString('utf8')));
  store.close();
  process.stdout.write(JSON.stringify({ importMs: t1 - t0, openMs: t2 - t1, ...r }));
}

function handlerCold(dbPath, tool, args) {
  const t0 = now();
  const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--handler-child', dbPath, tool, Buffer.from(JSON.stringify(args)).toString('base64')], { maxBuffer: 256 * 2 ** 20, env: GIT_ENV });
  const processMs = now() - t0;
  try { return { ...JSON.parse(r.stdout.toString('utf8')), processMs }; } catch { return { ms: null, text: '', isError: true, error: String(r.stderr).slice(0, 200), processMs }; }
}

// ── scoring one MCP response ─────────────────────────────────────────────────────────────────────
function scoreResponse(text, baseline) {
  let payload = null;
  try { payload = JSON.parse(text); } catch { /* not JSON */ }
  const got = new Set(((payload?.files ?? payload?.matches) ?? []).map((m) => String(m.filePath).replace(/\\/g, '/')));
  return { payload, recall: recallOf(baseline, got), truncated: Boolean(payload?.truncated), freshness: payload?.freshness?.state ?? (payload?.freshness ? 'present' : 'none') };
}
function scoreDocs(text, baseline) {
  let payload = null;
  try { payload = JSON.parse(text); } catch { /* not JSON */ }
  return { payload, docsHit: (payload?.results ?? []).some((x) => baseline.has(String(x.filePath).replace(/\\/g, '/'))) };
}

// ── the run ──────────────────────────────────────────────────────────────────────────────────────
function pickPatterns(sample, maxN, only) {
  const all = sample.patterns.map((p, i) => ({ ...p, id: i + 1 }));
  if (only) return all.filter((p) => only.includes(p.id));
  if (!maxN || maxN >= all.length) return all;
  // Round-robin across ranks so a short validation run still touches every rank.
  const byRank = new Map();
  for (const p of all) (byRank.get(p.rank) ?? byRank.set(p.rank, []).get(p.rank)).push(p);
  const out = [];
  for (let i = 0; out.length < maxN; i++) {
    let added = false;
    for (const list of byRank.values()) if (list[i] && out.length < maxN) { out.push(list[i]); added = true; }
    if (!added) break;
  }
  return out.sort((a, b) => a.id - b.id);
}

export async function perf({ repoId, sample, trackedTextFiles, baselineFiles, toJsRegex, repeats, outPrefix, via, maxN, only, workDir, reuseIndex }) {
  const repoPath = sample.repoPath;
  const shapes = JSON.parse(fs.readFileSync(SHAPES_FILE, 'utf8')).shapes;
  const patterns = pickPatterns(sample, maxN, only);
  const log = (...a) => console.error('[perf]', ...a);

  const loadStart = sampleLoad('start');
  const treeStart = treeState(repoPath);
  log(`tree ${treeStart.state} (${treeStart.dirtyFiles} dirty) @ ${treeStart.head.slice(0, 12)}; cpu ${loadStart.cpuBusyPct}%`);

  fs.mkdirSync(workDir, { recursive: true });
  const dbPath = path.join(workDir, `${repoId}.db`);
  let index;
  if (reuseIndex && fs.existsSync(dbPath)) index = { reused: true };
  else { log('building the index (full, docs on) with the built server…'); index = await buildIndex(dbPath, repoId, repoPath); log(`index built in ${index.ms} ms`); }

  const files = trackedTextFiles(repoPath);
  const sed = sedPath();
  const rows = patterns.map((p) => {
    const rankDef = sample.ranks.find((r) => r.rank === p.rank);
    const shape = shapes[p.pattern]?.shape ?? 'lines';
    const re = toJsRegex(p.pattern);
    return { id: p.id, rank: p.rank, pattern: p.pattern, docs: Boolean(rankDef.docs), shape, plan: grepPlan(rankDef, shape), baseline: new Set(baselineFiles(files, re)), mcp: {} };
  });

  // grep: one discarded pass (warms the filesystem cache), then `repeats` timed passes; median.
  log(`grep lane (${rows.length} patterns × ${repeats + 1})…`);
  for (const r of rows) {
    grepPass(repoPath, r.plan, r.pattern, sed);
    const passes = Array.from({ length: repeats }, () => grepPass(repoPath, r.plan, r.pattern, sed));
    const last = passes[passes.length - 1];
    const got = filesOfGrep(last.listText, r.plan.listFlag);
    r.grep = { ms: median(passes.map((x) => x.ms)), msAll: passes.map((x) => round(x.ms, 2)), calls: last.cmds.length, commands: last.cmds.map((c) => c.cmd), bytes: last.bytes, tokens: tokensOf(last.bytes), recallVsBaseline: round(recallOf(r.baseline, got), 3), ...(last.error && { error: last.error }) };
  }

  const lanes = via;
  const measure = async (lane, cold, warmCall) => {
    for (const r of rows) {
      const c = await cold(r);
      // warm: one discarded call, then `repeats` timed calls in the same, already-warm process.
      await warmCall('search_regex', regexArgs(repoId, r.pattern));
      const warm = [];
      for (let i = 0; i < repeats; i++) warm.push(await warmCall('search_regex', regexArgs(repoId, r.pattern)));
      const last = warm[warm.length - 1];
      const sc = scoreResponse(last.text, r.baseline);
      let docs = null;
      if (r.docs && docsArgs(repoId, r.pattern).query.length >= 2) {
        await warmCall('query_docs', docsArgs(repoId, r.pattern));
        const dw = [];
        for (let i = 0; i < repeats; i++) dw.push(await warmCall('query_docs', docsArgs(repoId, r.pattern)));
        const ds = scoreDocs(dw[dw.length - 1].text, r.baseline);
        const bytes = Buffer.byteLength(dw[dw.length - 1].text, 'utf8');
        docs = { warmMs: median(dw.map((x) => x.ms)), bytes, tokens: tokensOf(bytes), docsHit: ds.docsHit, extraContext: hasExtraContext(ds.payload), ...(dw[dw.length - 1].isError && { error: dw[dw.length - 1].error ?? dw[dw.length - 1].text.slice(0, 200) }) };
      }
      const bytes = Buffer.byteLength(last.text, 'utf8');
      const hit = sc.recall >= 0.9 || docs?.docsHit === true;
      r.mcp[lane] = {
        coldMs: c.ms, ...(c.startupMs !== undefined && { coldStartupMs: round(c.startupMs, 1) }), ...(c.processMs !== undefined && { coldProcessMs: round(c.processMs, 1) }),
        coldFreshness: c.text ? scoreResponse(c.text, r.baseline).freshness : null,
        warmMs: median(warm.map((x) => x.ms)), warmMsAll: warm.map((x) => round(x.ms, 2)), warmFreshness: sc.freshness,
        bytes, tokens: tokensOf(bytes), recall: round(sc.recall, 3), truncated: sc.truncated, hit, extraContext: hasExtraContext(sc.payload),
        ...(docs && { docs }), ...((last.isError || c.isError) && { error: last.error ?? c.error ?? last.text.slice(0, 200) })
      };
      const adv = advantage({ grepMs: r.grep.ms, mcpMs: r.mcp[lane].warmMs, grepTokens: r.grep.tokens, mcpTokens: r.mcp[lane].tokens, mcpHit: hit, extraContext: r.mcp[lane].extraContext });
      r.mcp[lane].advantage = adv;
    }
  };

  if (lanes.includes('stdio')) {
    log('stdio lane: cold = first call after spawning the built server, one spawn per pattern…');
    const coldStdio = async (r) => {
      const s = await startServer(dbPath, repoPath);
      const c = await callStdio(s.client, 'search_regex', regexArgs(repoId, r.pattern));
      await s.close();
      return { ...c, startupMs: s.startupMs };
    };
    const warmServer = await startServer(dbPath, repoPath);
    try {
      await measure('stdio', coldStdio, (tool, args) => callStdio(warmServer.client, tool, args));
    } finally { await warmServer.close(); }
  }
  if (lanes.includes('handler')) {
    log('handler lane (no freshness gate): cold = first call in a fresh child process…');
    const h = await loadHandlers();
    const store = new h.GraphStore(dbPath);
    const call = handlerCaller(h, store);
    try {
      await measure('handler', async (r) => handlerCold(dbPath, 'search_regex', regexArgs(repoId, r.pattern)), (tool, args) => call(tool, args));
    } finally { store.close(); }
  }

  const treeEnd = treeState(repoPath);
  const loadEnd = sampleLoad('end');
  const env = {
    node: process.version, platform: `${process.platform} ${os.release()}`, cpus: `${os.cpus().length}× ${os.cpus()[0]?.model ?? '?'}`,
    git: execFileSync('git', ['--version']).toString().trim(), sed,
    serverBuild: JSON.parse(fs.readFileSync(path.join(SERVER_DIR, 'package.json'), 'utf8')).version,
    workspaceHead: execFileSync('git', ['-C', ROOT, 'rev-parse', '--short=12', 'HEAD']).toString().trim(),
    knobs: Object.fromEntries(KNOBS.map((k) => [k, process.env[k] ?? '(default)']))
  };
  const out = rows.map(({ baseline, ...r }) => ({ ...r, baselineFiles: baseline.size }));
  const laneLabels = { stdio: 'MCP via stdio — the built server, R1 freshness gate applies (headline)', handler: 'MCP handler only (no freshness gate) — diagnostic' };
  const result = {
    kind: 'replay-perf', version: 1, startedAt: loadStart.at, repoId, repoPath, sample: { frozenAt: sample.frozenAt, repoHead: sample.repoHead, patterns: rows.length, of: sample.patterns.length },
    repeats, via: lanes, tree: { start: treeStart, end: treeEnd, headMoved: treeStart.head !== treeEnd.head }, load: { start: loadStart, end: loadEnd }, env, index: { dbPath, ...index },
    summary: Object.fromEntries(lanes.map((l) => [l, summarize(out, l)])),
    wins: Object.fromEntries(lanes.map((l) => [l, topWins(out, l)])),
    rows: out
  };
  const md = renderMarkdown(result, laneLabels);
  if (outPrefix) {
    fs.mkdirSync(path.dirname(path.resolve(outPrefix)), { recursive: true });
    fs.writeFileSync(`${outPrefix}.json`, JSON.stringify(result, null, 1) + '\n');
    fs.writeFileSync(`${outPrefix}.md`, md + '\n');
    log(`wrote ${outPrefix}.json and ${outPrefix}.md`);
  }
  console.log(md);
  return result;
}

function renderMarkdown(r, laneLabels) {
  const load = (l) => `CPU busy ${l.cpuBusyPct}% (2 s os.cpus sample)` + (l.win32LoadPercentage !== undefined ? `, Win32 LoadPercentage ${l.win32LoadPercentage}` : '') + (l.loadavg ? `, loadavg ${l.loadavg.join(' ')}` : '') + (l.topProcessesPctOfOneCore ? `; busiest: ${l.topProcessesPctOfOneCore.join(', ')}` : '') + `; free mem ${l.freeMemMb}/${l.totalMemMb} MB`;
  const lines = [
    `## replay perf — ${r.repoId} @ ${r.tree.start.head.slice(0, 12)} (${r.startedAt})`,
    '',
    `- sample: ${r.sample.patterns}/${r.sample.of} frozen patterns (frozen ${r.sample.frozenAt} @ ${r.sample.repoHead}); repeats ${r.repeats} (median), one discarded warm-up per side`,
    `- tree at start: **${r.tree.start.state}** (${r.tree.start.dirtyFiles} dirty files); at end: ${r.tree.end.state} (${r.tree.end.dirtyFiles})${r.tree.headMoved ? ' — **HEAD MOVED during the run, numbers are not comparable**' : ''}`,
    `- load at start: ${load(r.load.start)}`,
    `- load at end: ${load(r.load.end)}`,
    `- env: node ${r.env.node}, ${r.env.platform}, ${r.env.cpus}, ${r.env.git}, workspace ${r.env.workspaceHead}, knobs ${JSON.stringify(r.env.knobs)}`,
    `- index: ${r.index.reused ? 'reused' : `built fresh (full, docs on) in ${r.index.ms} ms`} at ${r.index.dbPath}`,
    `- grep = \`git grep -n|-l -I -P\` (+ one \`sed -n\` region read for doc ranks); tokens = ceil(bytes/4); times in ms`,
    ''
  ];
  for (const lane of r.via) {
    lines.push(renderLaneTable(r.rows, RANK_NAMES(r), lane, laneLabels[lane]), '');
    const counts = (key) => r.rows.map((x) => x.mcp[lane]?.[key]).filter(Boolean).reduce((a, s) => ({ ...a, [s]: (a[s] ?? 0) + 1 }), {});
    if (lane === 'stdio') {
      lines.push(`R1 freshness block on the cold call: ${JSON.stringify(counts('coldFreshness'))}; on the last warm call: ${JSON.stringify(counts('warmFreshness'))} (none = the gate found the index fresh and added no block; refreshing = a refresh outlived the budget and the answer came from the previous index)`, '');
      const st = r.rows.map((x) => x.mcp.stdio?.coldStartupMs).filter((v) => v !== undefined);
      lines.push(`server spawn + initialize before the cold call (not in the cold number): median ${round(median(st), 0)} ms`, '');
    } else {
      const pm = r.rows.map((x) => x.mcp.handler?.coldProcessMs).filter((v) => v !== undefined);
      lines.push(`child process wall for the cold call (node start + import + DB open + call): median ${round(median(pm), 0)} ms`, '');
    }
    lines.push(`Clearest wins (${lane}, warm):`, '', renderWins(r.wins[lane]), '');
  }
  return lines.join('\n');
}

const RANK_NAMES = (r) => [...new Map(r.rows.map((x) => [x.rank, x.rank])).keys()].sort((a, b) => a - b).map((rank) => ({ rank, name: NAMES[rank] ?? '' }));
const NAMES = { 1: 'snake_case', 2: 'markdown+citations', 3: 'code identifiers', 4: 'English prose', 5: 'CSS+Vue', 6: 'routes+board', 7: 'test names' };

/** `perf-compare a.json b.json` — the two runs' medians side by side, with the relative difference. */
export function compare(aFile, bFile) {
  const a = JSON.parse(fs.readFileSync(aFile, 'utf8'));
  const b = JSON.parse(fs.readFileSync(bFile, 'utf8'));
  const d = (x, y) => (x === null || y === null || x === 0 ? '–' : `${(((y - x) / x) * 100).toFixed(1)}%`);
  const out = ['| lane | metric | run A | run B | B vs A |', '|---|---|---:|---:|---:|'];
  for (const lane of a.via.filter((l) => b.via.includes(l))) {
    const sa = a.summary[lane];
    const sb = b.summary[lane];
    for (const [label, pick] of [['grep ms median', (s) => s.grepMs.median], ['grep ms p90', (s) => s.grepMs.p90], ['MCP warm ms median', (s) => s.warmMs.median], ['MCP warm ms p90', (s) => s.warmMs.p90], ['MCP cold ms median', (s) => s.coldMs.median], ['MCP cold ms p90', (s) => s.coldMs.p90], ['grep tokens median', (s) => s.grepTokens.median], ['MCP tokens median', (s) => s.mcpTokens.median]]) {
      out.push(`| ${lane} | ${label} | ${round(pick(sa), 1)} | ${round(pick(sb), 1)} | ${d(pick(sa), pick(sb))} |`);
    }
  }
  console.log(out.join('\n'));
}

if (process.argv[2] === '--handler-child') await handlerChild(process.argv[3], process.argv[4], process.argv[5]);
