import assert from "node:assert/strict";
import test from "node:test";

import { createNullLogger, createEventLogger } from "@mcp/core";
import { asErrorPayload, createToolRegistry, dispatchToolCall } from "@mcp/sdk";

import { buildDeps, buildTools, toWireError } from "./index.js";
import type { SqlserverConfig } from "../config/index.js";
import {
  parseConnectionString,
  withDatabase,
  maskConnection,
  buildEnvironmentRegistry
} from "../config/environments.js";
import { ConnectionManager, MAX_FANOUT_CONCURRENCY } from "../repositories/connectionManager.js";
import { referencedCatalogCandidates, validateReadOnlySql } from "../middleware/sqlGuardrails.js";

/**
 * Tools are pinned here rather than only in `contracts/sqlserver-mcp.json`.
 *
 * The snapshot covers `tools/list` — names, descriptions, schemas. It cannot see what a *call*
 * returns, so a refactor can keep the advertised contract byte-identical while changing every
 * response and every refusal. These tests are that second net.
 *
 * Nothing here reaches a database. Every assertion is about guardrails, gates, resolution and
 * envelopes — the parts that decide whether a call is allowed to reach one at all.
 */

const QUOTE = String.fromCharCode(39);
const CONNECTION =
  "data source=db.internal,1433; initial catalog=AppMain; User Id=svc; Password=p4ss; TrustServerCertificate=true";

function makeConfig(overrides: Partial<SqlserverConfig> = {}): SqlserverConfig {
  const source: Record<string, string> = { SQLSERVER_CONNECTION: CONNECTION };
  const env = {
    raw: (name: string) => source[name],
    string: (name: string, fallback: string) => source[name] ?? fallback,
    optionalString: (name: string) => source[name],
    presentKeys: (prefix?: string) =>
      Object.keys(source).filter((key) => (prefix === undefined ? true : key.startsWith(prefix)))
  } as never;

  const { registry } = buildEnvironmentRegistry(env);

  return {
    registry,
    invalidEnvironments: [],
    allowedEnvironments: [],
    allowedDatabases: [],
    readonlyDatabases: [],
    limits: {
      defaultLimit: 500,
      maxLimit: 2000,
      defaultTimeoutMs: 30_000,
      maxTimeoutMs: 60_000,
      maxFanout: 25
    },
    pools: { poolMax: 5, maxPools: 12, idleTimeoutMs: 30_000 },
    exec: { enabled: false, allowlist: [], timeoutMs: 120_000 },
    ...overrides
  };
}

function makeTools(config: SqlserverConfig = makeConfig()) {
  return buildTools(buildDeps(config, new ConnectionManager(config), createEventLogger(() => undefined)));
}

const logger = createNullLogger("test");

/** Dispatch exactly as `index.ts` wires it, so the envelope is the one a client receives. */
const bodyOf = async (name: string, args: Record<string, unknown>, config = makeConfig()) => {
  const registry = createToolRegistry(makeTools(config));
  const result = await dispatchToolCall(registry, name, args, {
    logger,
    formatError: (error) => asErrorPayload(toWireError(error), "verbose")
  });
  return { isError: result.isError, payload: JSON.parse(result.content[0]?.text ?? "null") };
};

// --- the tool table ------------------------------------------------------------

test("every tool is snake_case and declares annotations", () => {
  for (const tool of makeTools()) {
    assert.match(tool.name, /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/, `${tool.name} is not snake_case`);
    assert.equal(typeof tool.annotations.readOnly, "boolean");
    assert.equal(typeof tool.annotations.idempotent, "boolean");
    assert.equal(typeof tool.annotations.destructive, "boolean");
    assert.notEqual(tool.description.trim(), "", `${tool.name} has an empty description`);
  }
});

test("health_check is present, as every server must have it", () => {
  const names = makeTools().map((t) => t.name);
  assert.ok(names.includes("health_check"), `health_check missing; got ${names.join(", ")}`);
});

test("execute_routine is the only tool that is not read-only", () => {
  const writers = makeTools()
    .filter((tool) => tool.annotations.readOnly !== true)
    .map((tool) => tool.name);
  assert.deepEqual(writers, ["execute_routine"]);
});

test("execute_routine declares itself destructive for every routine", () => {
  // Not a doc detail. SQL Server records nothing about whether a procedure writes, so a client
  // deciding what to auto-approve has only this annotation to go on — and a `Get…` procedure
  // sitting beside an `Update…` one in the same schema is the normal case.
  const exec = makeTools().find((tool) => tool.name === "execute_routine");
  assert.ok(exec);
  assert.equal(exec.annotations.destructive, true);
  assert.equal(exec.annotations.idempotent, false);
});

