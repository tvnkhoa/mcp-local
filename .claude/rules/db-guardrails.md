---
description: "Use when adding or changing database-related MCP tools, SQL validation, or query execution flow. Enforces least privilege and read-only-by-default posture."
---
> Scope: `postgres-mcp/**` (TS + docs + config).

# Database Guardrails Rules

- Default DB tools to **read-only** unless the task explicitly requires mutation.
- Always block multi-statement SQL where not required.
- Block dangerous SQL tokens for read-only tools (DDL/DML/admin tokens).
- Enforce bounded `limit` and `timeoutMs` from config with safe defaults.
- Never log secrets, full connection strings, or raw sensitive payloads.

## Query Safety
- Validate query shape before execution.
- For read queries, wrap/limit results to avoid unbounded data extraction.
- Run read queries in read-only transaction mode when possible.
- Prefer parameterized queries; never concatenate untrusted input.

## Error Handling
- Return errors with stable code + clear message.
- Do not leak sensitive DB details in error text.

## Documentation
- When adding/changing DB tools, update `README.md` with:
  - input schema
  - limits/timeouts
  - sample safe query
