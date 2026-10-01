/**
 * `POSTGRES_MIGRATION_LOCK_TIMEOUT_MS=0` must mean "off", not "unset".
 *
 * A file of its own: `config/index.ts` snapshots the environment on its first read, and
 * `node --test` gives every file its own process, so this is the one value this process sees.
 * Through `numberFromEnv`, which treats anything ≤ 0 as unset, "0" would have quietly become the
 * 5 s default.
 */

import assert from "node:assert/strict";
import process from "node:process";
import { test } from "node:test";

process.env.POSTGRES_MIGRATION_LOCK_TIMEOUT_MS = "0";

const { migrationLockTimeoutFromEnv, numberFromEnv } = await import("./index.js");

test("0 is read as 0, where numberFromEnv would have substituted the default", () => {
  assert.equal(migrationLockTimeoutFromEnv(5000), 0);
  assert.equal(numberFromEnv("POSTGRES_MIGRATION_LOCK_TIMEOUT_MS", 5000), 5000, "the trap this accessor avoids");
});
