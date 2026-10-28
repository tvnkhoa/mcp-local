#!/usr/bin/env node

/**
 * Serve one MCP server over streamable HTTP, so every Claude session shares one process (R4).
 *
 *   node scripts/serve-http.mjs --server codebase-index                 # run it (foreground)
 *   node scripts/serve-http.mjs --server codebase-index --log <file>    # stderr to a file
 *   node scripts/serve-http.mjs --server codebase-index --task print    # the logon task, printed
 *   node scripts/serve-http.mjs --server codebase-index --task register # ... and registered
 *   node scripts/serve-http.mjs --server codebase-index --task unregister
 *
 *   node scripts/serve-http.mjs --server codebase-index --restart       # deploy, kill the tree on its port, /Run the task, wait for the new listener
 *   node scripts/serve-http.mjs --server codebase-index --deploy-only   # deploy only; the running process is untouched
 *
 * Flags: --config <path> (default ~/.claude/mcp/http/<key>.env.json), --log <path>,
 * --deploy-root <path> (default ~/.claude/mcp/deploy; a scratch root for a trial run).
 *
 * The served process never runs from the working tree's dist (V-A): it runs from a deploy copy under
 * ~/.claude/mcp/deploy/<key>/<sha>-<n>/ that `--restart` / `--deploy-only` make, so a build in the tree
 * changes nothing live until the next `--restart`. See `deployServer`.
 *
 * The served process takes its whole env from the env file, `{ "env": { ... } }`, which
 * `install-mcp --transport http` writes: the same values a stdio registration would carry, plus
 * `<PREFIX>_HTTP_PORT` and `<PREFIX>_HTTP_TOKEN`. A client registration then holds only the URL
 * and the Authorization header. Only a server whose manifest declares both vars can be served.
 *
 * The listener is 127.0.0.1 only, behind a Host/Origin allow-list and the bearer token — see
 * packages/sdk/src/httpTransport.ts. A second copy on the same port fails with EADDRINUSE, which is
 * what keeps it to one process.
 *
 * `--task register` runs `schtasks /Create /XML` for a per-user task at logon and daily 08:00 (no
 * elevation, replaced if present). It is the only thing here that changes the machine, and only when asked by name.
 */

import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { WORKSPACE_ROOT, serverEntryPath } from "./lib/manifest.mjs";
import { parseArgs, resolveServers } from "./lib/cli.mjs";
import { DEPLOY_RECORD, copyOverrides, deployHash, importClosure, nativePackages, staleBuilds } from "./lib/deploy.mjs";
import { linkDir, linkEntries, removeTree } from "./lib/junctions.mjs";
import { err, info, ok } from "./lib/log.mjs";

const SCRIPT = fileURLToPath(import.meta.url);

/** The server's HTTP env var names, or null when it cannot be served over HTTP. */
export function httpEnvNames(server) {
  const port = server.env.find((f) => f.name.endsWith("_HTTP_PORT"))?.name;
  const token = server.env.find((f) => f.name.endsWith("_HTTP_TOKEN"))?.name;
  return port && token ? { port, token } : null;
}

export function httpStateDir() {
  return path.join(os.homedir(), ".claude", "mcp", "http");
}

export function defaultEnvFile(server) {
  return path.join(httpStateDir(), `${server.key}.env.json`);
}

/**
 * R4-4': where install-mcp keeps the stdio entry it replaced, so a `*-stdio` profile in
 * ~/.claude/mcp/build-profiles.mjs can still build a per-session stdio server after the switch.
 */
export function stdioSnapshotFile(server) {
  return path.join(os.homedir(), ".claude", "mcp", "stdio", `${server.key}.json`);
}

/** A stdio entry: it has a command and is not an http registration. */
export function isStdioEntry(entry) {
  return entry !== null && typeof entry === "object" && typeof entry.command === "string" && entry.type !== "http";
}

export function defaultLogFile(server) {
  return path.join(httpStateDir(), `${server.key}.log`);
}

