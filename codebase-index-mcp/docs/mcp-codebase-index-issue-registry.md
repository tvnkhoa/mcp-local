# MCP Codebase-Index — Issue Registry (server-side bugs)

Bug/enhancement reports for the `codebase-index-mcp` server, raised from consuming repos (e.g.
`wec.communication-hub`). Each entry: Scenario · Tool/query attempted · Expected vs actual · Impact ·
Workaround · Enhancement proposal. Filed here so the MCP server team can triage and fix at the source.

> Note: consumer repos keep their own *fallback log* (when they drop to Grep/Read) separately; this
> file tracks defects/limitations of the MCP server itself.

---

## MCP-ISSUE-032 — an index run is not reproducible: edge counts vary between identical runs

- **Status:** open. Found 2026-07-29 while validating the S-41 `indexPipeline` split; pre-existing
  and unrelated to that change.
- **Scenario:** index the same repository twice, same build, same input, nothing changed on disk.
- **Evidence:** on `wec.communication-hub` (521 files), two runs of the **same** build:

  | | run 1 | run 2 | delta |
  |---|---|---|---|
  | symbols | 4457 | 4457 | 0 |
  | CALLS / IMPORTS / PROPERTY_WRITE / DEPENDS_ON / PUBLISHES | — | — | 0 |
  | PROPERTY_REF | 10895 | 11397 | **+502** |
  | IMPLEMENTS | 308 | 300 | −8 |
  | CONSUMES | 58 | 60 | +2 |
  | TYPE_REF | 154 | 156 | +2 |

  Total `edgesUpserted` moved 34921 → 35419 (1.4%). Reproduced with `parseWorkers: 2` **and**
  `parseWorkers: 0`, so it is not worker-lane concurrency.
- **Root cause (confirmed for the first half):** `glob("**/*")` in the scan phase returns the same
  1422 paths in a **different order** on each call — verified directly over three consecutive
  calls, first divergence at index 11. Nothing sorts the result before it becomes the processing
  order.
- **Root cause (hypothesis for the second half, NOT verified):** the edge types that move are the
  ones needing a type resolved from elsewhere in the repo, while the per-file, order-independent
  ones (symbols, CALLS, IMPORTS, PROPERTY_WRITE) are stable. That is consistent with C# type/DI
  resolution seeing a different set of already-indexed files depending on order. Confirming this
  needs a run where the file order is fixed and only that varies — not yet done.
- **Impact:** `health_check` edge counts differ between identical runs, so a change in them is not
  evidence of a change in the code. Any test asserting an exact edge total on a C# repo is
  latently flaky. It also means a before/after edge count cannot validate a refactor — which is how
  this was found: the first comparison appeared to show a 237-edge regression that turned out to be
  noise, and only a same-build control run distinguished the two.
- **Workaround:** compare symbol counts, not edge counts. For edges, run the same build twice to
  establish the noise band before reading any delta as signal.
- **Enhancement proposal:** sort the glob result in `indexing/fileScan.ts` (`scanRepoFiles`) so
  processing order is deterministic. One line, and it makes runs comparable. Deliberately NOT done
  as part of S-41: it changes the edge counts a run produces, which is tool output, and it should
  land as its own change with the second root cause confirmed first — sorting may make runs
  reproducible without making them *correct*, since whichever order is fixed still decides which
  cross-file references resolve.

---

## MCP-ISSUE-031 — `dead_code_scan` suppresses every method in an `i`-prefixed C# file

- **Status:** open. Found 2026-07-29 while splitting `staticAnalyzer.ts` (S-41); the defect itself
  predates the split and is unchanged by it.
- **Scenario:** `dead_code_scan` on a .NET repo. Any method declared in a file whose name begins
  with `I` followed by a letter — `ItemService.cs`, `IndexController.cs`, `InvoiceRepository.cs` —
  is dropped from the candidate list under `suppressed.reasons.heuristic_contract_declaration`.
