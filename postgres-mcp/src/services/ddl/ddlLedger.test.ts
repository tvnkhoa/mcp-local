/**
 * Tests for external-ledger mode (POSTGRES_DDL_EXTERNAL_LEDGER): the psql file format, the state a
 * repo's `(filename, checksum)` rows describe, and the plans built on them. Pure, like the
 * planner's own tests — the live round trip is `test:ddl-flow` §X.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { parseDdlLaneSettings, type DdlConfig, type DdlLaneSettings } from "./ddlConfig.js";
import { loadMigrations, type LoadedMigrations } from "./ddlFiles.js";
import { deriveExternalState } from "./ddlLedger.js";
import { buildPlan, computeStatus, planDigest, type PlanInput } from "./ddlPlanner.js";

const CONFIG: DdlConfig = {
  enabled: true,
  migrationsDir: "/unused",
  lockTimeoutMs: 5000,
  statementTimeoutMs: 300_000,
  maxStatementTimeoutMs: 3_600_000,
  previewTtlMs: 3_600_000,
  approvalSecret: "s",
  externalLedger: { schema: "public", name: "schema_migration" },
  ownerRoles: ["aria"]
};

const sha = (text: string): string => createHash("sha256").update(text).digest("hex");

const BACKSLASH = String.fromCharCode(92);
const WRAPPED = `-- header\n${BACKSLASH}set ON_ERROR_STOP on\nbegin;\ncreate table t2 (a int);\nalter table t2 owner to aria;\ngrant select on t2 to reporting;\ncommit;\n`;

function psqlFile(file: string, text: string): LoadedMigrations["migrations"][number] {
  const match = /^(\d+)-(.+)\.sql$/.exec(file) as RegExpExecArray;
  return { version: match[1] as string, name: match[2] as string, up: { file, text, checksum: sha(text) } };
}

const F1 = psqlFile("0001-baseline.sql", "create table t1 (a int);\n");
const F2 = psqlFile("0002-second.sql", WRAPPED);
const loaded = (...migrations: LoadedMigrations["migrations"]): LoadedMigrations => ({ migrations, ignoredFiles: [], warnings: [] });

function build(input: Partial<PlanInput> & Pick<PlanInput, "state" | "request">) {
  return buildPlan({ files: loaded(F1, F2), config: CONFIG, ...input });
}

// ── files ────────────────────────────────────────────────────────────────────

test("the psql format loads NNNN-name.sql, checksums raw bytes as sha256sum does, and sorts by file name", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ddl-psql-"));
  try {
    const crlf = "create table b (a int);\r\n";
    await writeFile(path.join(dir, "0002-b.sql"), crlf);
    await writeFile(path.join(dir, "0001-a.sql"), "﻿create table a (a int);\n");
    await writeFile(path.join(dir, "V20261001000000__x.up.sql"), "create table x (a int);");
    await writeFile(path.join(dir, "notes.txt"), "not sql");
    const result = await loadMigrations(dir, "psql");
    assert.deepEqual(result.migrations.map((m) => m.up.file), ["0001-a.sql", "0002-b.sql"]);
    assert.deepEqual(result.migrations.map((m) => m.version), ["0001", "0002"]);
    // Raw bytes, BOM and CRLF included — not the normalized text the mcp format hashes.
    assert.equal(result.migrations[1]?.up.checksum, sha(crlf));
    assert.equal(result.migrations[0]?.up.checksum, createHash("sha256").update(Buffer.from("﻿create table a (a int);\n", "utf8")).digest("hex"));
    // ...while what RUNS is normalized.
    assert.equal(result.migrations[1]?.up.text, "create table b (a int);\n");
    assert.deepEqual(result.ignoredFiles, ["V20261001000000__x.up.sql"]);
    assert.match(result.warnings.join(" "), /0002-b\.sql has CRLF/);

    await writeFile(path.join(dir, "0002-c.sql"), "create table c (a int);");
    await assert.rejects(loadMigrations(dir, "psql"), (e: { code?: string }) => e.code === "DDL_DUPLICATE_VERSION");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── state ────────────────────────────────────────────────────────────────────

test("ledger rows become applied versions keyed by prefix, and the state id tracks every row", () => {
  const state = deriveExternalState([{ filename: "0002-second.sql", checksum: "b" }, { filename: "0001-baseline.sql", checksum: "a" }], "public.schema_migration");
  assert.deepEqual(state.applied.map((a) => [a.version, a.name, a.file]), [
    ["0001", "baseline", "0001-baseline.sql"],
    ["0002", "second", "0002-second.sql"]
  ]);
  const other = deriveExternalState([{ filename: "0001-baseline.sql", checksum: "a" }], "public.schema_migration");
  assert.notEqual(state.stateId, other.stateId);
  assert.equal(deriveExternalState([], "x").maxId, 0);
});

// ── plans ────────────────────────────────────────────────────────────────────

test("an up plan applies the pending file, unwrapping it as psql would, with its raw checksum", () => {
  const state = deriveExternalState([{ filename: F1.up.file, checksum: F1.up.checksum }], "public.schema_migration");
  const result = build({ state, request: { mode: "file", direction: "up" } });
  assert.ok(result.ok, result.ok ? "" : result.error.message);
  if (!result.ok) {
    return;
  }
  const step = result.plan.steps[0];
  assert.equal(result.plan.steps.length, 1);
  assert.equal(step?.file, "0002-second.sql");
  assert.equal(step?.checksum, F2.up.checksum);
  assert.deepEqual(step?.statements.map((s) => `${s.verb} ${s.kind}`), ["create table", "alter table", "grant privilege"]);
  assert.deepEqual(result.plan.requiredAcknowledgements, ["PRIVILEGE_CHANGE"]);
  // A 4-digit target names one file.
  const through = build({ state: deriveExternalState([], "l"), request: { mode: "file", direction: "up", target: "0001" } });
  assert.deepEqual(through.ok ? through.plan.steps.map((s) => s.file) : null, ["0001-baseline.sql"]);
});

test("a recorded checksum that differs from the file on disk stops every plan", () => {
  const state = deriveExternalState([{ filename: F1.up.file, checksum: sha("something else") }], "l");
  const result = build({ state, request: { mode: "file", direction: "up" } });
  assert.equal(result.ok ? "" : result.error.code, "DDL_CHECKSUM_MISMATCH");
  assert.equal(computeStatus(loaded(F1, F2).migrations, state).checksumMismatch.length, 1);
});

test("a file renamed after it was applied stops the plan: the repo's runner keys on the name", () => {
  const state = deriveExternalState([{ filename: "0001-old-name.sql", checksum: F1.up.checksum }], "l");
  const result = build({ state, request: { mode: "file", direction: "up" } });
  assert.equal(result.ok ? "" : result.error.code, "DDL_LEDGER_FILENAME_MISMATCH");
  assert.match(result.ok ? "" : result.error.message, /0001-old-name\.sql \(now 0001-baseline\.sql\)/);
});

test("forward-only, files-only: down and inline plans are refused", () => {
  const state = deriveExternalState([], "l");
  const down = build({ state, request: { mode: "file", direction: "down", target: "0" } });
  assert.equal(down.ok ? "" : down.error.code, "DDL_DOWN_UNSUPPORTED");
  const inline = build({ state, request: { mode: "inline", sql: "create table z (a int)" } });
  assert.equal(inline.ok ? "" : inline.error.code, "DDL_INLINE_UNSUPPORTED");
});

test("the adoption guard refuses a populated schema with an empty ledger, and only that", () => {
  const empty = deriveExternalState([], "l");
  const guard = { sentinel: "public.chunks", sentinelPresent: true, ledgerRowCount: 0 };
  const refused = build({ state: empty, request: { mode: "file", direction: "up" }, adoption: guard });
  assert.equal(refused.ok ? "" : refused.error.code, "DDL_ADOPTION_REQUIRED");
  assert.match(refused.ok ? "" : refused.error.message, /public\.chunks exists but the ledger is empty/);
  // A fresh database (no sentinel) and an adopted one (ledger rows) both plan.
  assert.equal(build({ state: empty, request: { mode: "file", direction: "up" }, adoption: { ...guard, sentinelPresent: false } }).ok, true);
  const one = deriveExternalState([{ filename: F1.up.file, checksum: F1.up.checksum }], "l");
  assert.equal(build({ state: one, request: { mode: "file", direction: "up" }, adoption: { ...guard, ledgerRowCount: 1 } }).ok, true);
});

test("OWNER TO a role outside POSTGRES_DDL_OWNER_ROLES is refused in a file", () => {
  const result = buildPlan({ files: loaded(F1, F2), config: { ...CONFIG, ownerRoles: [] }, state: deriveExternalState([], "l"), request: { mode: "file", direction: "up" } });
  assert.equal(result.ok ? "" : result.error.code, "DDL_STATEMENT_NOT_ALLOWED");
  assert.match(result.ok ? "" : result.error.message, /^0002-second\.sql: Statement 3: OWNER TO aria is refused/);
});

test("a repo's own file may hold a backfill and a DO block; the lane's own format may not hold DML", () => {
  // wec.aria's 0018 shape: a DO wrapping INSERT … SELECT, a backfill, then the drop, in one file.
  const F3 = psqlFile(
    "0003-move.sql",
    "begin;\ncreate table t3 (a int);\ndo $$ begin insert into t3 select a from t1; end $$;\nupdate t1 set a = 0 where a is null;\nalter table t1 drop column a;\ncommit;\n"
  );
  const result = buildPlan({ files: loaded(F1, F2, F3), config: CONFIG, state: deriveExternalState([], "l"), request: { mode: "file", direction: "up" } });
  assert.ok(result.ok, result.ok ? "" : result.error.message);
  const step = result.plan.steps[2];
  assert.deepEqual(step?.statements.map((s) => s.kind), ["table", "block", "data", "table"]);
  assert.deepEqual(
    result.plan.requiredAcknowledgements.filter((c) => c === "DO_BLOCK" || c === "DATA_CHANGE"),
    ["DO_BLOCK", "DATA_CHANGE"]
  );

  const inline = buildPlan({
    config: { ...CONFIG, externalLedger: undefined },
    state: { applied: [], unadoptedInline: [], stateId: "s", maxId: 0 },
    request: { mode: "inline", sql: "update t1 set a = 0" }
  });
  assert.match(inline.ok ? "" : inline.error.message, /write_preview/);
});

test("a plan that adds an enum value before a later migration warns that the dry run cannot check it", () => {
  const F3 = psqlFile("0003-add-value.sql", "alter type public.usage_kind add value if not exists 'retrieval_inspection';\n");
  const F4 = psqlFile("0004-use-value.sql", "alter table t1 add column kind public.usage_kind default 'retrieval_inspection';\n");
  const state = deriveExternalState([{ filename: F1.up.file, checksum: F1.up.checksum }, { filename: F2.up.file, checksum: F2.up.checksum }], "l");
  const both = buildPlan({ files: loaded(F1, F2, F3, F4), config: CONFIG, state, request: { mode: "file", direction: "up" } });
  assert.ok(both.ok);
  assert.ok(both.plan.warnings.some((w) => /0003-add-value\.sql adds an enum value\. ddl_dry_run cannot check/.test(w)), JSON.stringify(both.plan.warnings));
  // The value-adding migration last, or alone: nothing later to warn about.
  const alone = buildPlan({ files: loaded(F1, F2, F3, F4), config: CONFIG, state, request: { mode: "file", direction: "up", target: "0003" } });
  assert.ok(alone.ok);
  assert.ok(!alone.plan.warnings.some((w) => /enum value/.test(w)));
});

test("the session role is on the plan, and in its digest", () => {
  const state = deriveExternalState([], "l");
  const without = build({ state, request: { mode: "file", direction: "up" } });
  const withRole = buildPlan({ files: loaded(F1, F2), config: { ...CONFIG, sessionRole: "aria" }, state, request: { mode: "file", direction: "up" } });
  assert.ok(without.ok && withRole.ok);
  assert.equal(without.plan.sessionRole, null);
  assert.equal(withRole.plan.sessionRole, "aria");
  const digest = (plan: typeof withRole.plan) => planDigest({ environment: "dev", preSnapshotId: "p", historyStateId: "h", plan });
  assert.notEqual(digest(without.plan), digest(withRole.plan));
});

// ── settings ─────────────────────────────────────────────────────────────────

test("lane settings parse, and a bad one fails closed with the variable named", () => {
  const ok = parseDdlLaneSettings({
    externalLedger: "public.schema_migration",
    ownerRoles: "aria, aria_billing",
    sessionSettings: "aria.expected_market=AU, app.flag = on",
    adoptionSentinel: "chunks",
    sessionRole: "aria"
  });
  assert.equal(ok.configError, undefined);
  assert.deepEqual(ok.externalLedger, { schema: "public", name: "schema_migration" });
  assert.deepEqual(ok.adoptionSentinel, { schema: "public", name: "chunks" });
  assert.deepEqual(ok.ownerRoles, ["aria", "aria_billing"]);
  assert.equal(ok.sessionRole, "aria");
  assert.deepEqual(ok.sessionSettings, [
    { name: "aria.expected_market", value: "AU" },
    { name: "app.flag", value: "on" }
  ]);

  const none = parseDdlLaneSettings({ externalLedger: "", ownerRoles: "", sessionSettings: "", adoptionSentinel: "", sessionRole: "" });
  assert.equal(none.configError, undefined);
  assert.equal(none.externalLedger, undefined);
  assert.equal(none.sessionRole, undefined);

  for (const [raw, pattern] of [
    [{ externalLedger: "mcp_ops.ddl_history" }, /server's own schema/],
    [{ externalLedger: 'public."Ledger"' }, /POSTGRES_DDL_EXTERNAL_LEDGER must be/],
    [{ ownerRoles: "postgres, pg_read_all_data" }, /pg_read_all_data/],
    [{ sessionSettings: "search_path=evil" }, /custom setting/],
    [{ sessionSettings: "role=postgres" }, /custom setting/],
    [{ sessionSettings: "aria.x=1,aria.x=2" }, /set twice/],
    [{ adoptionSentinel: "a.b.c" }, /POSTGRES_DDL_ADOPTION_SENTINEL/],
    // Everything a migration creates is owned by the session role, so it must be allowlisted too.
    [{ ownerRoles: "aria_review", sessionRole: "aria" }, /must also be listed in POSTGRES_DDL_OWNER_ROLES/],
    [{ ownerRoles: "aria", sessionRole: "Aria" }, /POSTGRES_DDL_SESSION_ROLE: .Aria. is not a plain/]
  ] as Array<[Partial<DdlLaneSettings>, RegExp]>) {
    const parsed = parseDdlLaneSettings({ externalLedger: "", ownerRoles: "", sessionSettings: "", adoptionSentinel: "", sessionRole: "", ...raw });
    assert.match(parsed.configError ?? "", pattern, JSON.stringify(raw));
  }
});