/** `{ env }` from the env file, or null when there is none. Throws on a malformed one. */
export function readEnvFile(file) {
  if (!fs.existsSync(file)) return null;
  const parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
  if (parsed === null || typeof parsed !== "object" || typeof parsed.env !== "object") {
    throw new Error(`${file}: expected { "env": { ... } }`);
  }
  return parsed.env;
}

/** Written owner-only where the platform honours a mode; it holds the token and any secrets. */
export function writeEnvFile(file, env) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ env }, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
}

/** MCP-ISSUE-104: the server's refactor approval secret var, or null when it has none. */
export function approvalSecretEnvName(server) {
  return server.env.find((f) => f.name.endsWith("_REFACTOR_APPROVAL_SECRET"))?.name ?? null;
}

export function approvalSecretFile(server) {
  return path.join(httpStateDir(), `${server.key}.approval-secret`);
}

/**
 * MCP-ISSUE-104: the served process's refactor approval secret, created once and reused, so tokens and
 * previews outlive a restart. The file is the user's alone: mode 0600, and on Windows (which ignores the mode)
 * icacls drops inherited entries and grants only the current user. A file that cannot be locked down is
 * removed and the supervisor refuses to serve.
 */
export function ensureApprovalSecret(file, { user = currentUser(), platform = process.platform } = {}) {
  if (fs.existsSync(file)) {
    const secret = fs.readFileSync(file, "utf-8").trim();
    if (secret.length >= 32) return secret;
    // Empty: a previous start stopped between creating the file and writing the secret. Start over.
    if (secret.length > 0) throw new Error(`${file} holds no usable secret — delete it and restart to generate a new one`);
    fs.rmSync(file, { force: true });
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Created EMPTY and restricted first, so the secret is never on disk under the folder's inherited ACL.
  fs.writeFileSync(file, "", { encoding: "utf-8", mode: 0o600, flag: "wx" });
  if (platform === "win32") {
    try {
      execFileSync("icacls", [file, "/inheritance:r", "/grant:r", `${user}:F`], { stdio: "ignore" });
    } catch (e) {
      fs.rmSync(file, { force: true });
      throw new Error(`could not restrict ${file} to ${user}: ${e.message}`, { cause: e });
    }
  }
  const secret = randomBytes(32).toString("hex");
  fs.writeFileSync(file, `${secret}\n`, { encoding: "utf-8" });
  return secret;
}

/** The client registration for a served server: URL plus header, never the server's env. */
export function httpClientEntry(port, token) {
  return { type: "http", url: `http://127.0.0.1:${port}/mcp`, headers: { Authorization: `Bearer ${token}` } };
}

export function taskName(server) {
  return `mcp-local\\${server.key}-http`;
}

const xmlEscape = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * The task definition, registered from XML because `schtasks /Create` flags cannot express it: the
 * flag form refuses to start on battery, is killed when the laptop leaves AC, has a 72 h execution
 * limit and cuts /TR at 261 characters. Triggers: logon of the current user, plus daily 08:00 with
 * StartWhenAvailable so a missed 08:00 runs on wake. No repetition, no restart-on-failure: a shutdown
 * ends the server and the next logon or morning starts it. `conhost --headless` keeps a console
 * window from opening; the process still gets a console, which node needs for its stdio.
 */
export function taskXml(server, { envFile, logFile, node = process.execPath, script = SCRIPT, user = currentUser() }) {
  const args = `--headless "${node}" "${script}" --server ${server.key} --config "${envFile}" --log "${logFile}"`;
  const u = xmlEscape(user);
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${u}</UserId>
    </LogonTrigger>
    <CalendarTrigger>
      <StartBoundary>2026-01-01T08:00:00</StartBoundary>
      <Enabled>true</Enabled>
      <ScheduleByDay>
        <DaysInterval>1</DaysInterval>
      </ScheduleByDay>
    </CalendarTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${u}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Enabled>true</Enabled>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>conhost.exe</Command>
      <Arguments>${xmlEscape(args)}</Arguments>
    </Exec>
  </Actions>
</Task>
`;
}

function currentUser() {
  const name = os.userInfo().username;
  return process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\${name}` : name;
}

/** The schtasks arguments that register the task from an XML file (no elevation, replaced if present). */
export function taskCreateArgs(server, { xmlFile }) {
  return ["/Create", "/TN", taskName(server), "/XML", xmlFile, "/F"];
}

/**
 * "Access is denied" on /Create /F is not the XML: a task first registered from an elevated prompt
 * keeps an ACL that gives its user read only, so a non-elevated session can neither replace nor
 * delete it (a task this script created is the user's to replace). Remove it once, elevated.
 */
export function taskDeniedHint(server) {
  return `If this was "Access is denied" and ${taskName(server)} already exists, it was created elevated and a normal prompt cannot replace it. Once, from an ELEVATED prompt: schtasks /Delete /TN "${taskName(server)}" /F — then re-run --task register.`;
}

function runTask(server, mode, envFile, logFile) {
  if (mode === "print" || mode === "register") {
    const xml = taskXml(server, { envFile, logFile });
    const xmlFile = path.join(os.tmpdir(), `${server.key}-http-task.xml`);
    const args = taskCreateArgs(server, { xmlFile });
    info(`schtasks ${args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(" ")}`);
    info(xml);
    if (mode === "register") {
      // schtasks reads UTF-16 LE with a BOM.
      fs.writeFileSync(xmlFile, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml, "utf16le")]));
      try {
        execFileSync("schtasks", args, { stdio: "inherit" });
      } catch (e) {
        throw new Error(`${e.message}\n${taskDeniedHint(server)}`, { cause: e });
      } finally {
        fs.rmSync(xmlFile, { force: true });
      }
      ok(`Registered ${taskName(server)} (at logon and daily 08:00). Start it now with: schtasks /Run /TN "${taskName(server)}"`);
    }
    return;
  }
  if (mode === "unregister") {
    execFileSync("schtasks", ["/Delete", "/TN", taskName(server), "/F"], { stdio: "inherit" });
    ok(`Removed ${taskName(server)}`);
    return;
  }
  throw new Error(`--task must be print, register or unregister, got ${mode}`);
}

