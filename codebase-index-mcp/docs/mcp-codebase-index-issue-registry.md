# MCP Codebase-Index — Issue Registry (server-side bugs)

Bug/enhancement reports for the `codebase-index-mcp` server, raised from consuming repos (e.g.
`wec.communication-hub`). Each entry: Scenario · Tool/query attempted · Expected vs actual · Impact ·
Workaround · Enhancement proposal. Filed here so the MCP server team can triage and fix at the source.

> Note: consumer repos keep their own *fallback log* (when they drop to Grep/Read) separately; this
> file tracks defects/limitations of the MCP server itself.

---

## MCP-ISSUE-032 — an index run is not reproducible: edge counts vary between identical runs

- **Status:** open — **root cause relocated 2026-07-29**, see the update below. Two contributing
  bugs fixed; the main one is narrowed to the extraction phase and not yet fixed. Found while
  validating the S-41 `indexPipeline` split; pre-existing and unrelated to that change.
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
- **Update 2026-07-29 — the proposed fix was attempted and is NOT sufficient. Root cause relocated.**

  The sort landed (`indexing/fileScan.ts` now `.sort()`s the glob, plain UTF-16 order rather than
  `localeCompare`, so it is platform- and locale-stable). It did **not** make runs reproducible.
  Nine runs on `wec.communication-hub` (475 files), same build:

  | | sorted ×2 | workers off ×2 | + ORDER BY ×3 |
  |---|---|---|---|
  | symbolsUpserted | 4411 / 4411 | 4411 / 4411 | 4411 / 4411 / 4411 |
  | edgesUpserted | 35167 / 35566 | 35379 / 35579 | 35552 / 35765 / 35586 |

  Three things are now ruled out, each by measurement rather than reasoning:

  1. **Glob order** — sorted runs still vary.
  2. **Worker concurrency** — `CODEBASE_INDEX_PARSE_WORKERS=0` genuinely disables the pool
     (`parseWorkers > 0 ? new ExtractionWorkerPool(...) : null`), and single-threaded runs still vary.
  3. **Unordered `LIMIT` in the resolvers** — six queries in `src/graph/` had a `LIMIT` with no
     `ORDER BY`, so they sampled unresolved rows arbitrarily. Real latent bug, **fixed** (see below),
     but not this one: variance survives the fix.

- **Root cause (relocated, confirmed):** the divergence happens in the **extraction/write phase**, not
  in resolution. Verbose logs from two runs, normalized for timing, differ at the same batch:

  ```
  [index-write] batch=5/8 files=176 subtx=9 symbols=1316 edges=6377   <- run 1
  [index-write] batch=5/8 files=176 subtx=9 symbols=1316 edges=6480   <- run 2
  ```

  Identical batch composition, identical symbol count, **103 more edges**. Since the scan is now
  sorted and the read loop preserves order (`Promise.allSettled` over fixed chunks, results pushed in
  input order), the file processing order is deterministic — so the nondeterminism is *inside*
  extracting one file's edges. The most likely remaining mechanism is an extraction-time DB lookup
  that resolves a type/member name with a `LIMIT` and no `ORDER BY`, returning an arbitrary candidate:
  there are ~175 such candidate sites across `src/store/` and `src/search/`. **Not yet confirmed to
  that line**, and auditing 175 queries is its own change — adding `ORDER BY` blindly would broaden
  tool-output changes and risk sort costs on the hot path.

- **Why the edge-type split now makes sense:** the stable types (`PROPERTY_WRITE`, `IMPORTS`,
  `DEPENDS_ON`) are derived purely from the one file being parsed. The varying ones (`CALLS`,
  `PROPERTY_REF`, `TYPE_REF`, `IMPLEMENTS`, `CONSUMES`, `PUBLISHES`) all need a name resolved against
  symbols from elsewhere. The original note guessed this was *post-hoc* cross-file resolution; the
  logs show it happens during extraction.

- **What landed:**
  - `indexing/fileScan.ts` — glob result sorted. Independently worth keeping: when `maxFiles`
    truncates a scan, *which* files get indexed was previously arbitrary.
  - Six `ORDER BY` clauses in `src/graph/` — `edgeResolverCalls.ts`, `edgeResolverImports.ts`,
    `edgeResolverRefs.ts` (×2), `edgeResolverShared.ts` (the hard-coded `limit 5000`), and
    `interfaceSiblings.ts` (before `IMPLEMENTOR_CAP`, so which implementors survive the cap is no
    longer arbitrary).
  - 30/30 harnesses pass; `contracts:check` 4/4 — no schema change.

