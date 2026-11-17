/**
 * Unit tests for the EF Core lane, through the runner seam (B-15.3). No `dotnet`, no database:
 * `migration_status` and `migration_add` need neither, and the connection points at a port nothing
 * listens on. Preview, apply and dry run need a schema snapshot, so they are covered against a real
 * Postgres by `scripts/migration-flow-test.mjs`.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { test } from "node:test";

import { ConnectionManager } from "../../repositories/connectionManager.js";
import { checkAssemblyFreshness } from "../../services/migration/assemblyFreshness.js";
import { buildEfArgv, type EfResult, type MigrationConfig } from "../../services/migration/efRunner.js";
import { handleMigrationAdd, handleMigrationDryRun, handleMigrationPreview, handleMigrationStatus, planEfDryRun, previewRevert } from "./migrationHandlers.js";

process.env.POSTGRES_CONNECTION = "postgres://t:t@127.0.0.1:59999/t";
delete process.env.POSTGRES_ALLOWED_ENVIRONMENTS;
delete process.env.POSTGRES_DEFAULT_ENVIRONMENT;

function connections(): ConnectionManager {
  return new ConnectionManager({ poolMax: 1, idleTimeoutMs: 1000, statementTimeoutMs: 1000, applicationName: "test" });
}

/** A config whose runner records every call and answers from `reply`. */
function fake(reply: (efArgs: string[]) => EfResult): { config: MigrationConfig; calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    config: {
      enabled: true,
      project: "/p/Infrastructure.csproj",
      startupProject: "/p/Web.csproj",
      timeoutMs: 1000,
      lockTimeoutMs: 5000,
      approvalSecret: "s",
      previewTtlMs: 60_000,
      run: async (efArgs) => {
        calls.push(efArgs);
        return reply(efArgs);
      }
    }
  };
}

const ok = (stdout: string): EfResult => ({ exitCode: 0, stdout, stderr: "" });

function payload(result: { content: unknown }): Record<string, unknown> {
  return JSON.parse((result.content as Array<{ text: string }>)[0]?.text ?? "null");
}

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

test("the real argv is the subcommand, then a fixed project template — nothing else", () => {
  assert.deepEqual(buildEfArgv({ project: "/p/A.csproj", startupProject: "/p/B.csproj" }, ["migrations", "list", "--json"]), [
    "ef", "migrations", "list", "--json", "--project", "/p/A.csproj", "--startup-project", "/p/B.csproj", "--no-build"
  ]);
});

test("migration_status splits on the structured applied flag, never on the name", async () => {
  // PG-MIG-002: a migration NAMED like the old "(Pending)" marker must not be classified by it.
  const { config, calls } = fake(() =>
    ok(
      JSON.stringify([
        { id: "20260101000000_Init", name: "Init", safeName: "Init", applied: true },
        { id: "20260102000000_PendingCleanup", name: "PendingCleanup", safeName: "PendingCleanup", applied: true },
        { id: "20260103000000_AddFoo", name: "AddFoo", safeName: "AddFoo", applied: false },
        // An unexpected null is pending: flag it for attention rather than assume it ran.
        { id: "20260104000000_Odd", name: "Odd", safeName: "Odd", applied: null }
      ])
    )
  );
  const body = payload(await handleMigrationStatus({}, connections(), config));
  assert.deepEqual(body.applied, ["20260101000000_Init", "20260102000000_PendingCleanup"]);
  assert.deepEqual(body.pending, ["20260103000000_AddFoo", "20260104000000_Odd"]);
  assert.deepEqual(calls, [["migrations", "list", "--json", "--verbose", "--prefix-output"]]);
  assert.equal(body.raw, undefined, "raw is verbose-only (PG-STA-001)");
});

test("unparseable list output and a non-zero exit refuse with stable codes", async () => {
  const garbage = fake(() => ok("Build started...\nnot json"));
  assert.equal(await codeOf(handleMigrationStatus({}, connections(), garbage.config)), "EF_OUTPUT_UNPARSEABLE");
  const failing = fake(() => ({ exitCode: 1, stdout: "", stderr: "Unable to create a 'DbContext'" }));
  assert.equal(await codeOf(handleMigrationStatus({}, connections(), failing.config)), "EF_COMMAND_FAILED");
});