/** `netstat -ano -p TCP` output: the pid LISTENING on `port`, or null. */
export function parseListenerPid(netstatOut, port) {
  for (const line of netstatOut.split(/\r?\n/)) {
    const m = line.trim().match(/^TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)$/i);
    if (m && m[1] === String(port)) return Number(m[2]);
  }
  return null;
}

const defaultExec = (cmd, args) => execFileSync(cmd, args, { encoding: "utf-8" });
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function psNumber(exec, script) {
  const n = Number(exec("powershell", ["-NoProfile", "-NonInteractive", "-Command", script]).trim());
  return Number.isFinite(n) && n > 0 ? n : null;
}

function isServeHttp(exec, pid) {
  const cmd = exec("powershell", ["-NoProfile", "-NonInteractive", "-Command", `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`]);
  return /serve-http\.mjs/i.test(cmd);
}

function listenerOn(exec, port) {
  return parseListenerPid(exec("netstat", ["-ano", "-p", "TCP"]), port);
}

/**
 * `--restart`: `schtasks /End` does not stop the supervisor, so stop the tree that owns the port instead:
 * the listener's parent (the serve-http supervisor; the listener itself when it has none) — or its parent
 * in turn when that is the tree's hand-off serve-http — with `taskkill /T`,
 * then `schtasks /Run` and wait for a NEW listener, one with another pid whose start time is after the
 * restart began. Every command goes through `exec(cmd, argsArray)`, so the test stubs the machine.
 * Resolves `{ oldPid, newPid }`.
 */
