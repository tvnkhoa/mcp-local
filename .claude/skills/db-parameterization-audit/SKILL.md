---
name: db-parameterization-audit
description: "Audit SQL construction to ensure parameterized execution, anti-concatenation posture, and read-only safety."
---

# DB Parameterization Audit

## When to Use
- Any change in SQL generation/execution.
- Security review before merging DB-related changes.

## Audit Checklist
1. Input handling
   - Untrusted values are bound via parameters.
   - No string concatenation for SQL conditions.
2. Guardrails
   - Multi-statement blocked where not required.
   - Dangerous tokens blocked for read-only tools.
3. Execution context
   - Read-only transaction enabled for query tools.
4. Error and logging
   - SQL text redacted or hashed in logs when needed.
5. Tests and docs
   - Include positive and negative guardrail test cases.

## Output Format
- `pass` or `fail`
- Violations with exact fix recommendations