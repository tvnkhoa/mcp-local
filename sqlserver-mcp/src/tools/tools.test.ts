import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { createNullLogger, createEventLogger } from "@mcp/core";
import { asErrorPayload, createToolRegistry, dispatchToolCall } from "@mcp/sdk";

import { buildDeps, buildTools, toWireError } from "./index.js";
import { summarizeCrossDatabaseTargets } from "./readTools.js";
import type { SqlserverConfig } from "../config/index.js";
import {
  parseConnectionString,
  withDatabase,
  maskConnection,
  buildEnvironmentRegistry
} from "../config/environments.js";
import { ConnectionManager, MAX_FANOUT_CONCURRENCY } from "../repositories/connectionManager.js";
import { referencedCatalogCandidates, validateReadOnlySql } from "../middleware/sqlGuardrails.js";
import { buildCrossDatabasePayload } from "./readTools.js";
import type { ResponseProfile } from "../middleware/responseFormatter.js";
import {
  classifyConnectionFailure,
  connectionFailureAsPlatformError
} from "../middleware/errors.js";

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


// ---- Connection failure classification (found by the first real install: a TLS failure reached
// the caller as `internal_error` / "Health probe failed.", which is the one answer a health check
// must not give) ----

/** Shaped like a `mssql` ConnectionError, which nests the useful text on `originalError`. */
function driverError(code: string, message: string): Error & { code: string; originalError: Error } {
  const error = new Error(message) as Error & { code: string; originalError: Error };
  error.code = code;
  error.originalError = new Error(message);
  return error;
}

test("a TLS chain failure is reported as config_error and names the fix", () => {
  const classified = classifyConnectionFailure(
    driverError("ESOCKET", "Failed to connect to db.example:1433 - unable to get local issuer certificate")
  );
  assert.equal(classified?.code, "config_error");
  assert.match(classified?.message ?? "", /NODE_EXTRA_CA_CERTS/);
  // The trade-off is stated, not just the workaround.
  assert.match(classified?.message ?? "", /impersonable/);
});

test("classification never echoes the driver's own text", () => {
  // Both the host and the login name appear in real driver messages, and `describeConfig`
  // redacts the login to `***` — forwarding the message would leak past our own redaction.
  const cases = [
    driverError("ESOCKET", "Failed to connect to secret-host.internal:1433 - getaddrinfo ENOTFOUND secret-host.internal"),
    driverError("ELOGIN", "Login failed for user 'svc_reporting'."),
    driverError("ETIMEOUT", "Timeout: request failed to complete in 15000ms"),
    driverError("ECONNRESET", "socket hang up at secret-host.internal")
  ];
  for (const error of cases) {
    const message = classifyConnectionFailure(error)?.message ?? "";
    assert.equal(message.includes("secret-host.internal"), false, message);
    assert.equal(message.includes("svc_reporting"), false, message);
  }
});

test("each connect failure gets its own code, and the driver code is carried", () => {
  const expected: ReadonlyArray<readonly [string, string, string]> = [
    ["ESOCKET", "getaddrinfo ENOTFOUND host", "config_error"],
    ["ELOGIN", "Login failed for user 'u'.", "unauthorized"],
    ["ETIMEOUT", "Timeout: connection failed", "timeout"],
    ["ECONNREFUSED", "connect ECONNREFUSED 10.0.0.1:1433", "config_error"],
    ["ESOCKET", "socket hang up", "upstream_error"]
  ];
  for (const [code, text, want] of expected) {
    const classified = classifyConnectionFailure(driverError(code, text));
    assert.equal(classified?.code, want, `${code}: ${text}`);
    assert.match(classified?.message ?? "", new RegExp(`driver: ${code}`));
  }
});

test("a non-driver error is left to the normal mapper", () => {
  assert.equal(classifyConnectionFailure(new Error("something else")), undefined);
  // A `code` outside the fixed vocabulary is not interpolated into a message.
  assert.equal(classifyConnectionFailure(driverError("not a code", "x")), undefined);
});

test("the probe's PlatformError keeps the original on cause, never in the message", () => {
  const cause = driverError("ELOGIN", "Login failed for user 'svc_reporting'.");
  const error = connectionFailureAsPlatformError(cause);
  assert.equal(error.code, "unauthorized");
  assert.equal(error.message.includes("svc_reporting"), false);
  assert.equal(error.cause, cause, "the full error stays reachable for the log");
});

test("an unclassifiable probe failure still says it was the probe", () => {
  const error = connectionFailureAsPlatformError(new Error("boom"));
  assert.equal(error.code, "internal_error");
  assert.match(error.message, /probe/i);
});

