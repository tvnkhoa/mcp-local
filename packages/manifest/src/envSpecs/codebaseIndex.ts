/**
 * `codebase-index-local`'s environment contract — 34 vars.
 *
 * Seven of these were declared before S-35; the other 27 were read by the code and declared
 * nowhere, which is why `.env.example`, the README and this manifest each described a different
 * server. The set was recovered by proxying `process.env` during a real boot and recording every
 * key actually read, then reading each call site for its true fallback — not by grepping for
 * `process.env`, which misses `env.string("KEY", …)` entirely.
 *
 * Only the first seven carry `default`, because `install-mcp` writes a `default` into
 * `~/.claude.json` and thereby pins it. The tuning knobs carry `codeDefault` instead: documented,
 * never pinned. See {@link import("../types.js").EnvField}.
 */

import type { EnvField } from "../types.js";

/** @param root the workspace root, POSIX-separated — see `servers.ts` for why that matters. */
export function codebaseIndexEnv(root: string): readonly EnvField[] {
  return [
    // --- Required -----------------------------------------------------------------
    {
      name: "CODEBASE_INDEX_ALLOWED_ROOTS",
      required: true,
      group: "roots",
      default: root,
      section: "Required",
      prompt: "Allowed roots (comma-separated absolute paths)",
      note: "The ONLY required var. Comma-separated absolute paths the server may index. Use the exact path `list_repositories` reports — changing drive-letter casing or slash style causes allowlist rejection."
    },

    // --- Storage ------------------------------------------------------------------
    {
      name: "CODEBASE_INDEX_DB_PATH",
      required: false,
      default: `${root}/mcp-local-index-central.db`,
      section: "Storage",
      prompt: "SQLite DB path",
      note: "Where the code graph is stored — one file holds every repo, scoped by repoId. Four names were in play before S-40; this is the one actually in use. Note that the server's own fallback when this is unset is the RELATIVE path ./codebase-index.db, which lands wherever the process was started, so leaving it set is what keeps the index in one place."
    },

    // --- Docs lane ----------------------------------------------------------------
    { name: "CODEBASE_INDEX_DOCS_INDEXING_ENABLED", required: false, default: "false", section: "Docs lane (off by default)" },
    { name: "CODEBASE_INDEX_DOCS_TOOLS_ENABLED", required: false, default: "false", section: "Docs lane (off by default)" },

    // --- Telemetry ----------------------------------------------------------------
    { name: "CODEBASE_INDEX_TELEMETRY_ENABLED", required: false, default: "false", section: "Telemetry (off by default)" },
    {
      name: "CODEBASE_INDEX_TELEMETRY_SAMPLE_RATE",
      required: false,
      codeDefault: "1",
      section: "Telemetry (off by default)",
      note: "Ratio 0–1. Only meaningful when telemetry is enabled."
    },

    // --- Watch --------------------------------------------------------------------
    {
      name: "CODEBASE_INDEX_WATCH_AUTO_START",
      required: false,
      default: "false",
      section: "Watch",
      note: "Watchless by default, per the workspace's MCP hard-mode policy."
    },
    {
      name: "CODEBASE_INDEX_WATCH_ACTIVE_ONLY",
      required: false,
      codeDefault: "true",
      section: "Watch",
      note: "Defaults to TRUE — only the active repo is watched. The one boolean here whose default is not false."
    },
    { name: "CODEBASE_INDEX_WATCH_ACTIVE_TTL_MS", required: false, codeDefault: "900000", section: "Watch", note: "Idle watcher stop timeout. Clamped to 5s–24h." },
    { name: "CODEBASE_INDEX_WATCH_DEBOUNCE_MS", required: false, codeDefault: "500", section: "Watch" },
    { name: "CODEBASE_INDEX_WATCH_BATCH_SIZE", required: false, section: "Watch" },
    { name: "CODEBASE_INDEX_WATCH_MAX_FILES_PER_RUN", required: false, section: "Watch" },
    { name: "CODEBASE_INDEX_WATCH_MAX_QUEUED_EVENTS", required: false, section: "Watch" },
    {
      name: "CODEBASE_INDEX_AUTO_WATCH_REPOS",
      required: false,
      section: "Watch",
      note: "Comma-separated repoIds to auto-watch at boot. Unset = none."
    },

    // --- Indexing limits ----------------------------------------------------------
    { name: "CODEBASE_INDEX_MAX_FILES_PER_RUN", required: false, codeDefault: "20000", section: "Indexing limits" },
    { name: "CODEBASE_INDEX_MAX_FILE_SIZE_BYTES", required: false, codeDefault: "500000", section: "Indexing limits" },
    { name: "CODEBASE_INDEX_LARGE_FILE_THRESHOLD_BYTES", required: false, codeDefault: "0", section: "Indexing limits", note: "0 = no large-file special casing." },
    { name: "CODEBASE_INDEX_MAX_RESULT_LIMIT", required: false, codeDefault: "500", section: "Indexing limits", note: "Hard ceiling on any tool's `limit`." },
    { name: "CODEBASE_INDEX_MAX_DEPTH", required: false, codeDefault: "5", section: "Indexing limits", note: "Hard ceiling on traversal `depth`." },
    {
      name: "CODEBASE_INDEX_LARGE_REPO_PROFILE",
      required: false,
      codeDefault: "auto",
      section: "Indexing limits",
      note: "Performance profile: auto | standard/off | large/balanced | very-large/aggressive."
    },

    // --- Parser tuning ------------------------------------------------------------
    { name: "CODEBASE_INDEX_PARSE_WORKERS", required: false, section: "Parser tuning", note: "Worker-pool size. Unset = derived from CPU count." },
    { name: "CODEBASE_INDEX_PARSE_TIMEOUT_MS", required: false, codeDefault: "5000", section: "Parser tuning", note: "Per-file parse timeout." },
    { name: "CODEBASE_INDEX_PARSE_JOB_TIMEOUT_MS", required: false, codeDefault: "20000", section: "Parser tuning", note: "Whole-batch timeout." },
    { name: "CODEBASE_INDEX_MAX_CALL_EDGES_PER_FILE", required: false, section: "Parser tuning", note: "Override; unset = the extractor's own limit." },
    { name: "CODEBASE_INDEX_MIN_EDGE_CONFIDENCE", required: false, section: "Parser tuning", note: "Ratio 0–1. Drops low-confidence edges at extraction time." },
    { name: "CODEBASE_INDEX_MAX_STRING_LITERALS_PER_FILE", required: false, section: "Parser tuning" },
    { name: "CODEBASE_INDEX_MIN_STRING_LITERAL_LENGTH", required: false, section: "Parser tuning" },
    { name: "NUGET_NAMESPACE_MAP", required: false, section: "Parser tuning", note: "Extra NuGet package → namespace mappings for .NET dependency edges." },

    // --- Write batching -----------------------------------------------------------
    { name: "CODEBASE_INDEX_SUBTX_SIZE", required: false, codeDefault: "20", section: "Write batching", note: "Files per SQLite sub-transaction." },
    { name: "CODEBASE_INDEX_CHECKPOINT_EVERY_N_BATCHES", required: false, codeDefault: "1", section: "Write batching", note: "WAL checkpoint cadence." },

    // --- Post-resolve phase -------------------------------------------------------
    {
      name: "CODEBASE_INDEX_MAX_UNRESOLVED_RESOLVE_ROWS",
      required: false,
      section: "Post-resolve phase",
      note: "Cap on unresolved pairs resolved after extraction. Profile-dependent when unset (0 = unlimited for standard/very-large, 120000 for large)."
    },
    { name: "CODEBASE_INDEX_POST_RESOLVE_TYPE_REFS", required: false, codeDefault: "true", section: "Post-resolve phase" },
    { name: "CODEBASE_INDEX_POST_RESOLVE_PROPERTY_REFS", required: false, codeDefault: "true", section: "Post-resolve phase" },
    { name: "CODEBASE_INDEX_CROSS_REPO_NAMESPACES", required: false, section: "Post-resolve phase", note: "Namespaces treated as shared when resolving cross-repo edges." },

    // --- Refactor approval --------------------------------------------------------
    {
      name: "CODEBASE_INDEX_REFACTOR_APPROVAL_SECRET",
      required: false,
      secret: true,
      section: "Refactor approval",
      note: "HMAC secret for refactor approval tokens. Auto-generated per process if unset; set it to keep tokens valid across restarts."
    },
    { name: "CODEBASE_INDEX_REFACTOR_PREVIEW_TTL_MS", required: false, codeDefault: "1800000", section: "Refactor approval", note: "Preview/token lifetime — 30 minutes." },
    {
      name: "CODEBASE_INDEX_REFACTOR_STRICT_APPROVAL",
      required: false,
      codeDefault: "false",
      section: "Refactor approval",
      note: "When true, startup fails unless CODEBASE_INDEX_REFACTOR_APPROVAL_SECRET is set."
    },

    // --- Diagnostics --------------------------------------------------------------
    { name: "CODEBASE_INDEX_INDEX_LOG", required: false, section: "Diagnostics", note: "Enables verbose index-progress logging on stderr." },

    // --- Hard block ---------------------------------------------------------------
    {
      name: "CODEBASE_INDEX_LLM_ENABLED",
      required: false,
      codeDefault: "false",
      section: "Hard block — do not enable",
      note: "Runtime LLM invocation is prohibited by design. Setting this to true ABORTS STARTUP, and `guard:no-llm-runtime` statically verifies no LLM client is importable. Declared here so the constraint is documented, not so it can be turned on."
    }
  ];
}
