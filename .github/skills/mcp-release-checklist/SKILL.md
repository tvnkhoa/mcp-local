---
name: mcp-release-checklist
description: "Run a pre-release checklist for local MCP packages: typecheck/build/start path, env constraints, README completeness, and safe defaults. Use before publishing or handing off."
---

# MCP Release Checklist

## When to Use
- Before tagging/releasing a local MCP package.
- Before handoff to another internal team member.

## Checklist
1. Build & runtime
   - `typecheck` passes.
   - `build` succeeds.
   - `start` works from built output.
2. Safety defaults
   - Least-privilege defaults preserved.
   - Timeouts/limits bounded and documented.
3. Configuration hygiene
   - Sensitive config via env vars only.
   - No secrets in code/docs/sample configs.
4. Documentation
   - README includes setup, run, tool list, sample input/output.
   - Notes security limitations and expected guardrails.
5. Change hygiene
   - Diff is minimal and scoped.
   - Error messages remain clear and actionable.

## Output Format
- Release readiness: `ready` or `blocked`.
- Blockers list with exact file references.
- Optional follow-ups for hardening.
