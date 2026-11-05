#!/usr/bin/env node
/**
 * Run one command inside the machine-wide heavy-check lock (`scripts/lib/heavyLock.mjs`).
 *
 * The root `verify:*` scripts wrap their step chains with this, so `npm run verify:all` waits for
 * another session's gate instead of racing it. Exit code is the command's; 75 when the lock times out; 76 when
 * the run stopped waiting because an ancestor that was alive when it began waiting died (its session is
 * gone — e.g. TaskStop killed the shell but not this child). Neither code means the check failed.
 *
 * Usage:
 *   node scripts/heavy-lock.mjs [--no-lock] -- <command> [args...]
 *   node scripts/heavy-lock.mjs status [--json]
 *   node scripts/heavy-lock.mjs deploy [--deploy-root <dir>] [--allow-dirty] [--json]
 *
 * `deploy` (H-5) writes the self-contained copy other repos run: `~/.claude/mcp/deploy/heavy-lock/heavy-lock.mjs`
 * (see `deployHeavyLock`). A leader runs it; tests pass a scratch `--deploy-root`.
 *
 * The lock is first come, first served (H-2): a caller takes a ticket on arrival and only the oldest
 * live ticket may take the lock, however often the others poll.
 *
 * `status` is read-only (it only removes registry entries of dead waiters and silent tickets): the
 * holder and every waiter in ticket order with its position, each with its repo and Claude session id
 * (`unknown` when they cannot be told), its pid, command, cwd, since when, whether it is alive, whether a recorded ancestor
 * is gone (`launcher gone (session alive)`) and whether its whole recorded chain up to the session is
 * gone (`ORPHAN`). For a holder flagged either way it keeps the first sighting in `<lock>.orphan.json`
 * (`orphanSince`) and, after
 * `MCP_HEAVY_LOCK_ORPHAN_MINUTES` (default 10), prints `taskkill /PID <pid> /T /F` — a command a leader
 * runs only on the owner's yes. It kills nothing and never frees a lock whose holder lives.
 */

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { DEPLOY_RECORD, deployHash, foreignImports, importClosure } from "./lib/deploy.mjs";
import { formatHeavyLockStatus, heavyLockStatus, holdHeavyLockOrExit } from "./lib/heavyLock.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEPLOYS_KEPT = 3;

/**
 * The deploy copy (row H-5, 2026-11-05). Other repos' wrappers (wec.be's `dotnet-build-safe.ps1`) ran this
 * script straight from the main tree, so every merge changed their lock at once. `deploy` copies this
 * script and every module it imports (`importClosure`, then `foreignImports` proves no other import —
 * bare, single-quoted or dynamic — is left: builtins only, no node_modules) to
 * `<deployRoot>/heavy-lock/<sha>-<n>/scripts/`, records it in `deploy.json` (`head`, `dirty`, `hash`),
 * points `current.json` at it and copies the stable entry (`lib/heavyLockEntry.mjs`) to
 * `<deployRoot>/heavy-lock/heavy-lock.mjs`, which runs the current copy and exits 78 when the deploy is
 * broken. Each write is temp + rename, so a caller starting mid-deploy runs the old copy or the new one,
 * whole. The lock itself is the same either way: its name comes from the lock path, not from where the
 * script lives. Only an explicit `deploy` changes what other repos run. It refuses uncommitted copied
 * files, or a tree whose git cannot say, unless `allowDirty`; a version it cannot prune is reported in
 * `pruneSkipped`, never a failed deploy (current.json has already moved by then).
 */
