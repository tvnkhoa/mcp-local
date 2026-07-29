/**
 * The test harnesses must never write to a real index DB.
 *
 * `smoke-test.mjs` and `benchmark-plan-mode.mjs` both spawn the server with an env block. Both used
 * to compute the DB as `process.env.CODEBASE_INDEX_DB_PATH ?? makeTempDbPath(...)`, which reads as
 * "allow an override" and behaved as the opposite in the one context that matters: the installer
 * runs the smoke test with the server's real configured env, so the ambient var was always set, and
 * every install wrote a `smoke-test-repo` row into the central index — pointing at the real
 * codebase-index-mcp directory. Two repoIds for one path.
 *
 * The failure needs an ambient variable to be set, so it is invisible in CI (where none is) and
 * happens every time on a configured machine. That asymmetry is exactly why it needs a test rather
 * than a comment.
 *
 * This is a source-level check on purpose: actually spawning both harnesses to observe which file
 * they open would cost a build plus two index runs to assert something the code states outright.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS = path.resolve(HERE, "..");

const HARNESSES = [
  { file: "smoke-test.mjs", ownVar: "CODEBASE_INDEX_SMOKE_DB_PATH" },
  { file: "benchmark-plan-mode.mjs", ownVar: "CODEBASE_INDEX_BENCH_DB_PATH" }
];

let failures = 0;
const fail = (msg) => {
  console.error(`  FAIL  ${msg}`);
  failures += 1;
};
const pass = (msg) => console.log(`  ok    ${msg}`);

for (const { file, ownVar } of HARNESSES) {
  const full = path.join(SCRIPTS, file);
  const text = fs.readFileSync(full, "utf8");

  // The exact regression: falling back to the ambient DB path.
  if (/CODEBASE_INDEX_DB_PATH:\s*process\.env\.CODEBASE_INDEX_DB_PATH\s*\?\?/.test(text)) {
    fail(`${file} inherits an ambient CODEBASE_INDEX_DB_PATH — it must always use a temp DB`);
  } else {
    pass(`${file} does not inherit an ambient CODEBASE_INDEX_DB_PATH`);
  }

  // It must still be overridable, but only by naming its own variable.
  if (!text.includes(ownVar)) {
    fail(`${file} should allow an explicit override via ${ownVar}`);
  } else {
    pass(`${file} allows an explicit override via ${ownVar}`);
  }

  // And it must actually reach for a temp path.
  if (!/makeTempDbPath\(/.test(text)) {
    fail(`${file} no longer calls makeTempDbPath`);
  } else {
    pass(`${file} defaults to makeTempDbPath`);
  }

  // The allowlist must include the directory being indexed, rather than being replaced by whatever
  // the ambient config allows — otherwise the harness fails on a machine configured for other roots.
  if (/CODEBASE_INDEX_ALLOWED_ROOTS:\s*process\.env\.CODEBASE_INDEX_ALLOWED_ROOTS\s*\?\?/.test(text)) {
    fail(`${file} replaces the allowlist with the ambient value instead of including repoPath`);
  } else {
    pass(`${file} keeps repoPath on the allowlist`);
  }
}

console.log(`\n  ${failures === 0 ? "PASS" : "FAIL"} — harness DB isolation`);
process.exit(failures === 0 ? 0 : 1);
