import test from "node:test";

import { createEventLogger } from "@mcp/core";
import { assertRequiredKeysAdvertised, assertSchemaParity } from "@mcp/testing";

import { buildDeps, buildTools } from "./index.js";
import { buildEnvironmentRegistry } from "../config/environments.js";
import type { SqlserverConfig } from "../config/index.js";
import { ConnectionManager } from "../repositories/connectionManager.js";

/**
 * Every tool declares its input twice — a zod schema the handler validates with, and a hand-written
 * JSON Schema `tools/list` advertises — and nothing else compares them. `contracts:check` pins the
 * advertised side against a snapshot of *itself*, so a parameter missing from both stays missing;
 * `docs:check` reads the advertised side only. This server gained the gate the day `databases` and
 * `includeReferences` were about to be hand-added to three tools.
 *
 * No zod namespace is passed. Injecting one was the first design — ADR 0001 means this server's
 * `ZodObject` is not an instance of a hoisted package's class — and it does not work here:
 * `health_check` comes from `@mcp/sdk` carrying the hoisted zod while this server's own eleven
 * tools carry its copy, so no single namespace matches the table. The helper discriminates on
 * `_def.typeName` instead, and the floor is what turns a broken walk into a failure rather than a
 * clean report over nothing.
 */

const CONNECTION =
  "data source=db.internal,1433; initial catalog=AppMain; User Id=svc; Password=p4ss";

function makeConfig(): SqlserverConfig {
  const source: Record<string, string> = { SQLSERVER_CONNECTION: CONNECTION };
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
    limits: {
      defaultLimit: 500,
      maxLimit: 2000,
      defaultTimeoutMs: 30_000,
      maxTimeoutMs: 60_000,
      maxFanout: 25
    },
    pools: { poolMax: 5, maxPools: 12, idleTimeoutMs: 30_000 },
    exec: { enabled: false, allowlist: [], timeoutMs: 120_000 }
  };
}

const config = makeConfig();
const tools = buildTools(
  buildDeps(config, new ConnectionManager(config), createEventLogger(() => undefined))
);

test("every tool advertises exactly the parameters its zod schema accepts", () => {
  // 12 tools with exec disabled — the floor is the whole surface, so a tool that stops being
  // comparable fails rather than quietly reducing coverage.
  assertSchemaParity(tools, { floor: 12 });
});

test("a tool declaring additionalProperties:false advertises every required key", () => {
  assertRequiredKeysAdvertised(tools);
});