export async function restartServer(server, port, { exec = defaultExec, sleep = defaultSleep, now = Date.now, timeoutMs = 60000 } = {}) {
  const oldPid = listenerOn(exec, port);
  if (oldPid !== null) {
    const parentOf = (pid) => psNumber(exec, `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").ParentProcessId`);
    const parent = parentOf(oldPid);
    let target = parent !== null && parent !== process.pid ? parent : oldPid;
    // The deploy's supervisor runs under the tree's hand-off copy: kill from there, so the task instance
    // has ended before /Run (MultipleInstancesPolicy IgnoreNew drops a /Run while it lives).
    const grand = target === parent ? parentOf(parent) : null;
    if (grand !== null && grand !== process.pid && isServeHttp(exec, grand)) target = grand;
    exec("taskkill", ["/T", "/F", "/PID", String(target)]);
    for (let i = 0; i < 50 && listenerOn(exec, port) !== null; i++) await sleep(200);
  }
  const startedAt = now();
  exec("schtasks", ["/Run", "/TN", taskName(server)]);
  while (now() < startedAt + timeoutMs) {
    const pid = listenerOn(exec, port);
    if (pid !== null && pid !== oldPid) {
      const start = psNumber(exec, `[DateTimeOffset]::new((Get-Process -Id ${pid}).StartTime).ToUnixTimeMilliseconds()`);
      if (start !== null && start >= startedAt) return { oldPid, newPid: pid };
    }
    await sleep(500);
  }
  throw new Error(`${server.key}: no new listener on port ${port} within ${timeoutMs} ms of /Run ${taskName(server)}`);
}

export function defaultDeployRoot() {
  return path.join(os.homedir(), ".claude", "mcp", "deploy");
}

/** Files a server reads at run time from outside its dist/, relative to the server dir. */
const RUNTIME_EXTRAS = { "observe-mcp": ["docs/service-catalog.json"] };

/** How many deploys `pruneDeploys` keeps, newest first; the current and the running one are never removed. */
export const DEPLOYS_KEPT = 2;

/** `{ "@mcp/core": "<root>/packages/core", ... }` from each packages/<dir>/package.json. */
function workspacePackages(root) {
  const out = {};
  const dir = path.join(root, "packages");
  if (!fs.existsSync(dir)) return out;
  for (const name of fs.readdirSync(dir)) {
    const pj = path.join(dir, name, "package.json");
    if (fs.existsSync(pj)) out[JSON.parse(fs.readFileSync(pj, "utf-8")).name] = path.join(dir, name);
  }
  return out;
}

/** The workspace packages `pkgJson` reaches through its dependencies, transitively, sorted. */
export function packageClosure(pkgJson, packages) {
  const seen = new Set();
  const visit = (pj) => {
    for (const dep of Object.keys(pj.dependencies ?? {})) {
      if (!packages[dep] || seen.has(dep)) continue;
      seen.add(dep);
      visit(JSON.parse(fs.readFileSync(path.join(packages[dep], "package.json"), "utf-8")));
    }
  };
  visit(pkgJson);
  return [...seen].sort();
}

/** Builds `node_modules/@mcp` as a real dir whose entries point at the deploy's own package copies. */
function mcpScope(names, deployDir) {
  return (dest) => {
    fs.mkdirSync(dest, { recursive: true });
    for (const name of names) {
      const short = name.slice("@mcp/".length);
      linkDir(path.join(deployDir, "packages", short), path.join(dest, short));
    }
  };
}

function gitHead(root) {
  try {
    return execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf-8" }).trim();
  } catch {
    return null;
  }
}

function gitSha(root) {
  return gitHead(root)?.slice(0, 12) ?? "nogit";
}

function gitDirty(root, paths) {
  try {
    return execFileSync("git", ["-C", root, "status", "--porcelain", "--", ...paths], { encoding: "utf-8" }).trim() !== "";
  } catch {
    return null;
  }
}

/** Every deploy of one server, `{ dir, sha, n }`, newest (highest n) first. */
export function listDeploys(keyDir) {
  if (!fs.existsSync(keyDir)) return [];
  const out = [];
  for (const e of fs.readdirSync(keyDir, { withFileTypes: true })) {
    const m = e.isDirectory() && e.name.match(/^(.+)-(\d+)$/);
    if (m) out.push({ dir: path.join(keyDir, e.name), sha: m[1], n: Number(m[2]) });
  }
  return out.sort((a, b) => b.n - a.n);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return null;
  }
}

