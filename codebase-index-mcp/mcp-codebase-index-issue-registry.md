# MCP Codebase-Index Issue Registry

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
