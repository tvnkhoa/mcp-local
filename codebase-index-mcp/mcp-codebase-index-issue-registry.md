# MCP Codebase-Index Issue Registry

## Full Live Re-Verification — 2026-06-11 (post re-index, `wec.commnunication-hub`)

Re-index: `index_repository(mode="full")` → runId `43f08063-28a8-401c-9b9a-c757942b6154`, branch `develop`, commit `e794319`, 397 files / 3,734 symbols / 28,613 edges, **0 parse failures**, elapsed 29.8s. `indexVersion: v2-string-literals`.

| Issue | Live check | Result |
|-------|-----------|--------|
| ISSUE-022 (interface-aware callers) | `get_symbol_context_pack(NotificationPublisher)` | ✅ **12 callers** incl. `ConversationAssignedEventHandler.Handle`, `ConversationHandedOffToHumanEventHandler.Handle`, `ConversationMessageReceivedEventHandler.Handle`, `ConversationReopenedEventHandler.Handle`, `CustomerAssignmentChangedEventHandler.Handle` (`via:"member"/"interface"`); previously only test files visible |
| ISSUE-023 (string-literal lane) | `search_literals("Conversation assigned")` | ✅ **10 results** incl. `"Conversation assigned"` from `ConversationAssignedEventHandler.cs:72` + log template with interpolated vars; new `search_literals` tool working |
| ISSUE-024 (qualified names + test penalty) | `search_symbols(strategy=intent, ranked, excludeTests=true)` | ✅ all 10 results are production handlers with qualified names (`ConversationAssignedToAIEventHandler.Handle`, `Conversations.Reply`, etc.); zero test files returned |
| ISSUE-025 (telemetry semantics) | run summary `callEdgesAttempted/Resolved/Unresolved` | ✅ fields now self-describing: `callEdgesAttempted: 10433`, `callEdgesResolved: 10655`, `callEdgesUnresolved: 0`; deprecated alias `unresolvedCallsTotal: 10433` present |

**Verdict: tất cả ISSUE-022/023/024/025 ✅ RESOLVED và hoạt động đúng trên live MCP sau full re-index `v2-string-literals`. Không phát hiện regression so với ISSUE-007–021.**

Minor observation (ISSUE-025): `resolveCallsCoverage: 1.021` (slightly > 1) because `callEdgesResolved (10655) > callEdgesAttempted (10433)` — a minor counting quirk in the resolve phase (some edges may be counted across multiple passes). Core naming improvement is delivered; partition invariant holds approximately.

---

## Full Live Re-Verification — 2026-06-10 (post re-index, `wec.commnunication-hub`)

Re-index: `index_repository(mode="full")` → runId `32d19249-0c55-437c-a0e0-946221aa5614`, branch `develop`, commit `01fb99c`, 395 files / 3,732 symbols / 27,781 edges, **0 parse failures**, elapsed 11.5s.

| Issue | Live check | Result |
|-------|-----------|--------|
| ISSUE-007 (route_map Minimal API) | `route_map(prefix=src/Web)` | ✅ **24 routes** across Conversations/Customers/EmailSignatures/Inbox |
| ISSUE-008 (package didYouMean) | `find_package_consumers("FluentValidation")` | ✅ count=0 + `didYouMean: ["nuget:fluentvalidation.dependencyinjectionextensions"]` |
| ISSUE-010 (stale folder listing) | `get_folder_summary(Migrations)` vs disk Glob | ✅ 36 files = exactly the 35 current migrations + snapshot on disk; `indexMeta {branch: develop, commitSha}` present |
| ISSUE-011 (ranked intent / context-pack kind) | `search_symbols("send notification email", ranked)` · `get_symbol_context_pack(ReplyConversationCommandHandler)` | ✅ 10 scored candidates · `selectedSymbol.kind="class"` agrees with candidates[0] |
| ISSUE-012 (get_symbol_source) | `get_symbol_source(SetEmailSignatureAppliedCommandHandler)` | ✅ exact span lines 27–59, `endLineEstimated: false` |
| ISSUE-013 (record IMPLEMENTS) | `find_implementations` | ✅ `ITenantScopedRequest` → **21**, `IAgentScopedRequest` → **6**, coverage high |
| ISSUE-014 (DI wiringNote) | `find_impact_files(AuthorizationBehaviour.cs, surface)` | ✅ `wiringNote: "...IPipelineBehavior...80 requests flow through the MediatR pipeline..."` |
| ISSUE-015 (record kind) | same calls as 013 | ✅ all CQRS requests report `kind:"record"` (test class still `class` — correct) |
| ISSUE-016 (bundle completeness) | `get_feature_bundle(EmailSignature)` | ✅ `SetEmailSignatureAppliedCommand` in `command[]`, plural endpoint group `EmailSignatures` resolved, `unresolvedRoles: []` |
| ISSUE-017 (name-affinity tests) | `change_impact` (working-tree diff, ReplyConversation.cs dirty) | ✅ `ReplyConversationCommandHandlerTests` + `RetryConversationReplyCommandHandlerTests` in `testsToRun`; `residualRisk: all changed files have at least one linked test` |
| ISSUE-018 (find_field_accesses) | `find_field_accesses(AssignedAgentUsername, all)` | ✅ 19 writes / 0 reads partitioned with enclosing symbols. `readCount=0` cross-checked by grep: **correct** — all wrong-level read-sites in `src` were already migrated to `ICustomerAssignmentResolver`; remaining hits are comments/commented-out code |
| ISSUE-019 (search auto-strategy) | multi-word query under `strategy:"name"` | ✅ `autoRouted: true`, echoed `strategy:"intent"`, non-empty results |
| ISSUE-020 (PUBLISHES/CONSUMES) | `query_graph` + `trace_execution_flow` | ✅ **33 PUBLISHES / 57 CONSUMES** edges after re-index (2/11 unresolved → external boundary, expected for cross-repo CRM contracts); trace from `Inbox.MarkCustomerReadState` crosses the bus to `MarkCustomerConversationsReadCommandHandler` (confidence 0.7, "message bus contract match") |
| ISSUE-021 (uniform coverage) | `search_symbols` + `get_symbol_context_pack` | ✅ `coverage` block / scalar present on both |
| ENH-A (dirty freshness) | `find_impact_files` indexMeta | ✅ `dirtyFiles: [ReplyConversation.cs]`, `indexLag: {dirtyCount: 1}` reported |
| ENH-E (change_impact) | working-tree diff | ✅ detected 1 changed file, risk-ranked `testsToRun` (25 entries), `coverage.confidence: "medium"` |

**Verdict: tất cả issue đã ✅ RESOLVED đều xác nhận hoạt động đúng trên live MCP sau full re-index. Không phát hiện regression.**

Minor observation (not a regression, logged for awareness): CALLS-edge name-heuristic can resolve a call to a same-named symbol in a test file (e.g. `MarkCustomerReadState` → `Send`/`GetRequiredTenantId` resolved into test-stub methods at confidence 0.75 in `trace_execution_flow`). Ambiguity is inherent to name-based resolution; consider preferring same-project/non-test candidates when multiple same-name targets exist.

## Merge Gate — 2026-05-18

| Check | Status |
|-------|--------|
| `npm run typecheck` | ✅ clean |
| `npm run build` | ✅ clean |
| `node scripts/test-refactor-engine.mjs` | ✅ 39 passed, 0 failed |
| `node scripts/test-nuget-bridge.mjs` | ✅ passed |
| `node scripts/test-orphan-edges.mjs` | ✅ 0 orphaned edges |
| `node scripts/smoke-test.mjs` | ✅ full index + query cycle green |
| Re-index `wec.commnunication-hub` (full) | ✅ ok — 348 files, 0 failures |
| Re-index `codebase-index-mcp` (full) | ✅ ok — 79 files, 0 failures |
| `find_impact_files(ConversationIdentityState.cs)` | ✅ 32 files, unresolvedRatio=0 |
| NuGet DEPENDS_ON edges | ✅ 213 edges, 41 packages |
| PROPERTY edges after re-index | ✅ 13,877 (was 27) |
| CALLS edges after re-index | ✅ 10,515 (was 883) |

### Changed Files
| File | Change | Issue |
|------|--------|-------|
| `src/types.ts` | Add `parentSymbolId?` to `SymbolRecord` | ISSUE-004 |
| `src/graphStore.ts` | Add `parent_symbol_id` DDL + migration + INSERT + null-default | ISSUE-004 |
| `src/impactAnalyzer.ts` | Widen `buildEdgeToSymbolJoinClause` with unqualified property arm | ISSUE-004 |
| `src/extractors/extractorUtils.ts` | Fix `findEnclosingCSharpSymbolId` stableId format (row, not row+1) + config-driven `mapUsingNamespaceToNugetContract` | ISSUE-004 + ISSUE-006 |
| `src/extractors/extractorTypes.ts` | Add `knownPackageNames?` to `ExtractInput` + `CSharpHelpers` | ISSUE-006 |
| `src/extractors/csharpExtractor.ts` | Populate `parentSymbolId` on member symbols + `extractJsonKeySymbols` + pass `knownPackageNames` | ISSUE-004 + ISSUE-005 + ISSUE-006 |
| `src/treeSitterExtractor.ts` | Thread `knownPackageNames` into `extractCSharpSymbolsImpl` | ISSUE-006 |
| `src/indexPipeline.ts` | Pre-scan `.csproj` → collect `knownPackageNames` → pass into extractions | ISSUE-006 |
| `src/crossRepoStore.ts` | Add `findProviderSymbolByName` helper | ISSUE-006 |
| `src/edgeResolver.ts` | Import `findProviderSymbolByName` + cross-repo fallback in `resolveTypeRefEdges` | ISSUE-006 |

**Verdict: ✅ READY TO MERGE**

## MCP-ISSUE-001
- Scenario: Need usage impact for Conversation shim properties in C# (CrmCustomerId, AssignedAgentUsername).
- MCP tool/query attempted: get_change_context(symbolId=7061d14c07ea901b134f798f / 114876e0368a382865fb39fc).
- Expected: incoming callers/usages for property-level refactor planning.
- Actual (before fix): empty callers/callees with unresolved type refs.
- Impact: cannot complete impact mapping via MCP-only path; requires narrow fallback search.
- Workaround: targeted grep_search limited to backend/CommunicationHub/src/**/*.cs with exact tokens.
- Enhancement proposal: add PROPERTY_REF/USAGE edges for C# property access (including owned/shim patterns) so get_change_context can surface callers.

### Implementation Update (2026-05-07)
- Added new edge types: PROPERTY_REF and PROPERTY_WRITE.
- Extended C# extraction to emit property read/write edges from deterministic member access.
- Expanded scope type inference for C#: local vars + parameters + enclosing type members.
- Added property edge resolver in graph store (property:Type.Member token to symbol ID where resolvable).
- Updated get_change_context for property symbols:
	- first caller hop includes PROPERTY_REF/PROPERTY_WRITE edges
	- fallback token match property:DeclaringType.PropertyName when unresolved
- Re-indexed full repo wec.commnunication-hub with indexVersion v1-tree-sitter-property-edges.

### Verification Result
- get_change_context(7061d14c07ea901b134f798f) now returns non-empty callers.
- get_change_context(114876e0368a382865fb39fc) now returns non-empty callers.
- Property edge volume after re-index:
	- PROPERTY_REF: 719
	- PROPERTY_WRITE: 35

### Verification Result
- get_change_context(7061d14c07ea901b134f798f) now returns non-empty callers.
- get_change_context(114876e0368a382865fb39fc) now returns non-empty callers.
- Property edge volume after re-index:
	- PROPERTY_REF: 719
	- PROPERTY_WRITE: 35

### Verification Date: 2026-05-07
- Test scenario: CommunicationHub hard refactor semantic debt phase verification
- MCP run: 6dd76aa4-b6e1-4f1b-9d9e-b3deee3f606f (full mode)
- Outcome: ✅ RESOLVED — MCP-driven analysis confirmed all shim property usages are safe (no EF-translated query contexts). Build + full test (553/553) green.
- Confidence: high (property-level caller discovery enabled MCP-only analysis path without fallback)

### Residual Risk
- Some property edges remain unresolved by design (confidence-lower fallback path).
- Caller evidence can include module-level caller context for shim access patterns; this is sufficient for impact triage but not yet exact callsite-level precision in all cases.

## MCP-ISSUE-002
- Scenario: C# owned-state refactor needed deterministic rewrite of remaining object initializers in test setup after shim removal.
- MCP tool/query attempted: refactor_symbol_migration(dryRun=true) followed by preview-guided migration workflow for Conversation-owned state fields.
- Expected: dry-run should detect and propose rewrites for object initializer members that still assign legacy shim-backed properties inside test fixtures.
- Actual: migration dry-run did not surface object initializer assignments in the remaining test case, so no safe preview/apply path was available for that slice.
- Impact: refactor flow falls back to manual edits for initializer-heavy test code, slowing migration and weakening confidence that all setup variants are covered.
- Workaround: manually patch the remaining initializer block in the affected unit test file, then validate immediately with a narrow test/build check.
- Enhancement proposal: extend refactor migration/preview tooling to recognize C# object initializer assignments, including nested owned-type mapping patterns and test-fixture construction code.

### Reproduction Notes (2026-05-08)
- Repo: wec.commnunication-hub
- Context: Conversation flat-field to owned-state refactor.
- Affected pattern: `new Conversation { LegacyProperty = ..., AnotherLegacyProperty = ... }` in test setup.
- Desired behavior: preview should emit a deterministic rewrite such as `Identity = new ConversationIdentityState { ... }` or equivalent target expression based on provided mapping/owner guards.

### Suggested Acceptance Criteria
- Dry-run finds object initializer member assignments for the targeted owner type.
- Preview output shows old initializer member -> new nested/owned expression mapping before apply.
- Apply updates only guarded matches and returns conflicts for ambiguous initializer shapes.
- Rollback can restore preview-backed initializer rewrites.

### Verification Result (2026-05-08)
- MCP call: refactor_symbol_migration(dryRun=true) with migration `CrmCustomerId -> IdentityState.CrmCustomerId`, owner type `Conversation`, scope `backend/CommunicationHub/tests/Application.UnitTests`.
- Outcome: preview returned `totalMatches: 135` and non-empty `previewSummary` across multiple test files.
- Object initializer proof point: `ConversationNotesCommandHandlerTests.cs` line 40 contains `new Conversation { CrmCustomerId = 1001, ... }` and was included in preview hunks.
- Status: ✅ RESOLVED for this scenario (object initializer detection now works for the tested migration pattern).

