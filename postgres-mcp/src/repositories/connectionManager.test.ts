/**
 * An idle pooled connection that dies (RDS restart, failover, network drop) reaches pg-pool as an
 * `error` event on the Pool. With no listener, Node throws it, and the whole server process exits.
 * Found in verify:live, where `docker restart` of the bouncer killed pgbouncer-test, and behind the
 * teardown crash of migration-flow, whose harness uses this class.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { ConnectionManager } from "./connectionManager.js";

process.env.POSTGRES_CONNECTION = "postgres://t:t@127.0.0.1:59999/t";
delete process.env.POSTGRES_ALLOWED_ENVIRONMENTS;
delete process.env.POSTGRES_DEFAULT_ENVIRONMENT;

const options = { poolMax: 1, idleTimeoutMs: 1000, statementTimeoutMs: 1000, applicationName: "test" };

test("an idle-client error on a pool is reported, not thrown", async () => {
  const seen: Array<{ environment: string; code: string | undefined; message: string }> = [];
  const connections = new ConnectionManager({ ...options, onIdleError: (detail) => seen.push(detail) });
  const pool = connections.getPool();
  const error = Object.assign(new Error("Connection terminated unexpectedly"), { code: "57P01" });

  // `emit` throws synchronously for an `error` event that has no listener.
  assert.doesNotThrow(() => pool.emit("error", error));
  assert.deepEqual(seen, [{ environment: connections.defaultEnvironment, code: "57P01", message: "Connection terminated unexpectedly" }]);
  await connections.closeAll();
});

test("without onIdleError the pool still has a listener", async () => {
  const connections = new ConnectionManager(options);
  const pool = connections.getPool();
  assert.ok(pool.listenerCount("error") >= 1);
  assert.doesNotThrow(() => pool.emit("error", new Error("Connection terminated unexpectedly")));
  await connections.closeAll();
});