function deployHeavyLock(deployRoot, { allowDirty = false } = {}) {
  if (fs.existsSync(path.join(HERE, "..", DEPLOY_RECORD))) throw new Error("this is a deployed copy: run deploy from the source tree");
  const git = (args) => {
    try {
      return execFileSync("git", args, { cwd: HERE, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
      return null;
    }
  };
  const files = importClosure(path.join(HERE, "heavy-lock.mjs"));
  const foreign = foreignImports(HERE, files);
  if (foreign.length > 0) throw new Error(`the copy would not be self-contained: ${foreign.map((f) => `${f.file} imports ${f.specifier}`).join("; ")}`);
  const entrySource = path.join(HERE, "lib", "heavyLockEntry.mjs");
  const head = git(["rev-parse", "HEAD"]);
  const changed = git(["status", "--porcelain", "--", ...files, "lib/heavyLockEntry.mjs"]);
  if (!allowDirty && (head === null || changed === null)) throw new Error("git cannot tell whether the copied files are committed; --allow-dirty deploys anyway");
  if (!allowDirty && changed !== "") throw new Error(`uncommitted changes in the copied files:\n${changed}\n--allow-dirty deploys anyway`);
  const sha = head?.slice(0, 12) ?? "nogit";
  const keyDir = path.join(deployRoot, "heavy-lock");
  fs.mkdirSync(keyDir, { recursive: true });
  const deploys = () =>
    fs
      .readdirSync(keyDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && /-\d+$/.test(e.name))
      .map((e) => ({ name: e.name, n: Number(/-(\d+)$/.exec(e.name)[1]) }))
      .sort((a, b) => b.n - a.n);
  const n = (deploys()[0]?.n ?? 0) + 1;
  const name = `${sha}-${String(n)}`;
  const dir = path.join(keyDir, name);
  for (const rel of files) {
    const dest = path.join(dir, "scripts", ...rel.split("/"));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(HERE, ...rel.split("/")), dest);
  }
  const record = {
    key: "heavy-lock",
    sha,
    n,
    dir,
    // Relative to the key dir, so the stable entry finds it wherever the deploy root is.
    entry: `${name}/scripts/heavy-lock.mjs`,
    source: HERE,
    head,
    dirty: changed === null ? null : changed !== "",
    files,
    hash: deployHash(dir),
    createdAt: new Date().toISOString()
  };
  const writeAtomic = (file, content) => {
    const tmp = `${file}.${String(process.pid)}.tmp`;
    fs.writeFileSync(tmp, content);
    fs.renameSync(tmp, file);
  };
  writeAtomic(path.join(dir, DEPLOY_RECORD), JSON.stringify(record, null, 2));
  // The entry first: a new entry reads the old current.json fine; the old entry never meets a new layout.
  const stable = path.join(keyDir, "heavy-lock.mjs");
  writeAtomic(stable, fs.readFileSync(entrySource));
  writeAtomic(path.join(keyDir, "current.json"), JSON.stringify(record, null, 2));
  // Keep the newest few; a copy is never held open (node reads its modules at start), so removing an old
  // one is safe — but Windows can refuse (EBUSY, a scanner): report it and leave it for the next deploy.
  const pruned = [];
  const pruneSkipped = [];
  for (const d of deploys().slice(DEPLOYS_KEPT)) {
    if (d.name === name) continue;
    try {
      fs.rmSync(path.join(keyDir, d.name), { recursive: true, force: true });
      pruned.push(d.name);
    } catch (error) {
      pruneSkipped.push({ name: d.name, error: String(error.code ?? error.message) });
    }
  }
  return { ...record, stable, pruned, pruneSkipped };
}

const argv = process.argv.slice(2);
if (argv[0] === "deploy") {
  const at = argv.indexOf("--deploy-root");
  const value = at === -1 ? null : argv[at + 1];
  if (at !== -1 && (value === undefined || value === "" || value.startsWith("--"))) {
    console.error("usage: node scripts/heavy-lock.mjs deploy [--deploy-root <dir>] [--allow-dirty] [--json] — --deploy-root needs a directory");
    process.exit(2);
  }
  const deployRoot = value === null ? path.join(os.homedir(), ".claude", "mcp", "deploy") : path.resolve(value);
  try {
    const d = deployHeavyLock(deployRoot, { allowDirty: argv.includes("--allow-dirty") });
    console.log(
      argv.includes("--json")
        ? JSON.stringify(d, null, 2)
        : `deployed heavy-lock ${d.sha}-${String(d.n)}${d.dirty !== false ? " (DIRTY or unknown: --allow-dirty)" : ""}\n  run: node ${d.stable}\n  copy: ${d.dir}` +
            (d.pruneSkipped.length ? `\n  could not prune: ${d.pruneSkipped.map((p) => `${p.name} (${p.error})`).join(", ")}` : "")
    );
    process.exit(0);
  } catch (error) {
    console.error(`heavy-lock deploy refused: ${error.message}`);
    process.exit(1);
  }
}
if (argv[0] === "status") {
  const status = await heavyLockStatus();
  console.log(argv.includes("--json") ? JSON.stringify(status, null, 2) : formatHeavyLockStatus(status));
  process.exit(0);
}
const sep = argv.indexOf("--");
const own = sep === -1 ? [] : argv.slice(0, sep);
const command = sep === -1 ? argv : argv.slice(sep + 1);

if (command.length === 0) {
  console.error(
    "usage: node scripts/heavy-lock.mjs [--no-lock] -- <command> [args...]\n       node scripts/heavy-lock.mjs status [--json]\n       node scripts/heavy-lock.mjs deploy [--deploy-root <dir>] [--allow-dirty] [--json]"
  );
  process.exit(2);
}

const lock = await holdHeavyLockOrExit({ cmd: command.join(" "), noLock: own.includes("--no-lock") });
// `npm` is `npm.cmd` on Windows, which needs a shell; a shell joins arguments with bare spaces, so
// quote the ones that contain any.
const args = process.platform === "win32" ? command.slice(1).map((a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)) : command.slice(1);
const result = spawnSync(command[0], args, { stdio: "inherit", shell: process.platform === "win32" });
if (lock.acquired) lock.release();

if (result.error !== undefined) {
  console.error(`could not start ${command[0]}: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
