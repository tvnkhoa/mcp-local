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
- Every MCP server provides:
  - `src/index.ts` as the only entrypoint.
  - The nine-slot standard structure — guardrails, response serialization and error mapping live in
    `src/middleware/`, not in a root-level file. See `docs/reference/folder-convention.md` §2.
  - `src/config/` as the only reader of `process.env`.
  - `README.md` with setup, run command, tool list, input/output examples.
- **Script vocabulary: `build`, `typecheck`, `test`, `smoke`** (plus `start`, `dev`). The first four
  are what make the root aggregates work uniformly — see `docs/reference/conventions.md` §4.

## Safety Baseline
- Never hardcode secrets, tokens, or connection strings.
- Prefer environment variables for sensitive configuration.
- Avoid logging sensitive payloads; use metadata or hashes where possible.
- Use deterministic error codes and actionable messages without leaking internals.

## Two-Layer Resolution
- Domain instructions may tighten rules for a specific package.
- If Base and Domain conflict, Domain rules win within that package scope.