- **Status:** still **open**, with the root cause corrected and narrowed to extraction. The workaround
  is unchanged and still necessary: compare symbol counts, not edge counts; for edges, run the same
  build twice to establish the noise band before reading any delta as signal.

---

## MCP-ISSUE-034 — C# `TYPE_REF` edges are almost never produced, so every C# type looks dead

- **Status:** **largely fixed** 2026-07-29 (`src/extractors/csharpSymbols.ts`,
  `src/extractors/extractorEdges.ts`). Found immediately after MCP-ISSUE-033 made `dead_code_scan`
  return results for the first time — the tool became usable and its first real output was mostly wrong.
- **Scenario:** `dead_code_scan` on a .NET repo. Every candidate it reports is a type declaration
  (`class` / `record` / `record struct`), and the obvious ones are live: `ValidationException`,
  `ForbiddenAccessException`, `RequestContext`, `N8nChatDecisionRequest`, and
  `NormalizedMessageContent` — which is the return type of the very file it is declared in.
- **Measured on `wec.communication-hub`** (4442 symbols, 35 887 edges):

  | edge type | distinct symbols that are its TARGET |
  |---|---|
  | CALLS | 1751 |
  | PROPERTY_REF | 1622 |
  | IMPORTS | 79 |
  | IMPLEMENTS | 58 |
  | **TYPE_REF** | **22** |

  | | count |
  |---|---|
  | C#-type-like declarations (`class`/`record`/`record struct`/`struct`/`interface`/`type`) | 792 |
  | ...with **zero** incoming `TYPE_REF` edge | **784 (99.0%)** |

- **Root cause (not yet confirmed):** the graph barely contains resolved C# type references at all —
  22 target symbols across a whole repo is not a suppression problem or a scan problem, it is an
  extraction/resolution problem. `dead_code_scan`'s rule ("no incoming CALLS/TYPE_REF/IMPORTS") is
  correct given the edges it is shown; the edges are missing. Whether the loss is at extraction
  (`treeSitterExtractor` not emitting `type:` placeholders for declarations, fields, parameters and
  return types) or at resolution (`resolveTypeRefEdges` not matching them) is the next question, and
  the `TYPE_REF` totals are small enough — 145 to 149 across runs — to inspect exhaustively.
- **Relationship to MCP-ISSUE-032:** `TYPE_REF` is one of the edge types that varies between identical
  runs there (145/146/147/148/149). Scarce *and* nondeterministic is a consistent picture: C# type
  resolution is barely functioning, so tiny differences in what happens to resolve move the total by a
  few percent.
- **Impact:** `dead_code_scan` is mechanically working but its **type-level** results on C# are not
  trustworthy — a reported type means "no TYPE_REF edge exists", which is true of 99% of types. Its
  method-level results are better founded, since `CALLS` coverage is real (1751 targets). Also affects
  anything else reading `TYPE_REF`: `find_impact_files` view `"surface"` (whose 0.75-confidence rows
  are TYPE_REF-based), and `get_change_context` blast radius for types.
- **Workaround:** treat a reported `class`/`record`/`struct` candidate as unproven. Cross-check with
  `search_regex` on the type name, or `find_impact_files`. Method/function candidates are the ones
  worth acting on.
- **Do not "fix" by dropping TYPE_REF from the scan rule.** That would hide the missing edges behind a
  narrower query and make the graph's real gap invisible.

### Root cause (confirmed) and fix

`emitTypeRefEdge` had **exactly one call site in the entire extractor** — the base class inside a
`base_list` in `csharpSymbols.ts`. Every other type position emitted nothing. Resolution was not at
fault: of the 148 edges that existed, 110 were unresolved `type:` tokens and all of them were
framework base types (`DbContext`, `BackgroundService`, `AbstractValidator`, `Exception`, `Migration`)
that legitimately have no symbol in the repo.

Added `emitTypeRefEdgesFromTypeNode`, which walks a type expression per node kind and emits one edge
per name mentioned, including nested generic arguments — `Task<List<OrderDto>>` yields `Task`, `List`
and `OrderDto`. Walking generics is the point: a DTO's only reference is very often a generic argument
on a return type. Handled per node kind rather than by collecting descendant identifiers, so a
`qualified_name` contributes the type and not its namespace segments. C# keyword types are excluded —
`string` and `int` would add thousands of edges that can never resolve in any repo.

Wired into: method return types and parameters, property types, constructor parameters, field and
event-field types (attributed to the enclosing type, since fields are not emitted as symbols), record
and primary-constructor positional parameters, and the generic arguments of a base type — which the
old `base_list` path discarded by stripping `<...>`, so `IRequestHandler<CreateOrderCommand, Result>`
referenced only the interface.