test("every tool that touches the instance is marked openWorld", () => {
  const local = new Set(["health_check", "list_environments"]);
  for (const tool of makeTools()) {
    if (local.has(tool.name)) {
      continue;
    }
    assert.equal(tool.annotations.openWorld, true, `${tool.name} reaches the network`);
  }
});

// --- connection string parsing -------------------------------------------------

test("connection string parses into parts, including host and port", () => {
  const parsed = parseConnectionString(CONNECTION);
  assert.equal(parsed.server, "db.internal");
  assert.equal(parsed.port, 1433);
  assert.equal(parsed.database, "AppMain");
  assert.equal(parsed.user, "svc");
  assert.equal(parsed.trustServerCertificate, true);
});

test("named instances and tcp: prefixes are understood", () => {
  const parsed = parseConnectionString("Server=tcp:host01\\SQLEXPRESS; Database=D; User ID=u; Password=p");
  assert.equal(parsed.server, "host01");
  assert.equal(parsed.instanceName, "SQLEXPRESS");
  assert.equal(parsed.port, undefined);
});

test("a semicolon inside a braced password does not truncate the string", () => {
  // `split(';')` loses everything after the first semicolon in a password — and a password is the
  // field most likely to contain one.
  const parsed = parseConnectionString(
    "Data Source=h; Initial Catalog=D; User Id=u; Password={pa;ss}; Encrypt=true"
  );
  assert.equal(parsed.password, "pa;ss");
  assert.equal(parsed.encrypt, true);
});

test("switching catalog does NOT corrupt a password that contains the catalog name", () => {
  // The regression this whole module exists for. The application audited before writing this
  // server switches tenant catalog with `connString.Replace(oldDb, newDb)`; with a password of
  // `p_AppMain_p` that silently rewrites the credential and the login fails against a database
  // that looks correct in the logs.
  const raw = "data source=AppMain-host; initial catalog=AppMain; User Id=u; Password=p_AppMain_p";
  const parsed = parseConnectionString(raw);
  const switched = withDatabase(parsed, "TenantAU");

  assert.equal(switched.database, "TenantAU");
  assert.equal(switched.password, "p_AppMain_p", "password must be untouched");
  assert.equal(switched.server, "AppMain-host", "host must be untouched");

  // And for contrast, what the naive approach would have produced.
  assert.equal(
    raw.split("AppMain").join("TenantAU").includes("p_TenantAU_p"),
    true,
    "string replacement corrupts the password — that is the bug being avoided"
  );
});

test("integrated security is refused with a message that says what to do", () => {
  assert.throws(
    () => parseConnectionString("Server=h; Database=D; Integrated Security=SSPI"),
    /Integrated Security is not supported/
  );
});

test("a masked connection carries no credential", () => {
  const masked = maskConnection(parseConnectionString(CONNECTION));
  assert.equal(masked.user, "***");
  assert.equal(masked.hasPassword, true);
  assert.equal(JSON.stringify(masked).includes("p4ss"), false);
  assert.equal(JSON.stringify(masked).includes("svc"), false);
});

// --- target resolution and allowlists -------------------------------------------

test("omitting database resolves to the catalog the connection string names", () => {
  const config = makeConfig();
  const target = new ConnectionManager(config).resolve();
  assert.equal(target.database, "AppMain");
});

test("a database outside SQLSERVER_ALLOWED_DATABASES is refused", async () => {
  const config = makeConfig({ allowedDatabases: ["AppMain", "TenantAU"] });
  const { isError, payload } = await bodyOf("list_tables", { database: "Payroll" }, config);
  assert.equal(isError, true);
  assert.equal(payload.code, "database_not_allowed");
});

test("an allowed database is matched case-insensitively, as SQL Server does", () => {
  const config = makeConfig({ allowedDatabases: ["TenantAU"] });
  const target = new ConnectionManager(config).resolve(undefined, "tenantau");
  assert.equal(target.database, "tenantau");
});

test("a catalog name carrying a bracket or semicolon is refused", () => {
  const manager = new ConnectionManager(makeConfig());
  assert.throws(() => manager.resolve(undefined, "Foo]; drop database Bar --"), /not a usable/);
});

test("an unknown environment names the ones that exist", async () => {
  const { isError, payload } = await bodyOf("list_tables", { environment: "nope" });
  assert.equal(isError, true);
  assert.equal(payload.code, "unknown_environment");
  assert.match(payload.message, /default/);
});

