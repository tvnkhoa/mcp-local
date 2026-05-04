---
name: mcp-error-taxonomy
description: "Standardize MCP errors into user-actionable vs developer/internal classes with stable codes and safe messages."
---

# MCP Error Taxonomy

## When to Use
- Add new tool logic or new failure paths.
- Refactor validation or runtime exceptions.
- Prepare release and observability dashboards.

## Taxonomy
- User-actionable errors
  - Validation failures, permission denied, not found, rate limits, timeout.
- Internal/developer errors
  - Unexpected exceptions, invariant breaks, dependency failures.

## Procedure
1. Assign stable code namespace
   - Examples: `VALIDATION_ERROR`, `AUTH_ERROR`, `TIMEOUT_ERROR`, `INTERNAL_ERROR`.
2. Define message policy
   - User-actionable: clear next step.
   - Internal: generic safe message + requestId.
3. Ensure structured payload
   - Include `code`, `message`, `requestId`.
4. Link to logs safely
   - Correlate with requestId, avoid sensitive dumps.

## Output Format
- Error matrix: case -> code -> message style -> action