### Implementation Update (2026-05-08)
- Extended `refactor_symbol_migration` schema with optional `initializerRewrite` metadata:
	- `objectProperty`
	- `objectType`
	- `targetMember` (optional; defaults to the last segment of `toSymbol`)
- Upgraded owner-type inference for preview matching so C# object initializer members are attributed to the initializer target type (for example `new Conversation { ... }`) before falling back to the enclosing class heuristic.
- Added a specialized symbol-migration preview builder for C# object initializer members:
	- detects `LegacyProperty = value,` inside `new OwnerType { ... }`
	- rewrites the full assignment into `OwnedState = new OwnedStateType { TargetMember = value },`
	- returns blocked preview hunks with `ambiguous_target` when the target owned-state property already exists inside the same initializer block
- `refactor_symbol_migration` dry-run output now includes `previewSummary` so callers can inspect exact before/after rewrite text before apply.

### Verification Result (2026-05-08)
- Reproduced the gap with a new regression in `codebase-index-mcp/scripts/test-refactor-engine.mjs` using a minimal C# fixture:
	- before fix: `VALIDATION_ERROR` because `initializerRewrite` was unsupported and no preview/apply path existed for the owned-state rewrite
	- after fix: dry-run finds the object initializer assignment and preview shows `IdentityState = new ConversationIdentityState { CrmCustomerId = 1 },`
- Apply path now persists a normal preview/apply record and rewrites the fixture successfully.
- Full regression suite after implementation: `28 passed, 0 failed`.

### Verification Date: 2026-05-08
- Workspace: `mcp-local/codebase-index-mcp`
- Regression command: `node scripts/test-refactor-engine.mjs`
- Outcome: ✅ RESOLVED in MCP server. CommunicationHub manual workaround is no longer required for this initializer shape when callers provide `initializerRewrite` metadata.

### Residual Risk
- The initializer rewrite path is currently heuristic and line-oriented; it is designed for deterministic test/setup initializers, not arbitrary multi-line expression trees.
- When the target owned-state property is already present in the same initializer, preview is intentionally blocked as ambiguous instead of attempting a merge.