// --- the T-SQL guardrail --------------------------------------------------------

const accepted = [
  ["a plain select", "select Id, Name from dbo.Customer"],
  // If this one ever fails the server is useless: three-part names are the only way SQL Server
  // joins across catalogs, and the schema this was built for does it ~4,000 times.
  ["a three-part cross-catalog name", "select * from AppMain.dbo.Tenant"],
  ["a three-part join", "select t.Id from TenantAU.dbo.Customer c join AppMain.dbo.Tenant t on t.Id = c.TenantId"],
  // The reason `bracketQuotedIdentifiers` was added to @mcp/shared.
  ["reserved words as bracketed identifiers", "select [Update], [Delete], [Into] from dbo.Audit"],
  ["a bracketed name containing an escaped bracket", "select [a]]b] from dbo.T"],
  ["a CTE", "with c as (select 1 as x) select * from c"],
  ["a forbidden word inside a string literal", `select ${QUOTE}a${QUOTE}${QUOTE}; drop table t --${QUOTE} as s`],
  ["a trailing semicolon", "select 1;"]
] as const;

for (const [label, statement] of accepted) {
  test(`guardrail accepts ${label}`, () => {
    const result = validateReadOnlySql(statement);
    assert.equal(result.ok, true, result.ok ? "" : result.error.message);
  });
}

const refused = [
  ["a second statement", "select 1; drop table t"],
  ["a linked-server read", "select * from openquery(other, 'select 1')"],
  ["a four-part name", "select * from srv.db.dbo.t"],
  ["an EXEC", "exec sp_who"],
  ["SELECT INTO, which creates a table", "select * into #t from dbo.Customer"],
  ["a CTE that wraps a delete", "with c as (delete from t output deleted.*) select * from c"],
  ["an UPDATE", "update dbo.Customer set Name = 'x'"],
  ["a WAITFOR delay", "select 1 where 1 = 1 waitfor delay '00:00:10'"],
  ["DBCC", "dbcc freeproccache"],
  ["an unterminated bracket", "select [Name from dbo.T"],
  ["an unterminated literal", `select ${QUOTE}abc from dbo.T`]
] as const;

for (const [label, statement] of refused) {
  test(`guardrail refuses ${label}`, () => {
    assert.equal(validateReadOnlySql(statement).ok, false, `should have been refused: ${statement}`);
  });
}

test("the four-part refusal explains the workaround", () => {
  const result = validateReadOnlySql("select * from srv.db.dbo.t");
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "policy_violation");
    assert.match(result.error.message, /alias/);
  }
});

test("a refused statement reaches the client as this server's envelope", async () => {
  const { isError, payload } = await bodyOf("run_read_query", { sql: "drop table t" });
  assert.equal(isError, true);
  assert.equal(payload.code, "validation_error");
  assert.match(payload.message, /SELECT/);
});

// --- fan-out --------------------------------------------------------------------

test("database and databases are mutually exclusive", async () => {
  const { isError, payload } = await bodyOf("run_read_query", {
    sql: "select 1",
    database: "A",
    databases: ["A", "B"]
  });
  assert.equal(isError, true);
  assert.match(payload.message, /not both/);
});

test("a fan-out wider than SQLSERVER_MAX_FANOUT is refused before any connection is opened", async () => {
  const config = makeConfig({
    limits: { ...makeConfig().limits, maxFanout: 2 }
  });
  const { isError, payload } = await bodyOf(
    "run_read_query",
    { sql: "select 1", databases: ["A", "B", "C"] },
    config
  );
  assert.equal(isError, true);
  assert.equal(payload.code, "fanout_limit_exceeded");
  assert.match(payload.message, /2/);
});

test("the guardrail runs before the fan-out limit, so bad SQL is reported as bad SQL", async () => {
  const config = makeConfig({ limits: { ...makeConfig().limits, maxFanout: 1 } });
  const { payload } = await bodyOf(
    "run_read_query",
    { sql: "drop table t", databases: ["A", "B"] },
    config
  );
  assert.equal(payload.code, "validation_error");
});

// --- the exec gate ---------------------------------------------------------------

test("execute_routine is refused while SQLSERVER_EXEC_ENABLED is off", async () => {
  const { isError, payload } = await bodyOf("execute_routine", { routine: "GetCustomers" });
  assert.equal(isError, true);
  assert.equal(payload.code, "policy_violation");
  assert.match(payload.message, /SQLSERVER_EXEC_ENABLED/);
});

