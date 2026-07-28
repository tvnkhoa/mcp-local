/**
 * Every MCP server in this workspace.
 *
 * To add one: append an entry here and add `<dir>/skill/SKILL.md`. The installer, doctor, skill
 * generator, contract snapshotter and server runner all pick it up with no further edits — see
 * `.claude/skills/mcp-skill-authoring/SKILL.md` for the full contract.
 *
 * Ported verbatim from `scripts/lib/manifest.mjs` in S-34. Not one value changed: this data is
 * what `~/.claude.json` is written from, so a "tidy-up" here silently rewrites working
 * configuration on the next install.
 */

import { toPosixPath } from "@mcp/core";

import { WORKSPACE_ROOT } from "./paths.js";
import type { ServerDescriptor } from "./types.js";

/**
 * The workspace root as it must appear *inside a config value*.
 *
 * Forward slashes even on Windows: these strings become defaults in `~/.claude.json` and in
 * `CODEBASE_INDEX_ALLOWED_ROOTS`, where a backslash is an escape character. `toPosixPath` is
 * `@mcp/core`'s, and byte-identical to the `toConfigPath` this file used before S-34.
 */
const ROOT = toPosixPath(WORKSPACE_ROOT);

export const SERVERS: readonly ServerDescriptor[] = [
  {
    key: "codebase-index-local",
    displayName: "Codebase Index MCP",
    dir: "codebase-index-mcp",
    entry: "dist/index.js",
    tagline: "Code graph indexing: symbols, call chains, impact analysis, safe refactors.",
    build: { install: true, guards: ["guard:no-llm-runtime"] },
    smokeTest: "node scripts/smoke-test.mjs",
    skillSource: "codebase-index-mcp/skill",
    tools: [
      "list_repositories", "index_repository", "health_check",
      "search_symbols", "get_symbol_context_pack", "find_impact_files",
      "trace_execution_flow", "get_call_chain", "search_regex",
      "refactor_replace_preview", "refactor_replace_apply", "refactor_replace_rollback",
    ],
    env: [
      { name: "CODEBASE_INDEX_ALLOWED_ROOTS", required: true, group: "roots", default: ROOT,
        prompt: "Allowed roots (comma-separated absolute paths)",
        note: "The ONLY required var. Comma-separated absolute paths the server may index." },
      { name: "CODEBASE_INDEX_DB_PATH", required: false, default: `${ROOT}/mcp-codebase-index.db`,
        prompt: "SQLite DB path",
        note: "Where the code graph is stored. Defaults next to the workspace." },
      { name: "CODEBASE_INDEX_DOCS_INDEXING_ENABLED", required: false, default: "false" },
      { name: "CODEBASE_INDEX_DOCS_TOOLS_ENABLED", required: false, default: "false" },
      { name: "CODEBASE_INDEX_TELEMETRY_ENABLED", required: false, default: "false" },
      { name: "CODEBASE_INDEX_WATCH_AUTO_START", required: false, default: "false" },
      { name: "CODEBASE_INDEX_REFACTOR_APPROVAL_SECRET", required: false, secret: true,
        note: "HMAC secret for refactor approval tokens. Auto-generated per process if unset." },
    ],
  },

  {
    key: "postgres-mcp",
    displayName: "PostgreSQL MCP",
    dir: "postgres-mcp",
    entry: "dist/index.js",
    tagline: "Read-only Postgres access with SQL guardrails; gated writes + EF Core migrations.",
    build: { install: true, guards: [] },
    smokeTest: "node scripts/smoke-test.mjs",
    skillSource: "postgres-mcp/skill",
    tools: [
      "list_environments", "list_tables", "describe_table", "get_table_relationships",
      "run_read_query", "profile_table", "compare_environments", "data_diff",
      "write_preview", "write_apply", "write_rollback",
      "migration_status", "migration_add", "migration_preview", "migration_dry_run", "migration_apply",
    ],
    env: [
      { name: "CH_DB_CONNECTION", required: false, secret: true, group: "connection-source",
        prompt: "Postgres connection string (Npgsql; blank to use PG_ENV_* or appsettings)",
        note: "Connection source. Need ONE of: CH_DB_CONNECTION | PG_ENV_* | CH_APPSETTINGS_ROOTS." },
      { name: "CH_APPSETTINGS_ROOTS", required: false, group: "connection-source",
        prompt: "appsettings.json root(s) to discover connections (optional)",
        note: "Alternative connection source: discover connection strings from .NET appsettings*.json." },
      { name: "PG_ENV_*", prefix: "PG_ENV_", required: false, secret: true, group: "connection-source",
        note: "Per-env connections, e.g. PG_ENV_DEV / PG_ENV_STAGING / PG_ENV_PROD. Any one satisfies the connection source." },
      { name: "CH_CONNECTION_NAME", required: false, default: "CommunicationHubDb" },
      { name: "PG_ALLOWED_ENVIRONMENTS", required: false, default: "dev" },
      { name: "PG_WRITABLE_ENVIRONMENTS", required: false, default: "",
        note: "prod is ALWAYS read-only regardless of this value." },
      { name: "PG_DEFAULT_ENVIRONMENT", required: false, default: "dev" },
      { name: "MCP_DB_DEFAULT_LIMIT", required: false, default: "500" },
      { name: "MCP_DB_MAX_LIMIT", required: false, default: "2000" },
      { name: "MCP_DB_DEFAULT_TIMEOUT_MS", required: false, default: "30000" },
      { name: "MCP_DB_MAX_TIMEOUT_MS", required: false, default: "60000" },
      { name: "PG_WRITE_ENABLED", required: false, default: "false",
        note: "Data writes (preview→apply→rollback) OFF unless true." },
      { name: "PG_WRITE_APPROVAL_SECRET", required: false, secret: true,
        note: "Auto-generated per process if empty; set to keep tokens valid across restarts." },
      { name: "PG_MIGRATION_ENABLED", required: false, default: "false",
        note: "EF Core migration tooling OFF unless true." },
    ],
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
    tools: [
      "list_streams", "describe_stream", "search_logs", "tail_logs",
      "trace_logs", "get_trace_spans", "log_stats", "run_observe_query",
    ],
    env: [
      { name: "OBSERVE_BASE_URL", required: true,
        prompt: "OpenObserve base URL (query API host)",
        note: "The OpenObserve UI/API host — NOT the OTLP ingest host." },
      { name: "OBSERVE_ORG", required: true, prompt: "Organization identifier" },
      { name: "OBSERVE_LOG_STREAM", required: true, prompt: "Log stream name", default: "wecrm_dev" },
      { name: "OBSERVE_TRACE_STREAM", required: true, prompt: "Trace stream name", default: "wecrm_dev" },
      { name: "OBSERVE_AUTH_BASIC", required: false, secret: true, group: "observe-auth",
        prompt: "Pre-encoded Basic token (blank to use username+password)",
        note: "Auth: provide this OR OBSERVE_USERNAME + OBSERVE_PASSWORD." },
      { name: "OBSERVE_USERNAME", required: false, group: "observe-auth",
        prompt: "OpenObserve username (if not using OBSERVE_AUTH_BASIC)" },
      { name: "OBSERVE_PASSWORD", required: false, secret: true, group: "observe-auth",
        prompt: "OpenObserve password" },
      { name: "OBSERVE_DEFAULT_SIZE", required: false, default: "100" },
      { name: "OBSERVE_MAX_SIZE", required: false, default: "1000" },
      { name: "OBSERVE_DEFAULT_LOOKBACK_MS", required: false, default: "3600000" },
      { name: "OBSERVE_MAX_LOOKBACK_MS", required: false, default: "604800000" },
      { name: "OBSERVE_TIMEOUT_MS", required: false, default: "30000" },
    ],
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
    tools: [
      "list_repositories", "get_repository", "list_branches",
      "list_pull_requests", "get_pull_request", "get_pull_request_diff",
      "create_pull_request", "health_check",
    ],
    env: [
      { name: "BITBUCKET_WORKSPACE", required: true, prompt: "Bitbucket workspace slug" },
      { name: "BITBUCKET_ACCESS_TOKEN", required: false, secret: true, group: "bitbucket-auth",
        prompt: "Access token for Bearer auth (blank to use email + API token)",
        note: "Auth: this (Bearer) OR BITBUCKET_EMAIL + BITBUCKET_API_TOKEN (Basic)." },
      { name: "BITBUCKET_EMAIL", required: false, group: "bitbucket-auth",
        prompt: "Atlassian account email (Basic auth)",
        note: "siliconstack workspace uses an Atlassian API token → Basic auth (email + token)." },
      { name: "BITBUCKET_API_TOKEN", required: false, secret: true, group: "bitbucket-auth",
        prompt: "Atlassian API token (Basic auth)" },
      { name: "BITBUCKET_DEFAULT_REPO", required: false, prompt: "Default repository slug (optional)" },
      { name: "BITBUCKET_WRITE_ENABLED", required: false, default: "false",
        note: "create_pull_request is DISABLED unless true." },
      { name: "BITBUCKET_TIMEOUT_MS", required: false, default: "30000" },
      { name: "BITBUCKET_MAX_RETRIES", required: false, default: "2" },
    ],
  },
];

export function getServer(key: string): ServerDescriptor | null {
  return SERVERS.find((s) => s.key === key) ?? null;
}

export function serverKeys(): string[] {
  return SERVERS.map((s) => s.key);
}