test("migration_add refuses an unsafe name before the runner is ever called", async () => {
  const { config, calls } = fake(() => ok("Done."));
  for (const name of ["Add Foo", "x;rm -rf", "../Escape", "--project=evil"]) {
    assert.equal(await codeOf(handleMigrationAdd({ name }, connections(), config)), "INVALID_MIGRATION_NAME", name);
  }
  assert.equal(calls.length, 0);
  await handleMigrationAdd({ name: "AddFoo_2" }, connections(), config);
  assert.deepEqual(calls, [["migrations", "add", "AddFoo_2"]]);
});

function planOf(script: string) {
  const result = planEfDryRun(script);
  if (!result.ok) {
    assert.fail(`${result.error.code}: ${result.error.message}`);
  }
  return result.plan;
}

test("the dry-run plan drops EF's transaction control in any spelling, and keeps DO blocks whole", () => {
  const plan = planOf(
    [
      "START TRANSACTION;",
      'CREATE TABLE "Foo" (id int);',
      "DO $EF$",
      "BEGIN",
      "    IF NOT EXISTS (SELECT 1) THEN",
      '        CREATE TABLE "Bar" (id int);',
      "    END IF;",
      "END $EF$;",
      // PG-MIG-007: the old line filter kept this one, and it committed the dry run.
      "  commit ;",
      "begin; create table baz (a int); COMMIT"
    ].join("\r\n")
  );
  assert.deepEqual(
    plan.run.map((s) => s.text.split(/\s+/).slice(0, 3).join(" ")),
    ['CREATE TABLE "Foo"', "DO $EF$ BEGIN", "create table baz"]
  );
  assert.deepEqual(
    plan.skipped.map((s) => s.reason),
    ["TRANSACTION_CONTROL", "TRANSACTION_CONTROL", "TRANSACTION_CONTROL", "TRANSACTION_CONTROL"]
  );
});

test("statements Postgres refuses inside a transaction are skipped and reported, not run", () => {
  const plan = planOf(
    'CREATE INDEX CONCURRENTLY ix ON "Foo" (id); DROP INDEX CONCURRENTLY ix2; ALTER TABLE p DETACH PARTITION p1 CONCURRENTLY; CREATE INDEX ix3 ON "Foo" (id)'
  );
  assert.deepEqual(plan.skipped.map((s) => [s.index, s.reason]), [
    [0, "NON_TRANSACTIONAL"],
    [1, "NON_TRANSACTIONAL"],
    [2, "NON_TRANSACTIONAL"]
  ]);
  assert.equal(plan.run.length, 1);
  // A column named "concurrently" inside parentheses does not make a statement non-transactional.
  assert.equal(planOf('CREATE INDEX ix ON t ("concurrently", concurrently)').run.length, 1);
});

test("a script the tokenizer cannot follow is refused with a stable code", () => {
  const result = planEfDryRun("CREATE TABLE t (a text DEFAULT 'never closed);");
  assert.equal(result.ok ? "" : result.error.code, "EF_SCRIPT_UNSPLITTABLE");
});

// ── row #9: a stale --no-build assembly ────────────────────────────────────────

const LISTED = ["20260101000000_Init", "20260102000000_AddA"];

/**
 * A project dir with Migrations/<id>.cs for `sourceIds`, a fake built assembly, and a runner that
 * answers `migrations list` the way EF does with --verbose --prefix-output: verbose lines naming the
 * assembly (and a line carrying a connection string, which must never reach the response), then
 * the JSON on data: lines, `LISTED` all pending.
 */
function staleFixture(t: { after: (fn: () => void) => void }, sourceIds: string[], times: { sourceMs: number; dllMs: number }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mig-stale-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "Infra", "Migrations"), { recursive: true });
  for (const id of sourceIds) {
    const file = path.join(root, "Infra", "Migrations", `${id}.cs`);
    fs.writeFileSync(file, "// fixture\n");
    fs.utimesSync(file, times.sourceMs / 1000, times.sourceMs / 1000);
  }
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "Acme.Infra.dll"), "MZ");
  fs.utimesSync(path.join(bin, "Acme.Infra.dll"), times.dllMs / 1000, times.dllMs / 1000);
  const json = JSON.stringify(LISTED.map((id) => ({ id, name: id, safeName: id, applied: false })), null, 2);
  const stdout = [
    "verbose: Using project 'x'.",
    "verbose: Host=secret-host;Password=SECRET_PW",
    "verbose: Using assembly 'Acme.Infra'.",
    `verbose: Using application base '${bin}'.`,
    ...json.split("\n").map((l) => `data:    ${l}`)
  ].join("\r\n");
  const f = fake(() => ok(stdout));
  f.config.project = path.join(root, "Infra", "Infra.csproj");
  return f;
}

const OLD = Date.UTC(2026, 10, 9);
const NEW = Date.UTC(2026, 10, 16);

