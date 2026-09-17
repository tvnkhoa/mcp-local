/**
 * The query set `docs-recall.mjs` measures against. Twenty queries, two halves, different jobs.
 *
 * **`phrase` (10).** Generated, not invented: each is a five-word fragment lifted from a prose
 * section, verified to occur in exactly ONE file of the corpus, and sampled round-robin across
 * directories so the set is not dominated by whichever folder sorts first. They read oddly because
 * they are real text rather than composed sentences, and that is the point — they test mechanical
 * reachability end to end, and before the Stage 4 prose writer every one of them returned nothing.
 *
 * **`intent` (10).** Hand-written: the way an agent actually asks. `expectFiles` is a SET, because
 * these documents deliberately cross-reference and the same fact genuinely lives in several places —
 * keying recall to a single file would measure my guess about where an answer "should" be rather
 * than whether the answer was found. A hit is any expected file in the top 5.
 *
 * Two caveats worth carrying:
 *
 * - `q07` is Vietnamese, from `postgres-mcp/README.md`. It is deliberate: the Stage 6 plan is to
 *   normalize every document to English, and whether Vietnamese prose is retrievable today is a fact
 *   that decision should rest on rather than an assumption.
 * - The `phrase` half will drift as documents are edited. When one starts missing, check whether the
 *   source text still exists before treating it as a retrieval regression — `docs-recall.mjs` prints
 *   the expected file so the check is one grep.
 */

export const QUERY_SET = [
  // ── phrase: generated, each occurs in exactly one file ──────────────────────
  { id: "q01", kind: "phrase", query: "actually is: four servers, six", expectFile: "docs/architecture/README.md" },
  { id: "q02", kind: "phrase", query: "Baseline track: only structural tools", expectFile: ".claude/commands/mcp-effectiveness-eval.md" },
  { id: "q03", kind: "phrase", query: "file per MCP server, holding", expectFile: "contracts/README.md" },
  { id: "q04", kind: "phrase", query: "workspace holds five shared packages", expectFile: "docs/decisions/0001-workspace-native-deps.md" },
  { id: "q05", kind: "phrase", query: "Guards ship reporting-only: findings print", expectFile: "packages/cli/README.md" },
  { id: "q06", kind: "phrase", query: "Normative lookups. Each answers one", expectFile: "docs/reference/README.md" },
  { id: "q07", kind: "phrase", query: "MCP server cho PostgreSQL với", expectFile: "postgres-mcp/README.md" },
  { id: "q08", kind: "phrase", query: "agent can violate without noticing", expectFile: "AGENTS.md" },
  { id: "q09", kind: "phrase", query: "table links out rather than", expectFile: "docs/servers/README.md" },
  { id: "q10", kind: "phrase", query: "API rather than reading files", expectFile: "observe-mcp/README.md" },

  // ── intent: how an agent asks. expectFiles is a set; any one in the top 5 is a hit ──
  {
    id: "q11",
    kind: "intent",
    query: "why are the servers not part of the npm workspace",
    expectFiles: ["docs/decisions/0001-workspace-native-deps.md", "docs/architecture/target-architecture.md"]
  },
  {
    id: "q12",
    kind: "intent",
    query: "which database environment is always read only",
    expectFiles: ["CLAUDE.md", "postgres-mcp/README.md", "postgres-mcp/skill/SKILL.md", ".claude/skills/postgres-mcp/SKILL.md"]
  },
  {
    id: "q13",
    kind: "intent",
    query: "what does CI actually run and what does it skip",
    expectFiles: ["docs/development/ci.md", "docs/development/workflow.md", "CLAUDE.md"]
  },
  {
    id: "q14",
    kind: "intent",
    query: "how do I add a new MCP server to this workspace",
    expectFiles: ["docs/servers/server-development.md", "CLAUDE.md", ".claude/skills/mcp-skill-authoring/SKILL.md"]
  },
  {
    id: "q15",
    kind: "intent",
    query: "where are environment variables declared and how do I add one",
    expectFiles: ["CLAUDE.md", "docs/reference/conventions.md", "AGENTS.md", "docs/servers/server-development.md"]
  },
  {
    id: "q16",
    kind: "intent",
    query: "what happens when better-sqlite3 fails to build on windows",
    expectFiles: ["CLAUDE.md", "docs/guides/onboarding.md", "docs/development/workflow.md"]
  },
  {
    id: "q17",
    kind: "intent",
    query: "how are stored procedure calls gated in sql server",
    expectFiles: ["CLAUDE.md", "sqlserver-mcp/README.md", "sqlserver-mcp/skill/SKILL.md", "docs/decisions/0004-tsql-guardrail-policy.md", ".claude/skills/sqlserver-mcp/SKILL.md"]
  },
  {
    id: "q18",
    kind: "intent",
    query: "what is the approval token used for in refactoring",
    expectFiles: ["codebase-index-mcp/CLAUDE.md", "codebase-index-mcp/README.md", "CLAUDE.md"]
  },
  {
    id: "q19",
    kind: "intent",
    query: "which files are generated and must not be hand edited",
    expectFiles: ["CLAUDE.md", "docs/reference/conventions.md", "contracts/README.md", "docs/development/workflow.md"]
  },
  {
    id: "q20",
    kind: "intent",
    query: "how do I find which documents have gone out of date",
    expectFiles: ["codebase-index-mcp/README.md", "codebase-index-mcp/CLAUDE.md", ".claude/skills/codebase-index/SKILL.md", "docs/README.md"]
  }
];
