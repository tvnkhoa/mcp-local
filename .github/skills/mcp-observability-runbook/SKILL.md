---
name: mcp-observability-runbook
description: "Define operational telemetry and incident runbooks for MCP servers: logs, metrics, alerts, and recovery paths."
---

# MCP Observability Runbook

## When to Use
- Add long-running or high-risk tools.
- Prepare production-like internal deployment.
- Investigate recurring failures.

## Procedure
1. Define critical metrics
   - Request count, error rate, latency p95/p99.
   - Tool-level timeout rate and validation failure rate.
2. Standardize logs
   - Structured logs with requestId/toolName/status/elapsedMs.
   - No secrets or raw sensitive payloads.
3. Alert policy
   - Thresholds for error spikes and sustained latency.
4. Incident runbook
   - Detect -> triage -> mitigate -> recover -> postmortem.
   - Include rollback/restart/reindex procedures where applicable.
5. Verification drills
   - Simulate timeout and dependency failures.

## Output Format
- Metrics set
- Alert set
- Runbook steps with owners