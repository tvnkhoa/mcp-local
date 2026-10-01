/**
 * Tests for `withLockTimeout`: how the EF lane's lock wait reaches `dotnet ef` (B-15.1).
 *
 * Every case that does NOT apply the timeout must say so, because a migration that runs with no
 * lock wait while the operator believes it has one is the failure this exists to prevent.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { withLockTimeout } from "./efRunner.js";

const NPGSQL = "Host=db;Port=5432;Database=app;Username=u;Password=p";

test("a keyword connection string gains Options=-c lock_timeout", () => {
  const r = withLockTimeout(NPGSQL, 5000);
  assert.equal(r.applied, true);
  assert.equal(r.connectionString, `${NPGSQL};Options=-c lock_timeout=5000;`);
  // A trailing separator in the original does not produce an empty segment.
  assert.equal(withLockTimeout(`${NPGSQL};`, 5000).connectionString, `${NPGSQL};Options=-c lock_timeout=5000;`);
});

test("an existing Options value is extended, not replaced, whatever the key's case", () => {
  const r = withLockTimeout(`${NPGSQL};options=-c search_path=app`, 750);
  assert.equal(r.applied, true);
  assert.equal(r.connectionString, `${NPGSQL};options=-c search_path=app -c lock_timeout=750;`);
});

test("a lock_timeout the connection string already sets is left as the operator chose it", () => {
  const original = `${NPGSQL};Options=-c lock_timeout=60000`;
  const r = withLockTimeout(original, 5000);
  assert.equal(r.applied, false);
  assert.equal(r.connectionString, original);
  assert.match(r.note ?? "", /already sets lock_timeout/);
});

test("a postgres:// URI cannot carry it, and says so", () => {
  const uri = "postgres://u:p@db:5432/app";
  const r = withLockTimeout(uri, 5000);
  assert.equal(r.applied, false);
  assert.equal(r.connectionString, uri);
  assert.match(r.note ?? "", /URI/);
});

test("0 turns it off", () => {
  const r = withLockTimeout(NPGSQL, 0);
  assert.equal(r.applied, false);
  assert.equal(r.connectionString, NPGSQL);
  assert.match(r.note ?? "", /disabled/);
});
