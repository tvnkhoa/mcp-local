import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * The S-43 alias table exists twice, and this is the check that keeps the copies honest.
 *
 * It has to exist twice: `@mcp/manifest` needs it to generate `.env.example`, the README table and
 * the installer prompts, while `postgres-mcp` needs it at runtime — and a server may not import the
 * workspace tooling packages (dependency rule 5, `servers/tooling-import`). ADR 0002 is about
 * exactly this shape of problem: three hand-copied SQL guardrail token lists drifted apart because
 * nothing compared them. So this test compares them.
 *
 * A root-level test rather than a server-level one, because only a script may import the manifest.
 */

// pathToFileURL, not a bare path: on Windows an absolute `D:\...` specifier is rejected by the
// ESM loader as an unsupported URL scheme.
const manifest = await import(pathToFileURL(path.join(ROOT, "packages/manifest/dist/index.js")).href);
const servers = manifest.SERVERS ?? manifest.servers;
const postgres = servers.find((s) => s.key === "postgres-mcp");

// Read the runtime table out of source rather than importing it: the server compiles to its own
// dist/, which may not have been built when this runs.
const aliasSource = fs.readFileSync(
  path.join(ROOT, "postgres-mcp/src/config/aliases.ts"),
  "utf8"
);

function parseTable(constName) {
  const start = aliasSource.indexOf(`export const ${constName}`);
  assert.notEqual(start, -1, `${constName} not found in aliases.ts`);
  const open = aliasSource.indexOf("{", start);
  const close = aliasSource.indexOf("\n};", open);
  assert.ok(close > open, `${constName} block not delimited as expected`);
  const body = aliasSource.slice(open + 1, close);
  const table = {};
  for (const m of body.matchAll(/^\s*([A-Z0-9_]+):\s*\[([^\]]*)\]/gm)) {
    table[m[1]] = [...m[2].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
  }
  return table;
}

const runtimeAliases = parseTable("ENV_ALIASES");
const runtimePrefixAliases = parseTable("ENV_PREFIX_ALIASES");

test("the runtime table was parsed at all", () => {
  // Guards against the regexes above silently matching nothing, which would make every
  // comparison below vacuously true.
  assert.ok(Object.keys(runtimeAliases).length >= 15, "expected the full alias table");
  assert.deepEqual(Object.keys(runtimePrefixAliases), ["POSTGRES_ENV_"]);
});

test("every manifest field with aliases has the same aliases at runtime", () => {
  for (const field of postgres.env) {
    if (!field.deprecatedAliases?.length) continue;
    if (field.prefix !== undefined) {
      assert.deepEqual(
        runtimePrefixAliases[field.prefix],
        [...field.deprecatedAliases],
        `prefix aliases for ${field.name} differ between manifest and runtime`
      );
      continue;
    }
    assert.deepEqual(
      runtimeAliases[field.name],
      [...field.deprecatedAliases],
      `aliases for ${field.name} differ between manifest and runtime`
    );
  }
});

test("the runtime table declares nothing the manifest does not", () => {
  const byName = new Map(postgres.env.map((f) => [f.name, f]));
  for (const name of Object.keys(runtimeAliases)) {
    const field = byName.get(name);
    assert.ok(field, `runtime honours ${name}, which is not in the manifest`);
    assert.ok(
      field.deprecatedAliases?.length,
      `runtime declares aliases for ${name}, but the manifest does not — generated docs would omit them`
    );
  }
});

test("every postgres-mcp env var is POSTGRES_-prefixed", () => {
  // S-43's actual goal. Three prefixes (CH_, PG_, MCP_DB_) became one; this is what stops a
  // fourth appearing.
  for (const field of postgres.env) {
    assert.ok(
      field.name.startsWith("POSTGRES_"),
      `${field.name} is not under the POSTGRES_ prefix`
    );
  }
});

test("no var collides with the official postgres image's variables", () => {
  // POSTGRES_USER / POSTGRES_PASSWORD / POSTGRES_DB are the postgres Docker image's own names.
  // Taking one would mean this server and a local database container silently reconfigure each
  // other from the same shell.
  const reserved = new Set(["POSTGRES_USER", "POSTGRES_PASSWORD", "POSTGRES_DB", "POSTGRES_HOST_AUTH_METHOD"]);
  for (const field of postgres.env) {
    assert.ok(!reserved.has(field.name), `${field.name} collides with the postgres Docker image`);
  }
});

test("no legacy name is left in postgres-mcp source outside the alias table", () => {
  // One exception, asserted rather than assumed: efRunner injects CH_DB_CONNECTION into the
  // `dotnet ef` child because that is the name the .NET project's IDesignTimeDbContextFactory
  // reads. It is an outbound contract, not this server's configuration.
  const legacy = /\b(CH_DB_CONNECTION|CH_APPSETTINGS_ROOTS|CH_CONNECTION_NAME|CH_DOTNET_PROJECT|CH_DOTNET_STARTUP_PROJECT|PG_ENV_|PG_ALLOWED_ENVIRONMENTS|PG_WRITABLE_ENVIRONMENTS|PG_DEFAULT_ENVIRONMENT|PG_EXPLAIN_COST_WARN|PG_WRITE_[A-Z_]+|PG_MIGRATION_[A-Z_]+|PG_DOTNET_TIMEOUT_MS|MCP_DB_[A-Z_]+)\b/;
  const srcDir = path.join(ROOT, "postgres-mcp/src");
  const offenders = [];

  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      if (fs.statSync(full).isDirectory()) { walk(full); continue; }
      if (!name.endsWith(".ts")) continue;
      const rel = path.relative(ROOT, full).replace(/\\/g, "/");
      if (rel.endsWith("config/aliases.ts") || rel.endsWith("config/aliases.test.ts")) continue;
      const text = fs.readFileSync(full, "utf8");
      text.split("\n").forEach((line, i) => {
        if (!legacy.test(line)) return;
        const isOutbound = rel.endsWith("migration/efRunner.ts");
        if (isOutbound) return;
        offenders.push(`${rel}:${i + 1}  ${line.trim()}`);
      });
    }
  };
  walk(srcDir);

  assert.deepEqual(offenders, [], `legacy env names still read in source:\n${offenders.join("\n")}`);
});
