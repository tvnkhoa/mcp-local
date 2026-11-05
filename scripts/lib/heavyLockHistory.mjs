/**
 * What heavy runs cost (row H-6a, 2026-11-05). The machine went to 38.8 GB and the owner chose a RAM
 * budget over one-at-a-time ("Khoá theo ngân sách RAM"); a budget needs numbers. So each run that takes
 * the lock through `heavy-lock.mjs` is measured and appended to `<lock>.history.jsonl`:
 * `{at, startedAt, repo, session, class, cost, ramMb, cmd, cwd, pid, durationMs, exit, peakMb, peakAt,
 * peakTop, sampling}`. `heavy-lock.mjs history [--class x] [--repo r] [--json]` prints p50/p95/max per class.
 *
 * Peak = the largest sum of working sets of the run's WHOLE process tree seen in one sample. The tree is
 * every descendant of the heavy-lock process, and it stays the tree after a process detaches: a process
 * joins when its parent is the root or any process already seen in the tree (alive or not), so a
 * VBCSCompiler / csc / dotnet build server that outlives the `dotnet` that spawned it (3 Nov: a detached
 * VBCSCompiler reached 17.7–19 GB) is still sampled until the run ends. A seen pid whose creation time
 * changes was reused and leaves the tree; a process created before the run began never joins it. The
 * sampler's own processes are excluded. A process that starts and exits between two samples, under a
 * parent that also did, is missed — the interval bounds that.
 *
 * Sampling runs in a separate process (the CLI sits in spawnSync): a node sampler drives one
 * PowerShell that loads a small C# helper (toolhelp snapshot for parents, then OpenProcess +
 * GetProcessTimes + K32GetProcessMemoryInfo for tree members only). The helper is compiled once per
 * machine to a cached DLL in the temp dir (~1 s, one csc); a sample then costs a few ms of CPU. Default
 * interval 1000 ms (`MCP_HEAVY_LOCK_SAMPLE_MS`, ≥ 100); `MCP_HEAVY_LOCK_SAMPLE=off` disables it. The
 * first sample lands ~1–2 s after the run starts (PowerShell start-up), so a shorter run records
 * `samples: 0` and `peakMb: null`. Windows only; elsewhere `peakMb` is null with the reason in `sampling`.
 *
 * The file is capped: past `MCP_HEAVY_LOCK_HISTORY_MAX_BYTES` (default 2 MiB) it is renamed to
 * `<lock>.history.1.jsonl` (replacing the older one) and a new one starts; readers read both. Appends
 * are one `appendFileSync` of one line each, and a rename never loses a line. Recording never fails a
 * run. Measured only when the call holds the lock itself (not nested, not `--no-lock`, not CI).
 */

import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { heavyLockPath, isPidAlive } from "./heavyLock.mjs";

export const DEFAULT_SAMPLE_MS = 1_000;
export const DEFAULT_HISTORY_MAX_BYTES = 2 * 1024 * 1024;
const SELF = fileURLToPath(import.meta.url);

export function historyPath(env = process.env) {
  return `${heavyLockPath(env)}.history.jsonl`;
}

export function sampleIntervalMs(env = process.env) {
  const value = Number(env.MCP_HEAVY_LOCK_SAMPLE_MS);
  return Number.isFinite(value) && value >= 100 ? Math.round(value) : DEFAULT_SAMPLE_MS;
}

function historyMaxBytes(env) {
  const value = Number(env.MCP_HEAVY_LOCK_HISTORY_MAX_BYTES);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_HISTORY_MAX_BYTES;
}

/**
 * The class a run is filed under when the caller names none: its repo and its command, each path-like
 * token cut to its basename (a scratch csproj path becomes `aliasprobe.csproj`), at most 160 chars.
 */