function writeJsonAtomic(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
  fs.renameSync(tmp, file);
}

/** The deploy the next start serves (`current.json`), or null. */
export function currentDeploy(server, { deployRoot = defaultDeployRoot() } = {}) {
  const cur = readJson(path.join(deployRoot, server.key, "current.json"));
  return cur && typeof cur.entry === "string" && fs.existsSync(cur.entry) ? cur : null;
}

/** What the supervisor last spawned (`running.json`: dir, sha, entry, pid, startedAt), or null. */
export function runningDeploy(server, { deployRoot = defaultDeployRoot() } = {}) {
  return readJson(path.join(deployRoot, server.key, "running.json"));
}

/**
 * Copy the server's runtime closure out of the working tree, so the served process tree holds nothing
 * under it open (V-A):
 *
 *   <deployRoot>/<key>/<sha>-<n>/
 *     <server dir>/dist, package.json (+ RUNTIME_EXTRAS)   copied
 *     <server dir>/node_modules/                          real dir: each entry a junction to the tree's,
 *                                                         except @mcp/* -> this deploy's packages/*, and
 *                                                         every package with a native binary (and each
 *                                                         that depends on one) COPIED — the OS locks a
 *                                                         loaded .node/.dll, so a junctioned one made
 *                                                         `npm install` in the tree fail EBUSY
 *     packages/<pkg>/dist, package.json                   copied: the server's workspace packages and
 *                                                         @mcp/manifest's, which the supervisor needs
 *     scripts/serve-http.mjs + its imports                copied: the supervisor the logon task hands off to
 *     package.json, tsconfig.base.json                    copied: @mcp/manifest's root markers, so its
 *                                                         WORKSPACE_ROOT is the deploy
 *     node_modules/                                       the root's entries the same way
 *     deploy.json
 *
 * The record proves what was copied: `head` (full HEAD), `dirty` (uncommitted changes under any copied
 * source path), `stale` (dirs whose src/ is newer than their dist/) and `hash` (`deployHash`, which
 * doctor recomputes). Marks the deploy current, then prunes. Returns the record.
 */
