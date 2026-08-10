import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * PG-ENV-002: the alias table must still be in effect for everything read through `config/index.ts`.
 *
 * This runs in a **child process**, and that is the whole point of the test rather than an
 * implementation detail. The defect was a module-evaluation-order bug: `src/index.ts` calls
 * `resolveAliases()` as its first statement, but its imports — including `config/index.ts`, which
 * snapshotted `process.env` at module scope — are fully evaluated before that statement runs. So the
 * snapshot was taken before any legacy name had been copied onto its canonical one, and
 * `POSTGRES_WRITE_ENABLED` / `POSTGRES_MIGRATION_ENABLED` read `false` where the operator had set
 * `PG_WRITE_ENABLED` / `PG_MIGRATION_ENABLED` to `true`.
 *
 * An in-process test cannot catch that. By the time it runs, this file's own imports have already
 * been evaluated and any module-scope snapshot is long taken — so setting `process.env` and asserting
 * would pass against the broken code too. The child gets a pristine module graph, static imports in
 * the same order the real entry point uses, and an environment carrying ONLY the legacy names.
 */

const configDir = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(configDir, "..", "..");

const configUrl = pathToFileURL(path.join(configDir, "index.ts")).href;
const aliasesUrl = pathToFileURL(path.join(configDir, "aliases.ts")).href;

/** Mirrors `src/index.ts`: static imports, then `resolveAliases()` as the first statement. */
const bootScript = `
import { numberFromEnv, parseBoolEnv, dotnetProjectsFromEnv } from ${JSON.stringify(configUrl)};
import { resolveAliases } from ${JSON.stringify(aliasesUrl)};

resolveAliases();

process.stdout.write(JSON.stringify({
  writeEnabled: parseBoolEnv("POSTGRES_WRITE_ENABLED"),
  migrationEnabled: parseBoolEnv("POSTGRES_MIGRATION_ENABLED"),
  dotnet: dotnetProjectsFromEnv(),
  defaultLimit: numberFromEnv("POSTGRES_DEFAULT_LIMIT", 500)
}));
`;

/**
 * Every `POSTGRES_*` / `PG_*` / `CH_*` / `MCP_DB_*` variable is stripped from the inherited
 * environment before the requested ones are set. A developer machine running this suite has a real
 * `postgres-mcp` configuration in its shell — inheriting it would let a canonical name already
 * present in the parent satisfy the assertion and hide the regression.
 */
function boot(vars: Record<string, string>): {
  writeEnabled: boolean;
  migrationEnabled: boolean;
  dotnet: { project: string; startupProject: string };
  defaultLimit: number;
  stderr: string;
} {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(POSTGRES_|PG_|CH_|MCP_DB_)/.test(key)) {
      delete env[key];
    }
  }

  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", bootScript],
    { cwd: packageRoot, encoding: "utf8", env: { ...env, ...vars } }
  );

  assert.equal(result.status, 0, `child exited ${String(result.status)}\n${result.stderr}`);
  return { ...JSON.parse(result.stdout), stderr: result.stderr };
}

test("legacy names reach the write and migration gates (PG-ENV-002)", () => {
  const boot1 = boot({
    PG_WRITE_ENABLED: "true",
    PG_MIGRATION_ENABLED: "true",
    CH_DOTNET_PROJECT: "/repo/src/Infrastructure",
    CH_DOTNET_STARTUP_PROJECT: "/repo/src/Web",
    MCP_DB_DEFAULT_LIMIT: "111"
  });

  // The two that failed silently toward "off" — the whole reason this is a defect and not a nit.
  assert.equal(boot1.writeEnabled, true, "PG_WRITE_ENABLED must open the write gate");
  assert.equal(boot1.migrationEnabled, true, "PG_MIGRATION_ENABLED must open the migration gate");
  assert.deepEqual(boot1.dotnet, { project: "/repo/src/Infrastructure", startupProject: "/repo/src/Web" });
  // Non-regression: this one always worked, because `numberFromEnv` read `process.env` live.
  assert.equal(boot1.defaultLimit, 111);
});

test("the deprecation warning names the canonical replacement", () => {
  const booted = boot({ PG_MIGRATION_ENABLED: "true" });

  assert.match(booted.stderr, /PG_MIGRATION_ENABLED is deprecated — use POSTGRES_MIGRATION_ENABLED/);
  assert.equal(
    booted.stderr.match(/PG_MIGRATION_ENABLED is deprecated/g)?.length,
    1,
    "warned once, even though resolveAliases() runs from both config/index.ts and the entry point"
  );
});

test("canonical names still work, and win over a legacy twin", () => {
  const canonical = boot({ POSTGRES_MIGRATION_ENABLED: "true", POSTGRES_DEFAULT_LIMIT: "222" });
  assert.equal(canonical.migrationEnabled, true);
  assert.equal(canonical.defaultLimit, 222);

  const both = boot({ POSTGRES_MIGRATION_ENABLED: "true", PG_MIGRATION_ENABLED: "false" });
  assert.equal(both.migrationEnabled, true, "the canonical name wins");
});

test("an unset gate still reads false", () => {
  const bare = boot({});
  assert.equal(bare.writeEnabled, false);
  assert.equal(bare.migrationEnabled, false);
  assert.deepEqual(bare.dotnet, { project: "", startupProject: "" });
  assert.equal(bare.defaultLimit, 500, "falls back to the code default");
});