export function defaultClass(cmd, repo) {
  const words = String(cmd ?? "")
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.replace(/^["']|["']$/g, ""))
    .map((w) => (/[\\/]/.test(w) ? w.split(/[\\/]/).filter(Boolean).at(-1) ?? w : w));
  return `${repo ?? "unknown"}/${words.join(" ")}`.slice(0, 160);
}

/** Append one run to the history, rotating at the cap. Never throws: a run never fails for its record. */
export function recordRun(row, { env = process.env } = {}) {
  const file = historyPath(env);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    let size = 0;
    try {
      size = fs.statSync(file).size;
    } catch {
      // first row
    }
    if (size > historyMaxBytes(env)) {
      try {
        fs.renameSync(file, file.replace(/\.jsonl$/, ".1.jsonl"));
      } catch {
        // another writer rotated it first, or Windows refused: append anyway
      }
    }
    fs.appendFileSync(file, `${JSON.stringify(row)}\n`);
    return true;
  } catch {
    return false;
  }
}

/** Every parseable row of the history (the rotated file first), oldest first. */
export function readHistory({ env = process.env } = {}) {
  const file = historyPath(env);
  const rows = [];
  for (const f of [file.replace(/\.jsonl$/, ".1.jsonl"), file]) {
    let text = "";
    try {
      text = fs.readFileSync(f, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue;
      try {
        const row = JSON.parse(line);
        if (row !== null && typeof row === "object") rows.push(row);
      } catch {
        // a torn line: skipped
      }
    }
  }
  return rows;
}

/** Nearest-rank percentile of sorted numbers, `null` for none. */
function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}

/** Per class: `{class, runs, measured, peakMb: {p50, p95, max}, durationS: {p50, p95, max}, failed, last}`, the heaviest p95 first. */
export function summarizeHistory(rows, { klass, repo } = {}) {
  const groups = new Map();
  for (const row of rows) {
    if (klass !== undefined && row.class !== klass) continue;
    if (repo !== undefined && row.repo !== repo) continue;
    const key = String(row.class ?? "(none)");
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const stats = (values) => {
    const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
    return { p50: percentile(sorted, 50), p95: percentile(sorted, 95), max: sorted.at(-1) ?? null };
  };
  return [...groups.entries()]
    .map(([name, list]) => ({
      class: name,
      runs: list.length,
      measured: list.filter((r) => Number.isFinite(r.peakMb)).length,
      peakMb: stats(list.map((r) => r.peakMb)),
      durationS: stats(list.map((r) => (Number.isFinite(r.durationMs) ? Math.round(r.durationMs / 100) / 10 : NaN))),
      failed: list.filter((r) => r.exit !== 0).length,
      last: list.map((r) => String(r.at ?? "")).sort().at(-1) ?? null
    }))
    .sort((a, b) => (b.peakMb.p95 ?? -1) - (a.peakMb.p95 ?? -1) || a.class.localeCompare(b.class));
}

export function formatHistory(summary, { file } = {}) {
  const n = (v) => (v === null ? "-" : String(v));
  const lines = [`history: ${String(file ?? "")}`];
  if (summary.length === 0) return [...lines, "no runs recorded"].join("\n");
  lines.push("peak MB p50/p95/max · duration s p50/p95/max · runs (measured, failed) · last");
  for (const s of summary) {
    lines.push(`${s.class}`);
    lines.push(
      `    ${n(s.peakMb.p50)}/${n(s.peakMb.p95)}/${n(s.peakMb.max)} MB · ${n(s.durationS.p50)}/${n(s.durationS.p95)}/${n(s.durationS.max)} s · ${String(s.runs)} (${String(s.measured)}, ${String(s.failed)} failed) · ${n(s.last)}`
    );
  }
  return lines.join("\n");
}

// ---- the sampler ----

const HELPER_CS = String.raw`
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class HeavyLockSampler {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct PE { public uint dwSize, cntUsage, th32ProcessID; public IntPtr th32DefaultHeapID; public uint th32ModuleID, cntThreads, th32ParentProcessID; public int pcPriClassBase; public uint dwFlags; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szExeFile; }
  [StructLayout(LayoutKind.Sequential)]
  struct PMC { public uint cb, PageFaultCount; public UIntPtr PeakWorkingSetSize, WorkingSetSize, QuotaPeakPagedPoolUsage, QuotaPagedPoolUsage, QuotaPeakNonPagedPoolUsage, QuotaNonPagedPoolUsage, PagefileUsage, PeakPagefileUsage; }
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32FirstW(IntPtr h, ref PE e);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32NextW(IntPtr h, ref PE e);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll")] static extern bool GetProcessTimes(IntPtr h, out long created, out long exited, out long kernel, out long user);
  [DllImport("kernel32.dll")] static extern bool K32GetProcessMemoryInfo(IntPtr h, out PMC counters, uint cb);
  static int root, exclude;
  static long runStartFt;
  static readonly Dictionary<int, long> seen = new Dictionary<int, long>();
  public static void Init(int rootPid, int excludePid, long runStartMs) {
    root = rootPid; exclude = excludePid;
    runStartFt = (runStartMs - 3000 + 11644473600000L) * 10000L;
  }
  static bool Read(int pid, out long created, out long ws) {
    created = 0; ws = 0;
    IntPtr h = OpenProcess(0x1000, false, (uint)pid);
    if (h == IntPtr.Zero) return false;
    long c, e, k, u;
    if (GetProcessTimes(h, out c, out e, out k, out u)) created = c;
    PMC m = new PMC(); m.cb = (uint)Marshal.SizeOf(typeof(PMC));
    if (K32GetProcessMemoryInfo(h, out m, m.cb)) ws = (long)m.WorkingSetSize.ToUInt64();
    CloseHandle(h);
    return true;
  }
  public delegate bool Reader(int pid, out long created, out long ws);
  public static string Sample() {
    var parent = new Dictionary<int, int>();
    var name = new Dictionary<int, string>();
    IntPtr snap = CreateToolhelp32Snapshot(2, 0);
    var pe = new PE(); pe.dwSize = (uint)Marshal.SizeOf(typeof(PE));
    if (Process32FirstW(snap, ref pe)) { do { parent[(int)pe.th32ProcessID] = (int)pe.th32ParentProcessID; name[(int)pe.th32ProcessID] = pe.szExeFile; } while (Process32NextW(snap, ref pe)); }
    CloseHandle(snap);
    return Run(parent, name, Read);
  }
  // Test hook: one sample over a scripted process table, one "pid ppid created ws name" per line.
  public static string SampleTable(string table) {
    var parent = new Dictionary<int, int>();
    var name = new Dictionary<int, string>();
    var info = new Dictionary<int, long[]>();
    foreach (var line in table.Split('\n')) {
      var f = line.Trim().Split(new[] { ' ' }, 5);
      if (f.Length < 5) continue;
      int pid = int.Parse(f[0]);
      parent[pid] = int.Parse(f[1]); name[pid] = f[4];
      info[pid] = new[] { long.Parse(f[2]), long.Parse(f[3]) };
    }
    return Run(parent, name, delegate(int pid, out long created, out long ws) {
      long[] v; created = 0; ws = 0;
      if (!info.TryGetValue(pid, out v)) return false;
      created = v[0]; ws = v[1]; return true;
    });
  }
  static string Run(Dictionary<int, int> parent, Dictionary<int, string> name, Reader read) {
    // A seen pid that is now another process (creation time changed) leaves the tree first; one whose
    // creation time is unchanged stays a member whatever its parent chain now says (its parent's pid
    // may have been reused by a stranger after the parent exited).
    foreach (var pid in new List<int>(seen.Keys)) {
      if (!parent.ContainsKey(pid)) continue;
      long c, w;
      if (read(pid, out c, out w) && c != 0 && seen[pid] != 0 && c != seen[pid]) seen.Remove(pid);
    }
    var memo = new Dictionary<int, int>();
    var sb = new StringBuilder();
    long sum = 0; int count = 0;
    foreach (var pid in parent.Keys) {
      if (Member(pid, parent, memo, 0) != 1) continue;
      long created, ws;
      if (!read(pid, out created, out ws)) continue;
      long known;
      if (!seen.TryGetValue(pid, out known)) {
        if (created != 0 && created < runStartFt) continue; // existed before the run: not its child
        seen[pid] = created;
      }
      sum += ws; count++;
      sb.Append("M ").Append(pid).Append(' ').Append(ws).Append(' ').Append(name[pid]).Append('\n');
    }
    return "S " + count + " " + sum + "\n" + sb.ToString();
  }
  // 1 in the run's tree, 0 not, -1 the sampler's own subtree.
  static int Member(int pid, Dictionary<int, int> parent, Dictionary<int, int> memo, int depth) {
    int r;
    if (memo.TryGetValue(pid, out r)) return r;
    if (pid == exclude) r = -1;
    else if (pid == root || depth > 64) r = 0;
    else if (seen.ContainsKey(pid)) r = 1; // already in the tree, verified unchanged above
    else {
      int pp;
      if (!parent.TryGetValue(pid, out pp) || pp == pid) r = 0;
      else if (pp == root) r = 1;
      else if (pp == exclude) r = -1;
      else if (seen.ContainsKey(pp) && !parent.ContainsKey(pp)) r = 1; // its parent was in the tree and is gone (detached)
      else if (parent.ContainsKey(pp)) r = Member(pp, parent, memo, depth + 1);
      else r = 0;
    }
    memo[pid] = r;
    return r;
  }
}
`;

const PS_LOOP = [
  "$ErrorActionPreference = 'Stop'",
  "$nl = [char]10",
  "$src = [IO.File]::ReadAllText($env:HL_CS)",
  "$dll = $env:HL_DLL",
  "$sum = \"$dll.sha256\"",
  // Compiled once per machine (one csc) beside a sha256 of the DLL. A racing compiler loses the move and
  // loads the winner's DLL; a DLL that does not match its sum (corrupt, half-written) is rebuilt once,
  // and one that still will not load is compiled in memory for this run: sampling never stays broken.
  "function Build {",
  "  $tmp = \"$dll.$PID.tmp.dll\"",
  "  Add-Type -TypeDefinition $src -OutputAssembly $tmp -OutputType Library",
  "  $h = (Get-FileHash -LiteralPath $tmp -Algorithm SHA256).Hash",
  "  Remove-Item -LiteralPath $dll, $sum -ErrorAction SilentlyContinue",
  "  try { Move-Item -LiteralPath $tmp -Destination $dll -ErrorAction Stop; [IO.File]::WriteAllText($sum, $h) } catch { Remove-Item -LiteralPath $tmp -ErrorAction SilentlyContinue }",
  "}",
  "$how = 'cached'",
  "$good = $false",
  "try { $good = (Test-Path -LiteralPath $sum) -and ((Get-FileHash -LiteralPath $dll -Algorithm SHA256).Hash -eq [IO.File]::ReadAllText($sum).Trim()) } catch { $good = $false }",
  "if (-not $good) { $how = 'built'; try { Build } catch { } }",
  "try { Add-Type -Path $dll } catch { $how = 'memory'; Add-Type -TypeDefinition $src }",
  "$out = [Console]::Out",
  "$out.Write('L ' + $how + $nl)",
  "[HeavyLockSampler]::Init([int]$env:HL_ROOT, [int]$env:HL_EXCLUDE, [long]$env:HL_START)",
  // Test mode: scripted process tables, one sample each, then exit.
  "if ($env:HL_TABLES) {",
  "  foreach ($t in ([IO.File]::ReadAllText($env:HL_TABLES) -split '(?m)^---\\s*$')) { $out.Write('T 0' + $nl + [HeavyLockSampler]::SampleTable($t) + 'E' + $nl) }",
  "  $out.Flush()",
  "  exit 0",
  "}",
  "while ($true) {",
  "  $sw = [Diagnostics.Stopwatch]::StartNew()",
  "  $s = [HeavyLockSampler]::Sample()",
  "  $out.Write('T ' + $sw.ElapsedMilliseconds + $nl + $s + 'E' + $nl)",
  "  $out.Flush()",
  "  Start-Sleep -Milliseconds ([int]$env:HL_INTERVAL)",
  "}"
].join("\n");

/**
 * The cached helper DLL and the C# source beside it, named by the source's hash (so an edit recompiles),
 * in `MCP_HEAVY_LOCK_SAMPLER_CACHE` (a test's scratch dir) or the temp dir.
 */
function helperFiles(env = process.env) {
  const hash = createHash("sha256").update(HELPER_CS).digest("hex").slice(0, 12);
  const dir = env.MCP_HEAVY_LOCK_SAMPLER_CACHE || os.tmpdir();
  fs.mkdirSync(dir, { recursive: true });
  const base = path.join(dir, `heavy-lock-sampler-${hash}`);
  const cs = `${base}.cs`;
  if (!fs.existsSync(cs)) {
    const tmp = `${cs}.${String(process.pid)}.${randomUUID()}.tmp`;
    fs.writeFileSync(tmp, HELPER_CS);
    try {
      fs.renameSync(tmp, cs);
    } catch {
      fs.rmSync(tmp, { force: true });
    }
  }
  return { cs, dll: `${base}.dll` };
}

/** Is sampling on for this run, and if not, why not. */
export function samplingOff(env = process.env, platform = process.platform) {
  if (env.MCP_HEAVY_LOCK_SAMPLE === "off") return "MCP_HEAVY_LOCK_SAMPLE=off";
  if (platform !== "win32") return `no sampler on ${platform}`;
  return null;
}

/**
 * Start sampling the tree under `rootPid` (default: this process) in a sampler process. Returns
 * `{ stop() }`; `stop()` ends it and returns the summary (`peakMb`, `peakAt`, `peakTop`, `sampling`).
 */
export function startSampler({ rootPid = process.pid, runStart = Date.now(), env = process.env } = {}) {
  const intervalMs = sampleIntervalMs(env);
  const off = samplingOff(env);
  if (off !== null) return { stop: () => ({ peakMb: null, peakAt: null, peakTop: [], sampling: { intervalMs, samples: 0, off } }) };
  cleanStaleSamples();
  const out = path.join(os.tmpdir(), `heavy-lock-sample-${String(process.pid)}-${randomUUID()}.json`);
  let child = null;
  try {
    child = spawn(process.execPath, [SELF, "--sample", String(rootPid), String(runStart), out, String(intervalMs)], { stdio: "ignore", windowsHide: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    child = null;
  }
  return {
    /** Never throws: the run's own exit code is what the caller reports. */
    stop() {
      if (child?.pid !== undefined && isPidAlive(child.pid)) {
        // The whole tree: the node sampler, its PowerShell helper and that one's conhost.
        try {
          if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true, timeout: 10_000 });
          else process.kill(child.pid);
        } catch {
          // already gone
        }
      }
      let summary = null;
      try {
        summary = JSON.parse(fs.readFileSync(out, "utf8"));
      } catch {
        // no sample written yet (a run shorter than the sampler's start-up)
      }
      try {
        fs.rmSync(out, { force: true });
      } catch {
        // left for cleanStaleSamples
      }
      return summary ?? { peakMb: null, peakAt: null, peakTop: [], sampling: { intervalMs, samples: 0 } };
    }
  };
}

const SAMPLE_FILE = /^heavy-lock-sample-(\d+)-[0-9a-f-]+\.json(\.[0-9a-f-]+\.tmp)?$/;

/** Remove summary files (and their temps) that a sampler of a process now gone left in the temp dir. */
export function cleanStaleSamples(dir = os.tmpdir()) {
  let removed = 0;
  try {
    for (const name of fs.readdirSync(dir)) {
      const m = SAMPLE_FILE.exec(name);
      if (m === null || isPidAlive(Number(m[1]))) continue;
      try {
        fs.rmSync(path.join(dir, name), { force: true });
        removed++;
      } catch {
        // next time
      }
    }
  } catch {
    // no temp dir listing: nothing to clean
  }
  return removed;
}

/**
 * Test hook: run the helper over scripted process tables (`pid ppid created ws name` lines, created in
 * FILETIME units), one sample each, its seen-set kept across them. Returns `{ helper, samples: [{count,
 * sumBytes, members}] }`. Windows only.
 */
export function sampleTables(tables, { root, exclude = 0, runStartMs = 0, env = process.env } = {}) {
  const { cs, dll } = helperFiles(env);
  const file = path.join(os.tmpdir(), `heavy-lock-tables-${String(process.pid)}-${randomUUID()}.txt`);
  fs.writeFileSync(file, tables.join("\n---\n"));
  try {
    const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(PS_LOOP, "utf16le").toString("base64")], {
      env: { ...env, HL_CS: cs, HL_DLL: dll, HL_ROOT: String(root), HL_EXCLUDE: String(exclude), HL_START: String(runStartMs), HL_INTERVAL: "100", HL_TABLES: file },
      encoding: "utf8",
      windowsHide: true,
      timeout: 60_000
    });
    if (r.status !== 0) throw new Error(`helper exit ${String(r.status)}: ${String(r.stderr)}`);
    const text = r.stdout.replace(/\r/g, "");
    return {
      helper: /^L (\w+)/m.exec(text)?.[1] ?? null,
      samples: text
        .split("E\n")
        .filter((b) => /^S /m.test(b))
        .map((b) => {
          const head = /^S (\d+) (\d+)/m.exec(b);
          return { count: Number(head[1]), sumBytes: Number(head[2]), members: [...b.matchAll(/^M (\d+) /gm)].map((m) => Number(m[1])).sort((x, y) => x - y) };
        })
    };
  } finally {
    fs.rmSync(file, { force: true });
  }
}

