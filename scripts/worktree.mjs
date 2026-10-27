#!/usr/bin/env node

/**
 * A git worktree of this workspace that can build and test at once (V-B).
 *
 *   node scripts/worktree.mjs add <name> [--base <sha>]   # ../<repo>-wt-<name> on branch wt/<name>, node_modules linked
 *   node scripts/worktree.mjs remove <name> [--force]     # unlink node_modules, then git worktree remove
 *   node scripts/worktree.mjs list
 *
 * A fresh worktree has no node_modules, and `npm install` in each of the seven trees costs minutes and
 * gigabytes. So `add` makes every node_modules the main tree has (the root's, each server's, each
 * package's) a REAL directory in the worktree holding one junction per entry to the main tree's — except
 * `@mcp/*`, which point at the WORKTREE's packages/*, or every build and test there would run main's
 * packages. Junctioning a whole node_modules would carry main's `@mcp` links with it.
 *
 * `remove` unlinks those junctions one by one (scripts/lib/junctions.mjs `removeTree`, which never walks
 * a link) before `git worktree remove`, so nothing in the main tree is reachable while anything deletes.
 * It refuses a worktree with uncommitted or untracked changes unless --force. The branch is kept: it may
 * hold commits not merged yet.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { isLink, linkDir, linkEntries, removeTree } from "./lib/junctions.mjs";
import { err, info, ok } from "./lib/log.mjs";

const git = (cwd, args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8" }).trim();

/** The main tree: the parent of git's common dir, so this works from inside a worktree too. */
export function mainRoot(cwd = process.cwd()) {
  return path.dirname(path.resolve(cwd, git(cwd, ["rev-parse", "--git-common-dir"])));
}

export function validName(name) {
  return typeof name === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name);
}

export function worktreePath(main, name) {
  return path.join(path.dirname(main), `${path.basename(main)}-wt-${name}`);
}

/**
 * The dirs (relative to the root) whose node_modules a worktree needs: the root, and every top-level
 * dir or packages/* dir with a package.json and a node_modules in the main tree.
 */
export function nodeModulesDirs(main) {
  const dirs = [];
  const consider = (rel) => {
    const abs = path.join(main, rel);
    if (fs.existsSync(path.join(abs, "package.json")) && fs.existsSync(path.join(abs, "node_modules"))) dirs.push(rel);
  };
  consider(".");
  for (const e of fs.readdirSync(main, { withFileTypes: true })) {
    if (e.isDirectory() && e.name !== "node_modules" && !e.name.startsWith(".")) consider(e.name);
  }
  if (fs.existsSync(path.join(main, "packages"))) {
    for (const e of fs.readdirSync(path.join(main, "packages"), { withFileTypes: true })) {
      if (e.isDirectory()) consider(path.join("packages", e.name));
    }
  }
  return dirs;
}

/** `{ "@mcp/core": "packages/core", ... }`: each workspace package by name, relative to the root. */
function workspacePackages(root) {
  const out = {};
  const dir = path.join(root, "packages");
  if (!fs.existsSync(dir)) return out;
  for (const name of fs.readdirSync(dir)) {
    const pj = path.join(dir, name, "package.json");
    if (fs.existsSync(pj)) out[JSON.parse(fs.readFileSync(pj, "utf-8")).name] = path.join("packages", name);
  }
  return out;
}

/**
 * Build each `<wt>/<dir>/node_modules` from the main tree's: a real dir of per-entry junctions to main,
 * with `@mcp` a real dir whose entries point at the worktree's own packages (main's for a name that is
 * not a workspace package). Returns `{ dir, entries }` per dir linked.
 */
export function linkNodeModules(main, wt, dirs = nodeModulesDirs(main)) {
  const packages = workspacePackages(main);
  const mcpScope = (dest, src) => {
    fs.mkdirSync(dest, { recursive: true });
    for (const short of fs.readdirSync(src)) {
      const own = packages[`@mcp/${short}`];
      linkDir(own ? path.join(wt, own) : fs.realpathSync(path.join(src, short)), path.join(dest, short));
    }
  };
  const out = [];
  for (const dir of dirs) {
    const dest = path.join(wt, dir, "node_modules");
    if (fs.existsSync(dest) || isLink(dest)) throw new Error(`${dest} already exists — remove it (never recursively) first`);
    const entries = linkEntries(path.join(main, dir, "node_modules"), dest, { override: { "@mcp": mcpScope } });
    out.push({ dir, entries: entries.length });
  }
  return out;
}