// ---- Default catalog ----

test("a connection string with no catalog starts in master", () => {
  // Requiring one contradicted the server's own thesis: the catalog is per-call, and the
  // connection string only names where to start. This was a hard boot failure until 2026-08-19.
  const parsed = parseConnectionString("Data Source=h; User Id=u; Password=p");
  assert.equal(parsed.database, "master");
});

test("an explicit catalog still wins, under either spelling", () => {
  assert.equal(parseConnectionString("Server=h; Initial Catalog=AppMain; User Id=u; Password=p").database, "AppMain");
  assert.equal(parseConnectionString("Server=h; Database=AppMain; User Id=u; Password=p").database, "AppMain");
});

test("a missing server is still refused — only the catalog got a default", () => {
  assert.throws(
    () => parseConnectionString("some-host.example.com;User Id=u;Password=p"),
    /missing a server/,
    "a bare host with no `Data Source=` is what a real operator pasted, and ADO.NET refuses it too"
  );
});


// ---- Reserved words in generated SQL ----

/**
 * T-SQL reserved words that are plausible column aliases. Not the full list — the full list is 180
 * words and most of them (`CROSS`, `HAVING`) could never be mistaken for a result column name.
 * These are the ones that read like data.
 */
const RESERVED_ALIASES = new Set([
  "rowcount", "key", "percent", "plan", "public", "read", "user", "current_user", "session_user",
  "system_user", "file", "identity", "check", "column", "constraint", "default", "distinct",
  "escape", "function", "grant", "index", "left", "right", "like", "national", "option", "order",
  "over", "primary", "print", "proc", "public", "raiserror", "replication", "restore", "return",
  "revert", "rule", "save", "schema", "select", "set", "statistics", "table", "top", "tran",
  "trigger", "truncate", "union", "unique", "update", "use", "values", "view", "when", "where",
  "while", "with", "writetext"
]);

test("no generated SQL aliases a column to a T-SQL reserved word", () => {
  // `list_tables` shipped broken: `as rowCount` is a syntax error because ROWCOUNT is reserved
  // (`SET ROWCOUNT`), so every call failed with "Incorrect syntax near the keyword 'rowCount'".
  // No test caught it — all of these run without a database, and the smoke test was never run.
  // This scans the SQL itself, which needs no connection.
  const source = readFileSync(
    fileURLToPath(new URL("../repositories/introspection.ts", import.meta.url)),
    "utf8"
  );
  const offenders: string[] = [];
  const aliasPattern = /\bas\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?=[,\r\n]|$)/gm;
  for (const match of source.matchAll(aliasPattern)) {
    const alias = match[1] ?? "";
    if (RESERVED_ALIASES.has(alias.toLowerCase())) {
      offenders.push(alias);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `alias(es) collide with a T-SQL reserved word and must be bracketed, e.g. \`as [${offenders[0] ?? "x"}]\``
  );
});


// ---- Cross-database targets that are not catalogs ----
// Found by running the tool against a real instance: of 13 target names reported for CRM_Master,
// four were not databases at all. `referenceCount: 107` was really 103 plus noise.

const XML_AND_DROPPED = [
  // XML shredding: `CROSS APPLY … AS agent_nodes(agent_node)` then `agent_node.value(…)` is
  // recorded by the catalog as the three-part name `agent_nodes.agent_node.value`.
  { fromSchema: "dbo", fromObject: "sp_WhoIsActive", fromType: "SQL_STORED_PROCEDURE", toDatabase: "agent_nodes", toSchema: "agent_node", toObject: "value" },
  { fromSchema: "dbo", fromObject: "USP_CaptureDeadlock", fromType: "SQL_STORED_PROCEDURE", toDatabase: "x", toSchema: "dl", toObject: "value" },
  // A real reference to a database that has since been dropped — the module no longer binds.
  { fromSchema: "dbo", fromObject: "ImportNZBSI", fromType: "SQL_STORED_PROCEDURE", toDatabase: "CRM_Tenant_NZ", toSchema: "dbo", toObject: "Vehicle" },
  { fromSchema: "dbo", fromObject: "ImportNZBSI", fromType: "SQL_STORED_PROCEDURE", toDatabase: "CRM_Tenant_NZ", toSchema: "dbo", toObject: "Warranty" },
  // Two genuine cross-catalog reads.
  { fromSchema: "dbo", fromObject: "DealerGroupView", fromType: "VIEW", toDatabase: "CRM_Identity", toSchema: "dbo", toObject: "Entity" },
  { fromSchema: "dbo", fromObject: "SP_GetOrgInfo", fromType: "SQL_STORED_PROCEDURE", toDatabase: "CRM_Identity", toSchema: "dbo", toObject: "Entity" }
];

