/**
 * Every MCP server in this workspace.
 *
 * To add one: append an entry here, add its env contract under `envSpecs/`, and add
 * `<dir>/skill/SKILL.md`. The installer, doctor, skill generator, contract snapshotter and server
 * runner all pick it up with no further edits — see `.claude/skills/mcp-skill-authoring/SKILL.md`.
 *
 * Two fields are deliberately not written here:
 *
 * - `env` lives in `envSpecs/` — 89 fields across four servers do not belong in one file, and
 *   keeping them separate means a change to one server's contract has a diff that says so.
 * - `tools` is **generated** from `contracts/` by `scripts/generate-tools.mjs`. It used to be a
 *   hand-maintained subset and had drifted to 12 of 43 tools for `codebase-index` (S-36).
 *
 * This data is what `~/.claude.json` gets written from, so a "tidy-up" here silently rewrites
 * working agent configuration on the next install.
 */

import { toPosixPath } from "@mcp/core";

import { bitbucketEnv } from "./envSpecs/bitbucket.js";
import { codebaseIndexEnv } from "./envSpecs/codebaseIndex.js";
import { observeEnv } from "./envSpecs/observe.js";
import { postgresEnv } from "./envSpecs/postgres.js";
import { sqlserverEnv } from "./envSpecs/sqlserver.js";
import { TOOL_LISTS } from "./generated/toolLists.js";
import { WORKSPACE_ROOT } from "./paths.js";
import type { ServerDescriptor } from "./types.js";

/**
 * The workspace root as it must appear *inside a config value*.
 *
 * Forward slashes even on Windows: these strings become defaults in `~/.claude.json` and in
 * `CODEBASE_INDEX_ALLOWED_ROOTS`, where a backslash is an escape character.
 */
const ROOT = toPosixPath(WORKSPACE_ROOT);

/**
 * The shared "no generated list yet" value. Frozen so a consumer cannot push into it and make one
 * pending server's list appear on another's.
 */
const NO_TOOLS: readonly string[] = Object.freeze([]);

/**
 * The generated tool list for `key`, or an empty list when `contracts/<key>.json` has not been
 * snapshotted yet.
 *
 * This used to THROW, and that made the natural order for adding a server impossible: the throw
 * fired while `servers.ts` was being imported, so every script that reads the manifest died —
 * including `contract-snapshot.mjs`, the one script that creates the missing snapshot. The docs
 * worked around it with a temporary `tools: ["health_check"]` that had to be swapped back by hand.
 *
 * Returning `[]` moves the failure from import time to the gates, where it belongs. The empty list
 * is the marker — {@link serversMissingTools} reports it, and every gate that could otherwise ship
 * it refuses: `contracts:check` (a MISSING snapshot, or one `generate:tools` has not consumed),
 * `generate:docs` and so `generate:check`, the skill renderer and so `mcp:install` / `mcp:doctor`,
 * and the manifest's own tests. A server can be registered without tools only long enough to be
 * snapshotted; nothing publishes it in that state.
 *
 * Exported for the manifest's tests only; `index.ts` does not re-export it.
 */
export function toolsFor(key: string): readonly string[] {
  const tools = TOOL_LISTS[key];
  return tools === undefined || tools.length === 0 ? NO_TOOLS : tools;
}

/**
 * The actionable message for a server whose tool list is empty — shared by every gate so they all
 * name the same two commands.
 */
export function missingToolsMessage(key: string): string {
  return (
    `"${key}" has no generated tool list. Snapshot its contract, then regenerate: ` +
    `\`npm run contracts:update -- --server ${key}\` (needs a built server), then ` +
    "`npm run generate:all`."
  );
}

export const SERVERS: readonly ServerDescriptor[] = [
  {
    key: "codebase-index",
    displayName: "Codebase Index MCP",
    dir: "codebase-index-mcp",
    entry: "dist/index.js",
    tagline: "Code graph indexing: symbols, call chains, impact analysis, safe refactors.",
    build: { install: true, guards: ["guard:no-llm-runtime"] },
    smokeTest: "node scripts/smoke-test.mjs",
    skillSource: "codebase-index-mcp/skill",
    tools: toolsFor("codebase-index"),
    env: codebaseIndexEnv(ROOT)
  },

  {
    key: "postgres-mcp",
    displayName: "PostgreSQL MCP",
    dir: "postgres-mcp",
    entry: "dist/index.js",
    tagline: "Read-only Postgres access with SQL guardrails; gated writes, EF Core migrations and raw-SQL DDL migrations.",
    build: { install: true, guards: [] },
    smokeTest: "node scripts/smoke-test.mjs",
    skillSource: "postgres-mcp/skill",
    tools: toolsFor("postgres-mcp"),
    env: postgresEnv
  },

  {
    key: "sqlserver-mcp",
    displayName: "SQL Server MCP",
    dir: "sqlserver-mcp",
    entry: "dist/index.js",
    tagline: "Read-only SQL Server access across catalogs on one instance; gated stored procedures.",
    build: { install: true, guards: [] },
    smokeTest: "node scripts/smoke-test.mjs",
    skillSource: "sqlserver-mcp/skill",
    tools: toolsFor("sqlserver-mcp"),
    env: sqlserverEnv
  },

  {
    key: "observe-mcp",
    displayName: "OpenObserve MCP",
    dir: "observe-mcp",
    entry: "dist/index.js",
    tagline: "Read-only log/trace search over OpenObserve for the CommunicationHub backend.",
    build: { install: true, guards: [] },
    smokeTest: "node scripts/smoke-test.mjs",
    skillSource: "observe-mcp/skill",
    tools: toolsFor("observe-mcp"),
    env: observeEnv
  },

  {
    key: "bitbucket-mcp",
    displayName: "Bitbucket Cloud MCP",
    dir: "bitbucket-mcp",
    entry: "dist/index.js",
    tagline: "Read repositories/pull requests and create PRs on Bitbucket Cloud.",
    build: { install: true, guards: [] },
    smokeTest: "node scripts/smoke-test.mjs",
    skillSource: "bitbucket-mcp/skill",
    tools: toolsFor("bitbucket-mcp"),
    env: bitbucketEnv
  }
];

export function getServer(key: string): ServerDescriptor | null {
  return SERVERS.find((s) => s.key === key) ?? null;
}

export function serverKeys(): string[] {
  return SERVERS.map((s) => s.key);
}

/**
 * Keys of registered servers that advertise no tools — normally one registered with `toolsFor`
 * before its contract was snapshotted. Every gate calls this; an empty result is the only
 * shippable state.
 *
 * Takes the list as a parameter so the gates can be tested against a fake descriptor without
 * registering a probe in the real manifest.
 */
export function serversMissingTools(servers: readonly ServerDescriptor[] = SERVERS): string[] {
  return servers.filter((s) => s.tools.length === 0).map((s) => s.key);
}
