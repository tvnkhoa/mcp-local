import assert from "node:assert/strict";
import test from "node:test";

import { ConnectionManager } from "./connectionManager.js";
import { buildEnvironmentRegistry } from "../config/environments.js";
import type { SqlserverConfig } from "../config/index.js";

/**
 * The connect-failure explanation path, with `connect` stubbed.
 *
 * `explainConnectFailure` reads the catalog list to tell "no such catalog" from "wrong password",
 * and reading it means connecting — so on genuinely wrong credentials it explained the failure of
 * the connect it made to explain the failure, forever. These tests count connect attempts, which
 * is the only way to see that from outside: without the guard the count does not converge.
 */

function makeConfig(): SqlserverConfig {
  const source: Record<string, string> = {
    SQLSERVER_CONNECTION: "data source=db.internal,1433; initial catalog=AppMain; User Id=svc; Password=p4ss"
  };
  const env = {
    raw: (name: string) => source[name],
    string: (name: string, fallback: string) => source[name] ?? fallback,
    optionalString: (name: string) => source[name],
    presentKeys: (prefix?: string) =>
      Object.keys(source).filter((key) => (prefix === undefined ? true : key.startsWith(prefix)))
  } as never;
  return {
    registry: buildEnvironmentRegistry(env).registry,
    invalidEnvironments: [],
    allowedEnvironments: [],
    allowedDatabases: [],
    readonlyDatabases: [],
    limits: { defaultLimit: 500, maxLimit: 2000, defaultTimeoutMs: 30_000, maxTimeoutMs: 60_000, maxFanout: 25 },
    pools: { poolMax: 5, maxPools: 12, idleTimeoutMs: 30_000 },
    exec: { enabled: false, allowlist: [], timeoutMs: 120_000 }
  };
}

/** A manager whose every connect rejects ELOGIN, counting attempts. */
function alwaysRejects() {
  const manager = new ConnectionManager(makeConfig());
  let attempts = 0;
  (manager as unknown as { connect: () => Promise<never> }).connect = () => {
    attempts += 1;
    if (attempts > 25) {
      // Without the guard this never converges; fail loudly instead of hanging the suite.
      throw new Error(`runaway: ${String(attempts)} connect attempts`);
    }
    return Promise.reject(Object.assign(new Error("Login failed for user 'svc'."), { code: "ELOGIN" }));
  };
  return { manager, attempts: () => attempts };
}

test("wrong credentials settle as an error instead of recursing", async () => {
  const { manager, attempts } = alwaysRejects();
  await assert.rejects(
    manager.pool(manager.resolve(undefined, "SomeOtherCatalog")),
    /Login failed|not usable|No catalog/,
    "a bad login must produce an error, not spin"
  );
  // One connect for the requested catalog, one for the default catalog while explaining it.
  assert.ok(attempts() <= 2, `expected at most 2 connects, made ${String(attempts())}`);
});

test("a failing default catalog does not try to explain itself", async () => {
  const { manager, attempts } = alwaysRejects();
  await assert.rejects(manager.pool(manager.resolve(undefined, undefined)), /Login failed/);
  assert.equal(attempts(), 1, "explaining the default catalog would re-enter the same path");
});

test("the guard is case-insensitive, as catalog names are", async () => {
  const { manager, attempts } = alwaysRejects();
  await assert.rejects(manager.pool(manager.resolve(undefined, "appmain")), /Login failed/);
  assert.equal(attempts(), 1, "`appmain` IS the default catalog `AppMain`");
});
