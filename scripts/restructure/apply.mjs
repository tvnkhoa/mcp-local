/**
 * Apply the standard-structure move map to one server.
 *
 *     node scripts/restructure/apply.mjs --server bitbucket-mcp [--dry-run]
 *
 * Two phases, in this order and for a reason:
 *
 *   1. Every relative import specifier in the server's `src/` is re-pointed at
 *      where its target will live. Resolution happens against the OLD tree
 *      (which still exists), and the new specifier is computed from the NEW
 *      location of the importing file. Doing this before the moves means a
 *      failure leaves a working tree `git checkout` can restore in one step.
 *   2. `git mv` performs the moves, preserving rename detection so the diff
 *      reads as moves rather than delete + add.
 *
 * What is deliberately NOT rewritten: string literals that are not module
 * specifiers. `new URL("./extractionWorker.js", import.meta.url)` resolves at
 * runtime against the module's own directory, and the worker moves with its
 * pool, so the relative path is still correct. A rewriter that touched every
 * `./…js` string would corrupt exactly this case.
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { MOVE_MAP } from "./move-map.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * Matches the specifier of an ES module import/export.
 *
 *   from "./x.js"      import "./x.js"      import("./x.js")      export * from "./x.js"
 *
 * The leading group is what distinguishes a specifier from any other string
 * literal in the file.
 */
const SPECIFIER = /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(["'])(\.[^"']*)\2/g;

function parseArgs() {
  const argv = process.argv.slice(2);
  const server = argv[argv.indexOf("--server") + 1];
  if (argv.indexOf("--server") === -1 || server === undefined) {
    throw new Error("Usage: node scripts/restructure/apply.mjs --server <key> [--dry-run]");
  }
  return { server, dryRun: argv.includes("--dry-run") };
}

/** Every `.ts` file under a directory, as paths relative to it. */
function listTsFiles(dir, base = dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listTsFiles(full, base));
    } else if (entry.name.endsWith(".ts")) {
      out.push(path.relative(base, full).split(path.sep).join("/"));
    }
  }
  return out;
}

/** `./a/b.js` as written in source ⇄ `a/b.ts` on disk. */
const toDisk = (spec) => (spec.endsWith(".js") ? `${spec.slice(0, -3)}.ts` : spec);
const toSpec = (rel) => (rel.endsWith(".ts") ? `${rel.slice(0, -3)}.js` : rel);

function relativeSpecifier(fromFile, toFile) {
  const rel = path.relative(path.dirname(fromFile), toFile).split(path.sep).join("/");
  return rel.startsWith(".") ? rel : `./${rel}`;
}

export function restructure({ server, dryRun }) {
  const moves = MOVE_MAP[server];
  if (moves === undefined) throw new Error(`No move map for "${server}".`);

  const srcDir = path.join(ROOT, server, "src");
  const files = listTsFiles(srcDir);

  // Validate the map against the tree before changing anything.
  const problems = [];
  for (const [from, to] of Object.entries(moves)) {
    if (!files.includes(from)) problems.push(`source missing: ${from}`);
    if (files.includes(to) && moves[to] === undefined) problems.push(`target occupied: ${to}`);
  }
  const targets = Object.values(moves);
  const duplicated = targets.filter((t, i) => targets.indexOf(t) !== i);
  if (duplicated.length > 0) problems.push(`duplicate targets: ${[...new Set(duplicated)].join(", ")}`);
  if (problems.length > 0) throw new Error(`Move map does not match ${server}/src:\n  ${problems.join("\n  ")}`);

  /** Where every file ends up — movers and stayers alike. */
  const newPathOf = (rel) => moves[rel] ?? rel;

  const rewrites = [];
  for (const rel of files) {
    const oldAbs = path.join(srcDir, rel);
    const content = fs.readFileSync(oldAbs, "utf8");
    const newRel = newPathOf(rel);
    let changed = 0;

    const updated = content.replace(SPECIFIER, (match, lead, quote, spec) => {
      // Resolve against the OLD tree — that is the only place the specifier is valid.
      const targetOld = path
        .relative(srcDir, path.resolve(path.dirname(oldAbs), toDisk(spec)))
        .split(path.sep).join("/");

      // A specifier that escapes src/ (none today) is left alone rather than guessed at.
      if (targetOld.startsWith("..")) return match;

      const targetNew = newPathOf(targetOld);
      const rewritten = toSpec(relativeSpecifier(newRel, targetNew));
      if (rewritten === spec) return match;
      changed += 1;
      return `${lead}${quote}${rewritten}${quote}`;
    });

    if (updated !== content) rewrites.push({ oldAbs, rel, newRel, updated, changed });
  }

  const summary = {
    server,
    filesMoved: Object.keys(moves).length,
    filesRewritten: rewrites.length,
    specifiersRewritten: rewrites.reduce((n, r) => n + r.changed, 0)
  };

  if (dryRun) return { ...summary, dryRun: true };

  // Phase 1 — content, still at the old paths.
  for (const r of rewrites) fs.writeFileSync(r.oldAbs, r.updated);

  // Phase 2 — the moves.
  for (const [from, to] of Object.entries(moves)) {
    const toAbs = path.join(srcDir, to);
    fs.mkdirSync(path.dirname(toAbs), { recursive: true });
    execFileSync("git", ["mv", path.join(server, "src", from), path.join(server, "src", to)], { cwd: ROOT });
  }

  // Directories the moves emptied.
  const prune = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) prune(path.join(dir, entry.name));
    }
    if (dir !== srcDir && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
  };
  prune(srcDir);

  return summary;
}

if (process.argv[1] !== undefined && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  const result = restructure(parseArgs());
  process.stderr.write(`${JSON.stringify(result, null, 2)}\n`);
}
