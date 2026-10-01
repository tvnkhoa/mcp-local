/**
 * Tests for the DDL planner: ordering, drift, adoption, rollback, timeouts and the digest.
 * Everything here is pure — files, ledger state and config are built in memory.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { DdlConfig } from "./ddlConfig.js";
import { checksumOf, type LoadedMigrations, type MigrationFile } from "./ddlFiles.js";
import { deriveState, type HistoryRow, type HistoryState } from "./ddlHistory.js";
import { buildPlan, computeStatus, planDigest, type DdlPlan, type PlanRequest } from "./ddlPlanner.js";

const CONFIG: DdlConfig = {
  enabled: true,
  migrationsDir: "/unused",
  lockTimeoutMs: 5000,
  statementTimeoutMs: 300_000,
  maxStatementTimeoutMs: 3_600_000,
  previewTtlMs: 3_600_000,
  approvalSecret: "s"
};

function migration(version: string, up: string, down?: string, name = `m${version.slice(-2)}`): MigrationFile {
  const script = (direction: string, text: string) => ({ file: `V${version}__${name}.${direction}.sql`, text, checksum: checksumOf(text) });
  return { version, name, up: script("up", up), ...(down === undefined ? {} : { down: script("down", down) }) };
}

function files(...migrations: MigrationFile[]): LoadedMigrations {
  return { migrations, ignoredFiles: [], warnings: [] };
}

let id = 1;
function applied(m: MigrationFile, kind: HistoryRow["kind"] = "file"): HistoryRow {
  return { id: id++, version: m.version, name: m.name, kind, direction: "up", checksum: m.up.checksum, upChecksum: null, status: "applied", appliedAt: "x" };
}

function plan(loaded: LoadedMigrations, state: HistoryState, request: PlanRequest, config = CONFIG): DdlPlan {
  const result = buildPlan({ files: loaded, state, request, config });
  if (!result.ok) {
    assert.fail(`expected a plan, got ${result.error.code}: ${result.error.message}`);
  }
  return result.plan;
}

function refusal(loaded: LoadedMigrations | undefined, state: HistoryState, request: PlanRequest, config = CONFIG): string {
  const result = buildPlan({ files: loaded, state, request, config });
  assert.equal(result.ok, false, "expected a refusal");
  return result.ok ? "" : result.error.code;
}

const A = migration("20261001000001", "create table a (x int);", "drop table if exists a;");
const B = migration("20261001000002", "create table b (x int);", "drop table if exists b;");
const C = migration("20261001000003", "create table c (x int);");

// ── up ───────────────────────────────────────────────────────────────────────

test("an up plan applies every pending migration in version order", () => {
  const p = plan(files(A, B, C), deriveState([applied(A)]), { mode: "file", direction: "up" });
  assert.deepEqual(p.steps.map((s) => `${s.version}:${s.action}`), ["20261001000002:apply", "20261001000003:apply"]);
  assert.equal(p.steps[0]?.timeouts.lockTimeoutMs, 5000);
});

test("target stops the plan, and a target nobody has is refused", () => {
  const p = plan(files(A, B, C), deriveState([]), { mode: "file", direction: "up", target: "20261001000002" });
  assert.deepEqual(p.steps.map((s) => s.version), ["20261001000001", "20261001000002"]);
  assert.equal(refusal(files(A), deriveState([]), { mode: "file", direction: "up", target: "20991231000000" }), "DDL_UNKNOWN_TARGET");
});

test("nothing pending is an empty plan, not an error", () => {
  assert.deepEqual(plan(files(A), deriveState([applied(A)]), { mode: "file", direction: "up" }).steps, []);
});

test("a pending migration older than the newest applied one needs allowOutOfOrder", () => {
  const state = deriveState([applied(B)]);
  assert.equal(refusal(files(A, B), state, { mode: "file", direction: "up" }), "DDL_OUT_OF_ORDER");
  assert.deepEqual(plan(files(A, B), state, { mode: "file", direction: "up", allowOutOfOrder: true }).steps.map((s) => s.version), ["20261001000001"]);
});

test("an applied file that changed on disk blocks every file-mode plan", () => {
  const edited = migration(A.version, "create table a (x bigint);", A.down?.text, A.name);
  const state = deriveState([applied(A)]);
  assert.equal(refusal(files(edited, B), state, { mode: "file", direction: "up" }), "DDL_CHECKSUM_MISMATCH");
  assert.equal(refusal(files(edited, B), state, { mode: "file", direction: "down", target: "0" }), "DDL_CHECKSUM_MISMATCH");
  assert.deepEqual(computeStatus([edited, B], state).checksumMismatch, [{ version: A.version, name: A.name }]);
});

test("a file identical to an inline apply is adopted, not run again — once", () => {
  const sql = "create table inl (x int);";
  const F1 = migration("20261001000005", `${sql}\n`);
  const F2 = migration("20261001000006", sql);
  const state = deriveState([
    { id: 1, version: null, name: "inline", kind: "inline", direction: "up", checksum: checksumOf(sql), upChecksum: null, status: "applied", appliedAt: "x" }
  ]);
  const p = plan(files(F1, F2), state, { mode: "file", direction: "up" });
  assert.deepEqual(p.steps.map((s) => s.action), ["adopt", "apply"]);
  assert.deepEqual(p.steps[0]?.risks, []);
});

// ── down ─────────────────────────────────────────────────────────────────────

test("a down plan reverts newest first, back to the target", () => {
  const state = deriveState([applied(A), applied(B)]);
  const p = plan(files(A, B), state, { mode: "file", direction: "down", target: "0" });
  assert.deepEqual(p.steps.map((s) => `${s.version}:${s.action}`), ["20261001000002:revert", "20261001000001:revert"]);
  assert.equal(p.steps[0]?.upChecksum, B.up.checksum);
  assert.equal(p.steps[0]?.checksum, B.down?.checksum);
  assert.deepEqual(plan(files(A, B), state, { mode: "file", direction: "down", target: A.version }).steps.map((s) => s.version), [B.version]);
});

test("a down plan needs a target that is applied, and a down script for every step", () => {
  const state = deriveState([applied(A), applied(C)]);
  assert.equal(refusal(files(A, C), state, { mode: "file", direction: "down" }), "DDL_INVALID_ARGS");
  assert.equal(refusal(files(A, C), state, { mode: "file", direction: "down", target: "20261001000002" }), "DDL_UNKNOWN_TARGET");
  assert.equal(refusal(files(A, C), state, { mode: "file", direction: "down", target: "0" }), "DDL_NO_DOWN_SCRIPT");
});

test("an applied migration deleted from disk cannot be reverted, and up plans only warn about it", () => {
  const state = deriveState([applied(A), applied(B)]);
  const down = buildPlan({ files: files(B), state, request: { mode: "file", direction: "down", target: "0" }, config: CONFIG });
  assert.equal(down.ok ? "" : down.error.code, "DDL_NO_DOWN_SCRIPT");
  assert.match(down.ok ? "" : down.error.message, /no file on disk/);
  // Reverting only what is still on disk is fine.
  assert.deepEqual(plan(files(B), state, { mode: "file", direction: "down", target: A.version }).steps.map((s) => s.version), [B.version]);
  const up = plan(files(B), state, { mode: "file", direction: "up" });
  assert.match(up.warnings.join(" | "), /20261001000001 .* no longer on disk/);
  assert.deepEqual(computeStatus([B], state).missingFiles.map((m) => m.version), [A.version]);
});

// ── lint, guardrail and timeouts flow through ────────────────────────────────

test("risks are linted per step, and a table created in an earlier step is not existing in a later one", () => {
  const create = migration("20261001000010", "create table fresh (x int);");
  const alter = migration("20261001000011", "alter table fresh drop column x;");
  const p = buildPlan({
    files: files(create, alter),
    state: deriveState([]),
    request: { mode: "file", direction: "up" },
    config: CONFIG,
    lint: { existingTables: new Set(["public.orders"]) }
  });
  assert.ok(p.ok);
  assert.deepEqual(p.ok ? p.plan.requiredAcknowledgements : null, []);

  const risky = buildPlan({
    files: files(migration("20261001000012", "alter table orders drop column note;")),
    state: deriveState([]),
    request: { mode: "file", direction: "up" },
    config: CONFIG,
    lint: { existingTables: new Set(["public.orders"]) }
  });
  assert.deepEqual(risky.ok ? risky.plan.requiredAcknowledgements : null, ["DROP_COLUMN"]);
});

test("a blocked risk and a guardrail refusal stop the plan, naming the file", () => {
  const blocked = buildPlan({ files: files(migration("20261001000020", "drop schema s cascade;")), state: deriveState([]), request: { mode: "file", direction: "up" }, config: CONFIG });
  assert.equal(blocked.ok ? "" : blocked.error.code, "DDL_RISK_BLOCKED");
  const refused = buildPlan({ files: files(migration("20261001000021", "grant all on t to public;")), state: deriveState([]), request: { mode: "file", direction: "up" }, config: CONFIG });
  assert.equal(refused.ok ? "" : refused.error.code, "DDL_STATEMENT_NOT_ALLOWED");
  assert.match(refused.ok ? "" : refused.error.message, /^V20261001000021__m21\.up\.sql: /);
});

test("directives may lower the lock timeout and raise the statement timeout up to the cap — no further", () => {
  const ok = plan(files(migration("20261001000030", "-- mcp:lock-timeout-ms=500\n-- mcp:statement-timeout-ms=600000\ncreate table t (x int);")), deriveState([]), { mode: "file", direction: "up" });
  assert.deepEqual(ok.steps[0]?.timeouts, { lockTimeoutMs: 500, statementTimeoutMs: 600_000 });
  assert.equal(refusal(files(migration("20261001000031", "-- mcp:lock-timeout-ms=60000\ncreate table t (x int);")), deriveState([]), { mode: "file", direction: "up" }), "DDL_DIRECTIVE_EXCEEDS_LIMIT");
  assert.equal(refusal(files(migration("20261001000032", "-- mcp:statement-timeout-ms=7200000\ncreate table t (x int);")), deriveState([]), { mode: "file", direction: "up" }), "DDL_DIRECTIVE_EXCEEDS_LIMIT");
});

// ── inline ───────────────────────────────────────────────────────────────────

test("an inline plan is one unversioned step, and warns when it has run before", () => {
  const sql = "create index concurrently i on t (x)";
  const p = plan(files(), deriveState([]), { mode: "inline", sql, noTransaction: true, label: "idx_t" });
  assert.deepEqual(p.steps.map((s) => [s.version, s.name, s.mode]), [[null, "idx_t", "non_transactional"]]);
  assert.equal(refusal(undefined, deriveState([]), { mode: "inline", sql }), "DDL_NEEDS_NO_TRANSACTION");

  const again = buildPlan({
    state: deriveState([
      { id: 1, version: null, name: "idx_t", kind: "inline", direction: "up", checksum: checksumOf(sql), upChecksum: null, status: "applied", appliedAt: "x" }
    ]),
    request: { mode: "inline", sql, noTransaction: true },
    config: CONFIG
  });
  assert.equal(again.ok ? again.plan.warnings.length : -1, 1);
});

test("file mode without a loaded directory is refused", () => {
  assert.equal(refusal(undefined, deriveState([]), { mode: "file", direction: "up" }), "DDL_MIGRATIONS_DIR_UNCONFIGURED");
});

// ── the digest ───────────────────────────────────────────────────────────────

test("the digest changes with the environment, either freshness id, or any step", () => {
  const p = plan(files(A, B), deriveState([]), { mode: "file", direction: "up" });
  const base = { environment: "dev", preSnapshotId: "s1", historyStateId: "h1", plan: p };
  const d = planDigest(base);
  assert.equal(planDigest(base), d);
  assert.notEqual(planDigest({ ...base, environment: "staging" }), d);
  assert.notEqual(planDigest({ ...base, preSnapshotId: "s2" }), d);
  assert.notEqual(planDigest({ ...base, historyStateId: "h2" }), d);
  const fewer = plan(files(A, B), deriveState([]), { mode: "file", direction: "up", target: A.version });
  assert.notEqual(planDigest({ ...base, plan: fewer }), d);
});
