---
name: mcp-host-integration-security
description: "Harden MCP host/client integration with token hygiene, scope minimization, transport safeguards, and policy checks."
---

# MCP Host Integration Security

## When to Use
- Integrate MCP with IDE hosts or remote clients.
- Add OAuth/PAT based authentication.
- Review workspace-level trust boundaries.

## Checklist
1. Token hygiene
   - Keep tokens in secure env/store.
   - Rotate tokens and avoid long-lived broad scopes.
2. Scope minimization
   - Start with least privilege and expand only as needed.
3. Transport hardening
   - Use localhost or HTTPS for remote traffic.
   - Avoid exposing internal-only MCP endpoints publicly.
4. Access policy
   - Restrict allowed roots/toolsets where possible.
5. Auditability
   - Record who triggered high-risk operations.

## Output Format
- Pass/fail
- Security findings with severity and mitigation

## Authoritative reference

What the installer writes, and where secrets live (`~/.claude.json`): `README.md` §"What install writes" and `docs/guides/onboarding.md`. Path allowlisting: `@mcp/shared/fs` `createPathAllowlist`.
