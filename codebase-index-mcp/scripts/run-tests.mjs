#!/usr/bin/env node
/**
 * Aggregate test runner (migration-plan step S-03).
 *
 * This package has ~40 individually-invoked `test:*` scripts. CI needs one
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
 *   node scripts/run-tests.mjs                    # unit + integration, one result
 *   node scripts/run-tests.mjs --integration-only # skip the node:test unit suite
 *   node scripts/run-tests.mjs --list             # show what would run
 *   node scripts/run-tests.mjs --bail             # stop at the first failure
 *   node scripts/run-tests.mjs --changed [<base>] # only what the change since <base> needs (default: merge-base
 *                                                 # with origin/main) — scripts/test-map.json; add --list to preview
 *   node scripts/run-tests.mjs --changed [<base>] --mapped-only
 *                                                 # exactly the mapped harnesses + what always runs: a changed file
 *                                                 # not in test-map.json is a warning, not the whole suite (exit 0
 *                                                 # unless a harness fails); an unresolvable base exits 2
 *   node scripts/run-tests.mjs --no-lock          # skip the machine-wide heavy-check lock (CI=true skips it too)
 *
 * Stopping the runner stops its children: each script runs as a tracked child, and SIGINT / SIGTERM /
 * SIGBREAK, an exit, the shell above the runner killed (orphan stop) or a hard kill of the runner (via a
 * watchdog) kills every child process tree and frees the heavy lock — ../../scripts/lib/childTree.mjs.
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { createChildTracker } from "../../scripts/lib/childTree.mjs";
import { holdHeavyLockOrExit } from "../../scripts/lib/heavyLock.mjs";
import { failureExcerpt } from "./lib/failureExcerpt.mjs";
import { changedFiles, EXCLUDED, selectForChanges, suiteScripts } from "./lib/testSelect.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const LIST_ONLY = argv.includes("--list");
const BAIL = argv.includes("--bail");
const INTEGRATION_ONLY = argv.includes("--integration-only");
const MAPPED_ONLY = argv.includes("--mapped-only");

if (MAPPED_ONLY && !argv.includes("--changed")) {
  console.error("--mapped-only needs --changed [<base>]");
  process.exit(2);
}

const scripts = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).scripts ?? {};

const suite = suiteScripts(scripts).filter((name) => !(INTEGRATION_ONLY && name === "test:unit"));

/**
 * `--changed [<base>]`: only the harnesses whose paths in scripts/test-map.json the change touches
 * (row V-E). Every fail-safe lives in testSelect.mjs; here it is printed, so a run says what it left
 * out and why.
 */
function selectChanged() {
  const i = argv.indexOf("--changed");
  const next = argv[i + 1];
  const base = next !== undefined && !next.startsWith("--") ? next : undefined;
  let changes;
  try {
    changes = changedFiles({ cwd: ROOT, base });
  } catch (error) {
    const why = String(error.message).split("\n")[0];
    // --mapped-only has no mapped set to fall back to without a base; running nothing would read as a pass.
    if (MAPPED_ONLY) {
      console.error(`--changed --mapped-only: cannot resolve the base (${why}) — nothing to map; pass a base that resolves`);
      process.exit(2);
    }
    console.log(`--changed: cannot resolve the base (${why}) — running the whole suite`);
    return suite;
  }
  const map = JSON.parse(fs.readFileSync(path.join(ROOT, "scripts", "test-map.json"), "utf8"));
  const result = selectForChanges({ changed: changes.files, map, suite, mappedOnly: MAPPED_ONLY });
  console.log(`--changed: base ${changes.base.slice(0, 12)}${base === undefined ? " (merge-base HEAD origin/main)" : ""}, ${String(changes.files.length)} changed file(s)`);
  for (const { file, reason } of result.skipped) console.log(`  skipped: ${file} (${reason})`);
  for (const file of result.unitOnly) console.log(`  test:unit only: ${file}`);
  for (const file of result.uncovered) {
    if (MAPPED_ONLY) console.warn(`  WARNING not in test-map.json, no harness selected for it (--mapped-only): ${file}`);
    else console.log(`  not in test-map.json → WHOLE SUITE: ${file}`);
  }
  console.log(`selected ${String(result.selected.length)}/${String(suite.length)}:`);
  for (const { name, why } of result.selected) console.log(`  ${name} ← ${why}`);
  console.log("");
  return result.selected.map(({ name }) => name);
}

const selected = argv.includes("--changed") ? selectChanged() : suite;

if (LIST_ONLY) {
  console.log(`${selected.length} script(s):`);
  for (const name of selected) console.log(`  ${name}`);
  for (const [name, why] of Object.entries(EXCLUDED)) console.log(`  (excluded) ${name} — ${why}`);
  process.exit(0);
}

// The integration harnesses run against `dist/`, so a missing build is a setup error rather than
// a test failure. `test:unit` reads source through tsx and needs none of it.
const needsBuild = selected.some((name) => name !== "test:unit");
if (needsBuild && !fs.existsSync(path.join(ROOT, "dist", "index.js"))) {
  console.error("dist/index.js not found — run `npm run build` first.");
  process.exit(2);
}

// The latency bounds in these harnesses assume the suite has the machine to itself; another session's
// gate running alongside is what made test:freshness-worker flake (277 ms > 250) — scripts/lib/heavyLock.mjs.
// The tracker first: its signal listeners must kill the children before the lock's listener exits.
const children = createChildTracker({ name: "run-tests" });
const lock = await holdHeavyLockOrExit({ cmd: `codebase-index run-tests ${argv.join(" ")}`.trim(), noLock: argv.includes("--no-lock") });
children.setLock(lock);

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const failures = [];
const started = Date.now();

for (const [index, name] of selected.entries()) {
  const label = `[${String(index + 1).padStart(2)}/${selected.length}] ${name}`;
  const t0 = Date.now();
  const result = await children.run(npm, ["run", name, "--silent"], {
    cwd: ROOT,
    capture: true,
    shell: process.platform === "win32"
  });
  const elapsed = `${((Date.now() - t0) / 1000).toFixed(1)}s`;

  if (result.status === 0) {
    console.log(`ok   ${label} (${elapsed})`);
    continue;
  }

  // A process that never started is a different failure from a test that ran and
  // failed, and it is the one this runner used to hide: on a spawn error stdout
  // and stderr are both null, so printing them produced `FAIL … (0.0s)` followed
  // by a blank line. That reads as a silent test failure when it is actually the
  // system refusing to fork — which, once it starts happening, happens to every
  // remaining script and makes the whole run look like a mass regression.
  if (result.error !== undefined) {
    console.error(`FAIL ${label} (${elapsed}) — could not start: ${result.error.message}`);
    failures.push(name);
    if (BAIL) break;
    continue;
  }

  const how = result.status === null ? `killed by ${String(result.signal)}` : `exit ${String(result.status)}`;
  console.error(`FAIL ${label} (${elapsed}) — ${how}`);
  // Every `not ok` with its assertion block, then the tail: these scripts are chatty, and a node:test
  // suite's tail is its summary, not the failing test's name.
  console.error(
    failureExcerpt(`${result.stdout ?? ""}${result.stderr ?? ""}`)
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