test("fresh build: status output is unchanged (no assembly field), prefixed JSON parsed", async (t) => {
  const { config } = staleFixture(t, LISTED, { sourceMs: OLD, dllMs: NEW });
  const body = payload(await handleMigrationStatus({ profile: "verbose" }, connections(), config));
  assert.equal(body.assembly, undefined);
  assert.deepEqual(body.pending, LISTED);
  assert.doesNotMatch(JSON.stringify(body), /SECRET_PW|secret-host/, "verbose lines never reach the response");
});

test("no Migrations folder: status output is unchanged", async () => {
  const { config } = fake(() => ok(JSON.stringify([{ id: LISTED[0], name: "Init", safeName: "Init", applied: true }])));
  const body = payload(await handleMigrationStatus({}, connections(), config));
  assert.equal(body.assembly, undefined);
});

test("source id missing from the assembly: status warns stale; preview and dry run refuse", async (t) => {
  const { config } = staleFixture(t, [...LISTED, "20261116000000_AddNew"], { sourceMs: OLD, dllMs: NEW });
  const body = payload(await handleMigrationStatus({}, connections(), config));
  const asm = body.assembly as { status: string; missingFromAssembly: string[]; warning: string; remedy: string };
  assert.equal(asm.status, "stale");
  assert.deepEqual(asm.missingFromAssembly, ["20261116000000_AddNew"]);
  assert.match(asm.warning, /STALE BUILD/);
  assert.match(asm.remedy, /startup project/);
  assert.doesNotMatch(JSON.stringify(body), /SECRET_PW/);
  assert.equal(await codeOf(handleMigrationPreview({}, connections(), config)), "MIGRATION_ASSEMBLY_STALE");
  assert.equal(await codeOf(handleMigrationDryRun({}, connections(), config)), "MIGRATION_ASSEMBLY_STALE");
});

test("assembly id with no source file: refuses as well", async (t) => {
  const { config } = staleFixture(t, [LISTED[0] as string], { sourceMs: OLD, dllMs: NEW });
  const asm = payload(await handleMigrationStatus({}, connections(), config)).assembly as { status: string; missingFromSource: string[] };
  assert.equal(asm.status, "stale");
  assert.deepEqual(asm.missingFromSource, [LISTED[1]]);
  assert.equal(await codeOf(handleMigrationDryRun({}, connections(), config)), "MIGRATION_ASSEMBLY_STALE");
});

test("branch switch (source newer, ids equal): status warns possibly_stale; dry run is not refused for it", async (t) => {
  const { config } = staleFixture(t, LISTED, { sourceMs: NEW, dllMs: OLD });
  const asm = payload(await handleMigrationStatus({}, connections(), config)).assembly as { status: string };
  assert.equal(asm.status, "possibly_stale");
  // It gets past the freshness check and fails later, on the fake's missing script / the dead port.
  assert.notEqual(await codeOf(handleMigrationDryRun({}, connections(), config)), "MIGRATION_ASSEMBLY_STALE");
});

// ── revert preview carries the possibly_stale warning, as the forward preview does ──

test("revert preview: a possibly_stale build warns (same shape as the forward preview); a fresh one has no assembly field", async (t) => {
  const stale = staleFixture(t, LISTED, { sourceMs: NEW, dllMs: OLD });
  const fresh = staleFixture(t, LISTED, { sourceMs: OLD, dllMs: NEW });
  const entries = LISTED.map((id) => ({ id, name: id, safeName: id, applied: true }));
  const revert = async (project: string) => {
    const bin = path.join(path.dirname(path.dirname(project)), "bin");
    const verbose = ["Using assembly 'Acme.Infra'.", `Using application base '${bin}'.`];
    const f = fake(() => ok("SELECT 1;"));
    const res = await previewRevert(
      LISTED[0] as string,
      {
        env: { name: "dev", connectionString: "postgres://t:t@127.0.0.1:59999/t" },
        profile: "compact",
        preSnapshotId: "snap",
        pending: [],
        applied: LISTED,
        entries,
        freshness: checkAssemblyFreshness(project, [...LISTED], verbose)
      },
      f.config
    );
    return payload(res);
  };
  const warned = await revert(stale.config.project);
  assert.equal(warned.direction, "down");
  const asm = warned.assembly as { status: string; warning: string; remedy: string };
  assert.equal(asm.status, "possibly_stale");
  assert.match(asm.warning, /./);
  assert.match(asm.remedy, /startup project/);
  assert.equal((await revert(fresh.config.project)).assembly, undefined);
});