- **Root cause (confirmed):** in `getCSharpSuppressionReason`
  (`src/analysis/staticAnalyzerDeadCodeCSharp.ts`), `normalizedPath` is lowercased before the filename is
  taken, and the interface-file test is then `/^i[a-z].*\.cs$/`. The pattern was written for the
  `IThing.cs` convention, where the discriminator is the *capital* `I` followed by a capital letter
  — but the casing is already gone by the time the test runs, so it matches any `i`-initial
  filename. The three sibling checks on the same branch (`/interfaces/`, `/contracts/`,
  `/abstractions/`) are path-based and unaffected.
- **Expected vs actual:** expected only interface declarations (`IOrderService.cs`) to be reported
  as `heuristic_contract_declaration`. Actual: ordinary implementation files match too, so the scan
  silently under-reports. Because a suppressed symbol is *excluded*, this is a false negative — the
  tool looks clean while hiding candidates, which is the failure mode hardest to notice.
- **Impact:** `dead_code_scan` under-reports on any .NET repo with `I`-initial type names. Scale
  depends on naming; on `wec.communication-hub` it covers every `Invoice*`/`Item*`/`Identity*` file.
  No effect on non-C# rows, which exit the function before this check.
- **Workaround:** none from the tool side. Cross-check an `I`-initial file by hand
  (`find_impact_files` view `"surface"` on it) before trusting a clean scan.
- **Enhancement proposal:** test the filename with its original casing — keep `normalizedPath` for
  the `/interfaces/`-style path checks, and match the interface convention against a
  non-lowercased basename as `/^I[A-Z]/`. That is a visible change to tool output (more candidates
  reported), so it needs its own step rather than riding along with a file split.
- **Covered by:** `src/analysis/staticAnalyzerDeadCodeCSharp.test.ts`, test
  `"KNOWN DEFECT (MCP-ISSUE-031)"` — pins the current behaviour, and names which of its two
  assertions must flip when the fix lands.

---

## ISSUE-CR-001 — Package bridge resolves 0/257 (cross-repo provider linkage)

- **Status:** fixed 2026-06-29 (`src/dotnetProjectParser.ts`) — provider bridge symbol now emitted for implicit PackageId. Consumer-side `edges`/`find_package_consumers` workaround remains valid as a fallback.
- **Root cause (confirmed):** the provider-side `nuget-export` module symbol (signature `nuget:<id>`) was only emitted when the `.csproj` declared an explicit `<PackageId>`. Real provider projects (e.g. `SSNet.CommunicationHub.Messaging`) rarely set it — NuGet defaults `PackageId` to `AssemblyName`, then to the project file name — so no provider symbol existed for `resolveUnlinkedEdges` to bridge against, leaving `packageResolved: 0`.
- **Fix:** `extractCsproj` now derives the contract id as `PackageId ?? AssemblyName ?? <project file name>`. Non-packable projects emit no bridge symbol — `isProjectPackable` detects `<IsPackable…>false`, `<IsTestProject>true`, and a `Microsoft.NET.Test.Sdk` reference (attribute-tolerant). Because the broadened emission raises the chance of two repos exporting the same `nuget:<id>`, `resolveUnlinkedEdges` no longer drops a colliding contract as `ambiguous_candidates`: for `nuget:`/`endpoint:` toIds it now resolves to the most complete provider repo (same `pickBestModule` heuristic as `resolveImportsCrossRepo`); genuine symbol-id collisions still stay ambiguous. Covered by `scripts/test/test-nuget-bridge.mjs` (implicit-PackageId, non-packable, and contract-collision-tiebreak scenarios).
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

- **Status:** fixed 2026-06-29 (`src/responseFormatter.ts`) — `toNugetContractId` is now idempotent.
- **First observed:** 2026-06-29
- **Scenario:** Passing a fully-qualified `nuget:<name>` to `find_package_consumers`.
- **Expected vs actual:** Expected the tool to accept the contract id as-is. Actual: it re-prepended `nuget:`, producing `packageContractId: "nuget:nuget:<name>"` → `consumerCount: 0` (false negative).
- **Fix:** `toNugetContractId` strips a leading `nuget:` prefix (any case/whitespace) before re-prefixing, so both a bare name and a fully-qualified id normalize to the same `nuget:<lowercase>` contract id. Covered by `scripts/test/test-nuget-bridge.mjs` (idempotency scenario).
- **Note:** Passing the bare package name still works exactly as before; both forms are now accepted.
