---
name: index-release-checklist
description: "Run pre-release checks for internal codebase indexing MCP: correctness, performance, security posture, and runbook readiness."
---

# Index Release Checklist

## Checklist
1. Correctness
   - Full and incremental results consistent on test repos.
2. Performance
   - Index and query latency within target budgets.
3. Security
   - No sensitive leakage in logs/storage.
4. Operations
   - Health checks, metrics, and alerts are validated.
5. Documentation
   - README, architecture notes, and recovery playbooks updated.

## Release Decision
- `ready` if no high-severity blockers.
- `blocked` with explicit blocker list and owners.