export function deployServer(server, { workspaceRoot = WORKSPACE_ROOT, deployRoot = defaultDeployRoot(), head = gitHead(workspaceRoot), sha = head?.slice(0, 12) ?? "nogit", scriptsDir = path.dirname(SCRIPT), now = () => new Date() } = {}) {
  const srcServer = path.join(workspaceRoot, server.dir);
  const pkgJson = JSON.parse(fs.readFileSync(path.join(srcServer, "package.json"), "utf-8"));
  const packages = workspacePackages(workspaceRoot);
  const closure = packageClosure(pkgJson, packages);
  const manifest = packages["@mcp/manifest"];
  const supervisorPackages = manifest ? [...new Set(["@mcp/manifest", ...packageClosure(JSON.parse(fs.readFileSync(path.join(manifest, "package.json"), "utf-8")), packages)])].sort() : [];
  const copied = [...new Set([...closure, ...supervisorPackages])].sort();
  const required = [path.join(srcServer, "dist", "index.js"), ...copied.map((name) => path.join(packages[name], "dist"))];
  const missing = required.filter((p) => !fs.existsSync(p));
  if (missing.length) {
    throw new Error(`${server.key}: not built — missing ${missing.join(", ")}. Run npm run build:packages, then npm run build in ${server.dir}`);
  }
  const supervisorFiles = importClosure(path.join(scriptsDir, path.basename(SCRIPT)));

  const keyDir = path.join(deployRoot, server.key);
  fs.mkdirSync(keyDir, { recursive: true });
  const n = (listDeploys(keyDir)[0]?.n ?? 0) + 1;
  const dir = path.join(keyDir, `${sha}-${n}`);
  fs.mkdirSync(dir);
  const native = {};
  try {
    const destServer = path.join(dir, server.dir);
    fs.mkdirSync(destServer);
    fs.cpSync(path.join(srcServer, "dist"), path.join(destServer, "dist"), { recursive: true });
    fs.copyFileSync(path.join(srcServer, "package.json"), path.join(destServer, "package.json"));
    for (const rel of RUNTIME_EXTRAS[server.dir] ?? []) {
      if (!fs.existsSync(path.join(srcServer, rel))) continue;
      fs.mkdirSync(path.dirname(path.join(destServer, rel)), { recursive: true });
      fs.copyFileSync(path.join(srcServer, rel), path.join(destServer, rel));
    }
    for (const name of copied) {
      const dest = path.join(dir, "packages", name.slice("@mcp/".length));
      fs.mkdirSync(dest, { recursive: true });
      fs.cpSync(path.join(packages[name], "dist"), path.join(dest, "dist"), { recursive: true });
      fs.copyFileSync(path.join(packages[name], "package.json"), path.join(dest, "package.json"));
    }
    for (const rel of supervisorFiles) {
      const dest = path.join(dir, "scripts", ...rel.split("/"));
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(path.join(scriptsDir, ...rel.split("/")), dest);
    }
    for (const marker of ["package.json", "tsconfig.base.json"]) {
      if (fs.existsSync(path.join(workspaceRoot, marker))) fs.copyFileSync(path.join(workspaceRoot, marker), path.join(dir, marker));
    }
    const base = { "@mcp": mcpScope(copied, dir) };
    for (const [rel, src, dest] of [[server.dir, srcServer, destServer], [".", workspaceRoot, dir]]) {
      native[rel] = nativePackages(path.join(src, "node_modules"));
      linkEntries(path.join(src, "node_modules"), path.join(dest, "node_modules"), { override: copyOverrides(native[rel], { linkEntries, base }) });
    }
  } catch (e) {
    removeTree(dir);
    throw e;
  }
  const builtDirs = [server.dir, ...copied.map((name) => path.relative(workspaceRoot, packages[name]).split(path.sep).join("/"))];
  const record = {
    key: server.key,
    sha,
    n,
    dir,
    entry: path.join(dir, server.dir, "dist", "index.js"),
    supervisor: supervisorFiles.length ? path.join(dir, "scripts", path.basename(SCRIPT)) : null,
    source: workspaceRoot,
    head,
    dirty: gitDirty(workspaceRoot, [...builtDirs, ...supervisorFiles.map((rel) => path.relative(workspaceRoot, path.join(scriptsDir, rel)))].filter((p) => !p.startsWith("..") && !path.isAbsolute(p))),
    stale: staleBuilds(workspaceRoot, builtDirs),
    hash: deployHash(dir),
    packages: closure,
    supervisorPackages,
    native,
    createdAt: now().toISOString()
  };
  writeJsonAtomic(path.join(dir, DEPLOY_RECORD), record);
  writeJsonAtomic(path.join(keyDir, "current.json"), record);
  return { ...record, pruned: pruneDeploys(server, { deployRoot }) };
}

/**
 * Keep the newest `keep` deploys; delete the rest with `removeTree`, which unlinks every junction and
 * never walks into it. The current deploy and the running one are never removed, and a deploy still
 * locked by a live process (Windows) is left for the next prune. Returns the dirs removed.
 */
export function pruneDeploys(server, { deployRoot = defaultDeployRoot(), keep = DEPLOYS_KEPT } = {}) {
  const keyDir = path.join(deployRoot, server.key);
  const spared = new Set([runningDeploy(server, { deployRoot })?.dir, currentDeploy(server, { deployRoot })?.dir]);
  const removed = [];
  for (const d of listDeploys(keyDir).slice(keep)) {
    if (spared.has(d.dir)) continue;
    try {
      removeTree(d.dir);
      removed.push(d.dir);
    } catch (e) {
      err(`${server.key}: could not remove old deploy ${d.dir} (${e.code ?? e.message}); the next deploy retries`);
    }
  }
  return removed;
}

/**
 * The entry the supervisor spawns: its own deploy's when it runs from one, else the current deploy's or,
 * when there is none yet, the working tree's (the caller warns), so a first start before any deploy still serves.
 */
