/**
 * The benchmark's default fixture file must exist.
 *
 * This is three lines of assertion standing in for a CI failure that lasted from S-41 until it was chased
 * down. S-41 moved `graphStore.ts` from `src/` into `src/store/`; the benchmark kept querying the old path,
 * `get_file_context` answered with a near-empty payload rather than an error, and the compact/verbose ratio
 * for `file-context` moved 0.1232 -> 0.5947. CI went red on every commit, for a reason that had nothing to
 * do with token efficiency, and the number it reported was plausible enough that the real cause was not
 * obvious.
 *
 * `benchmark-plan-mode.mjs` now refuses to run against a missing fixture, which is the real guard. This
 * test exists because that guard only fires after booting a server and indexing the repo — tens of seconds
 * into the slowest step in CI. Here it fails in milliseconds, in `npm test`, before anything is built.
 *
 * Asserted by reading the default out of the script rather than importing it, because importing would run
 * the benchmark.
 */

import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const scriptPath = path.join(repoRoot, "scripts", "benchmark-plan-mode.mjs");

const source = fs.readFileSync(scriptPath, "utf8");
const match = /BENCH_CONTEXT_FILE\s*\?\?\s*"([^"]+)"/.exec(source);

assert.ok(match, "could not find the BENCH_CONTEXT_FILE default in benchmark-plan-mode.mjs — did its shape change?");

const fixture = match[1];
const resolved = path.join(repoRoot, fixture);

assert.ok(
  fs.existsSync(resolved),
  `benchmark fixture "${fixture}" does not exist. The benchmark would measure an empty response and CI ` +
    `would fail as a token regression. Update the default in scripts/benchmark-plan-mode.mjs to the file's ` +
    `new location.`
);

// A directory would also produce an empty payload while passing an existence check.
assert.ok(fs.statSync(resolved).isFile(), `benchmark fixture "${fixture}" is not a file`);

// The folder scenarios derive their path from this one, so a top-level file would silently make
// folderPath fall back to "src" and measure something else entirely.
assert.ok(
  fixture.replace(/\\/g, "/").split("/").length >= 2,
  `benchmark fixture "${fixture}" has no parent directory; folder-summary would fall back to "src"`
);

console.log(`  ok    benchmark fixture exists: ${fixture}`);
console.log("\n  PASS — benchmark fixture (0 failing)");
