import assert from "node:assert/strict";
import { test } from "node:test";

import { resolveEnvAliases, type EnvAliasTable } from "./envAliases.js";

const TABLE: EnvAliasTable = {
  label: "test-mcp",
  names: { NEW_NAME: ["OLD_NAME", "OLDER_NAME"] },
  prefixes: { NEW_ENV_: ["OLD_ENV_"] }
};

test("a former name fills an unset canonical name and is reported", () => {
  const env: NodeJS.ProcessEnv = { OLD_NAME: "v" };
  assert.deepEqual(resolveEnvAliases(TABLE, env), ["OLD_NAME"]);
  assert.equal(env.NEW_NAME, "v");
  assert.equal(env.OLD_NAME, "v", "the legacy name is left in place");
});

test("the canonical name wins; an empty canonical name does not", () => {
  const both: NodeJS.ProcessEnv = { NEW_NAME: "new", OLD_NAME: "old" };
  assert.deepEqual(resolveEnvAliases(TABLE, both), []);
  assert.equal(both.NEW_NAME, "new");

  const empty: NodeJS.ProcessEnv = { NEW_NAME: "", OLD_NAME: "old" };
  resolveEnvAliases(TABLE, empty);
  assert.equal(empty.NEW_NAME, "old");
});

test("former names are tried in order, and empty ones are skipped", () => {
  const env: NodeJS.ProcessEnv = { OLD_NAME: "", OLDER_NAME: "older" };
  assert.deepEqual(resolveEnvAliases(TABLE, env), ["OLDER_NAME"]);
  assert.equal(env.NEW_NAME, "older");
});

test("a family is aliased by prefix", () => {
  const env: NodeJS.ProcessEnv = { OLD_ENV_DEV: "a", OLD_ENV_PROD: "b", NEW_ENV_PROD: "kept" };
  assert.deepEqual(resolveEnvAliases(TABLE, env), ["OLD_ENV_DEV"]);
  assert.equal(env.NEW_ENV_DEV, "a");
  assert.equal(env.NEW_ENV_PROD, "kept");
});

test("idempotent", () => {
  const env: NodeJS.ProcessEnv = { OLD_NAME: "v" };
  resolveEnvAliases(TABLE, env);
  assert.deepEqual(resolveEnvAliases(TABLE, env), []);
});