// Lower-case key -> the instance's own spelling, matching ConnectionManager.catalogNames().
const REAL_CATALOGS = new Map([
  ["crm_identity", "CRM_Identity"],
  ["crm_master", "CRM_Master"],
  ["master", "master"]
]);

test("a target that is not a catalog is marked, not dropped", () => {
  const { targets, unresolvedTargets } = summarizeCrossDatabaseTargets(XML_AND_DROPPED, REAL_CATALOGS);
  // Dropping them would hide CRM_Tenant_NZ, which is the one finding here worth acting on.
  assert.deepEqual(
    unresolvedTargets.map((t) => t.database).sort(),
    ["CRM_Tenant_NZ", "agent_nodes", "x"]
  );
  assert.equal(targets.length, 4, "every target still appears");
  assert.equal(targets.find((t) => t.database === "CRM_Identity")?.exists, true);
});

test("the headline count is split so noise cannot inflate it", () => {
  const { unresolvedReferenceCount } = summarizeCrossDatabaseTargets(XML_AND_DROPPED, REAL_CATALOGS);
  assert.equal(unresolvedReferenceCount, 4, "2 XML rows + 2 rows to the dropped catalog");
  assert.equal(XML_AND_DROPPED.length - unresolvedReferenceCount, 2, "only 2 are real");
});

test("real catalogs sort ahead of unresolved names", () => {
  const { targets } = summarizeCrossDatabaseTargets(XML_AND_DROPPED, REAL_CATALOGS);
  const firstUnresolved = targets.findIndex((t) => !t.exists);
  const lastReal = targets.map((t) => t.exists).lastIndexOf(true);
  assert.ok(lastReal < firstUnresolved, `real targets must come first: ${targets.map((t) => t.database).join(", ")}`);
});

test("catalog matching is case-insensitive, as SQL Server names are", () => {
  const { unresolvedTargets } = summarizeCrossDatabaseTargets(
    [{ fromSchema: "dbo", fromObject: "V", fromType: "VIEW", toDatabase: "CRM_IDENTITY", toSchema: "dbo", toObject: "Entity" }],
    REAL_CATALOGS
  );
  assert.deepEqual(unresolvedTargets, []);
});

// --- run_read_query response shape --------------------------------------------
//
// The response shape is NOT in `contracts/sqlserver-mcp.json` — that snapshot pins the *input*
// schema only. So when the fan-out moved onto a shared seam there was nothing to catch a key
// quietly appearing, disappearing or being renamed on the way through. These are that net.
//
// They reach no database. An allowlist makes `resolve()` refuse each requested catalog before a
// connection is attempted, while the connection's own default catalog — which the payload's
// `environment` is resolved from — is not allowlist-checked, so the call still completes.

const ALLOWLISTED = () => makeConfig({ allowedDatabases: ["Permitted"] });

test("the fan-out shape is the rolled-up one, with a slot per catalog in request order", async () => {
  const { payload } = await bodyOf(
    "run_read_query",
    { sql: "select 1", databases: ["Alpha", "Beta"] },
    ALLOWLISTED()
  );
  assert.deepEqual(Object.keys(payload).sort(), [
    "catalogCount",
    "environment",
    "failureCount",
    "maxRows",
    "results"
  ]);
  assert.equal(payload.catalogCount, 2);
  assert.equal(payload.failureCount, 2);
  assert.deepEqual(
    payload.results.map((slot: { database: string }) => slot.database),
    ["Alpha", "Beta"],
    "request order, not completion order"
  );
});

test("one refused catalog is a slot, not a failed call", async () => {
  // The whole point of the fan-out contract: the envelope stays a success and the refusal is
  // reported in the catalog it belongs to, carrying the code that says what to change.
  const { isError, payload } = await bodyOf(
    "run_read_query",
    { sql: "select 1", databases: ["Alpha"] },
    ALLOWLISTED()
  );
  assert.equal(isError, undefined, "a refused catalog must not fail the whole call");
  const slot = payload.results[0];
  assert.deepEqual(Object.keys(slot).sort(), ["database", "error", "errorCode"]);
  assert.equal(slot.errorCode, "database_not_allowed", "the actionable code, not a generic failure");
});

