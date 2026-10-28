// Helpers for the V-A deploy copy (`serve-http.mjs`): what must be copied rather than junctioned, which
// supervisor files go with it, and the content hash that proves what a deploy holds.
//
// Builtins only, and no import from the manifest: the copied supervisor loads this file from the deploy.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** A file the OS maps into the process (LoadLibrary/dlopen) and so keeps locked while it runs. */
const NATIVE_FILE = /\.(node|dll|so|dylib)$/i;

function hasNativeFile(dir, depth) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const e of entries) {
    if (e.isFile() && NATIVE_FILE.test(e.name)) return true;
    if (e.isDirectory() && e.name !== "node_modules" && depth > 0 && hasNativeFile(path.join(dir, e.name), depth - 1)) return true;
  }
  return false;
}

/** `{ "<name>": "<dir>" }` for every package directly in one node_modules, scoped ones expanded. */
function packagesIn(nodeModules) {
  const out = {};
  if (!fs.existsSync(nodeModules)) return out;
  for (const e of fs.readdirSync(nodeModules, { withFileTypes: true })) {
    if (e.name.startsWith(".") || e.name === "@mcp") continue;
    const dir = path.join(nodeModules, e.name);
    if (!e.name.startsWith("@")) {
      out[e.name] = dir;
      continue;
    }
    for (const inner of fs.readdirSync(dir)) out[`${e.name}/${inner}`] = path.join(dir, inner);
  }
  return out;
}

function dependencyNames(dir) {
  try {
    const pj = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf-8"));
    return [...Object.keys(pj.dependencies ?? {}), ...Object.keys(pj.optionalDependencies ?? {})];
  } catch {
    return [];
  }
}

/**
 * The packages of one node_modules that a deploy must COPY: each one holding a native binary, plus each
 * package that depends on one of those (a junctioned loader resolves from its real path, so it would
 * load the tree's binary — sqlite-vec -> sqlite-vec-windows-x64). Sorted.
 */
export function nativePackages(nodeModules, { depth = 4 } = {}) {
  const pkgs = packagesIn(nodeModules);
  const copied = new Set(Object.keys(pkgs).filter((name) => hasNativeFile(pkgs[name], depth)));
  for (let grew = copied.size > 0; grew; ) {
    grew = false;
    for (const name of Object.keys(pkgs)) {
      if (!copied.has(name) && dependencyNames(pkgs[name]).some((d) => copied.has(d))) {
        copied.add(name);
        grew = true;
      }
    }
  }
  return [...copied].sort();
}

/** Copy one package's own files (through a junction, if it is one); its nested node_modules is linked. */
export function copyPackage(src, dest, { linkEntries }) {
  const real = fs.realpathSync(src);
  fs.cpSync(real, dest, { recursive: true, filter: (p) => p === real || path.basename(p) !== "node_modules" });
  if (fs.existsSync(path.join(real, "node_modules"))) linkEntries(path.join(real, "node_modules"), path.join(dest, "node_modules"));
}

/**
 * `linkEntries` overrides that copy the given packages instead of junctioning them; a scoped package
 * makes its scope a real dir whose other entries stay junctions. Merged over `base` (the @mcp scope).
 */
export function copyOverrides(names, { linkEntries, base = {} }) {
  const override = { ...base };
  const scoped = {};
  for (const name of names) {
    const [scope, inner] = name.startsWith("@") ? name.split("/") : [null, name];
    if (scope) (scoped[scope] ??= []).push(inner);
    else override[name] = (to, from) => copyPackage(from, to, { linkEntries });
  }
  for (const [scope, inners] of Object.entries(scoped)) {
    const innerOverride = Object.fromEntries(inners.map((n) => [n, (to, from) => copyPackage(from, to, { linkEntries })]));
    override[scope] = (to, from) => linkEntries(from, to, { override: innerOverride });
  }
  return override;
}

const RELATIVE_IMPORT = /^\s*(?:import|export)\s(?:[^;]*?\sfrom\s)?\s*"(\.{1,2}\/[^"]+)"/gm;

/** The script and every module it reaches through static relative imports, as paths relative to `dir`, sorted. */
export function importClosure(entry, dir = path.dirname(entry)) {
  const seen = new Set();
  const visit = (file) => {
    const rel = path.relative(dir, file).split(path.sep).join("/");
    if (seen.has(rel)) return;
    seen.add(rel);
    for (const m of fs.readFileSync(file, "utf-8").matchAll(RELATIVE_IMPORT)) visit(path.resolve(path.dirname(file), m[1]));
  };
  visit(entry);
  return [...seen].sort();
}

function walkFiles(dir, rel, out, skip) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (skip(r, e)) continue;
    if (e.isDirectory()) walkFiles(path.join(dir, e.name), r, out, skip);
    else if (e.isFile()) out.push(r);
  }
  return out;
}

/** The file name inside a deploy that holds its record; it is not part of the hash. */
export const DEPLOY_RECORD = "deploy.json";

/**
 * sha256 over every copied file of a deploy — its path and its bytes, in path order — leaving out each
 * node_modules (junctions and native copies, which `npm install` changes, not a build) and the record.
 */
export function deployHash(dir) {
  const files = walkFiles(dir, "", [], (r, e) => (e.isDirectory() && e.name === "node_modules") || r === DEPLOY_RECORD).sort();
  const h = createHash("sha256");
  for (const r of files) {
    h.update(`${r}\0`);
    h.update(fs.readFileSync(path.join(dir, ...r.split("/"))));
    h.update("\0");
  }
  return h.digest("hex");
}

function newestMtime(dir) {
  if (!fs.existsSync(dir)) return null;
  let newest = 0;
  for (const r of walkFiles(dir, "", [], () => false)) newest = Math.max(newest, fs.statSync(path.join(dir, ...r.split("/"))).mtimeMs);
  return newest;
}

/** The dirs (relative to `root`) whose src/ has a file newer than anything in their dist/: edited since the last build. */
export function staleBuilds(root, dirs) {
  return dirs.filter((d) => {
    const src = newestMtime(path.join(root, d, "src"));
    const dist = newestMtime(path.join(root, d, "dist"));
    return src !== null && dist !== null && src > dist;
  });
}