test("a catalog in SQLSERVER_READONLY_DATABASES refuses exec even with the flag on", async () => {
  const config = makeConfig({
    exec: { enabled: true, allowlist: [], timeoutMs: 1000 },
    readonlyDatabases: ["AppMain"]
  });
  const { isError, payload } = await bodyOf(
    "execute_routine",
    { routine: "GetCustomers", database: "AppMain" },
    config
  );
  assert.equal(isError, true);
  assert.equal(payload.code, "policy_violation");
  assert.match(payload.message, /SQLSERVER_READONLY_DATABASES/);
});

test("the allowlist narrows exec to matching routines", async () => {
  const config = makeConfig({
    exec: { enabled: true, allowlist: ["dbo.Report_*"], timeoutMs: 1000 },
    // Point at a catalog that will fail to connect, so a routine that PASSES the allowlist fails
    // later and differently — which is what distinguishes "gate refused it" from "gate let it by".
    readonlyDatabases: []
  });
  const { payload } = await bodyOf("execute_routine", { routine: "UpdateEverything" }, config);
  assert.equal(payload.code, "policy_violation");
  assert.match(payload.message, /SQLSERVER_EXEC_ALLOWLIST/);
});

test("an empty allowlist does not narrow anything — the flag alone is the gate", async () => {
  const config = makeConfig({ exec: { enabled: true, allowlist: [], timeoutMs: 500 } });
  const { payload } = await bodyOf("execute_routine", { routine: "GetCustomers" }, config);
  // It gets past all three guards and fails trying to reach the (nonexistent) server, which is a
  // different code from every guard refusal above.
  assert.notEqual(payload.code, "policy_violation");
});

test("a routine name carrying its own qualification is refused by the schema", async () => {
  const config = makeConfig({ exec: { enabled: true, allowlist: [], timeoutMs: 500 } });
  const { isError, payload } = await bodyOf(
    "execute_routine",
    { routine: "dbo].[DropEverything" },
    config
  );
  assert.equal(isError, true);
  assert.equal(payload.code, "validation_error");
});

// --- the error envelope, which `tools/list` cannot see ----------------------------

test("a bad argument is a validation_error with readable issues, not a zod dump", async () => {
  const { isError, payload } = await bodyOf("run_read_query", { sql: "" });
  assert.equal(isError, true);
  assert.equal(payload.code, "validation_error");
  assert.equal(payload.message, "Invalid arguments.");
  assert.match(payload.detail, /^sql: /);
});

test("an unknown tool reports not_found, the code dispatch chose", async () => {
  const { isError, payload } = await bodyOf("no_such_tool", {});
  assert.equal(isError, true);
  assert.deepEqual(payload, { code: "not_found", message: "Unknown tool: no_such_tool." });
});

test("no error message leaks the password", async () => {
  for (const name of ["list_tables", "run_read_query", "execute_routine"]) {
    const { payload } = await bodyOf(name, { sql: "select 1", routine: "X", database: "Nope" });
    assert.equal(JSON.stringify(payload).includes("p4ss"), false, `${name} leaked a credential`);
  }
});

// --- regressions found in review -------------------------------------------------
// Each of these reproduces a defect that shipped in the first version of this server. They are
// written against the behaviour, not the fix, so a refactor that reintroduces the bug fails here.

test("REGRESSION: bracket-quoting a segment does not smuggle a four-part name past the guard", () => {
  // The bracket-identifier support added for `[Update]` blanked `[…]` to spaces BEFORE the
  // four-part shape test ran, so `[srv].[db].[dbo].[t]` contained no word characters and matched
  // nothing. Every one of these reached a linked server.
  for (const statement of [
    "select * from srv.db.dbo.t",
    "select * from [srv].[db].[dbo].[t]",
    "select * from srv.db.dbo.[t]",
    "select * from [srv].db.dbo.t",
    "select * from [srv].[db].dbo.t"
  ]) {
    assert.equal(validateReadOnlySql(statement).ok, false, `four-part name accepted: ${statement}`);
  }
});

test("a bracketed name containing a dot is still one part, so it stays a three-part name", () => {
  // The counterpart risk: over-counting. `[my.db].dbo.t` is three parts, not four.
  assert.equal(validateReadOnlySql("select * from [my.db].dbo.t").ok, true);
});

