/**
 * Unit tests for the EF Core lane, through the runner seam (B-15.3). No `dotnet`, no database:
 * `migration_status` and `migration_add` need neither, and the connection points at a port nothing
 * listens on. Preview, apply and dry run need a schema snapshot, so they are covered against a real
 * Postgres by `scripts/migration-flow-test.mjs`.
 */

import assert from "node:assert/strict";
import process from "node:process";
import { test } from "node:test";

import { ConnectionManager } from "../../repositories/connectionManager.js";
import { buildEfArgv, type EfResult, type MigrationConfig } from "../../services/migration/efRunner.js";
import { handleMigrationAdd, handleMigrationStatus, planEfDryRun } from "./migrationHandlers.js";

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
  assert.deepEqual(calls, [["migrations", "list", "--json"]]);
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
