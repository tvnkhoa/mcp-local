#!/usr/bin/env node
/**
 * Aggregate test runner (migration-plan step S-03).
 *
 * This package has ~25 individually-invoked `test:*` scripts. CI needs one
 * command, and so does anyone trying to check their work before committing.
 *
 * The list is DISCOVERED from package.json rather than written out here: a chain
 * of `&&`s is a list that silently falls behind the moment someone adds a test
 * script and forgets to append it. Discovery makes "the suite" mean "every test
 * script in this package", which is the only definition that stays true.
 *
 * Requires a build first — the scripts run against `dist/`.
 *
 * Usage:
 *   node scripts/run-tests.mjs           # everything
 *   node scripts/run-tests.mjs --list    # show what would run
 *   node scripts/run-tests.mjs --bail    # stop at the first failure
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const LIST_ONLY = argv.includes("--list");
const BAIL = argv.includes("--bail");

const scripts = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).scripts ?? {};

/**
 * Non-`test:*` scripts that are nonetheless part of the suite.
 * `guard:no-llm-runtime` enforces the hard no-LLM policy and must never be
 * optional; `verify:enhancements` is a test script that predates the naming
 * convention.
 */
const EXTRA = ["guard:no-llm-runtime", "verify:enhancements"];

/**
 * Deliberately excluded, with the reason. Anything added here must be run
 * somewhere else — see `.github/workflows/ci.yml`.
 */
const EXCLUDED = {
  "benchmark:plan:check": "a performance gate, not a correctness test; run as its own CI step"
};

const selected = [
  ...EXTRA.filter((name) => name in scripts),
  ...Object.keys(scripts)
    .filter((name) => name.startsWith("test:"))
    .sort()
].filter((name) => !(name in EXCLUDED));

if (LIST_ONLY) {
  console.log(`${selected.length} script(s):`);
  for (const name of selected) console.log(`  ${name}`);
  for (const [name, why] of Object.entries(EXCLUDED)) console.log(`  (excluded) ${name} — ${why}`);
  process.exit(0);
}

if (!fs.existsSync(path.join(ROOT, "dist", "index.js"))) {
  console.error("dist/index.js not found — run `npm run build` first.");
  process.exit(2);
}

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const failures = [];
const started = Date.now();

for (const [index, name] of selected.entries()) {
  const label = `[${String(index + 1).padStart(2)}/${selected.length}] ${name}`;
  const t0 = Date.now();
  const result = spawnSync(npm, ["run", name, "--silent"], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    shell: process.platform === "win32"
  });
  const elapsed = `${((Date.now() - t0) / 1000).toFixed(1)}s`;

  if (result.status === 0) {
    console.log(`ok   ${label} (${elapsed})`);
    continue;
  }

  console.error(`FAIL ${label} (${elapsed})`);
  // Only the tail: these scripts are chatty, and the failure is at the end.
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trimEnd();
  console.error(
    output
      .split("\n")
      .slice(-25)
      .map((line) => `       ${line}`)
      .join("\n")
  );
  failures.push(name);
  if (BAIL) break;
}

const total = `${((Date.now() - started) / 1000).toFixed(1)}s`;
console.log(`\n${selected.length - failures.length}/${selected.length} passed in ${total}`);

if (failures.length > 0) {
  console.error(`Failed: ${failures.join(", ")}`);
  process.exit(1);
}
