---
description: "Base instruction layer for all local MCP packages in this workspace. Apply before domain-specific instructions."
---
> Scope: all MCP packages (`codebase-index-mcp`, `postgres-mcp`, `observe-mcp`, `bitbucket-mcp`). Domain rules override these on conflict.

# MCP Base Rules

- Treat this as the default rule set for all MCP packages.
- Keep implementation least-privilege, secure by default, and operationally clear.
- Use TypeScript + Node.js ESM unless a package explicitly requires a different runtime.
- Validate all external inputs with schema and enforce documented hard bounds.
- Keep tool names explicit and stable; avoid hidden behavior changes.

## Base Contracts
- Every MCP package should provide:
  - `src/index.ts` as entrypoint.
  - A dedicated guardrails file when safety logic exists.
  - `README.md` with setup, run command, tool list, input/output examples.
- Keep scripts compatible with `build`, `dev`, `start`, `typecheck`.

## Safety Baseline
- Never hardcode secrets, tokens, or connection strings.
- Prefer environment variables for sensitive configuration.
- Avoid logging sensitive payloads; use metadata or hashes where possible.
- Use deterministic error codes and actionable messages without leaking internals.

## Two-Layer Resolution
- Domain instructions may tighten rules for a specific package.
- If Base and Domain conflict, Domain rules win within that package scope.