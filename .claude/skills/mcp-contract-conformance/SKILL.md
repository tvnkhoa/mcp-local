---
name: mcp-contract-conformance
description: "Validate MCP contract stability for tools/list, tools/call, schemas, and backward compatibility before merge or release."
---

# MCP Contract Conformance

## When to Use
- Add/remove/rename MCP tools.
- Change input schema, default values, or bounds.
- Refactor tool routing or error surfaces.

## Checklist
1. Tool inventory stability
   - Compare tool names before and after changes.
   - Confirm removed tools are intentional and documented.
2. Schema stability
   - Required fields and types match runtime behavior.
   - Boundaries (`limit`, `depth`, `timeoutMs`) remain enforced.
3. Error compatibility
   - Error codes remain stable and machine-readable.
   - Messages are actionable without leaking internals.
4. Behavioral compatibility
   - Existing valid requests still succeed.
   - Invalid requests fail with deterministic validation errors.
5. Documentation sync
   - README tool examples match final schema.

## Output Format
- `pass` or `fail`
- Findings with severity: `high|medium|low`
- Remediation per finding