test("REGRESSION: the exec read-only guard resolves the CALLER's environment, not the default", async () => {
  // The guard called resolve(undefined, database) while the handler called
  // resolve(input.environment, database). With prod's catalog on the never-execute list, a call
  // naming environment "prod" was checked against dev's catalog, passed, and executed on prod.
  const source: Record<string, string> = {
    SQLSERVER_ENV_DEV: "data source=h; initial catalog=AppDev; User Id=u; Password=p",
    SQLSERVER_ENV_PROD: "data source=h; initial catalog=AppProd; User Id=u; Password=p",
    SQLSERVER_DEFAULT_ENVIRONMENT: "dev"
  };
  const env = {
    raw: (name: string) => source[name],
    string: (name: string, fallback: string) => source[name] ?? fallback,
    optionalString: (name: string) => source[name],
    presentKeys: (prefix?: string) =>
      Object.keys(source).filter((key) => (prefix === undefined ? true : key.startsWith(prefix)))
  } as never;
  const { registry } = buildEnvironmentRegistry(env);

  const config = makeConfig({
    registry,
    readonlyDatabases: ["AppProd"],
    exec: { enabled: true, allowlist: [], timeoutMs: 500 }
  });

  const { isError, payload } = await bodyOf(
    "execute_routine",
    { environment: "prod", routine: "DoSomething" },
    config
  );
  assert.equal(isError, true);
  assert.equal(payload.code, "policy_violation");
  assert.match(payload.message, /AppProd/);
});

test("REGRESSION: encrypt is left unset when the connection string does not say", () => {
  // Defaulting it to `false` reached mssql's `options`, which OVERRIDE the driver's secure
  // default — so every connection string omitting `Encrypt=` connected in plaintext.
  const silent = parseConnectionString("data source=h; initial catalog=D; User Id=u; Password=p");
  assert.equal(silent.encrypt, undefined, "must defer to the driver, not assert false");

  assert.equal(parseConnectionString(CONNECTION + ";Encrypt=false").encrypt, false);
  assert.equal(parseConnectionString(CONNECTION + ";Encrypt=true").encrypt, true);
});

test("REGRESSION: a doubled semicolon does not corrupt the following key", () => {
  // `Data Source=h;;Initial Catalog=D` parsed the next key as ";initial catalog" and the whole
  // environment was reported unusable — or, if it was the only one, the server refused to start.
  const parsed = parseConnectionString(
    "Data Source=h;;Initial Catalog=D;;;User Id=u;Password=p;"
  );
  assert.equal(parsed.server, "h");
  assert.equal(parsed.database, "D");
  assert.equal(parsed.user, "u");
});

test("REGRESSION: two env vars folding to the same canonical name are reported, not silently merged", () => {
  // canonicalEnvName maps TEST and UAT both to "uat"; one set of credentials became unreachable
  // with nothing anywhere saying so.
  const source: Record<string, string> = {
    SQLSERVER_ENV_TEST: "data source=h; initial catalog=A; User Id=u; Password=p",
    SQLSERVER_ENV_UAT: "data source=h; initial catalog=B; User Id=u; Password=p"
  };
  const env = {
    raw: (name: string) => source[name],
    string: (name: string, fallback: string) => source[name] ?? fallback,
    optionalString: (name: string) => source[name],
    presentKeys: (prefix?: string) =>
      Object.keys(source).filter((key) => (prefix === undefined ? true : key.startsWith(prefix)))
  } as never;

  const { registry, invalid } = buildEnvironmentRegistry(env);
  assert.equal(registry.environments.size, 1);
  assert.equal(invalid.length, 1);
  assert.match(invalid[0]!.reason, /collides/);
});

test("three-part name candidates are extracted for the allowlist check", () => {
  // `dbo.Customer.Name` has the same shape as `Payroll.dbo.Salaries`, so this returns both and the
  // caller filters against the instance's real catalog list. Over-returning here is correct;
  // refusing `dbo.…` would not be.
  assert.deepEqual(
    referencedCatalogCandidates("select * from Payroll.dbo.Salaries s join dbo.Customer.Name n on 1=1"),
    ["payroll", "dbo"]
  );
  assert.deepEqual(referencedCatalogCandidates("select * from dbo.Customer"), []);
  // A bracketed catalog name is unquoted, so the allowlist compares like with like.
  assert.deepEqual(referencedCatalogCandidates("select * from [Pay roll].dbo.T"), ["pay roll"]);
});

test("the pool cap can never drop below the fan-out concurrency", () => {
  // Eviction takes the least-recently-used pool; below the worker count that can be a pool a
  // running query still holds.
  const config = makeConfig({ pools: { poolMax: 5, maxPools: 1, idleTimeoutMs: 1000 } });
  const manager = new ConnectionManager(config) as unknown as { limits: { maxPools: number } };
  assert.ok(manager.limits.maxPools >= MAX_FANOUT_CONCURRENCY);
});