/** Unlink every `<wt>/<dir>/node_modules`: each junction as a link, then the emptied real dirs. */
export function unlinkNodeModules(wt, dirs) {
  const removed = [];
  for (const dir of dirs) {
    const nm = path.join(wt, dir, "node_modules");
    if (!fs.existsSync(nm) && !isLink(nm)) continue;
    removeTree(nm);
    removed.push(dir);
  }
  return removed;
}

export function addWorktree(name, { cwd = process.cwd(), base = "HEAD", dirs } = {}) {
  if (!validName(name)) throw new Error(`bad worktree name ${JSON.stringify(name)}: letters, digits, . _ - only`);
  const main = mainRoot(cwd);
  const wt = worktreePath(main, name);
  if (fs.existsSync(wt)) throw new Error(`${wt} already exists`);
  git(main, ["worktree", "add", "-b", `wt/${name}`, wt, base]);
  try {
    return { path: wt, branch: `wt/${name}`, linked: linkNodeModules(main, wt, dirs ?? nodeModulesDirs(main)) };
  } catch (e) {
    unlinkNodeModules(wt, dirs ?? nodeModulesDirs(main));
    throw e;
  }
}

export function removeWorktree(name, { cwd = process.cwd(), force = false, dirs } = {}) {
  if (!validName(name)) throw new Error(`bad worktree name ${JSON.stringify(name)}`);
  const main = mainRoot(cwd);
  const wt = worktreePath(main, name);
  if (!fs.existsSync(wt)) throw new Error(`no worktree at ${wt}`);
  if (path.resolve(cwd).toLowerCase().startsWith(wt.toLowerCase())) throw new Error(`run remove from outside ${wt}`);
  const dirty = git(wt, ["status", "--porcelain"]);
  if (dirty && !force) throw new Error(`${wt} has uncommitted changes — commit or stash them, or pass --force:\n${dirty}`);
  const unlinked = unlinkNodeModules(wt, dirs ?? nodeModulesDirs(main));
  git(main, ["worktree", "remove", ...(force ? ["--force"] : []), wt]);
  return { path: wt, unlinked };
}

/** `git worktree list --porcelain` as `{ path, head, branch, linked }`, linked = has a root node_modules. */
export function listWorktrees({ cwd = process.cwd() } = {}) {
  const main = mainRoot(cwd);
  const out = [];
  for (const block of git(main, ["worktree", "list", "--porcelain"]).split(/\r?\n\r?\n/)) {
    const row = Object.fromEntries(block.split(/\r?\n/).map((l) => [l.split(" ")[0], l.slice(l.indexOf(" ") + 1)]));
    if (!row.worktree) continue;
    const p = path.resolve(row.worktree);
    out.push({ path: p, head: row.HEAD?.slice(0, 12) ?? null, branch: row.branch?.replace("refs/heads/", "") ?? "(detached)", linked: fs.existsSync(path.join(p, "node_modules")) });
  }
  return out;
}

function main() {
  const [cmd, name, ...rest] = process.argv.slice(2);
  const flag = (f) => rest.includes(f);
  const value = (f) => (rest.includes(f) ? rest[rest.indexOf(f) + 1] : undefined);
  if (cmd === "add") {
    const r = addWorktree(name, { base: value("--base") ?? "HEAD" });
    ok(`${r.path} on ${r.branch}; node_modules linked in ${r.linked.length} dirs (${r.linked.reduce((n, d) => n + d.entries, 0)} entries)`);
  } else if (cmd === "remove") {
    const r = removeWorktree(name, { force: flag("--force") });
    ok(`removed ${r.path} (node_modules unlinked in ${r.unlinked.length} dirs; branch kept)`);
  } else if (cmd === "list") {
    for (const w of listWorktrees()) info(`${w.path}  ${w.head}  ${w.branch}${w.linked ? "" : "  (no node_modules)"}`);
  } else {
    throw new Error("usage: worktree.mjs add <name> [--base <sha>] | remove <name> [--force] | list");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    main();
  } catch (e) {
    err(e.message);
    process.exit(1);
  }
}
