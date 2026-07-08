---
name: index-security-review
description: "Review security for internal codebase-index MCP: data isolation, secret redaction, access control, safe logging, and controlled query exposure."
---

# Index Security Review

## When to Use
- Before merging/deploying indexing or graph-query changes.

## Checklist
1. Data isolation (tenant/repo boundaries).
2. Secret handling (redaction before storage/logging).
3. Query controls (depth/limit/timeouts, anti-abuse).
4. Access controls (internal authN/authZ).
5. Auditability (run metadata, who-triggered, policy version).
6. Incident readiness (reindex/revoke/purge procedures).

## Output Format
- `pass` or `fail` with severity-tagged findings.
- Concrete remediation per finding.