test("a one-element databases array still gets the fan-out shape", async () => {
  // The rule that keeps the shape stable for a caller whose catalog list is computed.
  const { payload } = await bodyOf(
    "run_read_query",
    { sql: "select 1", databases: ["Solo"] },
    ALLOWLISTED()
  );
  assert.ok("results" in payload, "one entry must not collapse to the flat shape");
  assert.equal(payload.catalogCount, 1);
});

// --- fan-out on the metadata tools ---------------------------------------------

test("the three fan-out tools advertise the SAME databases node, not three lookalikes", () => {
  // `common.ts` exists so two tools meaning the same thing by a parameter advertise it identically.
  // Object identity is the only way to assert that and have it survive someone "improving" one of
  // the three descriptions in isolation.
  const nodes = ["run_read_query", "list_tables", "list_routines"].map((name) => {
    const tool = makeTools().find((candidate) => candidate.name === name);
    assert.ok(tool, `${name} not found`);
    return (tool.inputSchema as { properties: Record<string, unknown> }).properties["databases"];
  });
  assert.ok(nodes[0], "run_read_query must still advertise databases");
  assert.equal(nodes[1], nodes[0], "list_tables advertises a different databases node");
  assert.equal(nodes[2], nodes[0], "list_routines advertises a different databases node");
});

for (const toolName of ["list_tables", "list_routines"]) {
  test(`${toolName}: database and databases are mutually exclusive`, async () => {
    const { isError, payload } = await bodyOf(toolName, { database: "A", databases: ["B"] });
    assert.equal(isError, true);
    assert.match(payload.message, /not both/);
  });

  test(`${toolName}: a fan-out wider than the configured limit is refused`, async () => {
    const config = makeConfig({ limits: { ...makeConfig().limits, maxFanout: 2 } });
    const { isError, payload } = await bodyOf(toolName, { databases: ["A", "B", "C"] }, config);
    assert.equal(isError, true);
    assert.equal(payload.code, "fanout_limit_exceeded");
  });

  test(`${toolName}: a refused catalog is a slot, and the other catalogs are unaffected`, async () => {
    // The fan-out contract, provable without a database: the allowlist refuses at `resolve()`,
    // before a connection is attempted.
    const config = makeConfig({ allowedDatabases: ["Permitted"] });
    const { isError, payload } = await bodyOf(toolName, { databases: ["Alpha", "Beta"] }, config);
    assert.equal(isError, undefined, "one refused catalog must not fail the whole call");
    assert.equal(payload.catalogCount, 2);
    assert.equal(payload.failureCount, 2);
    assert.deepEqual(
      payload.results.map((slot: { database: string }) => slot.database),
      ["Alpha", "Beta"],
      "request order"
    );
    assert.equal(payload.results[0].errorCode, "database_not_allowed");
  });
}

// --- find_cross_database_references payload sizing -----------------------------
//
// This tool returned 295KB against a real catalog and overflowed the client at EVERY profile:
// `nano` and `compact` were byte-identical because the platform's profile handling is
// null-dropping plus minification, and this payload has no nulls. Tested through the pure builder
// so the whole matrix runs with no connection.

const XREFS = [
  { fromSchema: "dbo", fromObject: "V", fromType: "VIEW", toDatabase: "Other", toSchema: "dbo", toObject: "T" },
  { fromSchema: "dbo", fromObject: "P", fromType: "SQL_STORED_PROCEDURE", toDatabase: "Gone", toSchema: "dbo", toObject: "T" }
];
const KNOWN = new Map([["other", "Other"]]);

const xrefPayload = (profile: ResponseProfile, includeReferences?: boolean) =>
  buildCrossDatabasePayload({
    environment: "default",
    database: "AppMain",
    references: XREFS,
    catalogNames: KNOWN,
    dynamicSqlModules: 3,
    profile,
    ...(includeReferences === undefined ? {} : { includeReferences })
  });

test("references are omitted below standard and present at or above it", () => {
  assert.equal("references" in xrefPayload("nano"), false);
  assert.equal("references" in xrefPayload("compact"), false, "compact is the DEFAULT — it must be small");
  assert.equal("references" in xrefPayload("standard"), true);
  assert.equal("references" in xrefPayload("verbose"), true);
});

test("nano spends its rung on the remaining unbounded array", () => {
  const nano = xrefPayload("nano").targets as { referencingObjects?: unknown; referencingObjectCount: number }[];
  assert.equal("referencingObjects" in nano[0]!, false, "the last unbounded string array must go");
  assert.equal(nano[0]?.referencingObjectCount, 1, "the count survives the array");
  const compact = xrefPayload("compact").targets as { referencingObjects?: unknown }[];
  assert.ok(compact[0]?.referencingObjects, "compact keeps them — it is the usable default");
});