**Two field names were wrong and only a per-position test caught them.** A `method_declaration`'s
return type is the **`returns`** field, not `type` — reading `type` returns null, so return types
silently emitted nothing while parameters worked. And a record's positional `parameter_list` carries
**no field name at all**, so `childForFieldName("parameters")` was null for exactly the CQRS shape this
was meant to fix. Both were found by dumping the grammar's fields after the test failed, not by
reading the code.

### Measured (`wec.communication-hub`, 475 files, 4411 symbols)

| | before | after |
|---|---|---|
| TYPE_REF edges | 148 | **4885** |
| distinct TYPE_REF target symbols | 22 | **576** |
| type declarations with no incoming TYPE_REF | 784 / 792 (99.0%) | **479 / 794 (60.3%)** |

Of the 479 still unreferenced, **248 are under `Migrations/` or `Tests/`** — EF migrations and test
classes are discovered by reflection and genuinely have no code reference, which is why
`dead_code_scan` already suppresses them under `heuristic_runtime_or_convention_usage`.

### Still not covered (deliberate, and why the entry stays open)

Local variable declared types, `new Foo()` object creation, attribute usages, `typeof`/cast
expressions, and generic arguments on method invocations. Each is a smaller increment than the
positions above and some are noisy (a local variable type is usually also a parameter or field type
somewhere). The residual ~231 non-migration/test unreferenced types are where they would help.

**Do not measure any of this by re-indexing and comparing edge totals.** MCP-ISSUE-032 means two
identical runs differ by ~1.4%, which is larger than what a single new position contributes — adding
record positional parameters showed a *negative* total delta on one run purely as noise. The
per-position harness (`scripts/test/test-csharp-type-refs.mjs`, 11 cases) is deterministic and is what
proved each position works.

### Cost

`typeResolveMs` on this repo went 5214 → 19798: there is now ~33× more to resolve. Acceptable for an
index run, but it lands on the same resolver queries as MCP-ISSUE-032's `ORDER BY` work, so a future
performance pass should look at both together.

---

## MCP-ISSUE-033 — `dead_code_scan` returned an empty result for every repo, always

- **Status:** **fixed** 2026-07-29 (`src/analysis/staticAnalyzerDeadCode.ts`). Found while trying to
  observe the MCP-ISSUE-031 fix through the tool — which turned out to be impossible, because the
  tool had never returned anything.
- **Scenario:** `dead_code_scan` on any repo, with default options.
- **Symptom:** `{"count": 0, "suppressed": {"total": 0, "reasons": {}}, "symbols": []}`. Both lists
  empty, status ok.
- **Root cause (confirmed):** `includePrivate` defaults to `false`, which added the condition
  `s.name not like '_%'`. The intent was "skip names beginning with an underscore" (the C# private
  backing-field convention). But in SQL `LIKE`, `_` is a **single-character wildcard**, so `'_%'`
  matches every name of length ≥ 1 and `NOT LIKE '_%'` excluded **every symbol**. Measured on
  `wec.communication-hub`:

  | filter applied | rows surviving |
  |---|---|
  | repo + kind filter | 2760 |
  | + `signature not like 'private %'` | 2137 |
  | + `name not like '_%'` *(as written)* | **0** |
  | + `name not like '\_%' escape ''` *(fixed)* | 2760 |

  For the record, the repo contains **zero** symbols actually starting with an underscore, so the
  condition was removing 2760 rows to filter nothing.
- **Why it survived this long:** the empty result is a *plausible* answer — "no dead code found" reads
  as a clean bill of health, not as a broken filter. Two further things pointed away from the cause:
  the `suppressed` block was also empty (suppression only ever sees candidates, and there were none),
  and the response's own hint suggested unresolved call/import edges, which sends a reader to look at
  edge resolution. It also means **every previous clean `dead_code_scan` in this workspace was
  meaningless**, including the ones behind the "Dead public symbols" row in the tool-selection table.
- **Fix:** `s.name not like '\_%' escape ''`. Only one site in `src/` used an unescaped `_` in a
  LIKE pattern, verified by grep.
- **Verified end to end** through a real server against the real graph, `language: "csharp"`:
  400 candidates (limit-capped) and 997 suppressed, broken down as
  `heuristic_runtime_or_convention_usage: 631`, `heuristic_entry_point: 302`,
  `heuristic_contract_declaration: 56`, `heuristic_helper_container: 8` — so the C# suppressors are
  live rather than merely unreachable. 22 of the reported symbols sit in `I<lowercase>.cs`
  implementation files (`InboundMessageConsumer.cs`, `IdentityAuthorizationRequest.cs`,
  `InboxCardProjection.cs`, …), which is MCP-ISSUE-031's fix visible through the tool for the first
  time.
