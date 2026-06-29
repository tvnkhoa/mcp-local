# MCP Codebase-Index — Issue Registry (server-side bugs)

Bug/enhancement reports for the `codebase-index-mcp` server, raised from consuming repos (e.g.
`wec.communication-hub`). Each entry: Scenario · Tool/query attempted · Expected vs actual · Impact ·
Workaround · Enhancement proposal. Filed here so the MCP server team can triage and fix at the source.

> Note: consumer repos keep their own *fallback log* (when they drop to Grep/Read) separately; this
> file tracks defects/limitations of the MCP server itself.

---

## ISSUE-CR-001 — Package bridge resolves 0/257 (cross-repo provider linkage)

- **Status:** open (workaround documented; root-cause investigation pending)
- **First observed:** 2026-06-29 (live `health_check` on `wec.communication-hub`)
- **Scenario:** Cross-repo "who consumes the messaging contract" / provider-side symbol resolution.
- **Tool/query attempted:**
  - `health_check{ repoId: "wec.communication-hub" }` → `packageBridge: { packageAttempts: 257, packageResolved: 0, packageNoCandidate: 257 }`; `crossRepoResolved 34/5000`.
  - `get_cross_repo_impact` → returns `impactCount: 0` for actively-consumed contract symbols.
  - `find_package_consumers{ packageName: "nuget:ssnet.communicationhub.messaging" }` → 0 (double-prefixed to `nuget:nuget:...`).
- **Expected vs actual:** Expected provider symbols (in `ssnet.communicationhub.messaging`) to link to Hub's `nuget:` dependency edges. Actual: zero bridge links; per-consumer `resolved:false`.
- **Root-cause hypothesis (from `codebase-index-mcp/src/crossRepoStore.ts`):** The bridge (`findProviderSymbolByName` / `getPackageBridgeStatsImpl`) only links when a provider repo emits a `module` symbol whose `signature` **exactly equals** the consumer's `nuget:<contractId>` string. The messaging provider repo apparently does not produce a `module` symbol with signature `nuget:ssnet.communicationhub.messaging`, so no edge matches.
- **Impact:** Provider-side enrichment (provider repo/symbol columns) is empty; `get_cross_repo_impact` is unreliable. Consumer-side discovery is NOT affected.
- **Workaround (verified, in CLAUDE.md + POLICY.md + SKILL.md):**
  1. `query_graph` → `select distinct to_id from edges where repo_id=:repoId and type='DEPENDS_ON' and to_id like 'nuget:%'` to get the exact contract id.
  2. `find_package_consumers{ packageName: "ssnet.communicationhub.messaging" }` — **bare name, no `nuget:` prefix** → returns 8 consumers. The `edges` query works regardless of bridge state; `resolved:false` is the expected gap.
- **Enhancement proposal (touches `codebase-index-mcp`, out of scope for the docs PR — separate follow-up):**
  - Confirm the gap: `query_graph{ repoId: "ssnet.communicationhub.messaging", sql: "select symbol_id, name, signature from symbols where kind='module'" }` and compare `signature` values against the `to_id` strings the Hub depends on.
  - If signatures don't match the `nuget:<id>` format, fix the provider-side module-symbol signature emission (or the bridge's matching rule) in the indexer so `packageResolved` rises above 0; otherwise accept the consumer-side workaround as permanent and document it as such.

---

## ISSUE-CR-002 — `find_package_consumers` double-prefixes `nuget:`

- **Status:** documented (usage gotcha; not a defect to fix on our side)
- **First observed:** 2026-06-29
- **Scenario:** Passing a fully-qualified `nuget:<name>` to `find_package_consumers`.
- **Expected vs actual:** Expected the tool to accept the contract id as-is. Actual: it re-prepends `nuget:`, producing `packageContractId: "nuget:nuget:<name>"` → `consumerCount: 0` (false negative).
- **Workaround:** Always pass the **bare** package name; the tool adds the `nuget:` prefix. Captured in the param tables of all three docs.