test("includeReferences overrides in both directions, at every profile", () => {
  for (const profile of ["nano", "compact", "standard", "verbose"] as const) {
    assert.equal("references" in xrefPayload(profile, true), true, `${profile}: opt-in ignored`);
    assert.equal("references" in xrefPayload(profile, false), false, `${profile}: opt-out ignored`);
  }
});

test("the counts survive at every profile, so the number never vanishes with the array", () => {
  for (const profile of ["nano", "compact", "standard", "verbose"] as const) {
    const payload = xrefPayload(profile);
    assert.equal(payload.referenceCount, 2, `${profile}: referenceCount missing`);
    assert.equal(payload.resolvedReferenceCount, 1, `${profile}: one target is not a real catalog`);
    assert.equal(payload.unresolvedReferenceCount, 1);
  }
});

test("coverage says whether the drill-down was included, and how to get it", () => {
  const compact = xrefPayload("compact").coverage as { referencesIncluded: boolean; note: string };
  assert.equal(compact.referencesIncluded, false);
  assert.match(compact.note, /includeReferences/, "a truncated payload must say how to widen it");
  const standard = xrefPayload("standard").coverage as { referencesIncluded: boolean; note: string };
  assert.equal(standard.referencesIncluded, true);
  assert.equal(/includeReferences/.test(standard.note), false, "no advice needed when nothing was cut");
});

test("catalog spellings fold together, and the instance's own casing is echoed back", () => {
  // Live output split `CRM_Marketing` (848 refs) from `CRM_marketing` (4) into two targets and
  // understated both, while the existence check already folded case — so one catalog was reported
  // as several that all said `exists: true`. `referenced_database_name` records the spelling the
  // developer typed; catalog names are case-insensitive under a CI collation.
  const rows = [
    { fromSchema: "dbo", fromObject: "A", fromType: "VIEW", toDatabase: "CRM_Master", toSchema: "dbo", toObject: "T" },
    { fromSchema: "dbo", fromObject: "B", fromType: "VIEW", toDatabase: "crm_master", toSchema: "dbo", toObject: "T" },
    { fromSchema: "dbo", fromObject: "C", fromType: "VIEW", toDatabase: "CRM_MASTER", toSchema: "dbo", toObject: "T" }
  ];
  const { targets } = summarizeCrossDatabaseTargets(rows, REAL_CATALOGS);
  assert.equal(targets.length, 1, `three spellings of one catalog became ${String(targets.length)} targets`);
  assert.equal(targets[0]?.referenceCount, 3, "counts must accumulate across spellings");
  assert.equal(targets[0]?.referencingObjectCount, 3);
  assert.equal(
    targets[0]?.database,
    "CRM_Master",
    "echo the instance's spelling — a made-up casing is not usable as a `database` argument"
  );
});

test("an unresolved target keeps the spelling it was written with", () => {
  // There is no instance spelling to prefer when the catalog does not exist.
  const rows = [
    { fromSchema: "dbo", fromObject: "P", fromType: "SQL_STORED_PROCEDURE", toDatabase: "agent_nodes", toSchema: "n", toObject: "value" }
  ];
  const { targets } = summarizeCrossDatabaseTargets(rows, REAL_CATALOGS);
  assert.equal(targets[0]?.database, "agent_nodes");
  assert.equal(targets[0]?.exists, false);
});

test("list_routines accepts an ISO timestamp for modifiedAfter and rejects prose", async () => {
  // The strongest lead in a real incident was "five report procs changed today", found by eye
  // across 189 rows of `modifiedAt`. Both accepted spellings are pinned because a date alone is
  // what an operator actually types.
  for (const value of ["2026-08-19", "2026-08-19T02:49:00Z", "2026-08-19T02:49:00+10:00"]) {
    const { payload } = await bodyOf("list_routines", { databases: ["Nope"], modifiedAfter: value },
      makeConfig({ allowedDatabases: ["Permitted"] }));
    // Refused at the catalog, not at the argument — which is how we know the argument parsed.
    assert.equal(payload.results[0].errorCode, "database_not_allowed", `rejected ${value}`);
  }
  const { isError, payload } = await bodyOf("list_routines", { modifiedAfter: "last tuesday" });
  assert.equal(isError, true);
  assert.equal(payload.code, "validation_error");
});
