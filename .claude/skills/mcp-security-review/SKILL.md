---
name: mcp-security-review
description: "Review MCP server changes for security guardrails: least privilege, read-only DB defaults, SQL safety checks, secrets handling, and safe logging. Use before merging DB-related MCP changes."
---

# MCP Security Review

## When to Use
- Any DB-related MCP tool change.
- Any change touching SQL validation or query execution.
- Pre-merge review for MCP safety posture.

## Review Checklist
1. **Privilege**
   - Is behavior least-privilege by default?
   - Are mutating operations explicitly requested and bounded?
2. **SQL Guardrails**
   - Single-statement enforcement present?
   - Dangerous tokens blocked for read-only paths?
   - Query timeout and result limits enforced?
3. **Input Safety**
   - Inputs validated via schema (`zod`)?
   - Query args parameterized?
4. **Secrets & Logging**
   - No hardcoded secrets/tokens/connection strings.
   - Logs avoid sensitive payloads and full raw SQL where risky.
5. **Error Surfaces**
   - Error messages actionable but not sensitive.
6. **Docs & Operability**
   - `README.md` updated for tool inputs/limits/examples.

## Output Format
- Pass/fail summary.
- List of findings with severity: `high|medium|low`.
- Concrete remediation suggestions.
