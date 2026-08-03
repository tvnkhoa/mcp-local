---
name: index-unresolved-symbol-policy
description: "Define safe handling for unresolved symbols during extraction and graph linking without silent data loss."
---

# Index Unresolved Symbol Policy

## When to Use
- Add parser language support.
- Refactor symbol resolution or edge linking.

## Policy
- Do not silently drop unresolved references.
- Record unresolved counters by language and file.
- Keep fallback edges/markers explicit where applicable.

## Procedure
1. Classify unresolved types
   - Missing definition
   - Dynamic dispatch ambiguity
   - Parser limitation
2. Persist observability signals
   - unresolved count per run
   - top files/languages with unresolved symbols
3. Query behavior
   - Return partial but explicit results with unresolved indicators.
4. Documentation
   - Explain expected unresolved behavior and limitations.

## Output Format
- Policy conformance report
- Unresolved counters and remediation priorities

## Authoritative reference

Unresolved-edge handling as built, plus the defects it produced (MCP-ISSUE-034, 038): `codebase-index-mcp/docs/mcp-codebase-index-issue-registry.md`.