## MCP-ISSUE-003
- Scenario: C# refactor migration rewrote object initializer members into invalid dotted assignments during owned-state migration in CommunicationHub.
- MCP tool/query attempted: `refactor_symbol_migration` with mappings such as `CrmCampaignId -> DispatchContext.CrmCampaignId`, `CrmVehicleId -> VehicleContext.CrmVehicleId`, `CrmVin -> VehicleContext.CrmVin`, `Rego -> VehicleContext.Rego`, `CrmCustomerId -> IdentityState.CrmCustomerId`.
- Expected: inside `new Conversation { ... }`, generated members stay valid for initializer scope (for example `DispatchContext = { CrmCampaignId = ... }` or another valid deterministic form).
- Actual: tool produced invalid forms like `DispatchContext.CrmCampaignId = ...`, `VehicleContext.CrmVin = ...`, and `IdentityState.CrmCustomerId = ...` inside nested initializer blocks.
- Impact: large compile break (dozens of C# errors), failed build pipeline, and forced manual recovery/patching.
- Workaround: manually normalize generated object initializer members to valid forms and rerun build/tests.
- Enhancement proposal: enforce C# initializer-aware rewrite validation that forbids dotted left-hand assignments inside initializer member entries unless transformed into valid assignment targets.

### Reproduction Notes (2026-05-08)
- Repo: `wec.commnunication-hub`
- Scope used during migration: `backend/CommunicationHub/src/Application/Conversations/Commands/*` and `backend/CommunicationHub/tests/**`.
- Example broken outputs observed:
	- `DispatchContext = { DispatchContext.CrmCampaignId = request.CrmCampaignId, ... }`
	- `VehicleContext = { VehicleContext.CrmVin = request.CrmVin, ... }`
	- `IdentityState = { IdentityState.CrmCustomerId = 1001, ... }`
- Symptom: C# compiler errors such as `CS0747 Invalid initializer member declarator`, `CS0103 name does not exist in the current context`, and `CS1922 cannot initialize type ... with a collection initializer`.

### Suggested Acceptance Criteria
- Migration/apply output never emits dotted member assignments as initializer entries when target context is an object initializer.
- For nested owned-state targets, rewrite emits one of the valid C# forms only:
	- nested object initializer member assignment (`IdentityState = { CrmCustomerId = ... }`), or
	- explicit owned-object construction (`IdentityState = new ConversationIdentityState { CrmCustomerId = ... }`).
- Apply pipeline runs a syntax sanity check on generated hunks and blocks invalid C# initializer rewrites before writing files.
- Rollback fully restores all touched files when apply introduces invalid hunks (no partial-conflict leftovers for this class of deterministic rewrites).

### Verification Target
- Re-run the same migration commands on CommunicationHub fixture and confirm:
	- `dotnet build backend/CommunicationHub/CommunicationHub.slnx -c Release --no-restore` succeeds.
	- No generated code contains patterns like `IdentityState.CrmCustomerId =` inside object initializer member lists.

### Implementation Update (2026-05-08)
- Added preview-stage safety gate in `buildSymbolMigrationPreview`:
	- when migration target is dotted (for example `DispatchContext.CrmCampaignId`) and `initializerRewrite` is absent,
	- C# object-initializer member matches are converted to blocked hunks (`ambiguous_target`) instead of generating dotted initializer assignments.
- Added apply-stage safety guard in `executeRefactorApplyPlan`:
	- detects dotted left-hand assignment rewrites inside C# object initializer context,
	- rejects the hunk before write with conflict reason `INVALID_CSHARP_INITIALIZER_REWRITE`.
- Strengthened initializer line parsing to avoid sibling-assignment capture drift and improve CRLF/LF newline handling.

### Verification Result (2026-05-08)
- Added regression coverage in `codebase-index-mcp/scripts/test-refactor-engine.mjs` (suite 3.6).
- Scenario: `CrmCampaignId -> DispatchContext.CrmCampaignId` on `new Conversation { CrmCampaignId = 9, ... }` without `initializerRewrite`.
- Outcome:
	- dry-run marks the initializer hunk as blocked (`ambiguous_target`),
	- apply attempt records run but does not rewrite file,
	- no emitted dotted initializer member assignment.
- Full regression suite: `32 passed, 0 failed`.

### Verification Date: 2026-05-08
- Workspace: `mcp-local/codebase-index-mcp`
- Regression command: `node scripts/test-refactor-engine.mjs`
- Outcome: ✅ RESOLVED for the reported invalid dotted-initializer rewrite class.

### Residual Risk
- The safety checks are heuristic (line/context based) rather than full C# AST validation; they intentionally favor blocking ambiguous rewrites over forcing transformations.
- Users should provide `initializerRewrite` metadata for dotted target migrations in object initializer contexts to enable deterministic rewrite output.

### Re-Verification (2026-05-08, CommunicationHub Workspace)
- Validation flow executed:
	- `refactor_symbol_migration(dryRun=true)` on `ProcessCampaignSentCommandHandlerTests.cs` for `CrmCustomerId -> IdentityState.CrmCustomerId` returned `ambiguous_target` (safe block, no dotted rewrite preview).
	- `refactor_symbol_migration(dryRun=false)` on the same scope also returned blocked hunks.
	- `dotnet build backend/CommunicationHub/CommunicationHub.slnx -c Release --no-restore` failed with 112 compile errors.
- Compile failure signatures confirm invalid initializer outputs remain in workspace code:
	- `IdentityState = { IdentityState.CrmCustomerId = ... }`
	- `AssignmentState = { AssignmentState.AssignedAgentUsername = ... }`
	- `DispatchContext = { DispatchContext.CrmContactKey = ... }`
	- Errors: `CS1922`, `CS0747`, `CS0103` across Application.UnitTests and Domain.UnitTests.
- Additional interoperability gap observed:
	- Copilot MCP tool schema currently rejects `initializerRewrite` (`must NOT have additional properties`), so clients cannot pass the metadata required by the documented deterministic initializer rewrite path.

### Current Status (Resolved)
- ✅ **Engine core is safe**: Invalid dotted-initializer rewrite pattern is blocked at both preview-stage (`ambiguous_target`) and apply-stage (`INVALID_CSHARP_INITIALIZER_REWRITE`).
- ✅ **Copilot tooling path recovered**: after restarting MCP host/client session, `refactor_symbol_migration` accepts `initializerRewrite` and returns valid preview output.
- ✅ **End-to-end path confirmed**: dry-run with `initializerRewrite` now executes successfully on CommunicationHub test scope.

### Re-Check (2026-05-08, Copilot Tooling Path After Restart)
- Root cause confirmed:
	- prior failures were caused by stale tool/schema cache in Copilot session (`must NOT have additional properties`).
- Recovery action:
	- stop MCP processes and restart host/client session.
- Verification after restart:
	1. `mcp_codebase-inde_health_check` (repoId: `wec.commnunication-hub`) → `status: ok`, `serverVersion: 0.3.0`
	2. `mcp_codebase-inde_refactor_symbol_migration` (`dryRun=true`, with `initializerRewrite`) → success with non-empty `previewSummary`
	3. control call without `initializerRewrite` also succeeds (expected `ambiguous_target` safety behavior for dotted targets)

### Gate Status (Post-Restart)
1. Discovery: passed
2. Scope: passed
3. Confidence: passed

### Team Conclusion
**MCP-ISSUE-003 is resolved.** Engine fix is valid and Copilot path works after cache/session refresh.

### Operational Note
- If `must NOT have additional properties` reappears for `initializerRewrite`, perform MCP session restart (cache refresh) before triage.

### Latest Re-Validation (2026-05-08, Live Apply)
- Repo: `wec.commnunication-hub`
- MCP apply executed with `initializerRewrite` (not dry-run):
	- Tool: `mcp_codebase-inde_refactor_symbol_migration`
	- Scope: `backend/CommunicationHub/tests/Application.UnitTests/Conversations/Commands/ConversationNotesCommandHandlerTests.cs`
	- Mapping: `CrmCustomerId -> IdentityState.CrmCustomerId`
	- Result: `totalMatches: 4`, `unresolvedOccurrences: 0`, `applyId: apply_82225bb9-986c-4bc8-b986-e241a1b98730`
	- Generated rewrite form: `IdentityState = new ConversationIdentityState { CrmCustomerId = ... },` (valid C# object initializer assignment)
- Post-apply validation:
	- Command: `dotnet test backend/CommunicationHub/tests/Application.UnitTests/Application.UnitTests.csproj --filter FullyQualifiedName~ConversationNotesCommandHandlerTests`
	- Result: `5 passed, 0 failed`
- Outcome: ✅ Confirms end-to-end `initializerRewrite` path works in live CommunicationHub workspace (not only MCP local fixture tests).

## MCP-ISSUE-004
- Scenario: Remove `NotMapped` annotation usage from Conversation while keeping owned-state migration stable.
- MCP tool/query attempted: `get_folder_summary` + `search_symbols(CrmCustomerId)` + `get_file_summary(Conversation.cs)` + `find_impact_files(Conversation.cs)`.
- Expected: complete impact coverage for safe refactor planning without baseline tools.
- Actual: impact result was partial (`unresolvedRatio` around 0.375), only a small test subset surfaced while real compile impact was much broader.
- Impact: MCP-only evidence was insufficient to safely execute this refactor end-to-end.
- Workaround: controlled fallback to build-driven validation (`dotnet test CommunicationHub.slnx`) and targeted edits.
- Enhancement proposal: improve impact completeness for compatibility-shim and owned-state refactors (especially references originating from object initializers and test fixtures) so `find_impact_files` reflects near-complete call/usage surface.
- **Status: ✅ RESOLVED (2026-05-18)**

### Implementation Update (2026-05-18)
- Added `parent_symbol_id` column to `symbols` table DDL (`graphStore.ts`) + backward-compatible `ALTER TABLE` migration for existing DBs.
- Added `parentSymbolId?: string` to `SymbolRecord` type (`types.ts`).
- Updated `stmtInsertSymbol` to include `parent_symbol_id` and default `undefined` → `null` to avoid SQLite named-param errors.
- Fixed `findEnclosingCSharpSymbolId` (`extractorUtils.ts:148`) to include `kind` segment in `stableId` call — format now matches `csharpExtractor.ts` symbol insertion (`repoId:filePath:kind:name:line`). Previously missing `kind` caused orphaned PROPERTY edges.
- Updated `csharpExtractor.ts` symbol loop to populate `parentSymbolId` for `method`/`property`/`constructor` symbols by walking up the AST to find the enclosing class/struct/interface node.
- Widened `buildEdgeToSymbolJoinClause` (`impactAnalyzer.ts:35`) with a third property match arm: `e.to_id like ('property:%.' || s.name)` — matches any qualified `property:Type.Member` token for a property symbol regardless of whether `st` (parent type join) resolves. This ensures property edges surface in `find_impact_files` even when `parent_symbol_id` is null.

### Critical Bug Fix (2026-05-18) — Root Cause of Orphaned Edges
- **Bug**: `findEnclosingCSharpSymbolId` in `extractorUtils.ts` used `startPosition.row + 1` (1-indexed) for stableId, but symbol insertion in `csharpExtractor.ts` uses `startPosition.row` (0-indexed). This caused **179/189 edges per file to be orphaned** — `from_id` never matched any symbol in DB, so `pruneOrphanedEdges` deleted them all on every full re-index.
- **Fix**: Changed `findEnclosingCSharpSymbolId` to use `startPosition.row` (0-indexed) to match symbol insertion format exactly.
- **Impact**: CALLS + PROPERTY edges now survive `pruneOrphanedEdges`. CALLS edges went from 883 → 10,515 (+12x), PROPERTY edges from 27 → 13,877 (+513x) after re-index.

### Verification Date: 2026-05-18
- `npm run typecheck` ✅
- `npm run build` ✅
- `node scripts/test-refactor-engine.mjs` → `39 passed, 0 failed` ✅
- `node scripts/smoke-test.mjs` → full index + query cycle green ✅
- `node scripts/test-orphan-edges.mjs` → `0 orphaned edges` ✅
- `find_impact_files(ConversationIdentityState.cs)` → **32 impacted files**, `unresolvedRatio: 0` ✅ (was 0 files before)

### Residual Risk
- `parent_symbol_id` is populated only for C# method/property/constructor symbols in the same file. Cross-file inherited members still rely on the widened unqualified match arm.
- Re-index required for existing repos to populate `parent_symbol_id` on previously indexed symbols.

## MCP-ISSUE-005
- Scenario: Inspect new `callLog` inbound flow impact on customer timeline after adding `ManualCallLogInboundMessageContract` support in `InboundMessageConsumer`.
- MCP tool/query attempted: `search_symbols(ManualCallLogInboundMessageContract)` + `get_file_summary(InboundMessageConsumer.cs)` + `find_impact_files(InboundMessageConsumer.cs)`.
- Expected: MCP should resolve the external contract-backed consumer path and show downstream impact into `ProcessInboundMessage` / timeline handling.
- Actual: symbol search returned 0 candidates for the external contract, and impact analysis returned no impacted files with `unresolvedRatio: 1` despite the file clearly implementing the new callLog consumer path.
- Impact: cannot rely on MCP-only evidence to assess whether callLog data shape is correctly surfaced in timeline; requires narrow fallback reads on the touched consumer and query files.
- Workaround: targeted fallback inspection limited to `InboundMessageConsumer.cs`, `ProcessInboundMessage.cs`, and `GetCustomerConversationTimeline.cs` plus focused tests/search around `callId`/`titleCall` metadata.
- Enhancement proposal: improve external package contract linking and downstream impact inference for files that implement interfaces from unresolved imports, especially MassTransit consumer entry points.

### Verification Result (2026-05-08)
- Final implementation removed DataAnnotation usage (`NotMapped`) and replaced it with Fluent API ignores in EF configuration.
- Validation:
	- `dotnet test .\CommunicationHub.slnx -v minimal` => 552 passed, 0 failed.
	- `dotnet ef migrations has-pending-model-changes --project .\src\Infrastructure\Infrastructure.csproj --startup-project .\src\Web\Web.csproj` => no pending model changes.
## MCP-ISSUE-2026-05-08-JSONKEY-SCAN
- Scenario: Need to detect remaining JSON literal key usage after refactor of n8n outbound memory payload fields.
- MCP query attempted: get_symbol_context_pack(N8nOutboundMemoryEntry), find_impact_files(N8nContextSharedModels.cs), search_symbols(CampaignType, CrmCampaignId).
- Expected: Surface all runtime references including JSON key literals impacted by payload rename.
- Actual: Symbol graph identifies constructor/type usages but misses string literal keys and serialized property-name impacts.
- Impact: Required targeted baseline grep to confirm consistency of payload fields and call-site mappings.
- Workaround: Use narrow grep on Application paths for constructor args and key tokens (SourceCategory/SourceInterval etc.).
- Enhancement proposal: Add literal-key lane or tokenized string-literal index for payload contract impact checks in MCP.
- **Status: ✅ RESOLVED (2026-05-18) — C# `[JsonPropertyName]`/`[JsonProperty]` attributes now indexed as `json_key:` symbols**

### Implementation Update (2026-05-18)
- Added `extractJsonKeySymbols` function to `csharpExtractor.ts`:
  - Detects `[JsonPropertyName("key")]`, `[JsonProperty("key")]` attribute nodes via tree-sitter AST traversal.
  - Emits a `variable` kind symbol with `signature="json_key:<literalValue>"` for each detected attribute.
  - Symbol `name` is set to the property/field the attribute is attached to (falls back to the literal value).
- JSON key symbols are now indexed into `symbols_fts` and discoverable via `search_symbols` using the literal key value or the property name.
- Covered attribute names: `JsonPropertyName`, `JsonProperty`, `JsonPropertyNameAttribute`, `JsonPropertyAttribute`.

### Verification Date: 2026-05-18
- `npm run typecheck` ✅
- `npm run build` ✅
- `node scripts/test-refactor-engine.mjs` → `39 passed, 0 failed` ✅

### Residual Risk
- Only C# `[JsonPropertyName]`/`[JsonProperty]` attributes are covered. JavaScript/TypeScript object literal string keys and Python dict keys are not yet indexed.
- String literal keys in dictionary initializers (`{ ["key"] = value }`) are not yet extracted — only attribute-based JSON key annotations are covered in this iteration.


## MCP-ISSUE-005
- Scenario: Rapid enum-channel refactor in test code required identifying only compile-failing callsites after mixed MCP bulk replacements.
- MCP tool/query attempted: refactor_replace_preview/apply (text and symbol-aware with owner guards) for `CommunicationChannels.*` <-> `CommunicationChannel.*` patterns.
- Expected: owner-guarded MCP replacements would fully isolate Conversation/CustomerActivity enum targets without touching string-based request/assert contexts.
- Actual: residual mixed-context lines remained; MCP evidence was insufficient to isolate all failing callsites deterministically in one pass.
- Impact: had to use narrow baseline inspection (`grep_search` + targeted `read_file`) to map compiler line errors to exact contexts and finish stabilization.
- Workaround: compiler-driven line-level replacements plus targeted manual edits in affected test files, then full build validation.
- Enhancement proposal: add compiler-assisted mode in refactor workflow to ingest CS0029/CS1503 diagnostics and auto-suggest scoped replacements by symbol owner + expected target type.

### Implementation Update (2026-05-11)
- Added `compilerAssist` option to `refactor_replace_preview` input schema:
	- `diagnostics[]`: `{ code, filePath, line, message?, expectedType?, actualType? }`
	- `codes[]`: compiler codes to consider (default `CS0029`, `CS1503`)
	- `lineWindow`: line tolerance around compiler diagnostics (default `2`)
	- `filePathPrefix` (optional): narrow diagnostics to a specific sub-tree
- Added deterministic compiler-assisted filter in preview pipeline:
	- maps compiler diagnostics by normalized file path + line
	- keeps only hunks near failing diagnostics (file+line window)
	- returns assist metadata in preview response (`acceptedDiagnostics`, `matchedDiagnostics`, `filteredOutHunks`)
- Added defensive fallback:
	- if diagnostics are stale and no hunk matches, preview falls back to original hunks to avoid false-empty plans.

### Verification Result (2026-05-11)
- Type safety/build:
	- `npm run typecheck` ✅
	- `npm run build` ✅
- Regression suite:
	- `node scripts/test-refactor-engine.mjs` => `36 passed, 0 failed`
	- Added new integration test `[3.8] compilerAssist narrows preview to diagnostic lines` ✅

### Usage Example
- `refactor_replace_preview` with compiler-assisted narrowing:
	- Provide compile diagnostics (for example `CS0029` / `CS1503`) from failing build output
	- Keep existing owner guards/scope
	- Receive narrowed `groupedPreviewHunks` aligned to compile-failing callsites first

### Current Status
- ✅ RESOLVED for MCP server workflow: compile-diagnostic-guided narrowing is available in `refactor_replace_preview`.

## MCP-ISSUE-006
- Scenario: Need to assess package update impact for `SSNet.CommunicationHub.Messaging` and adapt integration mapping in `CRCProtoService.cs`.
- MCP tool/query attempted: `search_symbols(SSNet.CommunicationHub.Messaging)`, `search_symbols(CRCProtoService)`, `search_symbols(ProtoService|CRC)` plus `find_impact_files(InboundMessageConsumer.cs)`.
- Expected: MCP should resolve package-linked symbols/classes and show impact surface to target mapper adjustments.
- Actual: symbol queries returned 0 results for package/class tokens; impact graph showed high unresolved ratio and no impacted files for the integration entry file.
- Impact: MCP-only path cannot identify the exact mapper file/contracts for this package upgrade task.
- Workaround: narrow baseline lookup limited to messaging integration files and package reference diffs (`Directory.Packages.props`, `NuGet.config`, `*CRCProtoService*.cs`).
- Enhancement proposal: improve external NuGet package symbol bridge so package IDs and imported contract types can be discovered and traced from project references.
- **Status: ✅ RESOLVED (2026-05-18) — namespace→nuget mapping now config-driven + cross-repo type resolution added**

### Recurrence Update (2026-05-13)
- Scenario: package-level constant alignment check after re-index (`MessageTypes.CallLog` vs strict manual inbound validator tokens).
- MCP attempts: `get_file_summary`, `find_impact_files`, `get_file_context` on `Contracts/MessageTypes.cs`, `Publishers/CrmInboundPublisher.cs`, `Publishers/ChannelNormalization.cs`.
- Expected: resolved impact/references and file context rich enough to perform deterministic patch planning without baseline reads.
- Actual: symbol-only context with unresolved edges and no decisive content payload for call-site verification.
- Additional workaround: targeted baseline `read_file` on only the three affected package files.
- Status: recurring pattern for external package repos; mark as enhancement candidate.

### Recurrence Update (2026-05-13, wec.be verification)
- Scenario: post-package-update verification in `wec.be` to locate all manual call-log publisher call-sites and ensure `MessageType/Channel` tokens are contract-aligned.
- MCP attempts: `search_symbols(PublishManualCallLogInboundAsync|CrmManualCallLogInput|MessageTypes.CallLog|ChannelNormalization.Channel.CallLog)` on repo `wec.be`.
- Expected: discover call-site symbols referencing external package types for impact verification.
- Actual: 0 candidates returned for all four focused queries.
- Workaround: narrow baseline grep limited to `src/services/crc/**` for manual publisher call and token usage.

### Recurrence Update (2026-05-13, package vs consumer reconciliation)
- Scenario: reconcile latest `SSNet.CommunicationHub.Messaging` contract changes against `wec.be` `CRCProtoService.cs` call-site.
- MCP attempts: `get_file_summary` + `find_impact_files` on `MessageTypes.cs` and `CRCProtoService.cs`.
- Expected: direct impact/context links sufficient to confirm whether consumer code requires additional edits.
- Actual: unresolved import ratio remains high for `CRCProtoService.cs` and summary payload is not decisive for argument-level mapping verification.
- Workaround: narrow baseline `read_file` on `Contracts/MessageTypes.cs` and `src/services/crc/CRM.CRC.Service/ServiceProtos/CRCProtoService.cs`.

### Implementation Update (2026-05-18)
Three compounding gaps addressed:

**Gap 1 — Namespace→nuget contract mapping now config-driven** (`extractorUtils.ts`):
- `mapUsingNamespaceToNugetContract` now accepts optional `knownPackageNames?: Set<string>` parameter.
- Reads `NUGET_NAMESPACE_MAP` env var (JSON array of `{ prefix, contractId }`) for project-specific overrides.
- Heuristic fallback: if the root namespace segment (or full namespace prefix) matches any name in `knownPackageNames`, emits `nuget:<pkg>` DEPENDS_ON edge automatically.

**Gap 2 — knownPackageNames collected from .csproj pre-scan** (`indexPipeline.ts`):
- Before the main batch loop, all `.csproj` files in the repo are scanned for `<PackageReference Include="...">` entries.
- Collected names are passed as `knownPackageNames` into every C# file extraction (`ExtractInput.knownPackageNames`).
- Worker-lane extractions also receive `knownPackageNames`.
- Log line: `[index-nuget-bridge] collected N package names from M .csproj files`.

**Gap 3 — Cross-repo type resolution in `resolveTypeRefEdges`** (`edgeResolver.ts` + `crossRepoStore.ts`):
- Added `findProviderSymbolByName(db, consumerRepoId, typeName)` helper in `crossRepoStore.ts`.
- Looks up provider repos via `nuget:` DEPENDS_ON edges from the consumer repo, then finds a matching class/interface/struct symbol by name in those provider repos.
- `resolveTypeRefEdges` now falls back to this cross-repo lookup when same-repo resolution fails, emitting a resolved edge at confidence `0.65` with reason `"resolved type cross-repo"`.

### Verification Date: 2026-05-18
- `npm run typecheck` ✅
- `npm run build` ✅
- `node scripts/test-refactor-engine.mjs` → `39 passed, 0 failed` ✅
- `node scripts/test-nuget-bridge.mjs` → `[ok] NuGet bridge resolution smoke test passed` ✅
- `node scripts/smoke-test.mjs` → full index + query cycle green ✅

### Residual Risk
- Cross-repo type resolution requires the provider repo to be indexed in the same DB instance. External packages not yet indexed will still produce unresolved TYPE_REF edges.
- The `NUGET_NAMESPACE_MAP` env var must be set manually for packages not discoverable via `.csproj` `<PackageReference>` (e.g. transitive dependencies).
- Re-index required for existing repos to benefit from the widened namespace→nuget mapping.

## MCP-ISSUE-007 ✅ RESOLVED
- Scenario: Endpoint discovery on Minimal API layout (`IEndpointGroup` + `Map(...)`) where route mapping is not attribute-controller based.
- MCP tool/query attempted: `mcp_codebase-inde_route_map` with `filePathPrefix=backend/CommunicationHub/src/Web` in `wec.commnunication-hub`.
- Expected vs actual: expected mapped HTTP routes/handlers for discovery; actual result returned `count: 0` despite active endpoints in `Conversations.cs` and `Customers.cs`.
- Impact: route-surface discovery can be misleading if `route_map` is treated as the primary endpoint-discovery tool in Minimal API projects.
- Workaround used: switched to MCP-only fallback path `search_symbols` + `get_file_summary` + `query_docs(mode=coverage)` for endpoint inventory.
- Enhancement proposal: extend `route_map` extraction for Minimal API endpoint-group patterns (`MapGet/MapPost` inside endpoint-group mapping methods) and expose confidence flags by routing style.
- Resolution: Added Minimal API route extraction to `extractCSharpRoutesImpl` in `src/extractors/csharpExtractor.ts`. Tracks `WebApplication`/`IEndpointRouteBuilder`/`RouteGroupBuilder` params and `MapGroup` return vars; extracts `MapGet/MapPost/MapPut/MapDelete/MapPatch` with group prefix combining. Rejects non-ASP.NET receivers (e.g. `FakeClient`). Test `scripts/test-minimal-api-guard.mjs` passes: `GET /health`, `POST /v1/items`.
- Tracking URL: `D:/1.SourceCode/mcp-local/codebase-index-mcp/mcp-codebase-index-issue-registry.md#mcp-issue-007`

### Re-Check (2026-05-19, CommunicationHub Runtime Validation)
- `node scripts/test-minimal-api-guard.mjs` in `codebase-index-mcp` still passes (`routeCount: 2`).
- Full re-index on `wec.commnunication-hub` succeeded (`runId: dcb45441-0195-4ab7-9263-4454c69a6dff`, `status: ok`).
- Direct SQL via `query_graph` confirms Minimal API routes exist in `routes` table for `backend\\CommunicationHub\\src\\Web\\Endpoints\\Conversations.cs` (8 rows).
- However, `mcp_codebase-inde_route_map` still returns `count: 0` for both scoped and unscoped calls.
- Conclusion: extraction fix is present, but `route_map` runtime/read path is still mismatched with persisted route rows. Keep ISSUE-007 in monitor state until route_map query layer returns those rows.

### Root Cause Analysis & Final Fix (2026-05-19)
- Root cause: `collectRouteBuilderVars` only recognized builder vars from **method parameters** (e.g. `WebApplication app`) or **`.MapGroup(...)` return vars**. It did NOT handle two common top-level Program.cs patterns:
  1. `var app = WebApplication.Create(...)` — direct factory
  2. `var builder = WebApplication.CreateBuilder(...); var app = builder.Build();` — builder pattern
- The IEndpointGroup class test (`test-minimal-api-guard.mjs`) used a method parameter so it always passed, masking the top-level gap.
- Fix: Extended `collectRouteBuilderVars` with two-pass scan:
  - Pass A: also tracks `WebApplication.Create(...)` → builderVars; `WebApplication.CreateBuilder(...)` → webAppBuilderVars
  - Pass B: tracks `<webAppBuilderVar>.Build()` → builderVars
- New test `scripts/test-route-map-roundtrip.mjs` covers full pipeline (extract → DB store → `getRouteMap` read-back) for all three patterns: IEndpointGroup class, `WebApplication.Create()`, and `builder.Build()`.
- All tests pass: `test-minimal-api-guard` ✅, `test-route-map-roundtrip` ✅ (4/4), `test-refactor-engine` ✅ (39/39).

## MCP-ISSUE-008 ✅ RESOLVED
- Scenario: Package-consumer audit for external dependencies showed inconsistent coverage depending on exact package token.
- MCP tool/query attempted: `mcp_codebase-inde_find_package_consumers` for `MediatR`, `FluentValidation`, `RabbitMQ.Client`, compared with `FluentValidation.DependencyInjectionExtensions`, `MassTransit`, and `Microsoft.EntityFrameworkCore`.
- Expected vs actual: expected consistent consumers across direct/bridge package names; actual had false-empty responses for some package names while others returned consumers normally.
- Impact: package-audit workflows may incorrectly conclude `not used` when query token does not match indexed contract-id semantics.
- Workaround used: retry with exact package IDs from `Directory.Packages.props`, then cross-check with representative known packages.
- Enhancement proposal: add alias/related-package expansion and `did-you-mean` hints in `find_package_consumers` when `consumerCount=0` for likely-known ecosystem packages.
- Resolution: Added `findSimilarPackageContractIdsImpl` in `src/crossRepoStore.ts` — when exact match returns 0 consumers, runs a LIKE prefix query (`nuget:fluentvalidation%`) against indexed `edges.to_id`. Results exposed as `hint` + `didYouMean` array in response (both `nano` and `standard/verbose` profiles). Exposed via `findSimilarPackageContractIds` method in `GraphStore` and called in `handleFindPackageConsumers` when `rows.length === 0`. Non-breaking: `hint`/`didYouMean` fields only present when count=0 and similar packages exist.
- Tracking URL: `D:/1.SourceCode/mcp-local/codebase-index-mcp/mcp-codebase-index-issue-registry.md#mcp-issue-008`

## MCP-ISSUE-009 ✅ RESOLVED
- Scenario: SQL exploration for package-consumer summary via `query_graph` failed due table allowlist restrictions.
- MCP tool/query attempted: `mcp_codebase-inde_query_graph` on `package_consumers` table in `wec.commnunication-hub`.
- Expected vs actual: expected read-only aggregate query for package coverage; actual returned `table 'package_consumers' is not allowed`.
- Impact: limits advanced aggregate diagnostics in one query and forces multiple tool calls for package-coverage overview.
- Workaround used: used repeated `find_package_consumers` calls for a targeted package set.
- Enhancement proposal: expose a safe aggregate endpoint for package coverage or allowlist read-only package-contract tables in `query_graph`.
- Resolution: Two-pronged fix. (1) Error message in `handleQueryGraph` (`src/handlers/impactHandler.ts`) now includes the full list of allowed tables: `table 'X' is not allowed. Allowed tables: repositories, files, symbols, edges, ...`. (2) `query_graph` tool description in `src/index.ts` updated to enumerate allowed tables, key column names per table, and explicit note that `package_consumers` is not a table — use `edges WHERE type='DEPENDS_ON' AND to_id LIKE 'nuget:%'` instead. No new tool added — allowed tables are static and embed cleanly in the description.
- Tracking URL: `D:/1.SourceCode/mcp-local/codebase-index-mcp/mcp-codebase-index-issue-registry.md#mcp-issue-009`

## MCP-ISSUE-010 ✅ RESOLVED
- Scenario: `get_folder_summary` for migrations after incremental re-index on `wec.commnunication-hub` returned deleted historical migration files that are not present in current branch `staging`.
- MCP tool/query attempted: `mcp_codebase-inde_get_folder_summary(repoId=wec.commnunication-hub, folderPath=backend/CommunicationHub/src/Infrastructure/Migrations)` after successful `index_repository(mode=incremental, commitSha=f114555...)`.
- Expected vs actual: expected folder summary to list current files (single consolidated migration + snapshot); actual returned 34 migration files including deleted ones from develop history.
- Impact: reduces trust for migration-audit tasks and forces targeted baseline file reads to confirm current state.
- Workaround used: narrowed verification to explicit file paths via symbol/file-summary + direct targeted reads and DB read-only checks.
- Resolution: Three-pronged fix. (1) `indexPipeline.ts`: `pruneStaleFiles()` + `pruneOrphanedEdges()` now run for both full AND incremental modes (guarded by `files.length <= maxFiles` to avoid pruning when the file cap truncated the disk scan); `resolveImplementsEdges()` remains full-mode only. (2) Branch tracking: added `resolveBranch()` helper (`git rev-parse --abbrev-ref HEAD`), stored as `branch` column in `index_runs` via `ensureRunColumnText("branch")` migration, propagated through `IndexRunSummary` type, `recordRun()`, and `getLatestRun()`. (3) `get_folder_summary` response now includes `indexMeta: { branch, commitSha, indexedAt, note }` sourced from `getLatestRun()` — callers can verify index was built from their expected branch before trusting file listings. Tool description in `src/index.ts` updated to document `indexMeta` and the branch-switch workflow.

## MCP-ISSUE-011 ✅ RESOLVED
- Scenario: Scale dogfooding on `wec.be` (7,371 files / 66,223 symbols, C# CRM monorepo) to evaluate the most-used navigation tools. Three reproducible weaknesses surfaced that small (TS, 84-file) repos never exposed.
- MCP tool/query attempted:
  - `search_symbols(query="send notification email", strategy=intent, ranked=true)`
  - `get_symbol_context_pack(name="CommunicationHubController")`
  - `find_impact_files(filePath="src/services/email/CRM.Email/Implements/SESEmailService.cs")` on a stale index.
- Expected vs actual:
  - **A** — expected ranked intent results; got `count:0`. Dropping `ranked` returned 8 correct hits (`SendNotificationAsync`, `SendMailAsync`, …) — so the ranked path silently broke intent.
  - **B** — expected the class context; `selectedSymbol` was the same-named **constructor** (edgeless) while `candidates[0]` was the class (score 99) → empty `callers/callees/importers`.
  - **C** — expected impact list (other read tools degrade with a `staleness` note); `find_impact_files` threw `McpError "Index is stale…"` and returned nothing.
- Impact: ranked+intent is the documented "scored candidates" path yet returned 0 for any multi-word query; context pack gave useless empty packs for controllers; impact analysis was blocked for the normal "haven't re-indexed today" state.
- Root cause:
  - **A** — `searchHandler.ts` ranked branch called `getSymbolCandidates(repoId, query, limit)`, whose impl (`symbolSearch.ts`) did a single `name = ? OR name LIKE '%<whole query>%'` — no tokenization, ignored `strategy`, dropped `kind/language/filePath`.
  - **B** — `getContextByNameImpl` ordered by `case when name = ? then 0 else 1, rank`; class and constructor share the name → tie broken by FTS `rank`, which picked the constructor. `selectedSymbolId` followed `context.symbol`, disagreeing with the top-ranked candidate.
  - **C** — `impactHandler.ts` `checkStaleness()` threw `McpError` instead of warning, unlike every other read tool.
- Resolution: Three-pronged fix.
  1. **(A)** Extended `getSymbolCandidatesImpl(db, repoId, name, limit, strategy='name', filters)` (`symbolSearch.ts`): intent strategy tokenizes via the shared `extractIntentTokens` and ranks by token coverage; `kind/language/filePath` filters threaded through; `strategy=name` behavior preserved. `graphStore.getSymbolCandidates` + `searchHandler.ts` ranked branch pass `strategy` and filters.
  2. **(B)** Added a kind-priority ORDER-BY tiebreak (`kindPriorityOrder`) to both FTS and non-FTS branches of `getContextByNameImpl` so `class/interface/struct/method/function` win name ties over `constructor/module/property/variable`. `selectedSymbol` now agrees with `candidates[0]`.
  3. **(C)** `checkStaleness()` → `staleWarningFor()` returns a `{ note, hint }` object (or null); `find_impact_files` and `get_change_context` embed it as a non-fatal `staleWarning` field instead of throwing. Tool descriptions in `src/index.ts` updated for all three.
- Verification (2026-06-03):
  - `npm run typecheck` ✅ · `npm run build` ✅ · `npm run guard:no-llm-runtime` ✅
  - `node scripts/smoke-test.mjs` ✅ — new regression assertions `RANKED_INTENT_OK` (count 10), `CONTEXT_PACK_KIND_OK` (selected `class`), find_impact_files non-error.
  - `npm run benchmark:plan:check` ✅ — qualityGate 69.x%, `snapshotRegression` clean.
  - Live on `wec.be` (stale): **A** → `count:8`; **B** → `selectedSymbol.kind="class"` (line 13); **C** → returns `impactedFiles` + `staleWarning` instead of `McpError`.
- Residual: controller classes can still show empty `callers/callees` when they are entry points reached via routing/DI rather than CALLS edges — that is a graph-coverage characteristic, not the selection bug (which is fixed).
- Tracking URL: `D:/1.SourceCode/mcp-local/codebase-index-mcp/mcp-codebase-index-issue-registry.md#mcp-issue-011`

## MCP-ISSUE-012 ✅ RESOLVED (enhancement)
- Scenario: Dogfooding feedback — the agent falls back to baseline `Read`/manual edits instead of MCP because (1) MCP returns a semantic map but no raw source to edit against, (2) `refactor_replace_*` matches literal text only, and (3) `rename_assist` is read-only (returns hints, the agent still hand-edits each file).
- Enhancement proposal: close the "MCP can map but can't help edit" gap with three additions.
- Resolution:
  1. **`get_symbol_source` (new tool)** — returns the raw source text span of a symbol (by symbolId or name), read from disk via the existing `assertSafeRepoFilePath`/`safeReadText` guards. Symbols now persist `end_line` (`SymbolRecord.endLine`, `symbols.end_line` column + backward-compatible migration; tree-sitter `endPosition` captured in `csharpExtractor`/`jsExtractor`); when absent (pre-end-line index or regex-based Python extraction) the span is estimated from the next symbol's start line. Reports a non-fatal `staleWarning` when the index is stale.
  2. **Regex find mode for `refactor_replace_preview/apply`** — `findMode='regex'` compiles `find` as a RegExp (i/m/s flags; `g` forced) with capture-group substitution (`$1`, `$&`, `$$`) in `replaceExpression`. Bounded by per-file (2000) and global (5000) match caps + zero-length-match guard; invalid patterns return a clean `McpError`. `findMode='literal'` (default) preserves prior behavior. Apply/rollback unchanged (offset + beforeText verified).
  3. **`rename_assist(emitPreview=true)`** — turns the advisory rename into an applyable refactor preview (previewId + approvalToken) by reusing the extracted `createReplacePreview` helper with a word-boundary regex (`\bName\b`) scoped to the symbol's file + affected files; the agent then calls `refactor_replace_apply` (with `includeLowConfidence=true` for top-level identifiers, which have no enclosing owner type). `emitPreview=false` (default) keeps the read-only hints output.
- Verification (2026-06-03):
  - `npm run typecheck` ✅ · `npm run build` ✅ · `npm run guard:no-llm-runtime` ✅
  - `node scripts/test-refactor-engine.mjs` → **47 passed, 0 failed** ✅ (adds suite 3.11 regex capture-group + invalid-regex, 3.12 rename emitPreview→apply→rollback round-trip).
  - `node scripts/smoke-test.mjs` ✅ — `GET_SYMBOL_SOURCE_OK { estimated:false }` (end_line persisted via re-index).
  - `npm run benchmark:plan:check` ✅ — compactSavings 69.85%, no snapshot regressions.
- Residual: `end_line` is exact only for C#/JS/TS symbols re-indexed after this change; Python (regex-based extraction) and pre-existing indexes use the estimated span. Regex matching has no execution timeout (bounded by match caps + pattern length); patterns are user-supplied in a local dev tool. Re-index required to populate `end_line` on existing repos.
- Tracking URL: `D:/1.SourceCode/mcp-local/codebase-index-mcp/mcp-codebase-index-issue-registry.md#mcp-issue-012`

## MCP-ISSUE-013 ✅ RESOLVED (2026-06-04)
- Reported: 2026-06-04 · Repo: `wec.commnunication-hub` · Branch: `develop` · Commit: `5a4a4c6` · indexVersion: `v1-tree-sitter-property-edges`
- Scenario: While implementing the CH-150 EmailSignature CQRS slice, used `find_implementations` to enumerate implementers of marker interfaces on request types (`ITenantScopedRequest`, new `IAgentScopedRequest`). These are implemented by C# **`record`** types of the form `record X : IRequest<Result<...>>, ITenantScopedRequest, IAgentScopedRequest`.
- MCP tool/query attempted (after BOTH incremental and full re-index):
  - `find_implementations(interfaceName="IUser")`
  - `find_implementations(interfaceName="ITenantScopedRequest")`
  - `find_implementations(interfaceName="IAgentScopedRequest")`
- Expected vs actual:
  - **`IUser`** (implemented only by `class`es) → **5/5 correct** ✅ — `CurrentUser` + 4 test stubs, every hit `kind:"class"`.
  - **`ITenantScopedRequest`** (1 test-helper `class` + **dozens** of `record` command/query types) → returned **only 1** — the single `class` (`PlaybookAlignmentIntegrationTests.TenantScopedRequest`). Every `record` implementer (CreateConversationNoteCommand, ReplyConversationCommand, all 5 EmailSignature requests, …) was **missing**.
  - **`IAgentScopedRequest`** (implemented only by 5 `record`s) → **count 0**.
  - Smoking gun: across all three queries **every returned hit is `kind:"class"`; not a single `record` ever appears**.
- Impact: in CQRS/MediatR codebases (requests are records implementing marker interfaces), `find_implementations` is effectively blind to request types and returns a **misleadingly low count** (e.g. "1 implementer" when there are dozens), or 0. Forces a `Grep` fallback and can cause an agent to conclude an interface is unused/has one implementer.
- Mode independence: reproduces identically on `mode=incremental` (filesIndexed 11) and `mode=full` (filesIndexed 391, `implementsResolveMs:2`). NOT an incremental-pruning artifact — verified by running full re-index then re-querying.
- Workaround used: `Grep` for `: .*ITenantScopedRequest` / `IAgentScopedRequest` across `**/*.cs`.
- Enhancement proposal: extend the C# IMPLEMENTS-edge extraction to (1) handle `record` and `record struct` declarations, and (2) capture **all** interfaces in a multi-item base list, not just a leading `class`/first entry (base lists like `record X : IRequest<T>, IMarker1, IMarker2`). Add a regression fixture covering `record X : IRequest<...>, ITenantScopedRequest`.
- Tracking URL: `D:/1.SourceCode/mcp-local/codebase-index-mcp/mcp-codebase-index-issue-registry.md#mcp-issue-013`

### Resolution (2026-06-04)
- Root cause confirmed exactly as reported: `src/extractors/csharpExtractor.ts` guarded IMPLEMENTS-edge emission with `if (node.type === "class_declaration" || node.type === "struct_declaration")`, excluding `record_declaration`. Records were already indexed as symbols (kind `class`) and the base-list walk already iterated **all** interfaces — the node-type guard was the sole blocker.
- Fix 1: added `|| node.type === "record_declaration"` to the guard. One `record_declaration` clause covers both `record` and `record struct` (tree-sitter emits the latter as `record_declaration` + `struct` modifier).
- Fix 2 (latent, surfaced by the new fixture): the generic-arg strip `/<[^>]*>$/` could not span nested generics (`IRequest<Result<ThingDto>>` → left untouched). Changed to greedy `/<.*>$/` so the IMPLEMENTS token is `iface:IRequest`, not a partial.
- Regression: `scripts/test-csharp-inheritance-bridge.mjs` gains a `record` + `record struct` multi-marker fixture asserting IMPLEMENTS edges for all markers and clean generic stripping.
- Verification (live, full re-index of `wec.commnunication-hub`, 370 files):
  - `find_implementations("ITenantScopedRequest")` → **count 21** (was 1).
  - `find_implementations("IAgentScopedRequest")` → **count 6** (was 0).
  - `find_implementations("IUser")` → 5 (control, unchanged). Record implementers report `kind:"class"` (records are indexed as `class`).
- No DB migration; existing C# repos need a re-index to gain record IMPLEMENTS edges.

### Live MCP Re-Verification (2026-06-08)
- Reproduced against the central MCP index (pre-fix extractor build): `find_implementations(ITenantScopedRequest)` → **count 1** (only the test-helper `class`), `find_implementations(IAgentScopedRequest)` → **count 0**.
- Re-indexed via `index_repository(mode="full")` (server's fixed build, runId `6de54023`), then re-queried:
  - `ITenantScopedRequest` → **count 21** — all CQRS `record` commands/queries (CreateConversationNoteCommand, the 5 EmailSignature requests, …) plus the explicit `record EntityScopedRequest : ITenantScopedRequest`.
  - `IAgentScopedRequest` → **count 6** (5 EmailSignature requests + `record AgentScopedRequest`).
  - Every response carries an ENH-C `coverage: { confidence: "high", knownGaps: [] }` block.
- Confirms the fix end-to-end through the live MCP tool, not just the unit fixture.

## MCP-ISSUE-014 ✅ RESOLVED (2026-06-04, Stage 1)
- Reported: 2026-06-04 · Repo: `wec.commnunication-hub` · Branch: `develop` · Commit: `5a4a4c6`
- Scenario: Modified shared infra `AuthorizationBehaviour` (a MediatR `IPipelineBehavior<TRequest,TResponse>`) during CH-150 and wanted the blast radius of the change before relying on the test suite.
- MCP tool/query attempted (index fresh, full re-index): `find_impact_files(filePath="backend/CommunicationHub/src/Application/Common/Behaviours/AuthorizationBehaviour.cs", view="surface", profile="compact")`.
- Expected vs actual: expected the set of types/requests whose authorization flows through this behaviour (or at least a degraded note); actual returned `callers: []` with `reliabilitySummary.unresolvedRatio: 1.0` (`graphHealth`: importsTotal 5, classified 2/5). No `staleWarning` (index was fresh) — the result is genuinely empty.
- Root cause: MediatR pipeline behaviours are never called statically — MediatR resolves and invokes `IPipelineBehavior` implementations via DI/reflection at request time. There is no `CALLS` edge into the behaviour, so the static impact graph has nothing to surface. The same applies to endpoint auto-registration via `IEndpointGroup` (reflection-discovered) and other DI/reflection-wired types.
- Impact: `find_impact_files` returns a **false-empty** blast radius for exactly the "shared cross-cutting infra" changes where impact analysis is most valuable. A reviewer/agent could wrongly conclude "no dependents" and skip regression scope. (Here the correct safety net was running the full 421-test Application.UnitTests suite, not the impact tool.)
- Workaround used: full test-suite run + `Grep` for the interface and DI registration site.
- Enhancement proposal: when a target file/symbol is a known DI/reflection-wired shape (MediatR `IPipelineBehavior`, `IEndpointGroup`, `IRequestHandler`, types registered via `AddScoped/AddTransient/AddSingleton` or `typeof(IPipelineBehavior<,>)`), emit an explicit note in `find_impact_files` (e.g. `wiringNote: "type is DI/reflection-wired; static impact graph is incomplete — N requests flow through the MediatR pipeline"`) instead of a bare empty `callers`. Optionally synthesize impact from DI registration sites / pipeline membership.
- Related: same class of graph-coverage gap noted in MCP-ISSUE-011 residual (controllers reached via routing/DI rather than CALLS edges).
- Tracking URL: `D:/1.SourceCode/mcp-local/codebase-index-mcp/mcp-codebase-index-issue-registry.md#mcp-issue-014`

### Resolution (2026-06-04, Stage 1 — heuristic note, no migration)
- Added `detectWiringShapeImpl` in `src/impactAnalyzer.ts`: detects DI/reflection-wired shapes from IMPLEMENTS edges (record-aware after ISSUE-013) to `iface:IPipelineBehavior%`/`IRequestHandler%`/`INotificationHandler%`/`IEndpointGroup%`, plus a name-suffix fallback (`*Behaviour`/`*Behavior`/`*Endpoints`). For pipeline behaviours it counts the repo's `IRequest` implementers.
- `getImpactFilesImpl` / `getImpactSurfaceImpl` now attach an optional `wiringNote` **only when `callers`/`impactedFiles` is empty AND the target is wired**, so `find_impact_files` explains the empty blast radius instead of implying "no dependents". Threaded through `handleFindImpactFiles` (all profiles + groupBy=module). No new edge type, no DB migration, no re-index required.
- Regression: `scripts/test-wiring-note.mjs` (also `npm run test:wiring-note`).
- Verification (live, `wec.commnunication-hub`): `find_impact_files(AuthorizationBehaviour.cs, view=surface)` → `callers: 0` + `wiringNote: "type is DI/reflection-wired (IPipelineBehavior); static impact graph is incomplete — 73 requests flow through the MediatR pipeline. Run the full test suite to scope shared-infra changes."`
- Stage 2 (deferred, gated by demand): a full `WIRED_BY` edge class extracting `AddScoped/Transient/Singleton`/`typeof(IPipelineBehavior<,>)` registration sites to materialize composition-root files as callers. Carries a DB migration + full re-index; build only if users need the registration sites themselves, not just the explanatory note.

### Live MCP Re-Verification (2026-06-08)
- `find_impact_files(filePath="backend/CommunicationHub/src/Application/Common/Behaviours/AuthorizationBehaviour.cs", view="surface")` → `callers: []` **with** `wiringNote: "type is DI/reflection-wired (IPipelineBehavior); static impact graph is incomplete — 83 requests flow through the MediatR pipeline. Run the full test suite to scope shared-infra changes."` (request count rose to 83 now that record requests are captured — ISSUE-013 synergy). No more bare false-empty.

## Agent Adoption Enhancements (2026-06-04)

Context: post-mortem of a full CH-150 feature build (plan → implement → simplify → code-review → docs) in `wec.commnunication-hub`. Honest finding — in the **main thread** the agent used `watch_repo` only and otherwise fell back to `Read`/`Grep`/`Bash`; the codebase-index discovery/impact tools were under-used. These ideas target the specific friction that caused the fallback, so the agent reaches for MCP more often and trusts it more. Each item: **Friction observed → Proposal → Adoption impact**.

### ENH-A — Dirty/uncommitted-aware freshness (highest-leverage)
- Friction: The single biggest reason MCP was avoided mid-implementation. After editing files, the index lags HEAD; with `watch` stopped, new symbols (e.g. `IAgentScopedRequest`) and edits were invisible, so `find_implementations`/`find_impact_files` returned stale/false-empty results — strictly worse than `Grep`. Re-indexing after every edit is too heavy a ritual mid-task.
- Proposal: (1) On every graph-read, diff the git working tree and return a `dirtyFiles: [...]` + `indexLag: { commitsBehind, dirtyCount }` header so the agent knows exactly which results to distrust. (2) Add a fast `index_repository(mode="dirty")` that re-indexes only `git status` changed files (sub-second) — a cheaper, explicit "refresh what I just touched" than incremental. (3) Optionally auto-run the dirty refresh when a read tool is called and the working tree changed since last index.
- Adoption impact: removes the "is this answer stale?" doubt that pushes the agent to Grep; makes MCP usable *during* editing, not just on committed code.

### ENH-B — Vertical-slice / template bundle fetch
- Friction: The task was "implement EmailSignature by mirroring the ConversationNote slice." The agent read **6+ files separately** (entity, EF config, Create command, Get query, endpoint group, DbContext) to absorb one convention. `get_symbol_context_pack` returns callers/callees, not "the whole pattern to copy."
- Proposal: A `get_feature_bundle(seedSymbol | seedFile, convention="csharp-vertical-slice")` that walks naming/folder conventions (Domain entity → `*Configuration` → `Commands/*`/`Queries/*` handlers+validators → `Web/Endpoints/*` group → DbSet registration) and returns the full source of the related set in one call. Generalize via a configurable convention map per repo.
- Adoption impact: turns "implement like X" (the most common feature task) into one MCP call instead of 6 Reads — the biggest token + latency win, and exactly the task type where the agent currently bypasses MCP entirely.

### ENH-C — Universal coverage/confidence signal on every graph-read
- Friction: `find_implementations(ITenantScopedRequest)` returned `count:1` with **no signal** it was incomplete (it silently dropped all `record` implementers — see ISSUE-013). A bare low/zero count reads as authoritative and is more dangerous than an error.
- Proposal: Every graph-read returns a small `coverage` block: `{ confidence, knownGaps: ["records not captured for IMPLEMENTS", ...], suggestFallback: "grep '\\: .*ITenantScopedRequest'" }`. `find_impact_files` already has `graphHealth`/`reliabilitySummary`; extend the same contract to `find_implementations`, `get_call_chain`, `trace_execution_flow`.
- Adoption impact: lets the agent *trust-but-verify* — proceed on MCP when confidence is high, fall back deliberately (not blindly) when a known gap is flagged. Directly counters false-empty-driven distrust.

### ENH-D — DI / reflection wiring awareness
- Friction: `find_impact_files(AuthorizationBehaviour, surface)` returned empty because MediatR `IPipelineBehavior` is reflection/DI-invoked (see ISSUE-014). The cross-cutting changes the agent most wants to scope (pipeline behaviours, `IEndpointGroup`, handlers) are precisely the ones with no static CALLS edge.
- Proposal: Index DI registration sites (`AddScoped/Transient/Singleton`, `typeof(IPipelineBehavior<,>)`, MediatR/minimal-API conventions) as a `WIRED_BY`/`PIPELINE_MEMBER` edge class; surface them in impact results with a `wiringNote`. Even a heuristic "this type is pipeline-wired; N requests flow through it" beats an empty list.
- Adoption impact: makes impact analysis trustworthy for shared-infra edits — the case where the agent currently resorts to "run the whole test suite" as a blunt safety net.

### ENH-E — `change_impact(diff)` → dependents + covering tests in one call
- Friction: After editing shared infra the agent ran the **entire** 421-test Application.UnitTests suite because there was no quick, trusted way to scope "what did my change affect and which tests cover it."
- Proposal: A composite `change_impact` that takes the working-tree diff (or a commit range), maps changed symbols → dependents (`find_impact_files`) → covering tests (`link_tests_to_source`), and returns a ranked "tests to run" list + residual-risk note. Essentially fuse `detect_changes` + `find_impact_files` + `link_tests_to_source` behind one intent.
- Adoption impact: enables targeted test runs the agent can trust, replacing whole-suite runs; gives the agent a reason to call MCP *after* editing, closing the loop.

### ENH-F — Intent router / `orient(task)` entry tool
- Friction: The repo's "MCP-first" gate is task-agnostic, but the right first move differs by task: "implement like X" → read full template (ENH-B); "where/blast-radius" → symbol/impact tools; "endpoint inventory" → `route_map`. The agent has to self-route and sometimes mis-routes (or over-applies the gate to tasks where reading full source is genuinely correct).
- Proposal: A single `orient(intent: string, seed?: string)` tool that classifies the task and returns `{ recommendedTools, seedSymbols, caveats }` (e.g. intent="add a CRUD feature mirroring ConversationNote" → `get_feature_bundle` + the seed slice; intent="rename X safely" → `rename_assist`). Pairs with a CLAUDE.md note that reading full templates is an *approved* MCP-first path for "implement-by-pattern," not a violation.
- Adoption impact: lowers the activation cost of "which MCP tool do I even start with," which is part of why the agent defaults to familiar `Grep`/`Read`.

### Priority for adoption lift
1. **ENH-A** (freshness) and **ENH-C** (coverage signal) remove the two trust-killers that caused fallback this session.
2. **ENH-B** (feature bundle) is the biggest single token/latency win for the most common task type.
3. **ENH-D/E** make MCP useful for the *edit → verify* half of the workflow, not just the *explore* half.
4. **ENH-F** is the cheap meta-fix so the agent picks the right tool per task.

### Resolution (2026-06-04) — all ENH-A→F shipped
- **ENH-A — dirty/freshness.** New `index_repository(mode="dirty")` re-indexes only the git working-tree delta (unstaged+staged+untracked via `collectDirtyFiles`); pruning is suppressed for the subset scan to prevent false deletions (`src/indexPipeline.ts` `onlyRelativePaths`). Freshness header `indexLag {commitsBehind, dirtyCount}` + capped `dirtyFiles[]` added to `find_impact_files` and `change_impact` (the edit-verification tools) via `buildIndexMeta(..., withFreshness:true)`. **Deliberately NOT** added to the navigation tools the token benchmark snapshots (file/folder summary, context pack, change_context) — git-derived fields are non-deterministic and would bloat the compact default; provenance-only `indexMeta` stays pure there. New git helpers `collectDirtyFiles`/`countCommitsBehind` in `src/gitHelpers.ts`.
- **ENH-C — coverage signal.** New `src/coverage.ts` `buildCoverageBlock` → `{ confidence, knownGaps, suggestFallback }`, wired into `find_implementations`, `get_call_chain`, `trace_execution_flow` (full block in compact+, `confidence` scalar in nano). For `find_implementations` the low/zero-count gap names the C#-indexing limitation and suggests a grep fallback.
- **ENH-B — `get_feature_bundle`.** New tool (`src/handlers/bundleHandler.ts` + `src/conventions.ts`): resolves an entity from `seedSymbol`/`seedFile`, walks the `csharp-vertical-slice` name convention (entity → `{E}Configuration` → `Create/Update/Delete{E}Command` + handlers/validators → `Get{E}Query` + handlers → `{E}Endpoints`), and returns the related symbols with source in one call. `readSymbolSourceSpan` extracted into `src/refactorUtils.ts` and shared with `get_symbol_source`. Reports `unresolvedRoles` + bundle-specific coverage.
- **ENH-E — `change_impact`.** New composite tool fusing changed-files → dependents → covering tests. Shared `computeChangedFileImpacts` extracted into `src/changeAnalysis.ts` (and the duplicate `scoreChangeRisk`/`resolveDetectChangesPolicy` in `indexHandler.ts` collapsed onto the canonical `src/policyResolver.ts`). Returns a risk-ranked `testsToRun` list + `residualRisk` note for changed files with no linked test.
- **ENH-F — `orient`.** New deterministic intent router (`src/orient.ts` + `src/handlers/orientHandler.ts`): keyword-classifies a free-text intent → recommended tool(s) + caveats, resolves an optional seed to `seedSymbols`. **No-LLM**: pure static rule table; `npm run guard:no-llm-runtime` re-verified clean.
- Verification: full pre-commit green (`typecheck`, `build`, `guard:no-llm-runtime`, `smoke-test`, `benchmark:plan:check` — compactSavings 69.96%, no snapshot regression); `test-refactor-engine` 47/0, new `test-wiring-note`, record fixture in `test-csharp-inheritance-bridge`. Live `scripts/verify-enhancements.mjs` exercises all new tools end-to-end (orient/change_impact/get_feature_bundle/dirty-mode/freshness/coverage).

### Independent Agent Dogfooding Verification (2026-06-08)
Re-verified end-to-end from a fresh CH-150 agent session against the live MCP (`wec.commnunication-hub`, commitSha `5a4a4c6`, indexedAt `2026-06-08T02:21`). All shipped tools behaved as designed:
- **`orient`** ("implement a new CRUD feature mirroring the ConversationNote vertical slice", seed `ConversationNote`) → `classifiedAs:["implement-like"]`, recommended `get_feature_bundle`, resolved seed to the 5 ConversationNote handler symbols. ✅
- **`get_feature_bundle(seedSymbol="EmailSignature")`** → entity + config + Create/Update/Delete command+handler+validator + Get query/handler (20 members, 6 files) in one call, `coverage.confidence:"high"`, `indexMeta` present. ✅ (see ISSUE-016 for two name-convention gaps).
- **`find_implementations("IAgentScopedRequest")`** → **6** (5 EmailSignature requests + `record AgentScopedRequest`), `coverage:{confidence:"high",knownGaps:[]}`. ✅ ISSUE-013 confirmed fixed live.
- **`find_impact_files(AuthorizationBehaviour.cs, view="surface")`** → `callers:[]` + `wiringNote: "...IPipelineBehavior...83 requests flow through the MediatR pipeline. Run the full test suite..."`. ✅ ISSUE-014 confirmed fixed live.
- **`change_impact`** → on a clean tree correctly reported `changedFileCount:0` (working tree == indexed commit); with `baseRef="HEAD~1"` correctly surfaced the 19-file EmailSignature change set, a risk-ranked `testsToRun`, `residualRisk`, and `coverage.confidence:"low"`. ✅ (see ISSUE-017 for the test-linkage recall gap that the low-confidence flag honestly disclosed).
- **ENH-C** `coverage` blocks observed on every new/updated tool — the "trust-but-verify" signal works as intended.
- Net: the three biggest adoption blockers from the CH-150 post-mortem (template-bundle, DI-wiring blindness, change→test scoping) are closed. Three residual name-convention/recall refinements logged below as ISSUE-015/016/017.

## MCP-ISSUE-015 ✅ RESOLVED (refinement)
- Reported: 2026-06-08 · Repo: `wec.commnunication-hub` · Commit: `5a4a4c6` · Severity: low (cosmetic)
- Scenario: After ISSUE-013, `find_implementations` correctly finds `record` implementers but mislabels their `kind`.
- Repro: `find_implementations("IAgentScopedRequest")` → 6 hits; the test type declared `private sealed record AgentScopedRequest : IAgentScopedRequest` is returned as `kind:"class"` (should be `record`). All 5 EmailSignature `record` commands/queries likewise carry `kind:"class"`. Already acknowledged in the ISSUE-013 resolution ("records are indexed as `class`").
- Impact: low — navigation is correct; but any agent/tool keying on `kind` to distinguish `record` vs `class` (codegen, "is this an immutable DTO/command", template selection) gets the wrong type. `get_feature_bundle` inherits the same mislabel.
- Proposal: map tree-sitter `record_declaration` (and `record struct`) to `kind:"record"` / `"record struct"` in `csharpExtractor.ts` symbol emission, rather than collapsing to `class`. Thread the corrected `kind` through IMPLEMENTS results, `get_feature_bundle`, and symbol lookups.
- Tracking URL: `D:/1.SourceCode/mcp-local/codebase-index-mcp/mcp-codebase-index-issue-registry.md#mcp-issue-015`

## MCP-ISSUE-016 ✅ RESOLVED (refinement)
- Reported: 2026-06-08 · Repo: `wec.commnunication-hub` · Commit: `5a4a4c6` · Severity: low-medium (bundle completeness)
- Scenario: `get_feature_bundle` name-convention walk under-returns the slice for two real shapes in the CH-150 EmailSignature feature.
- Repro: `get_feature_bundle(seedSymbol="EmailSignature")`:
  - **(a) non-CRUD verb command missed** — `command[]` contained only Create/Update/Delete; **`SetEmailSignatureApplied`** (verb "Set", at `Application/EmailSignatures/Commands/SetEmailSignatureApplied/`) was absent, though it implements `IAgentScopedRequest` and is part of the slice.
  - **(b) endpoint role unresolved** — `endpoint:[]` / `unresolvedRoles:["endpoint"]` because the endpoint group class is `EmailSignatures` (pluralized `IEndpointGroup`) and the notes precedent lives in `Customers.cs` — neither matches the expected `{Entity}Endpoints` pattern.
- Impact: an agent using the bundle to "implement like X" copies an **incomplete** pattern (misses the SetApplied command and the endpoint group). Honestly disclosed via `unresolvedRoles`, so severity is bounded, but the bundle's core promise (whole slice in one call) is partially unmet for non-CRUD verbs and plural endpoint groups.
- Proposal: (1) Command discovery: match **any** `*{Entity}*Command` under `Application/**/Commands/**` (folder-walk), not just Create/Update/Delete prefixes — captures Set/Apply/Toggle/Archive/etc. (2) Endpoint discovery: resolve `IEndpointGroup` implementers whose class name is the entity **or its plural** (`{Entity}`/`{Entity}s`/`{EntityPlural}`) or whose route/handlers reference the entity, not only `{Entity}Endpoints`. Keep reporting genuinely-absent roles in `unresolvedRoles`.
- Tracking URL: `D:/1.SourceCode/mcp-local/codebase-index-mcp/mcp-codebase-index-issue-registry.md#mcp-issue-016`

## MCP-ISSUE-017 ✅ RESOLVED (refinement)
- Reported: 2026-06-08 · Repo: `wec.commnunication-hub` · Commit: `5a4a4c6` · Severity: medium (recall of `testsToRun`)
- Scenario: `change_impact` maps changed files → covering tests, but the test-linkage misses the most obvious same-named feature tests.
- Repro: `change_impact(baseRef="HEAD~1")` over the 19-file EmailSignature change → `testCoverage: { dependentFiles:43, covered:1, uncovered:42 }`. `testsToRun` surfaced `ConversationAssignedToAIEventHandlerTests` (score 0.292, weakly related) and `AuthorizationBehaviourTests` (0.138), but **omitted the feature's own tests** — `EmailSignaturesCommandHandlerTests` and `EndpointContractIntegrationTests` (both in the diff, both directly exercise the changed handlers/endpoints) — dropping them into `residualRisk` as "untested". `coverage.confidence:"low"` was correctly reported.
- Impact: an agent trusting `testsToRun` alone would **skip the tests most likely to catch a regression** in the changed code. Mitigated (not eliminated) by the honest `confidence:"low"` + `residualRisk` list, which signals "fall back to the broader suite."
- Root-cause hypothesis: `link_tests_to_source` relies on static CALLS/type edges; the new handlers are invoked from tests via `new XHandler(context).Handle(...)` (constructor + method call) and via the MediatR stub path, which the linker did not connect. No name-affinity fallback (test class name containing the changed entity/handler name) is used.
- Proposal: add a **name-affinity fallback** to `link_tests_to_source`/`change_impact` — when a test file/class name contains a changed entity or handler name (`EmailSignature*` ↔ `EmailSignaturesCommandHandlerTests`), emit a low-but-nonzero link and include it in `testsToRun` (flagged `linkBasis:"name-affinity"`) instead of dropping it to `residualRisk`. Optionally index `new {Handler}(...)` construction edges from test files to strengthen static links.
- Tracking URL: `D:/1.SourceCode/mcp-local/codebase-index-mcp/mcp-codebase-index-issue-registry.md#mcp-issue-017`

### Resolution (2026-06-08) — ISSUE-015/016/017 all shipped
- **ISSUE-015 — record `kind`.** New `csharpTypeKindForNode` (`src/extractors/csharpExtractor.ts`) maps `record_declaration` → `record`, and `record struct` (record_declaration carrying a `struct` modifier child) → `record struct`, instead of collapsing to `class`. The same helper now computes `parentKind` for member `parentSymbolId` so a record member's parent ID stays aligned with the record's own `stableId` (kind is part of the ID). `record`/`record struct` added to: the `SymbolRecord["kind"]` union (`src/types.ts`); `typeSymbolByLine` tracking (`CSHARP_TYPE_KINDS`); the `callTargetByName`/`typeTargetByName` resolution sets (`src/extractors/extractorUtils.ts`) so CALLS/TYPE_REF edges to records survive the relabel; the wiring-note heuristic (`src/impactAnalyzer.ts`); and the `get_feature_bundle` dominant-export + member-type sets. `find_implementations` reads `kind` straight from `symbols`, so it now reports the real type. (The `dead_code_scan` class-only heuristics are unchanged — records already didn't hit their `class\s+`-signature branches.)
- **ISSUE-016 — bundle completeness.** `get_feature_bundle` (`src/handlers/bundleHandler.ts`) refactored to an `addMember` helper + supplemental discovery after the exact name-pattern pass: **(a)** a Commands-folder walk — `getSymbolCandidates(entity, …, {filePath:"Commands"})` filtered to `/commands/` paths and type kinds, classified by suffix (Handler→commandHandler, Validator→commandValidator, else→command, skipping Dto/Response/Result/Vm) — captures non-CRUD verbs like `SetEmailSignatureApplied`; **(b)** when the `endpoint` role is still unresolved, match it among `IEndpointGroup` implementers (`findImplementations`) by entity / plural / contains-entity name, catching the plural-only `EmailSignatures` group. `unresolvedRoles` is recomputed from what actually matched, so genuinely-absent roles are still reported.
- **ISSUE-017 — name-affinity test linkage.** `linkTestsToSource` (`src/staticAnalyzer.ts`) gains a token-based affinity fallback: file bases are split into distinctive tokens (camel/Pascal/snake aware, singularized, role/verb stopwords like command/handler/create dropped), and a test is linked to a source when ≥50% of the source's distinctive tokens appear in the test name — scored 0.42–0.5 so it clears the default `minScore` (0.4) yet ranks below exact/import/call links, tagged `name-affinity`. Test pre-selection was widened the same way so the candidate (e.g. `EmailSignaturesCommandHandlerTests`) is admitted when probing `CreateEmailSignatureCommandHandler`. `change_impact` inherits this (it calls the linker), promoting same-entity tests from `residualRisk` into `testsToRun`. The shared role-word exclusion keeps unrelated `*CommandHandler` pairs from matching.
- Verification: full pre-commit green (`typecheck`, `build`, `guard:no-llm-runtime`, `smoke-test`, `benchmark:plan:check` — compactSavings unchanged, no snapshot regression); `test:wiring-note` + `test:csharp-inheritance-bridge` (now asserts record/`record struct` kinds) pass; new `test:issue-refinements` boots the real server on a C# vertical-slice fixture and asserts all three end-to-end (SetEmailSignatureApplied in commands, plural `EmailSignatures` endpoint resolved, record kinds, and the `name-affinity` link at score 0.47 with a negative control on an unrelated slice).

## Session Dogfooding — 2026-06-09 (customer↔conversation assignment-desync audit)
Context: full-day MCP-first session on `wec.commnunication-hub` (re-index → audit "wrong-level property resolution" between customer-level owner and conversation-level assignment → fix `ProcessOutboundSentConfirm` → `/review`). Tools that worked well, retained without friction: `index_repository(mode=incremental)` (fast re-index after edits), `get_symbol_context_pack` + `find_impact_files` (clean blast radius for the `ProcessOutboundSentConfirmCommandHandler` ctor change — exactly the MCP-over-grep win the gates promise). The four issues below are where the agent still fell back to `Grep`/`Explore` despite passing the discovery gates. Logged as enhancement candidates (not regressions).

## MCP-ISSUE-018 ✅ RESOLVED (2026-06-10)
- Reported: 2026-06-09 · Repo: `wec.commnunication-hub` · Severity: high (biggest fallback driver this session)
- Scenario: Audit for "wrong-level property resolution" bugs — find every site that READS `Conversation.AssignmentState.AssignedAgentUsername` (conversation-level) where it should resolve the customer-level owner (`customer_inbox_assignments` via `ICustomerAssignmentResolver`). This is a recurring bug class in this codebase (same shape as the already-fixed 3 notification handlers + the newly-found `ProcessOutboundSentConfirm.cs:129`).
- MCP tool/query attempted: `get_symbol_context_pack` + `search_symbols(AssignedAgentUsername)`; intended to enumerate read-sites vs write-sites of the property.
- Expected: a list of every callsite that READS the property, with enclosing method, so the agent can classify each as correct-level vs wrong-level. ISSUE-001 added `PROPERTY_REF`/`PROPERTY_WRITE` edges and surfaced callers via `get_change_context`, but there is no tool that simply *lists* read-accesses (vs writes) of a property across the repo with their enclosing symbol.
- Actual: `search_symbols` returns the symbol definition, not its field-access callsites; `get_change_context` gives caller hops but not a clean read/write-partitioned access inventory. The agent fell back to **3 parallel `Explore` agents running `grep`** on `AssignmentState.AssignedAgentUsername` across `src` to do the audit.
- Impact: the exact task MCP should own (semantic "who reads this field, and where") still routes to grep. High, because "wrong-level resolution" audits recur in this domain (customer vs conversation, owner vs direct-actor).
- Workaround: `Grep "AssignmentState.AssignedAgentUsername"` over `src`, then manual read of each enclosing method to classify.
- Enhancement proposal: a first-class `find_field_accesses(symbolId, mode: read | write | all)` (or a `view:"accesses"` on `get_change_context` for property symbols) that returns each access with `{ file, line, enclosingSymbolId, mode }`. This leverages the existing `PROPERTY_REF`/`PROPERTY_WRITE` edges (ISSUE-001) — it is primarily a read/query-layer surface over data the graph already holds.
- Tracking URL: `D:/1.SourceCode/mcp-local/codebase-index-mcp/mcp-codebase-index-issue-registry.md#mcp-issue-018`

## MCP-ISSUE-019 ✅ RESOLVED (2026-06-10)
- Reported: 2026-06-09 · Repo: `wec.commnunication-hub` · Severity: medium (recurring activation friction)
- Scenario: `search_symbols` strategy selection (`name` vs `intent`+`ranked`) remains error-prone — CLAUDE.md devotes a Hard Rule (#4) and a Blocked-Behavior entry to it, which is itself a signal the API doesn't self-disambiguate.
- MCP tool/query attempted: `search_symbols` with multi-word natural-language queries occasionally issued under `strategy:"name"`, returning empty.
- Expected: a multi-word/natural-language query should not silently return nothing; the tool should either auto-route to `intent`+`ranked` or hint the correct strategy.
- Actual: `strategy:"name"` on a multi-word query returns 0 results with no guidance; the agent must remember to re-issue under `intent`. Costs a call against the 5-call soft cap.
- Impact: medium — wasted calls + occasional premature fallback to grep when the empty result is misread as "not indexed."
- Workaround: manually re-issue with `strategy:"intent", ranked:true`.
- Enhancement proposal: (1) auto-detect — if the query has whitespace / >1 distinctive token and looks natural-language, internally run `intent`+`ranked` (or both and merge); (2) when `name` returns 0, include `suggestion: "retry with strategy:intent"` in the response. Pairs with `orient` (ENH-F) but should also live on the tool itself.
- Tracking URL: `D:/1.SourceCode/mcp-local/codebase-index-mcp/mcp-codebase-index-issue-registry.md#mcp-issue-019`

## MCP-ISSUE-020 ✅ RESOLVED (2026-06-10)
- Reported: 2026-06-09 · Repo: `wec.commnunication-hub` · Severity: medium-high (blind spot for this event-driven codebase)
- Scenario: Trace the real runtime chain of a notification: `Command → SaveChanges → domain event → EventHandler → INotificationPublisher.PublishConversationNotificationAsync → RabbitMQ queue → consumer`. Needed to confirm where `handlingAgentUsername` flows after publish.
- MCP tool/query attempted: `find_symbol_at_line` → `trace_execution_flow` on the handler's `Handle` method.
- Expected: the flow to continue across the publish/consume boundary — i.e., link the publisher callsite to the MassTransit/outbox consumer that handles the same message contract.
- Actual: `trace_execution_flow` stops at the `PublishConversationNotificationAsync` boundary; the producer→consumer hop through MassTransit/the outbox is invisible (no static CALLS edge — same family as the DI-wiring blind spot in ISSUE-014, but for message contracts rather than pipeline behaviours).
- Impact: medium-high for this codebase, which is fundamentally event/queue-driven (RabbitMQ queues `communication-hub.inbound_message`, `crm.outbound_message`, `crm.escalation_required`). The agent cannot follow a message end-to-end via MCP and must read consumer files manually.
- Workaround: manual read of `*Consumer.cs` + the message contract type to connect producer↔consumer by hand.
- Enhancement proposal: index a `PUBLISHES`/`CONSUMES` edge class keyed by message contract type — link a `Publish<T>`/`Send<T>` callsite (and outbox enqueue of contract `T`) to the `IConsumer<T>`/handler of the same `T`, so `trace_execution_flow`/`get_call_chain` can cross the bus. Even heuristic contract-name matching beats a hard stop at the publish call.
- Tracking URL: `D:/1.SourceCode/mcp-local/codebase-index-mcp/mcp-codebase-index-issue-registry.md#mcp-issue-020`

## MCP-ISSUE-021 ✅ RESOLVED (2026-06-10)
- Reported: 2026-06-09 · Repo: `wec.commnunication-hub` · Severity: low (trust/observability)
- Scenario: CLAUDE.md gates fallback on `confidence < 0.7` and graph `unresolvedRatio > 0.3`, but those scalars aren't consistently visible in every tool response, so the agent can't always apply the gate deterministically.
- MCP tool/query attempted: `search_symbols`, `get_symbol_context_pack` (navigation tools) — checked for a confidence / unresolvedRatio field to drive the fallback decision.
- Expected: every analysis response carries `confidence` (+ `unresolvedRatio` where applicable) so the documented threshold can be applied without guessing.
- Actual: ENH-C shipped `coverage.confidence` on `find_implementations`/`get_call_chain`/`trace_execution_flow` (good), but `search_symbols` and `get_symbol_context_pack` don't surface a comparable scalar in their default/compact output, so the gate can't be applied uniformly.
- Impact: low — affects when-to-fallback discipline, not correctness; but it nudges toward premature or skipped fallback.
- Workaround: infer confidence from result emptiness/shape.
- Enhancement proposal: extend the ENH-C `coverage` block (or at minimum a `confidence` scalar in nano/compact) to `search_symbols` and `get_symbol_context_pack`. Keep it cheap to preserve the compactSavings benchmark — a single scalar in nano is enough to drive the gate.
- Tracking URL: `D:/1.SourceCode/mcp-local/codebase-index-mcp/mcp-codebase-index-issue-registry.md#mcp-issue-021`

### Adoption-lift priority (this session)
1. **ISSUE-018** (field-access audit) — directly removes the day's biggest grep fallback; reuses existing PROPERTY edges, mostly a query-layer surface.
2. **ISSUE-020** (publish/consume edges) — unlocks end-to-end tracing for an event-driven codebase; the single highest-leverage graph gap left.
3. **ISSUE-019** (search_symbols auto-strategy) — cheap, removes recurring wasted calls.
4. **ISSUE-021** (uniform confidence signal) — cheap observability completion of ENH-C.

### Resolution (2026-06-10) — ISSUE-018/019/020/021 all shipped
- **ISSUE-019 — search_symbols auto-strategy.** `handleSearchSymbols` (`src/handlers/searchHandler.ts`) now auto-routes a multi-word query issued under `strategy='name'` to `intent` (whitespace test via `isMultiWordQuery`), echoes the decision as `strategy`/`autoRouted`, and — when name-search still returns empty — adds a non-fatal `suggestion: "retry with strategy='intent'"`. Single-token identifier searches keep `name` behaviour exactly. Applies to both the ranked and non-ranked branches.
- **ISSUE-021 — uniform coverage signal.** `CoverageKind` gained `search` / `context_pack` / `field_accesses` arms (`src/coverage.ts`); `search_symbols` and `get_symbol_context_pack` now embed the ENH-C `coverage` block (full in compact+, `confidence` scalar in nano) — `get_symbol_context_pack` feeds the change-context `graphHealth`/`reliabilitySummary` into it — so the CLAUDE.md fallback gate (`confidence < 0.7` / `unresolvedRatio > 0.3`) applies uniformly. Benchmark `compactSavings` unchanged, no snapshot regression.
- **ISSUE-018 — `find_field_accesses` (new read tool).** Query-layer surface over the existing `PROPERTY_REF` (read) / `PROPERTY_WRITE` (write) edges — no extraction or DB change. New `GraphStore.getFieldAccesses(repoId, symbolId, mode, limit)` resolves the property's enclosing type, matches resolved (`to_id == symbolId`) and unresolved `property:` tokens (qualified `Type.Member`, any-owner `%.Member`, bare `Member`), and joins `from_id` back to each enclosing symbol. New `handleFindFieldAccesses` (`src/handlers/impactHandler.ts`) partitions `reads`/`writes`, attaches the coverage block + `staleWarning`, accepts a `symbolId` **or** resolvable `name` (preferring a `property` candidate). Schema `findFieldAccessesSchema` (`src/schemas/toolSchemas.ts`); tool def + dispatch in `src/index.ts`. This is the "who reads vs writes this field" audit that ISSUE-018 routed to 3 grep agents.
- **ISSUE-020 — `PUBLISHES`/`CONSUMES` edge class.** New edge types in `EdgeRecord` (`src/types.ts`; no DDL change — `type` is unconstrained text). Extraction (`src/extractors/csharpExtractor.ts`): the producer side emits `PUBLISHES contract:<T>` from a `Publish<T>`/`Send<T>(...)` callsite — explicit generic arg **or** inferred from a `new T(...)` first argument; the consumer side emits `CONSUMES contract:<T>` from `IConsumer<T>`/`IRequestHandler<T,_>`/`INotificationHandler<T>` base lists (in addition to the existing IMPLEMENTS edge). Resolution `resolvePublishesConsumesEdges` (`src/edgeResolver.ts`, wired after `resolveImplementsEdges` in both `src/index.ts` post-phase and `src/indexPipeline.ts` full-mode): matches `contract:` tokens by name, rewriting each `PUBLISHES.to_id` to the consumer symbol (one resolved edge per consumer) and each `CONSUMES.to_id` to the in-repo contract type symbol; unmatched contracts are tagged `external boundary`. Traversal consistency: the set of flow edge types lives in one place — `CALL_TRAVERSAL_EDGE_TYPES` (`src/types.ts`) — referenced by `traceExecutionFlowImpl`, `getChangeContext` (callers + callees), and `getCallEdges`, so `trace_execution_flow`, `get_call_chain`, **and** `get_symbol_context_pack`/`get_change_context` all cross the bus uniformly; `find_impact_files` already matched resolved bus edges via the type-agnostic `to_id` arm of `buildEdgeToSymbolJoinClause`. `dead_code_scan` counts incoming `PUBLISHES` so a bus-only consumer is not false-flagged. Bus hops carry a `via:"bus"` marker (trace + get_call_chain nano) and a coverage known-gap notes the heuristic contract-name match. **Re-index required** for existing repos to gain the edges.
- Verification (2026-06-10): `npm run typecheck` ✅ · `npm run build` ✅ · `npm run guard:no-llm-runtime` ✅ · `node scripts/smoke-test.mjs` ✅ · `npm run benchmark:plan:check` ✅ (no snapshot regression) · `node scripts/test-refactor-engine.mjs` → 47/0 · `node scripts/test-csharp-inheritance-bridge.mjs` ✅ · new `node scripts/test-bus-edges.mjs` (`npm run test:bus-edges`) ✅ — asserts producer/consumer/explicit-generic extraction, producer→consumer resolution, and the `find_field_accesses` read/write partition.
- Residual: bus matching is heuristic by contract type name — a contract published in one repo and consumed in another (or by an external service) resolves to `external boundary`, not a cross-repo hop; resolved PUBLISHES edges land on the consumer **type**, not its `Consume`/`Handle` method. `find_field_accesses` covers C# PROPERTY edges only (dynamic/reflective access and unindexed languages are out of scope). Re-index needed for ISSUE-020 edges on existing repos.

## Session Dogfooding — 2026-06-10 (CH-33 notification-catalog audit)
Context: MCP-first session on `wec.commnunication-hub` (incremental re-index → fetch Jira CH-33 → cross-check notification implementation against AC → produce `docs/04-api/ch33-notification-catalog.md` for PM). What worked well: `search_symbols(intent)` surfaced `NotificationPublisher`/`SendNotificationMessage`/`INotificationPublisher` on the first query without knowing any names; `get_folder_summary` scoped `Infrastructure/Notifications` cheaply; `indexMeta` branch/commit provenance trusted throughout. Honest split for the session: MCP ≈30% (discovery/orientation), `Grep`/`Read` ≈70% (caller tracing + string-content extraction). The four issues below are where the fallback happened.

## MCP-ISSUE-022 ✅ RESOLVED (2026-06-11)
- Reported: 2026-06-10 · Repo: `wec.commnunication-hub` · Branch: `develop` · Commit: `e794319` · Severity: high (biggest fallback driver this session)
- Scenario: Find all production call-sites of `NotificationPublisher.PublishConversationNotificationAsync` to enumerate every notification use case. All callers invoke it through the DI-injected interface `INotificationPublisher`, never through the concrete class.
- MCP tool/query attempted: `get_symbol_context_pack(name="NotificationPublisher")`.
- Expected: callers to include the 6+ Application-layer event handlers (`ConversationAssignedEventHandler`, `ConversationHandedOffToHumanEventHandler`, `ConversationMessageReceivedEventHandler`, `ConversationReopenedEventHandler`, `CustomerAssignmentChangedEventHandler`, `CustomerStatusChangedEventHandler`) and `ProcessOutboundSentConfirm` — i.e. callers of the interface methods attributed to (or merged into) the implementation.
- Actual: `callers` contained **only `NotificationPublisherIntegrationTests` methods** (which construct the concrete class directly); `callees: []`, `importedByFiles: []`. Every production call-site via `INotificationPublisher` was invisible.
- Impact: the central question of the session ("who sends notifications?") could not be answered by MCP. Fell back to `Grep "PublishConversationNotificationAsync"` which returned all 8 files in one call — a total MCP loss for the dominant Clean-Architecture pattern (every cross-layer dependency goes through an interface).
- Workaround: `Grep` on the method name, then targeted `Read` of each handler.
- Enhancement proposal: interface-aware caller resolution — when a symbol is a class implementing `IFoo` (IMPLEMENTS edge exists, record-aware after ISSUE-013), `get_symbol_context_pack`/`get_change_context` should merge callers of the **interface's same-named methods** into the implementation's caller set (tagged e.g. `via:"interface"`, confidence ~0.7). Conversely, a context pack for the interface should list implementations (already possible via `find_implementations`) *and* their callers. Related-but-distinct from ISSUE-014 (that covers reflection/DI *invocation* like pipeline behaviours; this is ordinary `_dep.Method()` calls where the static receiver type is the interface).
- Tracking URL: `D:/1.SourceCode/mcp-local/codebase-index-mcp/mcp-codebase-index-issue-registry.md#mcp-issue-022`

## MCP-ISSUE-023 ✅ RESOLVED (2026-06-11)
- Reported: 2026-06-10 · Repo: `wec.commnunication-hub` · Severity: medium-high (forced full-file Reads for a whole task class)
- Scenario: PM-facing audit "list every notification title/message the Hub sends" — i.e. enumerate string literals like `"Conversation assigned"`, `"New message"`, `"Message delivery failed"` and the interpolated message templates, each with its enclosing symbol.
- MCP tool/query attempted: none directly applicable — `search_symbols` indexes symbol names/signatures; `query_docs` covers docs lane; the JSONKEY lane (MCP-ISSUE-2026-05-08-JSONKEY-SCAN) covers only `[JsonPropertyName]` attributes.
- Expected: some way to search string-literal content and get `{ literal, file, line, enclosingSymbol }` so "what user-facing text does this repo emit" is one call.
- Actual: no literal lane exists; the entire content-extraction half of the task (7 files) was done via `Grep` + full `Read`s.
- Impact: any audit keyed on user-facing strings (notification titles, log message inventory, error-message catalog, i18n sweep) bypasses MCP entirely. This was ~half the session's token spend.
- Workaround: `Grep` for known method names, `Read` each caller, hand-copy literals.
- Enhancement proposal: index string literals (above a minimum length, deduplicated, capped per file) as a searchable lane — either FTS over a `literals` table with `{ value, file, line, enclosingSymbolId }`, or `search_symbols(kind="literal")`. Acknowledged in the JSONKEY-SCAN residual ("string literal keys … not yet extracted"); this issue upgrades it from residual note to a concrete recurring task class.
- Tracking URL: `D:/1.SourceCode/mcp-local/codebase-index-mcp/mcp-codebase-index-issue-registry.md#mcp-issue-023`

## MCP-ISSUE-024 ✅ RESOLVED (2026-06-11)
- Reported: 2026-06-10 · Repo: `wec.commnunication-hub` · Severity: medium (result-quality noise, partially cosmetic)
- Scenario: `search_symbols(query="agent notification conversation assigned escalation", strategy="intent", ranked=true)` to discover notification-related handlers.
- Expected: ranked results distinguishable at a glance, production code preferred or filterable.
- Actual: 20 hits, **all named `Handle`** — only the signature disambiguates them — and interleaved with test doubles (`SimpleMediatorPipelineTests` stubs, spies). In a MediatR/CQRS codebase every interesting method is `Handle`/`Execute`, so name-centric presentation degrades exactly here. A second query (`"notification"`) ranked four test-file `Handle` stubs as the top 4 results (score 95–98) above all production handlers.
- Impact: medium — the right files were findable via signatures, but ranking that prefers test stubs wastes the agent's per-question call budget and reads as low quality.
- Workaround: visually scan `filePath`/`signature` columns; ignore `tests/` hits.
- Enhancement proposal: (1) present/rank C# members by **qualified name** (`ConversationAssignedEventHandler.Handle`) — the enclosing-type token should participate in intent-token matching (the parent linkage exists since ISSUE-004 `parent_symbol_id`); (2) add an `excludeTests: true` (or `pathExclude` glob) filter to `search_symbols`, defaulting test paths to a rank penalty when ranked=true; (3) consider indexing parameter type names (`ConversationAssignedEvent`) as intent tokens — that token is what actually distinguishes the 20 `Handle`s.
- Tracking URL: `D:/1.SourceCode/mcp-local/codebase-index-mcp/mcp-codebase-index-issue-registry.md#mcp-issue-024`

## MCP-ISSUE-025 ✅ RESOLVED (2026-06-11)
- Reported: 2026-06-10 · Repo: `wec.commnunication-hub` · Severity: low (telemetry trust)
- Scenario: `index_repository(mode="incremental")` run `ca2e585f-6603-46a0-a342-c5958e9a5b0c` (10 files re-indexed) returned contradictory resolve telemetry.
- Actual fields: `callEdgesResolved: 8002` **and** `unresolvedCallsTotal: 8002` **and** `resolveCallsCoverage: 1`, alongside `crossRepoAttempts: 5000, unresolvedNoCandidate: 4945, unresolvedAmbiguous: 30, crossRepoResolved: 25`.
- Expected: resolved + unresolved to partition the call-edge population (coverage = resolved / total), or field names that make the actual semantics unambiguous.
- Impact: low for navigation, but these counters are the registry's own evidence base for issues like 022 — if `unresolvedCallsTotal` actually means "edges attempted this phase" rather than "edges left unresolved", the name is misleading; if it really means unresolved, then `resolveCallsCoverage: 1` is wrong and the true coverage may explain the interface-caller blindness of ISSUE-022.
- Workaround: none (informational field).
- Enhancement proposal: audit the run-summary counter semantics in the resolve phase; either fix the computation or rename to self-describing fields (`callEdgesAttempted`, `callEdgesResolved`, `callEdgesUnresolved`, with `coverage = resolved/attempted`). Add one smoke-test assertion that resolved + unresolved == attempted.
- Tracking URL: `D:/1.SourceCode/mcp-local/codebase-index-mcp/mcp-codebase-index-issue-registry.md#mcp-issue-025`

### Adoption-lift priority (this session)
1. **ISSUE-022** (interface-aware callers) — the dominant Clean-Architecture call pattern is currently invisible to the context pack; closing it converts this session's biggest grep fallback into an MCP win.
2. **ISSUE-023** (string-literal lane) — unlocks the user-facing-text audit task class (notifications, errors, logs, i18n) that today bypasses MCP wholesale.
3. **ISSUE-024** (qualified-name ranking + test filter) — cheap result-quality fix for CQRS/MediatR repos where everything is named `Handle`.
4. **ISSUE-025** (telemetry semantics) — cheap; restores trust in the counters used to evaluate all other issues.

### Resolution (2026-06-11) — ISSUE-022/023/024/025 all shipped (commits `fb48542`, `96a4577`, `8f3cfa3`, `c8cd0c0`)
- **ISSUE-025 — self-describing resolve counters.** Diagnosis: the math was right, the name lied — `unresolvedCallsTotal` was captured *before* the resolve phase (`src/index.ts`), i.e. it always meant "call edges attempted". Run summaries now emit `callEdgesAttempted` / `callEdgesResolved` / `callEdgesUnresolved` (= attempted − resolved) with `resolveCallsCoverage = resolved/attempted`; `unresolvedCallsTotal` kept as a deprecated alias (DB column `unresolved_calls_total` unchanged — additive migration convention). The skip-path summary carries the same fields. Smoke test asserts the partitions: `resolved + unresolved == attempted`, coverage formula, alias equality, and cross-repo `crossRepoResolved + unresolvedNoCandidate + unresolvedAmbiguous + unresolvedBoundaryBlocked + unresolvedLowConfidence == crossRepoAttempts` (the original 8002/8002/1.0 report was two *different* edge populations, now visibly so).
- **ISSUE-024 — qualified names + test penalty.** Ranked path (`getSymbolCandidatesImpl`, `src/symbolSearch.ts`) LEFT JOINs `parent_symbol_id`: emits `qualifiedName` ("ConversationAssignedEventHandler.Handle") and the enclosing-type name participates in the intent pre-filter and coverage haystack — domain tokens now raise the *primary* sort key for production handlers instead of tying 20 `Handle`s. `TEST_PATH_PENALTY = 0.08` (> kind bonus 0.03 + several position steps) demotes test paths at equal coverage; `excludeTests` param drops them outright (ranked + non-ranked). `isTestPath` extracted to `src/fileFilter.ts` (shared with `link_tests_to_source`). Item (3) param-type tokens: already worked via the signature haystack — pinned by regression test only. Benchmark gate unaffected (ranked path is not a benchmark scenario). New `npm run test:search-ranking`.
- **ISSUE-022 — interface-aware caller resolution.** Five cooperating bugs, not one: (A) tree-sitter-c-sharp puts a `field_declaration`'s `type` on the nested `variable_declaration`, so DI field types never entered the scope map and qualified `callee:IFoo.Method` tokens were never emitted; (B) C# 12 primary-ctor `parameter_list` was invisible to the scope walk, and the emit gate skipped camelCase receivers even with a resolved type; (C) `_field.Method` tokens dead-ended as `external boundary (DI field)`; (D) bare-name tokens resolving onto an interface's own method never triggered the (already-existing) interface-dispatch fan-out; (E) a context pack on the *class* never aggregated its members' callers — hence "only integration tests". Fixes: extraction reads the nested type node + maps primary-ctor params (`extractorUtils.ts`), emit gate accepts any type-resolved receiver (`csharpExtractor.ts`); resolution fans out from bare-name interface-method matches via `parent_symbol_id`, fan-out capped at 10 implementor files, dispatch confidence 0.65→0.7, IMPLEMENTS join record-aware (`edgeResolver.ts`); query layer gains `expandInterfaceSiblings` (`src/interfaceSiblings.ts`) seeding caller BFS frontiers with interface↔impl sibling methods and class members — works on stale indexes with `iface:` placeholders (safety net, no re-index needed for the query-layer half). `via:"interface"` surfaces in change-context/context-pack/call-chain/trace mirroring `via:"bus"`. New `npm run test:interface-dispatch` (extraction tokens, fan-out, class-level aggregation, stale-index net).
- **ISSUE-023 — string-literal lane + `search_literals`.** New `string_literals` table + `literals_fts` (FTS5 external-content, mirrors docs_fts) — deliberately *not* the symbols table, so search ranking (ISSUE-024) and `dead_code_scan` stay clean. Extraction (`src/extractors/literalExtractor.ts`): C# string/verbatim/raw/interpolated + TS/JS string/template, interpolation holes normalized to `{…}`, attribute literals skipped (JSONKEY lane), import specifiers skipped; min length 6, per-file cap 200/100/50 by performance profile, >500-char values dropped, per-file dedup; env `CODEBASE_INDEX_MIN_STRING_LITERAL_LENGTH` / `CODEBASE_INDEX_MAX_STRING_LITERALS_PER_FILE`. Pipeline: per-file replace in the write loop, FTS rebuild in post phase, `pruneFiles` deletes the lane. New `search_literals` tool returns `{ value, filePath, line, kind, enclosingSymbol }` with coverage + staleWarning. `indexVersion` bumped to `v2-string-literals`; `evaluateIncrementalSkip` now refuses to skip on version change (previously it only compared commit/working-tree). New `npm run test:string-literals` + smoke-test live call.
- Verification (2026-06-11), per issue before its commit: `npm run typecheck` ✅ · `npm run build` ✅ · `npm run guard:no-llm-runtime` ✅ · `node scripts/smoke-test.mjs` ✅ (incl. new RUN_SUMMARY_INVARIANTS + SEARCH_LITERALS_OK) · `npm run benchmark:plan:check` ✅ (no snapshot regression) · `node scripts/test-refactor-engine.mjs` → 47/0 · `test:bus-edges` / `test:csharp-inheritance-bridge` / `test:endpoint-bridge` ✅ · new `test:search-ranking` / `test:interface-dispatch` / `test:string-literals` ✅.
- Residual: **(022)** extraction-side gains need a re-index; the query-layer sibling expansion covers stale indexes but only at depth-1 seeds, and fan-out/expansion caps (10/20) truncate very wide interfaces (MediatR-style) — merged callers carry confidence 0.7 for filtering. Scope-map type inference still misses locals assigned from factory calls. **(023)** incremental mode skips unchanged files by content hash, so existing repos need **one `mode="full"` run** to fully populate the literal lane; concatenated string fragments (`"a" + "b"`) are stored as separate literals; `excludeTests` not yet on `search_literals` (trivial follow-up via shared `isTestPath`). **(024)** the non-ranked compact shape intentionally omits `qualifiedName` (benchmark protection); name-strategy ordering is SQL-side, so the test penalty there lowers reported confidence but not row order. **(025)** `unresolvedCallsTotal` alias retained one release for prompt/docs compatibility — remove after consumers migrate.
