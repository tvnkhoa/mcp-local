import assert from "node:assert/strict";
import test from "node:test";

import { ENV_ALIASES, ENV_PREFIX_ALIASES, resolveAliases } from "./aliases.js";

/**
 * S-43's four validation cases, from the migration plan:
 *
 *   1. the server works with ONLY legacy vars;
 *   2. the server works with ONLY new vars;
 *   3. with both set, the new name wins;
 *   4. `prod` stays force read-only under either naming scheme.
 *
 * (4) lives in the environment-registry tests rather than here, since it is a property of
 * `buildEnvironmentRegistry`, but the alias plumbing it depends on is pinned below.
 *
 * `resolveAliases` takes an explicit env object so these run against a plain record instead of
 * mutating the real `process.env` and leaking into other tests in the same process.
 */

test("legacy only — the value is copied onto the canonical name", () => {
  const env: NodeJS.ProcessEnv = { CH_DB_CONNECTION: "postgres://legacy/db", PG_WRITE_ENABLED: "true" };
  const used = resolveAliases(env);

  assert.equal(env.POSTGRES_CONNECTION, "postgres://legacy/db");
  assert.equal(env.POSTGRES_WRITE_ENABLED, "true");
  assert.deepEqual(used.sort(), ["CH_DB_CONNECTION", "PG_WRITE_ENABLED"]);
  // The legacy name is left in place: something else in the process may still read it, and
  // deleting it would turn a deprecation into a breaking change.
  assert.equal(env.CH_DB_CONNECTION, "postgres://legacy/db");
});

test("canonical only — nothing is touched and nothing is reported as deprecated", () => {
  const env: NodeJS.ProcessEnv = { POSTGRES_CONNECTION: "postgres://new/db" };
  assert.deepEqual(resolveAliases(env), []);
  assert.equal(env.POSTGRES_CONNECTION, "postgres://new/db");
  assert.equal(env.CH_DB_CONNECTION, undefined);
});

test("both set — the canonical name wins", () => {
  const env: NodeJS.ProcessEnv = { POSTGRES_CONNECTION: "postgres://new/db", CH_DB_CONNECTION: "postgres://old/db" };
  assert.deepEqual(resolveAliases(env), []);
  assert.equal(env.POSTGRES_CONNECTION, "postgres://new/db");
});

test("an empty canonical value does not shadow a legacy one", () => {
  // The common shape of a generated agent config: every declared var present, most of them "".
  // Treating "" as set would silently drop a working legacy connection string.
  const env: NodeJS.ProcessEnv = { POSTGRES_CONNECTION: "", CH_DB_CONNECTION: "postgres://old/db" };
  assert.deepEqual(resolveAliases(env), ["CH_DB_CONNECTION"]);
  assert.equal(env.POSTGRES_CONNECTION, "postgres://old/db");
});

test("an empty legacy value is not promoted", () => {
  const env: NodeJS.ProcessEnv = { CH_DB_CONNECTION: "" };
  assert.deepEqual(resolveAliases(env), []);
  assert.equal(env.POSTGRES_CONNECTION, undefined);
});

test("the PG_ENV_ family is remapped member by member", () => {
  const env: NodeJS.ProcessEnv = {
    PG_ENV_DEV: "postgres://dev/db",
    PG_ENV_STAGING: "postgres://staging/db",
    POSTGRES_ENV_PROD: "postgres://prod/db"
  };
  const used = resolveAliases(env);

  assert.equal(env.POSTGRES_ENV_DEV, "postgres://dev/db");
  assert.equal(env.POSTGRES_ENV_STAGING, "postgres://staging/db");
  assert.equal(env.POSTGRES_ENV_PROD, "postgres://prod/db", "an already-canonical member is untouched");
  assert.deepEqual(used.sort(), ["PG_ENV_DEV", "PG_ENV_STAGING"]);
});

test("a canonical family member wins over its legacy twin", () => {
  const env: NodeJS.ProcessEnv = { PG_ENV_DEV: "postgres://old/db", POSTGRES_ENV_DEV: "postgres://new/db" };
  assert.deepEqual(resolveAliases(env), []);
  assert.equal(env.POSTGRES_ENV_DEV, "postgres://new/db");
});

test("resolveAliases is idempotent — it is called from two places", () => {
  const env: NodeJS.ProcessEnv = { CH_DB_CONNECTION: "postgres://legacy/db", PG_ENV_DEV: "postgres://dev/db" };
  const first = resolveAliases(env);
  const snapshot = { ...env };
  const second = resolveAliases(env);

  assert.deepEqual(second, [], "a second pass must report nothing new");
  assert.deepEqual(env, snapshot, "a second pass must change nothing");
  assert.equal(first.length, 2);
});

test("no legacy name is also a canonical name", () => {
  // If a rename ever mapped A -> B while some other field renamed B -> C, resolution order would
  // decide the outcome. Assert the graph is one level deep so it cannot.
  const canonical = new Set(Object.keys(ENV_ALIASES));
  for (const [name, legacyNames] of Object.entries(ENV_ALIASES)) {
    for (const legacy of legacyNames) {
      assert.ok(!canonical.has(legacy), `${legacy} is both an alias (for ${name}) and a canonical name`);
    }
  }
});

test("no canonical name collides with the POSTGRES_ENV_ family prefix", () => {
  // The trailing underscore in the prefix is what keeps this safe, and it is easy to break by
  // adding a plausible-looking var. `POSTGRES_ENVIRONMENT` would be read as a connection for an
  // environment called "IRONMENT".
  const familyPrefixes = Object.keys(ENV_PREFIX_ALIASES);
  for (const name of Object.keys(ENV_ALIASES)) {
    for (const prefix of familyPrefixes) {
      assert.ok(
        !name.startsWith(prefix),
        `${name} starts with the family prefix ${prefix} and would be parsed as a family member`
      );
    }
  }
});

test("every alias keeps its prefix's meaning — no legacy name maps to an unrelated area", () => {
  // A cheap sanity check on the table itself: the tail after the first underscore group should
  // still be recognisable. Catches a copy-paste that pairs POSTGRES_MAX_LIMIT with
  // MCP_DB_DEFAULT_LIMIT.
  const tail = (n: string): string => n.replace(/^(POSTGRES|CH|PG|MCP_DB)_/, "");
  const exempt = new Set([
    "POSTGRES_CONNECTION", // was CH_DB_CONNECTION — "DB_" dropped as redundant under POSTGRES_
    "POSTGRES_DOTNET_TIMEOUT_MS" // was PG_DOTNET_TIMEOUT_MS — same tail, listed for symmetry
  ]);
  for (const [name, legacyNames] of Object.entries(ENV_ALIASES)) {
    if (exempt.has(name)) continue;
    for (const legacy of legacyNames) {
      assert.equal(tail(name), tail(legacy), `${legacy} -> ${name} changes more than the prefix`);
    }
  }
});
