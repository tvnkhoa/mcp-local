#!/usr/bin/env node
/**
 * Bundle the built server into `dist/bundle/` (MCP-ISSUE-124): one ESM file per entry, flat in one folder.
 *
 * Why: under CPU load Node's per-module resolution (≈600 modules, a package.json lookup and several fs
 * syscalls each) took start-up from 2.4 s to 28 s; the bundle loads a handful of files (0.6 s / 2.1 s).
 *
 * Entries: the server (`index.js`) and the three worker scripts. They sit side by side because each client
 * spawns its worker as `new URL("./<worker>.js", import.meta.url)` — beside the client's own module, which
 * after bundling is the entry it was bundled into, in this same folder. The unbundled `dist/` keeps the same
 * relation (each client sits beside its worker), so one source line serves both layouts.
 *
 * External: native addons and the packages loaded lazily through `createRequire` (TypeScript, Vue/Volar);
 * they resolve from `codebase-index-mcp/node_modules` as before, since the bundle stays under this package.
 * The unbundled `dist/` stays: the harnesses import it by path.
 *
 * Usage: node scripts/bundle.mjs   (after `tsc`; `npm run build` runs both)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ROOT, "dist");
export const BUNDLE_DIR = path.join(DIST, "bundle");

/** Output name (in dist/bundle/) -> the tsc output it bundles. */
export const ENTRIES = {
  index: "index.js",
  refreshWorker: "services/indexing/refreshWorker.js",
  extractionWorker: "services/extractors/extractionWorker.js",
  fieldWorker: "services/typeResolution/fieldWorker.js"
};

export const EXTERNAL = [
  "better-sqlite3",
  "tree-sitter",
  "tree-sitter-*",
  "sqlite-vec",
  "sqlite-vec-*",
  "typescript",
  "vue",
  "@vue/*",
  "@volar/*"
];

// Bundled CommonJS calls `require` for Node built-ins; an ESM file has none, so give it one.
const BANNER = 'import { createRequire as __bundleCreateRequire } from "node:module";\nconst require = __bundleCreateRequire(import.meta.url);';

export async function bundle({ quiet = false } = {}) {
  const entryPoints = {};
  for (const [out, rel] of Object.entries(ENTRIES)) {
    const file = path.join(DIST, ...rel.split("/"));
    if (!fs.existsSync(file)) throw new Error(`bundle: ${path.relative(ROOT, file)} is missing — run tsc first (npm run build)`);
    entryPoints[out] = file;
  }
  fs.rmSync(BUNDLE_DIR, { recursive: true, force: true });
  const result = await build({
    entryPoints,
    outdir: BUNDLE_DIR,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    external: EXTERNAL,
    banner: { js: BANNER },
    logLevel: "warning",
    metafile: true
  });
  if (!quiet) {
    for (const [file, meta] of Object.entries(result.metafile.outputs)) {
      const inputs = Object.keys(meta.inputs).length;
      process.stdout.write(`bundle: ${path.relative(ROOT, path.resolve(file)).split(path.sep).join("/")} ${(meta.bytes / 1024).toFixed(0)} KiB, ${inputs} modules\n`);
    }
  }
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  bundle().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