export function resolveServeEntry(server, { deployRoot = defaultDeployRoot(), own = ownDeploy() } = {}) {
  const deploy = own ?? currentDeploy(server, { deployRoot });
  return deploy ? { entry: deploy.entry, deploy } : { entry: serverEntryPath(server), deploy: null };
}

const samePath = (a, b) => typeof a === "string" && typeof b === "string" && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

/** The deploy record this script was copied into (`<deploy>/scripts/serve-http.mjs`), or null when it runs from the tree. */
export function ownDeploy(script = SCRIPT) {
  const record = readJson(path.join(path.dirname(script), "..", DEPLOY_RECORD));
  return record && samePath(record.supervisor, script) ? record : null;
}

/**
 * Recompute a deploy's hash and compare it with its record: `{ record, recorded, actual, ok }`, or null
 * when the dir or its record is gone. A mismatch means the copy changed after the deploy.
 */
export function verifyDeploy(dir) {
  const record = dir ? readJson(path.join(dir, DEPLOY_RECORD)) : null;
  if (!record) return null;
  const actual = deployHash(dir);
  return { record, recorded: record.hash ?? null, actual, ok: record.hash === actual };
}

/**
 * mcp:doctor's `[deploy]` verdict from `currentDeploy`, `runningDeploy` and `verifyDeploy` of the running
 * copy: `[status, message]`. It names HEAD, the dirty flag and the hash; a hash mismatch fails; a dirty or
 * stale build, a deploy waiting for --restart or a supervisor still running from the tree warns.
 */
export function deployCheck(current, running, { verify = verifyDeploy } = {}) {
  if (!running) return ["warn", "the supervisor has not recorded a start since deploys began — --restart serves a deploy copy"];
  const ran = `pid ${running.pid}`;
  if (!running.dir) return ["warn", `${ran} serves the working tree's dist, so a build there changes it live`];
  const v = verify(running.dir);
  const rec = v?.record ?? {};
  const head = rec.head ? `HEAD ${rec.head.slice(0, 12)}` : "HEAD unknown";
  const dirty = rec.dirty === true ? "dirty" : rec.dirty === false ? "clean" : "dirty unknown";
  const hash = v?.recorded ? `hash ${v.recorded.slice(0, 12)}` : "no hash";
  const what = `${ran} runs ${running.sha} (${head}, ${dirty}, ${hash}) from ${running.dir}`;
  if (v?.recorded && !v.ok) return ["fail", `${what}; the copy now hashes ${v.actual.slice(0, 12)} — it changed after the deploy`];
  const warns = [];
  if (!v?.recorded) warns.push("the deploy records no content hash (made before deploy isolation)");
  if (rec.dirty === true) warns.push("deployed with uncommitted changes, so HEAD does not say what it runs");
  if (rec.stale?.length) warns.push(`deployed from a stale build of ${rec.stale.join(", ")} (src newer than dist)`);
  if (!running.supervisor) warns.push("the supervisor runs from the working tree");
  if (current && current.dir !== running.dir) warns.push(`deploy ${current.sha}-${current.n} is waiting for --restart`);
  return warns.length ? ["warn", `${what}; ${warns.join("; ")}`] : ["pass", what];
}

/**
 * The logon task starts the tree's serve-http.mjs. When the current deploy carries a supervisor copy, the
 * tree's copy only hands off: it leaves the tree (chdir), runs the deploy's supervisor with the same
 * arguments and waits, so nothing in the served process tree keeps a file or directory under the tree open.
 */
function handOff(deploy) {
  process.chdir(deploy.dir);
  const child = spawn(process.execPath, [deploy.supervisor, ...process.argv.slice(2)], { cwd: deploy.dir, stdio: "inherit" });
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
  child.on("exit", (code) => process.exit(code ?? 1));
}

