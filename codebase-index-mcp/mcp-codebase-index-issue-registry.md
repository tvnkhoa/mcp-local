# MCP Codebase-Index Issue Registry

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