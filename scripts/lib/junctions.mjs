// Junction helpers shared by `serve-http.mjs` (the deploy copy) and `worktree.mjs`.
//
// The one rule both callers depend on: a junction is removed as a LINK, never walked. `rm -r` on a
// tree that holds a junction follows it on some platforms and empties the main tree's node_modules;
// `removeTree` lstat's every entry and unlinks a link without looking inside it.

import fs from "node:fs";
import path from "node:path";

/** A directory link that needs no elevation: a junction on Windows, a dir symlink elsewhere. */
export function linkDir(target, linkPath) {
  fs.symlinkSync(path.resolve(target), linkPath, "junction");
}

/** True for a junction or symlink (lstat reports a junction as a symbolic link). */
export function isLink(p) {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Remove one link without touching what it points at. */
export function unlinkDir(p) {
  try {
    fs.unlinkSync(p);
  } catch (e) {
    // Some Windows builds refuse unlink on a directory junction; rmdir removes the reparse point only.
    if (e.code !== "EPERM" && e.code !== "EISDIR") throw e;
    fs.rmdirSync(p);
  }
}

/**
 * `dest` (created) becomes a real directory holding one entry per entry of `src`: a directory is a
 * junction to its source, a file is copied (a file symlink needs elevation on Windows). `override`
 * maps an entry name to a function `(destEntryPath, srcEntryPath) => void` that builds it instead —
 * how `@mcp` gets its own real directory. Returns the names linked.
 */
export function linkEntries(src, dest, { override = {} } = {}) {
  fs.mkdirSync(dest, { recursive: true });
  const names = [];
  if (!fs.existsSync(src)) return names;
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (override[entry.name]) {
      override[entry.name](to, from);
    } else if (entry.isDirectory() || entry.isSymbolicLink()) {
      let isDir = entry.isDirectory();
      if (!isDir) {
        try {
          isDir = fs.statSync(from).isDirectory();
        } catch {
          continue; // a dangling link in the source: nothing to point at
        }
      }
      if (isDir) linkDir(fs.realpathSync(from), to);
      else fs.copyFileSync(from, to);
    } else if (entry.isFile()) {
      fs.copyFileSync(from, to);
    }
    names.push(entry.name);
  }
  return names;
}

/**
 * Delete `dir` and everything under it, removing every link as a link: nothing reachable only
 * through a junction is ever read or deleted. A missing `dir` is a no-op.
 */
export function removeTree(dir) {
  let st;
  try {
    st = fs.lstatSync(dir);
  } catch (e) {
    if (e.code === "ENOENT") return;
    throw e;
  }
  if (st.isSymbolicLink()) {
    unlinkDir(dir);
    return;
  }
  if (!st.isDirectory()) {
    fs.rmSync(dir, { force: true });
    return;
  }
  for (const name of fs.readdirSync(dir)) removeTree(path.join(dir, name));
  fs.rmdirSync(dir);
}
