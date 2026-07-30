/**
 * The doctor's path-existence check must actually bite.
 *
 * This exists because the whole line of work behind it is a check that reported PASS while doing nothing
 * useful. A test that only asserts "no findings on a healthy config" would repeat that mistake — every
 * case here proves the check FIRES on a specific broken config, and one proves it stays quiet.
 *
 * `existsSync` is injected rather than mocked globally, so the test states which paths exist instead of
 * depending on this machine's filesystem.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { getServer } from "./manifest.mjs";
import { findMissingEnvPaths } from "./envPaths.mjs";

const CBI = getServer("codebase-index");
const PG = getServer("postgres-mcp");

/** @param present paths that "exist"; everything else does not. */
const fakeExists = (present) => (p) => present.includes(p.replace(/\\/g, "/"));

test("a missing allowlist root is reported, with counts and not paths", () => {
  const problems = findMissingEnvPaths(
    CBI,
    { CODEBASE_INDEX_ALLOWED_ROOTS: "D:/exists,D:/gone,D:/also-gone" },
    fakeExists(["D:/exists"])
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0], /^CODEBASE_INDEX_ALLOWED_ROOTS: 2 of 3 path\(s\) do not exist$/);
  // The finding must not carry the paths themselves — every message in this module stays count-shaped
  // so the "never prints values" guarantee needs no per-case reasoning.
  assert.ok(!problems[0].includes("gone"));
});

test("a DB path is judged by its PARENT, because the server creates the file", () => {
  // The common healthy case: configured DB does not exist yet on a fresh install. Reporting it would
  // train the operator to ignore the warning, which is worse than not checking.
  assert.deepEqual(
    findMissingEnvPaths(
      CBI,
      { CODEBASE_INDEX_DB_PATH: "D:/workspace/index.db" },
      fakeExists(["D:/workspace"])
    ),
    []
  );
  // ...but a DB path under a directory that does not exist IS reported: nothing will create it.
  const problems = findMissingEnvPaths(CBI, { CODEBASE_INDEX_DB_PATH: "D:/nope/index.db" }, fakeExists([]));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /CODEBASE_INDEX_DB_PATH/);
});

test("a healthy config produces nothing", () => {
  assert.deepEqual(
    findMissingEnvPaths(
      CBI,
      {
        CODEBASE_INDEX_ALLOWED_ROOTS: "D:/a,D:/b",
        CODEBASE_INDEX_DB_PATH: "D:/a/index.db"
      },
      fakeExists(["D:/a", "D:/b"])
    ),
    []
  );
});

test("non-path fields are not touched, however they are set", () => {
  // Only fields declaring kind path/path-list are examined. Without this the check would try to stat
  // connection strings and tokens.
  assert.deepEqual(
    findMissingEnvPaths(
      CBI,
      { CODEBASE_INDEX_DOCS_INDEXING_ENABLED: "true", CODEBASE_INDEX_MAX_DEPTH: "5" },
      fakeExists([])
    ),
    []
  );
});

test("an absent or blank path field is not a finding", () => {
  // Absence is `evaluateEnv`'s question. Answering it here too would double-report every optional var.
  assert.deepEqual(findMissingEnvPaths(CBI, {}, fakeExists([])), []);
  assert.deepEqual(findMissingEnvPaths(CBI, { CODEBASE_INDEX_ALLOWED_ROOTS: "   " }, fakeExists([])), []);
  // A stray comma yields an empty entry; `evaluateEnvValues` reports that as a shape problem, so this
  // half must not also report it as a missing path.
  assert.deepEqual(
    findMissingEnvPaths(CBI, { CODEBASE_INDEX_ALLOWED_ROOTS: "D:/a,," }, fakeExists(["D:/a"])),
    []
  );
});

test("a deprecated alias is validated, so a pre-rename config is not skipped (S-43)", () => {
  // The runtime still reads CH_APPSETTINGS_ROOTS. Checking only the canonical name would skip exactly
  // the operators most likely to be carrying a stale path.
  const problems = findMissingEnvPaths(PG, { CH_APPSETTINGS_ROOTS: "D:/gone" }, fakeExists([]));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /^POSTGRES_APPSETTINGS_ROOTS: 1 of 1 path\(s\) do not exist$/);
});
