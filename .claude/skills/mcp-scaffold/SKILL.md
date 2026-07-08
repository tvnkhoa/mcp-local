---
name: mcp-scaffold
description: "Scaffold or extend local MCP servers in TypeScript/Node.js with zod schemas, clear tool contracts, and workspace conventions. Use when creating new MCP tools or new MCP server packages."
---

# MCP Scaffold

## When to Use
- Create a new local MCP server package.
- Add a new tool to an existing MCP server.
- Standardize scripts, structure, and README for MCP components.

## Procedure
1. Confirm scope: new server vs new tool in existing server.
2. Ensure baseline structure:
   - `src/index.ts` (entrypoint)
   - Guardrails file when safety logic exists (e.g. `sqlGuardrails.ts`)
   - `README.md` usage + examples
3. Add/align scripts in `package.json`: `build`, `dev`, `start`, `typecheck`.
4. Define schemas with `zod` and validate before execution.
5. Keep tool contract explicit: clear names, bounded limits, predictable errors.
6. Update docs with sample input/output and configuration.

## Output Requirements
- Minimal diff, no unnecessary refactor.
- Preserve ESM + strict typing conventions.
- Keep code testable and operational locally.
