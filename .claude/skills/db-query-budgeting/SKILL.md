---
name: db-query-budgeting
description: "Control DB query budget with timeout, row limits, and concurrency caps to prevent abuse and resource exhaustion."
---

# DB Query Budgeting

## When to Use
- Add/modify DB query tools.
- Tune performance for large datasets.
- Prevent unbounded extraction behavior.

## Procedure
1. Define budget knobs
   - `timeoutMs`, `limit`, max concurrent queries.
2. Enforce hard caps
   - Clamp user input to safe bounds from env/config.
3. Protect server resources
   - Use read-only transaction mode for read tools.
   - Ensure cancellation or timeout handling is deterministic.
4. Emit budget telemetry
   - Track capped requests and timeout frequency.
5. Document policy
   - Include defaults and maximums in README.

## Output Format
- Budget table
- Enforcement points in code
- Risk notes

## Authoritative reference

Bounds are declared once, in `packages/manifest/src/envSpecs/postgres.ts`, and rendered into `postgres-mcp/README.md` — never hand-edit the generated table. Limit helpers: `@mcp/core` `limits` (`packages/core/README.md`).
