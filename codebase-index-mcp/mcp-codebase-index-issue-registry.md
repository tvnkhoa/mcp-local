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