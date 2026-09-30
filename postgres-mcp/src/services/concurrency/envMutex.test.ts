/**
 * Tests for the per-environment mutex, and for the claim it exists to make true: every lane
 * that changes a database takes the SAME lock.
 *
 * The lane tests hold the lock for `default` from outside, then call a handler and check that it
 * does not settle until the lock is released. A handler with a private mutex, or none, settles
 * immediately (with PREVIEW_NOT_FOUND, since no preview exists), so these fail against the
 * pre-0.2 code, where `migration_apply` took no lock at all. No database is reached: the
 * connection points at a port nothing listens on, and every call is decided by a preview lookup
 * that runs inside the lock.
 */

import assert from "node:assert/strict";
import process from "node:process";
import { test } from "node:test";

import { ConnectionManager } from "../../repositories/connectionManager.js";
import { handleMigrationApply } from "../../tools/handlers/migrationHandlers.js";
import { handleWriteApply } from "../../tools/handlers/writeHandlers.js";
import { WritePreviewStore } from "../write/previewStore.js";
import { runExclusive } from "./envMutex.js";

process.env.POSTGRES_CONNECTION = "postgres://t:t@127.0.0.1:59999/t";
delete process.env.POSTGRES_ALLOWED_ENVIRONMENTS;
delete process.env.POSTGRES_DEFAULT_ENVIRONMENT;

/** Long enough for an unlocked handler to settle; short enough not to slow the suite. */
const SETTLE_MS = 50;

function tick(ms = SETTLE_MS): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Take the lock for `envKey` and keep it until the returned `release` is called. */
function hold(envKey: string): { release: () => void; done: Promise<void> } {
  let release!: () => void;
  const done = runExclusive(envKey, () => new Promise<void>((resolve) => (release = resolve)));
  return { release: () => release(), done };
}

/** Run `promise` and report whether it had settled after SETTLE_MS, plus its outcome. */
async function settlesWhileHeld(envKey: string, start: () => Promise<unknown>): Promise<{ early: boolean; outcome: unknown }> {
  const lock = hold(envKey);
  await tick(0); // let the holder actually acquire before the contender queues
  let settled = false;
  const outcome = start().then(
    (value) => value,
    (error: unknown) => error
  );
  void outcome.finally(() => (settled = true));
  await tick();
  const early = settled;
  lock.release();
  await lock.done;
  return { early, outcome: await outcome };
}

function codeOf(value: unknown): unknown {
  return value !== null && typeof value === "object" ? (value as { code?: unknown }).code : undefined;
}

function connections(): ConnectionManager {
  return new ConnectionManager({ poolMax: 1, idleTimeoutMs: 1000, statementTimeoutMs: 1000, applicationName: "test" });
}

// ── the mutex itself ─────────────────────────────────────────────────────────

test("one environment runs one task at a time, in call order", async () => {
  const events: string[] = [];
  const task = (name: string, ms: number) => async () => {
    events.push(`${name}:start`);
    await tick(ms);
    events.push(`${name}:end`);
    return name;
  };
  const results = await Promise.all([runExclusive("e1", task("a", 20)), runExclusive("e1", task("b", 0))]);
  assert.deepEqual(results, ["a", "b"]);
  assert.deepEqual(events, ["a:start", "a:end", "b:start", "b:end"]);
});

test("different environments do not wait for each other", async () => {
  const slow = hold("e2-slow");
  await tick(0);
  const fast = await Promise.race([runExclusive("e2-fast", async () => "ran"), tick().then(() => "blocked")]);
  slow.release();
  await slow.done;
  assert.equal(fast, "ran");
});

test("a failed task releases the lock, and only its own caller sees the error", async () => {
  const failing = runExclusive("e3", async () => {
    throw new Error("boom");
  });
  const next = runExclusive("e3", async () => "after");
  await assert.rejects(failing, /boom/);
  assert.equal(await next, "after");
});

// ── every writing lane shares it ─────────────────────────────────────────────

test("migration_apply waits for the lock that write_apply holds", async () => {
  const { early, outcome } = await settlesWhileHeld("default", () =>
    handleMigrationApply({ previewId: "nope", approvalToken: "t" }, connections(), {
      enabled: true,
      project: "p.csproj",
      startupProject: "s.csproj",
      timeoutMs: 120_000,
      approvalSecret: "test-secret",
      previewTtlMs: 3_600_000
    })
  );
  assert.equal(early, false, "migration_apply ran while another lane held the environment's lock");
  assert.equal(codeOf(outcome), "PREVIEW_NOT_FOUND");
});

test("write_apply waits for the same lock", async () => {
  const { early, outcome } = await settlesWhileHeld("default", () =>
    handleWriteApply({ previewId: "nope", approvalToken: "t" }, connections(), new WritePreviewStore(), {
      enabled: true,
      approvalSecret: "test-secret",
      previewTtlMs: 900_000,
      sampleLimit: 20
    })
  );
  assert.equal(early, false, "write_apply ran while another lane held the environment's lock");
  assert.equal(codeOf(outcome), "PREVIEW_NOT_FOUND");
});