/** The sampler process: drive the PowerShell helper, keep the peak, rewrite the summary file after each sample. */
async function runSampler([rootPid, runStart, out, intervalMs]) {
  const { cs, dll } = helperFiles();
  const summary = { peakMb: null, peakAt: null, peakTop: [], sampling: { intervalMs: Number(intervalMs), samples: 0, sampleMsAvg: null, sampleMsMax: null, firstSampleAfterMs: null } };
  const write = () => {
    const tmp = `${out}.${randomUUID()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(summary));
    fs.renameSync(tmp, out);
  };
  const encoded = Buffer.from(PS_LOOP, "utf16le").toString("base64");
  const ps = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], {
    env: { ...process.env, HL_CS: cs, HL_DLL: dll, HL_ROOT: rootPid, HL_EXCLUDE: String(process.pid), HL_START: runStart, HL_INTERVAL: intervalMs },
    stdio: ["ignore", "pipe", "ignore"],
    windowsHide: true
  });
  summary.sampling.helperPid = ps.pid ?? null;
  let buffer = "";
  let totalMs = 0;
  ps.stdout.setEncoding("utf8");
  ps.stdout.on("data", (chunk) => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf("E\n")) !== -1) {
      const block = buffer.slice(0, end).replace(/\r/g, "").split("\n");
      buffer = buffer.slice(end + 2);
      // The helper says once how it loaded: cached DLL, rebuilt, or compiled in memory.
      if (/^L \w+/.test(block[0] ?? "")) summary.sampling.helper = block.shift().slice(2);
      const took = Number(/^T (\d+)/.exec(block[0] ?? "")?.[1]);
      const head = /^S (\d+) (\d+)/.exec(block[1] ?? "");
      if (!head) continue;
      const sampling = summary.sampling;
      sampling.samples++;
      if (Number.isFinite(took)) {
        totalMs += took;
        sampling.sampleMsAvg = Math.round((totalMs / sampling.samples) * 10) / 10;
        sampling.sampleMsMax = Math.max(sampling.sampleMsMax ?? 0, took);
      }
      sampling.firstSampleAfterMs ??= Date.now() - Number(runStart);
      sampling.treeMax = Math.max(sampling.treeMax ?? 0, Number(head[1]));
      const mb = Math.round(Number(head[2]) / 1048576);
      if (summary.peakMb === null || mb > summary.peakMb) {
        summary.peakMb = mb;
        summary.peakAt = new Date().toISOString();
        summary.peakTop = block
          .slice(2)
          .map((line) => /^M (\d+) (\d+) (.*)$/.exec(line))
          .filter(Boolean)
          .map((m) => ({ pid: Number(m[1]), name: m[3], mb: Math.round(Number(m[2]) / 1048576) }))
          .sort((a, b) => b.mb - a.mb)
          .slice(0, 3);
      }
      try {
        write();
      } catch {
        // the next sample writes it again
      }
    }
  });
  // The run is over when its root is: stop with it (the CLI also ends this process).
  const timer = setInterval(() => {
    if (!isPidAlive(Number(rootPid))) {
      ps.kill();
      process.exit(0);
    }
  }, 500);
  ps.on("exit", () => {
    clearInterval(timer);
    process.exit(0);
  });
}

const same = (a, b) => (process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b);
if (process.argv[2] === "--sample" && same(path.resolve(process.argv[1] ?? ""), SELF)) await runSampler(process.argv.slice(3));