function serve(server, envFile, logFile, deployRoot) {
  const own = ownDeploy();
  if (!own) {
    const current = currentDeploy(server, { deployRoot });
    if (current?.supervisor && fs.existsSync(current.supervisor)) return handOff(current);
  }
  const names = httpEnvNames(server);
  const env = readEnvFile(envFile);
  if (env === null) {
    throw new Error(`no env file at ${envFile} — run: node scripts/install-mcp.mjs --server ${server.key} --transport http`);
  }
  if (!env[names.port] || !env[names.token]) {
    throw new Error(`${envFile} must set ${names.port} and ${names.token}`);
  }
  // MCP-ISSUE-104: a secret the env file sets wins; otherwise the persisted one (the server refuses HTTP without).
  const secretName = approvalSecretEnvName(server);
  const secretEnv = secretName && !env[secretName] ? { [secretName]: ensureApprovalSecret(approvalSecretFile(server)) } : {};
  const stderr = logFile ? fs.openSync(logFile, "a") : "inherit";
  const { entry, deploy } = resolveServeEntry(server, { deployRoot, own });
  if (!deploy) err(`${server.key}: no deploy yet — serving from the working tree; --deploy-only or --restart makes one`);
  if (own) process.chdir(own.dir);
  // Inherit PATH and the like; every server setting comes from the env file and wins.
  const child = spawn(process.execPath, [entry, "--transport", "http"], {
    cwd: deploy?.dir,
    env: { ...process.env, ...env, ...secretEnv },
    stdio: ["ignore", "ignore", stderr]
  });
  const keyDir = path.join(deployRoot, server.key);
  fs.mkdirSync(keyDir, { recursive: true });
  writeJsonAtomic(path.join(keyDir, "running.json"), {
    dir: deploy?.dir ?? null,
    sha: deploy?.sha ?? null,
    entry,
    supervisor: own ? SCRIPT : null,
    pid: child.pid,
    startedAt: new Date().toISOString()
  });
  info(`${server.key}: serving on http://127.0.0.1:${env[names.port]}/mcp (pid ${child.pid}) from ${deploy ? deploy.dir : "the working tree"}`);
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
  child.on("exit", (code, signal) => {
    if (code !== 0) err(`${server.key}: exited ${signal ?? code}${logFile ? ` — see ${logFile}` : ""}`);
    process.exit(code ?? 1);
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2), { restart: ["--restart"], deployOnly: ["--deploy-only"] }, { config: ["--config"], log: ["--log"], task: ["--task"], deployRoot: ["--deploy-root"] });
  if (args.servers.length !== 1) throw new Error("pass exactly one --server <key>");
  const [server] = resolveServers(args.servers);
  if (httpEnvNames(server) === null) {
    throw new Error(`${server.key} declares no *_HTTP_PORT / *_HTTP_TOKEN env vars — it cannot be served over HTTP`);
  }
  const envFile = path.resolve(args.config ?? defaultEnvFile(server));
  const logFile = args.log ? path.resolve(args.log) : null;
  const deployRoot = args.deployRoot ? path.resolve(args.deployRoot) : defaultDeployRoot();
  if (args.restart || args.deployOnly) {
    const port = readEnvFile(envFile)?.[httpEnvNames(server).port];
    if (args.restart && !port) throw new Error(`${envFile} must set ${httpEnvNames(server).port}`);
    const d = deployServer(server, { deployRoot });
    const pruned = d.pruned.length ? `; removed ${d.pruned.length} older` : "";
    const flags = [d.dirty ? "uncommitted changes" : null, d.stale.length ? `stale build: ${d.stale.join(", ")}` : null].filter(Boolean);
    ok(`${server.key}: deployed ${d.sha}${flags.length ? ` (${flags.join("; ")})` : ""}, hash ${d.hash.slice(0, 12)}, to ${d.dir}${pruned}`);
    if (args.deployOnly) return;
    const { oldPid, newPid } = await restartServer(server, port);
    ok(`${server.key}: restarted, pid ${oldPid ?? "none"} -> ${newPid}`);
    return;
  }
  if (args.task) {
    runTask(server, args.task, envFile, logFile ?? defaultLogFile(server));
    return;
  }
  serve(server, envFile, logFile, deployRoot);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((e) => {
    err(e.message);
    process.exit(1);
  });
}