- **Covered by:** `src/analysis/staticAnalyzerDeadCode.test.ts` — five tests over an in-memory DB:
  ordinary names survive, a literal leading underscore is still excluded, `includePrivate: true`
  lifts both conditions, a symbol with an incoming edge is not a candidate, and the language filter
  works through the `files` join. The test schema carries the real `primary key (repo_id, path)` on
  `files`; without it the `insert or ignore` has nothing to conflict on and the LEFT JOIN multiplies
  every row — a test schema that drifts from the real one invents its own failures.
- **Follow-on found by the fix: the scan was never fast, only empty.** With the filter working, the
  first live call exceeded the 120s tool timeout on `wec.communication-hub` (4442 symbols). The row
  query selected `fileIncomingUsages` — a correlated subquery joining `edges` to `symbols` **twice**,
  evaluated once per row, and correlated only on `s.file_path`, so it recomputed an identical answer
  for every symbol in the same file. **Nothing read it**: not the suppressors, not the response. It was
  the most expensive part of the statement and its value was discarded. Removed; the call went from
  timing out to ~29.5s.
- **Still open — `dead_code_scan` is slow on large repos.** 29.5s for 4442 symbols is functional but
  poor, and `wec.be` (67 887 symbols) did not finish a measurement run. Cause: the query pages **all**
  matching rows regardless of `limit`, evaluating five correlated counting subqueries per row. The
  obvious fix is that four of those five exist only to find rows whose count is **zero** — a reported
  candidate has no incoming edges by definition — so they can become `NOT EXISTS` predicates in the
  `WHERE` clause, which short-circuit on the first match and use `idx_edges_repo_type_to`. Only
  `outgoingCalls` is genuinely needed as a value (by `isLikelyEntryPoint`). Not done here: it is a
  separate, well-scoped change and this entry is already about a correctness fix.

- **Lesson worth keeping:** a tool that returns a well-formed empty result is harder to notice than
  one that errors. MCP-ISSUE-031 was found by reading code, and its fix could only be *measured* by
  bypassing the tool entirely — that gap should itself have been the signal.

---

## MCP-ISSUE-031 — `dead_code_scan` suppresses every method in an `i`-prefixed C# file

- **Status:** **fixed** 2026-07-29 (`src/analysis/staticAnalyzerDeadCodeCSharp.ts`). Found the same
  day while splitting `staticAnalyzer.ts` (S-41); the defect predated the split.
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
- **Fix:** the filename test now reads the basename from the **original** path and matches
  `/^I[A-Z]/` (plus a case-insensitive `.cs$`). The three sibling checks stay on `normalizedPath`
  because they are path-based and case-insensitive by intent — a repo naming the folder `Interfaces/`
  or `INTERFACES/` must still match, and a test pins that. `fileName` (lowercased) is retained
  alongside the new `originalFileName`, since the later `/abstractions?\.cs$/` check genuinely wants
  the case-folded form; removing it broke three unrelated tests before typecheck caught the
  undefined reference.
- **Measured on the repo the issue named** (`wec.communication-hub`, 2021 C# methods), running both
  predicates over the real indexed symbols:

  | | old rule | new rule |
  |---|---|---|
  | methods suppressed by the filename test | 124 | 46 |

  78 methods across 9 files are no longer hidden — `InboundMessageMetadataMapper.cs`,
  `InboxCardProjectionService.cs`, `IdentityService.cs`, `Inbox.cs`,
  `IdentityAuthorizationClient.cs` and four more. 27 genuine interface files
  (`IApplicationDbContext.cs`, `IBackgroundTaskQueue.cs`, …) are still suppressed, and **nothing
  became newly suppressed**. That second half matters: a fix that merely stopped suppressing
  everything would have shown the same headline delta.
- **Contract impact:** none. `tools/list` is unchanged (`contracts:check` 4/4); this is a behaviour
  change only — `dead_code_scan` now reports more candidates on .NET repos, which is the point.
- **Covered by:** `src/analysis/staticAnalyzerDeadCodeCSharp.test.ts`, tests
  `"MCP-ISSUE-031 fixed: only a capital-I-capital filename reads as an interface file"` and
  `"MCP-ISSUE-031: the path-based interface checks stay case-insensitive"`.
- **Noticed, not fixed:** 42 of the 78 freed methods are in test files
  (`InboundMessageConsumerIntegrationTests.cs`, `InboxCardProjectionServiceConcurrencyTests.cs`).
  `dead_code_scan` has no `excludeTests` option the way `search_symbols` does, so test methods
  compete with production candidates in the output. Separate concern, separate change.

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
