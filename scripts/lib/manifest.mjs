// Single source of truth for every MCP server in this workspace.
// Consumed by install-mcp.mjs, mcp-doctor.mjs, uninstall-mcp.mjs, update-mcp.mjs,
// and the skill renderer (lib/skills.mjs).
//
// To add a new MCP server: append an entry here, add <dir>/skill/SKILL.md, done —
// the installer, doctor, and skill generator pick it up automatically.
// See .claude/skills/mcp-skill-authoring/SKILL.md for the full contract.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { toConfigPath } from "./jsonc.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// scripts/lib/ -> scripts/ -> workspace root
export const WORKSPACE_ROOT = path.resolve(__dirname, "..", "..");
const ROOT = toConfigPath(WORKSPACE_ROOT);

// Env-field shape:
//   name       (string, required)  env var name
//   required   (bool)   true = must be set for the server to work
//   secret     (bool)   true = value is sensitive; never echoed by doctor/summary
//   default    (string) written silently when the user gives no value
//   prompt     (string) if present, the installer asks for this var interactively
//   group      (string) "at least one of the vars in this group must be set"
//   note       (string) shown near the prompt / in the generated skill env table

/** @type {Array<{key:string, displayName:string, dir:string, entry:string, tagline:string,
 *   build:{install:boolean, guards:string[]}, smokeTest:string|null,
 *   skillSource:string, tools:string[], env:any[]}>} */
export const SERVERS = [
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

export function getServer(key) {
  return SERVERS.find((s) => s.key === key) || null;
}

// Single source of truth for "is this server's env satisfied?" — used by both the
// installer and the doctor so they can never drift on required/group/prefix rules.
// `presentKeys` = the env var names that currently have a non-empty value.
export function evaluateEnv(server, presentKeys) {
  const present = new Set(presentKeys);
  const missingRequired = server.env
    .filter((f) => f.required && !f.group && !present.has(f.name))
    .map((f) => f.name);
  const groups = [...new Set(server.env.filter((f) => f.group).map((f) => f.group))];
  const groupSatisfied = (g) => server.env.some((f) => {
    if (f.group !== g) return false;
    if (present.has(f.name)) return true;
    if (f.prefix) return [...present].some((k) => k.startsWith(f.prefix));
    return false;
  });
  const unsatisfiedGroups = groups.filter((g) => !groupSatisfied(g));
  const groupMembers = (g) => server.env.filter((f) => f.group === g).map((f) => f.name);
  return { missingRequired, unsatisfiedGroups, groupMembers };
}

export function serverKeys() {
  return SERVERS.map((s) => s.key);
}

// Absolute path to a server's built entry point.
export function serverEntryPath(server) {
  return path.join(WORKSPACE_ROOT, server.dir, ...server.entry.split("/"));
}

// Absolute path to a server's package dir.
export function serverDirPath(server) {
  return path.join(WORKSPACE_ROOT, server.dir);
}
